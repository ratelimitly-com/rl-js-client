export type WindowCap = {kind: 'finite'; milliseconds: number} | {kind: 'unlimited'};

export interface Quotas {
  rate_buckets_max: number;
  latency_services_max: number;
  metrics_labels_max: number;
  latency_buffer_size_max: number;
  dedup_ttl_ms_max: number;
  rate_window_size_ms_max: number;
}

/** Full, version-aware metadata; the legacy Quotas interface stays numeric. */
export type FullQuotas = Omit<Quotas, 'rate_window_size_ms_max'> & {
  rate_window_size_ms_max: number | WindowCap;
};
export type QuotasV2 = Omit<Quotas, 'rate_window_size_ms_max'> & {
  rate_window_size_ms_max: WindowCap;
};

export interface DecodedApiKey {
  hrp: string;
  authMethod: 'none' | 'cookie' | 'aes';
  formatVersion: number;
  keyId: bigint;
  authSecret: Uint8Array;
  quotas: Quotas | null;
}

/**
 * Decodes a RateLimitly Bech32 API key string (e.g. `rl-none...`, `rl-cookie...`, `rl-aes...`).
 *
 * @param addr Bech32 encoded string
 * @returns Decoded API key metadata including keyId and packed quotas
 */
/** Legacy v1-only numeric reader; v2 fails closed with a versioned-reader hint. */
export function decodeApiKey(addr: string): DecodedApiKey;

export type VersionedDecodedApiKey = (DecodedApiKey & {formatVersion: 1}) |
  (Omit<DecodedApiKey, 'formatVersion' | 'quotas'> & {formatVersion: 2; quotas: QuotasV2});

/** Dual reader with truthful discriminated v1 numeric / v2 tagged quotas. */
export function decodeApiKeyVersioned(addr: string): VersionedDecodedApiKey;

/**
 * Encodes key components into a RateLimitly Bech32 API key string.
 *
 * @param authMethod Authentication method ('none' | 'cookie' | 'aes')
 * @param keyId 64-bit unsigned integer key identifier
 * @param authSecret 32-byte secret (or empty for 'none')
 * @param quotas Quota limits to pack into the key
 * @returns Bech32 encoded key string
 */
export function encodeApiKey(
  authMethod: 'none' | 'cookie' | 'aes',
  keyId: bigint,
  authSecret?: Uint8Array | Buffer | string,
  quotas?: Partial<Quotas>,
  formatVersion?: 1
): string;

/** Additive explicit-v2 writer overload; tagged caps cannot use the v1 default. */
export function encodeApiKey(
  authMethod: 'none' | 'cookie' | 'aes',
  keyId: bigint,
  authSecret: Uint8Array | Buffer | string | undefined,
  quotas: Partial<QuotasV2>,
  formatVersion: 2
): string;

/**
 * Converts a byte array to a hex string.
 *
 * @param bytes Input byte array
 * @returns Lowercase hex string
 */
export function bytesToHex(bytes: Uint8Array | Buffer): string;
