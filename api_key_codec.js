"use strict";

// Standalone decoder/encoder for this project's tenant Bech32 key format.
// Returns keyId as BigInt because the payload contains a full u64.

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const CHARSET_REV = Object.fromEntries([...CHARSET].map((c, i) => [c, i]));
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
const ALLOWED_METHODS = new Set(["none", "cookie", "aes"]);
const FORMAT_VERSION = 1;

function hrpExpand(hrp) {
  const out = [];
  for (const ch of hrp) out.push(ch.charCodeAt(0) >> 5);
  out.push(0);
  for (const ch of hrp) out.push(ch.charCodeAt(0) & 31);
  return out;
}

function polymod(values) {
  let chk = 1;
  for (const v of values) {
    const b = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) {
      if ((b >>> i) & 1) chk ^= GEN[i];
    }
  }
  return chk >>> 0;
}

function verifyChecksum(hrp, data) {
  return polymod(hrpExpand(hrp).concat(data)) === 1;
}

function createChecksum(hrp, data) {
  const values = hrpExpand(hrp).concat(data, [0, 0, 0, 0, 0, 0]);
  const pm = polymod(values) ^ 1;
  const out = [];
  for (let i = 0; i < 6; i++) out.push((pm >>> (5 * (5 - i))) & 31);
  return out;
}

function convertBits(data, fromBits, toBits, pad = false) {
  let acc = 0;
  let bits = 0;
  const out = [];
  const maxv = (1 << toBits) - 1;
  const maxAcc = (1 << (fromBits + toBits - 1)) - 1;

  for (const value of data) {
    if (value < 0 || (value >> fromBits) !== 0) {
      throw new Error("invalid bech32 data value");
    }
    acc = ((acc << fromBits) | value) & maxAcc;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      out.push((acc >> bits) & maxv);
    }
  }

  if (pad) {
    if (bits > 0) out.push((acc << (toBits - bits)) & maxv);
  } else {
    if (bits >= fromBits) throw new Error("invalid bech32 padding");
    if (((acc << (toBits - bits)) & maxv) !== 0) throw new Error("non-zero bech32 padding");
  }

  return Uint8Array.from(out);
}

function bech32Decode(addr) {
  if (typeof addr !== "string" || addr.length === 0) {
    throw new Error("encoded key must be a non-empty string");
  }

  let hasLower = false;
  let hasUpper = false;
  for (const ch of addr) {
    const code = ch.charCodeAt(0);
    if (code < 33 || code > 126) throw new Error("bech32 contains non-printable characters");
    if (code >= 97 && code <= 122) hasLower = true;
    if (code >= 65 && code <= 90) hasUpper = true;
  }
  if (hasLower && hasUpper) throw new Error("mixed-case bech32 string is invalid");

  const s = addr.toLowerCase();
  const pos = s.lastIndexOf("1");
  if (pos < 0) throw new Error("missing bech32 separator");
  if (pos < 1) throw new Error("empty bech32 hrp");
  if (s.length - pos - 1 < 6) throw new Error("checksum too short");

  const hrp = s.slice(0, pos);
  const data = [];
  for (const ch of s.slice(pos + 1)) {
    const v = CHARSET_REV[ch];
    if (v === undefined) throw new Error(`invalid bech32 character: ${ch}`);
    data.push(v);
  }

  if (!verifyChecksum(hrp, data)) throw new Error("bech32 checksum failed");

  const payload = convertBits(data.slice(0, -6), 5, 8, false);
  return { hrp, payload };
}

function bech32Encode(hrp, payload) {
  if (typeof hrp !== "string" || hrp.length === 0) {
    throw new Error("hrp must be a non-empty string");
  }
  hrp = hrp.toLowerCase();
  for (const ch of hrp) {
    const code = ch.charCodeAt(0);
    if (code < 33 || code > 126) throw new Error("hrp contains invalid characters");
  }

  const data = Array.from(convertBits(Array.from(payload), 8, 5, true));
  const checksum = createChecksum(hrp, data);
  return hrp + "1" + data.concat(checksum).map((v) => CHARSET[v]).join("");
}

function readU64LE(bytes, offset) {
  let n = 0n;
  for (let i = 0; i < 8; i++) {
    n |= BigInt(bytes[offset + i]) << BigInt(8 * i);
  }
  return n;
}

function readU32LE(bytes, offset) {
  return (
    bytes[offset] |
    (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) |
    (bytes[offset + 3] << 24)
  ) >>> 0;
}

function writeU64LE(bytes, offset, value) {
  let tmp = value;
  for (let i = 0; i < 8; i++) {
    bytes[offset + i] = Number(tmp & 0xffn);
    tmp >>= 8n;
  }
}

function writeU32LE(bytes, offset, value) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}

function decodeQuotas(payload, offset) {
  const word = readU32LE(payload, offset);
  const rateExp = word & 0x1f;
  const latencyExp = (word >>> 5) & 0x1f;
  const labelsExp = (word >>> 10) & 0x1f;
  const bufferExp = (word >>> 15) & 0x0f;
  const dedupUnits = (word >>> 19) & 0xff;
  const windowExp = (word >>> 27) & 0x1f;
  if (rateExp > 24 || latencyExp > 24 || dedupUnits < 1 || dedupUnits > 200) {
    throw new Error("invalid packed quota word");
  }
  return {
    rate_buckets_max: 2 ** rateExp,
    latency_services_max: 2 ** latencyExp,
    metrics_labels_max: 2 ** labelsExp,
    latency_buffer_size_max: 2 ** bufferExp,
    dedup_ttl_ms_max: dedupUnits * 10,
    rate_window_size_ms_max: windowExp === 31 ? 0xffffffff : 2 ** windowExp,
  };
}

function normalizeSecret(authSecret) {
  if (authSecret instanceof Uint8Array) return authSecret;
  if (Array.isArray(authSecret)) return Uint8Array.from(authSecret);
  if (Buffer.isBuffer(authSecret)) return new Uint8Array(authSecret);
  throw new Error("authSecret must be Uint8Array/Buffer/byte array");
}

function encodeQuotas(quotas) {
  if (!quotas || typeof quotas !== "object") {
    throw new Error("quotas are required for API keys");
  }

  function exponent(key, maxExp) {
    const value = quotas[key];
    if (!Number.isInteger(value) || value <= 0 || value > 0xffffffff ||
        Math.log2(value) % 1 !== 0) {
      throw new Error(`${key} must be a power of two`);
    }
    const result = Math.log2(value);
    if (result > maxExp) throw new Error(`${key} is too large`);
    return result;
  }
  const rateExp = exponent("rate_buckets_max", 24);
  const latencyExp = exponent("latency_services_max", 24);
  const labelsExp = exponent("metrics_labels_max", 31);
  const bufferExp = exponent("latency_buffer_size_max", 15);
  const dedup = quotas.dedup_ttl_ms_max;
  if (!Number.isInteger(dedup) || dedup < 10 || dedup > 2000 || dedup % 10 !== 0) {
    throw new Error("dedup_ttl_ms_max must be a multiple of 10 in 10..2000");
  }
  const windowExp = quotas.rate_window_size_ms_max === 0xffffffff
    ? 31 : exponent("rate_window_size_ms_max", 30);
  const word = (rateExp | (latencyExp << 5) | (labelsExp << 10) |
    (bufferExp << 15) | ((dedup / 10) << 19) | (windowExp << 27)) >>> 0;
  const out = new Uint8Array(4);
  writeU32LE(out, 0, word);
  return out;
}

function decodeApiKey(encoded) {
  const { hrp, payload } = bech32Decode(encoded);
  if (!hrp.startsWith("rl-")) throw new Error("invalid hrp prefix (expected rl-*)");

  const authMethod = hrp.slice(3);
  if (!ALLOWED_METHODS.has(authMethod)) {
    throw new Error(`unsupported auth method in hrp: ${authMethod}`);
  }

  if (authMethod === "none") {
    if (payload.length !== 13) throw new Error(`invalid rl-none payload length: expected 13, got ${payload.length}`);
    if (payload[0] !== FORMAT_VERSION) throw new Error(`unsupported format version: ${payload[0]}`);
    return {
      hrp,
      formatVersion: FORMAT_VERSION,
      authMethod,
      keyId: readU64LE(payload, 1),
      authSecret: new Uint8Array(0),
      quotas: decodeQuotas(payload, 9),
    };
  }

  if (payload.length !== 45) {
    throw new Error(`invalid rl-${authMethod} payload length: expected 45, got ${payload.length}`);
  }
  if (payload[0] !== FORMAT_VERSION) throw new Error(`unsupported format version: ${payload[0]}`);

  return {
    hrp,
    formatVersion: FORMAT_VERSION,
    authMethod,
    keyId: readU64LE(payload, 1),
    authSecret: payload.slice(9, 41),
    quotas: decodeQuotas(payload, 41),
  };
}

function encodeApiKey(authMethod, keyId, authSecret = new Uint8Array(0), quotas) {
  if (!ALLOWED_METHODS.has(authMethod)) {
    throw new Error(`unsupported auth method: ${authMethod}`);
  }
  if (typeof keyId !== "bigint") {
    throw new Error("keyId must be a BigInt");
  }
  if (keyId < 0n || keyId > 0xffffffffffffffffn) {
    throw new Error("keyId must fit in u64");
  }

  const secret = normalizeSecret(authSecret);
  const quotaBytes = encodeQuotas(quotas);
  let payload;

  if (authMethod === "none") {
    if (secret.length !== 0) throw new Error("rl-none payload must not contain authSecret");
    payload = new Uint8Array(13);
    payload.set(quotaBytes, 9);
  } else {
    if (secret.length !== 32) {
      throw new Error(`rl-${authMethod} payload must contain a 32-byte secret`);
    }
    payload = new Uint8Array(45);
    payload.set(secret, 9);
    payload.set(quotaBytes, 41);
  }

  payload[0] = FORMAT_VERSION;
  writeU64LE(payload, 1, keyId);

  return bech32Encode(`rl-${authMethod}`, payload);
}

function bytesToHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

module.exports = { decodeApiKey, encodeApiKey, bytesToHex };

if (require.main === module) {
  const sampleQuotas = {
    rate_buckets_max: 65536,
    latency_services_max: 1024,
    metrics_labels_max: 4096,
    latency_buffer_size_max: 32,
    dedup_ttl_ms_max: 300,
    rate_window_size_ms_max: 0xffffffff,
  };
  const sample = encodeApiKey("aes", 123n, new Uint8Array(32).fill(1), sampleQuotas);
  const decoded = decodeApiKey(sample);
  const reencoded = encodeApiKey(decoded.authMethod, decoded.keyId, decoded.authSecret, decoded.quotas || sampleQuotas);
  console.log({
    ...decoded,
    keyId: decoded.keyId.toString(),
    authSecretHex: bytesToHex(decoded.authSecret),
    roundtrip: reencoded === sample,
  });
}
