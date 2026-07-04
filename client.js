#!/usr/bin/env node
/**
 * RateLimitly JavaScript R-Client Implementation
 * A stateful client library for centralized rate limiting and load shedding.
 */

const dgram = require('dgram');
const crypto = require('crypto');
const dns = require('dns');
const { decodeApiKey } = require('./api_key_codec');

// Protocol Constants
const TLV_TENANT = 0x4C52;
const TLV_AUTH_NONE = 0x414E;
const TLV_AUTH_COOKIE = 0x4143;
const TLV_AUTH_AES = 0x4541;
const TLV_METRICS_LABEL = 0x4C4D;
const PDU_RATE_REQUEST = 0x5452;
const PDU_RATE_RESPONSE = 0x5252;
const PDU_LATENCY_REPORT = 0x524C;
const SERVER_ID_EPOCH_S_2025 = 1735689600;
const SERVER_ID_TIME_SHIFT = 23;

const AuthMethod = {
    NONE: 'none',
    COOKIE: 'cookie',
    AES_GCM: 'aes_gcm'
};

class ResourceRequest {
    constructor(bucketId, windowSizeMs, rateLimit, tokensRequested) {
        this.bucketId = bucketId;
        this.windowSizeMs = windowSizeMs;
        this.rateLimit = rateLimit;
        this.tokensRequested = tokensRequested;
    }
}

class LatencyGuard {
    constructor(config) {
        // Validate required parameters
        if (!config) {
            throw new Error('LatencyGuard config object is required');
        }
        
        const required = ['serviceId', 'thresholdMs', 'ttlMs', 'maxSamples', 'bufferSize', 'minSampleThreshold'];
        for (const param of required) {
            if (config[param] === undefined || config[param] === null) {
                throw new Error(`LatencyGuard config.${param} is required`);
            }
        }
        
        this.serviceId = config.serviceId;
        this.thresholdMs = config.thresholdMs;
        this.ttlMs = config.ttlMs;
        this.maxSamples = config.maxSamples;
        this.bufferSize = config.bufferSize;
        this.minSampleThreshold = config.minSampleThreshold;
    }
}

class ServiceLatencyBlock {
    constructor(config) {
        // Validate required parameters
        if (!config) {
            throw new Error('ServiceLatencyBlock config object is required');
        }
        
        const required = ['serviceId', 'observedLatency', 'ttlMs', 'maxSamples', 'bufferSize', 'minSampleThreshold'];
        for (const param of required) {
            if (config[param] === undefined || config[param] === null) {
                throw new Error(`ServiceLatencyBlock config.${param} is required`);
            }
        }
        
        this.serviceId = config.serviceId;
        this.observedLatency = config.observedLatency;
        this.ttlMs = config.ttlMs;
        this.maxSamples = config.maxSamples;
        this.bufferSize = config.bufferSize;
        this.minSampleThreshold = config.minSampleThreshold;
    }
}

class GuardResult {
    constructor(serviceId, thresholdMs, currentLatencyMs, passed) {
        this.serviceId = serviceId;
        this.thresholdMs = thresholdMs;
        this.currentLatencyMs = currentLatencyMs;
        this.passed = passed;
    }
}

class ResourceResult {
    constructor(bucketId, tokensDeficit, actualRate) {
        this.bucketId = bucketId;
        this.tokensDeficit = tokensDeficit;
        this.actualRate = actualRate;
    }
}

class RateLimitResult {
    constructor(success, guardResults, resourceResults, serverId) {
        this.success = success;
        this.guardResults = guardResults;
        this.resourceResults = resourceResults;
        this.serverId = serverId;
    }
}

class TenantConfig {
    constructor(dnsName, keyId, authMethod = AuthMethod.NONE, authSecret = null, servers = null, steeringFeedback = false) {
        this.dnsName = dnsName;
        this.keyId = keyId;
        this.authMethod = authMethod;
        this.authSecret = authSecret; // Bech32 key for cookie/aes auth methods
        this.servers = servers; // [{ip: '127.0.0.1', port: 8080}, ...]
        this.steeringFeedback = steeringFeedback; // boolean: false=change port, true=keep port
    }
}

class RClientConfig {
    constructor(tenant, options = {}) {
        this.tenant = tenant;
        this.timeoutMs = options.timeoutMs || 1000;
        this.retryAttempts = options.retryAttempts || 2;
        this.serverStabilityThresholdMs = options.serverStabilityThresholdMs || 30000;
        this.dnsRefreshIntervalS = options.dnsRefreshIntervalS || 300;
        this.dedupTtlMs = options.dedupTtlMs || 300;
    }
}

class RateLimitError extends Error {
    constructor(message) {
        super(message);
        this.name = 'RateLimitError';
    }
}

class TimeoutError extends RateLimitError {
    constructor(message) {
        super(message);
        this.name = 'TimeoutError';
    }
}

class AuthenticationError extends RateLimitError {
    constructor(message) {
        super(message);
        this.name = 'AuthenticationError';
    }
}

class ProtocolError extends RateLimitError {
    constructor(message) {
        super(message);
        this.name = 'ProtocolError';
    }
}

class WireProtocol {
    static _decodeAuthKey(tenantConfig) {
        if (!tenantConfig || typeof tenantConfig.authSecret !== 'string' || tenantConfig.authSecret.trim().length === 0) {
            throw new AuthenticationError('Missing Bech32 auth key');
        }

        if (tenantConfig._decodedAuth && tenantConfig._decodedAuth.encoded === tenantConfig.authSecret) {
            return tenantConfig._decodedAuth;
        }

        let decoded;
        try {
            decoded = decodeApiKey(tenantConfig.authSecret.trim());
        } catch (error) {
            throw new AuthenticationError(`Invalid Bech32 auth key: ${error.message}`);
        }

        let expectedKeyId;
        try {
            expectedKeyId = BigInt(tenantConfig.keyId);
        } catch (error) {
            throw new AuthenticationError(`Invalid tenant keyId: ${tenantConfig.keyId}`);
        }

        if (decoded.keyId !== expectedKeyId) {
            throw new AuthenticationError(
                `Bech32 key_id mismatch: key has ${decoded.keyId.toString()}, tenant config uses ${expectedKeyId.toString()}`
            );
        }

        const secretBuffer = Buffer.from(decoded.authSecret);
        if ((decoded.authMethod === 'cookie' || decoded.authMethod === 'aes') && secretBuffer.length !== 32) {
            throw new AuthenticationError(
                `Bech32 ${decoded.authMethod} payload must be 32 bytes, got ${secretBuffer.length}`
            );
        }
        if (decoded.authMethod === 'none' && secretBuffer.length !== 0) {
            throw new AuthenticationError('Bech32 none key must not contain auth secret bytes');
        }

        tenantConfig._decodedAuth = {
            encoded: tenantConfig.authSecret,
            authMethod: decoded.authMethod,
            keyId: decoded.keyId,
            authSecret: secretBuffer,
            quotas: decoded.quotas || null
        };
        return tenantConfig._decodedAuth;
    }

    static _expectedDecodedMethod(tenantConfig) {
        switch (tenantConfig.authMethod) {
            case AuthMethod.NONE:
                return 'none';
            case AuthMethod.COOKIE:
                return 'cookie';
            case AuthMethod.AES_GCM:
                return 'aes';
            default:
                throw new AuthenticationError(`Unsupported auth method: ${tenantConfig.authMethod}`);
        }
    }

    static _tenantQuotas(tenantConfig) {
        if (!tenantConfig || typeof tenantConfig.authSecret !== 'string' || tenantConfig.authSecret.trim().length === 0) {
            return null;
        }

        const decoded = this._decodeAuthKey(tenantConfig);
        const expectedMethod = this._expectedDecodedMethod(tenantConfig);
        if (decoded.authMethod !== expectedMethod) {
            throw new AuthenticationError(
                `Auth method mismatch: tenant expects ${expectedMethod}, key is rl-${decoded.authMethod}`
            );
        }
        return decoded.quotas;
    }

    static _latencyBufferSizeMax(tenantConfig) {
        const quotas = this._tenantQuotas(tenantConfig);
        return quotas ? quotas.latency_buffer_size_max : null;
    }

    static _validateLatencyGuards(tenantConfig, guards) {
        const limit = this._latencyBufferSizeMax(tenantConfig);
        if (limit === null || limit === undefined) {
            return;
        }

        for (const guard of guards) {
            if (guard.bufferSize > limit) {
                throw new ProtocolError(
                    `Latency guard '${guard.serviceId}' bufferSize ${guard.bufferSize} exceeds tenant quota latency_buffer_size_max ${limit}`
                );
            }
        }
    }

    static _filterLatencyReports(tenantConfig, reports) {
        const limit = this._latencyBufferSizeMax(tenantConfig);
        if (limit === null || limit === undefined) {
            return reports;
        }
        return reports.filter((report) => report.bufferSize <= limit);
    }

    static _requireDecodedAuth(tenantConfig, expectedMethod) {
        const decoded = this._decodeAuthKey(tenantConfig);
        if (decoded.authMethod !== expectedMethod) {
            throw new AuthenticationError(
                `Auth method mismatch: tenant expects ${expectedMethod}, key is rl-${decoded.authMethod}`
            );
        }
        return decoded;
    }
    
    static _encryptPDU(pduData, aesKey, aadPrefix) {
        const nonce = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, nonce);
        cipher.setAAD(Buffer.concat([aadPrefix, nonce]));
        
        let encrypted = cipher.update(pduData);
        cipher.final();
        const authTag = cipher.getAuthTag();
        
        return { nonce, encrypted, authTag };
    }
    
    static createRateRequest(tenantConfig, resources, guards = [], metricsLabel = null, dedupTtlMs = 300) {
        this._validateLatencyGuards(tenantConfig, guards);
        let effectiveDedupTtlMs = dedupTtlMs >>> 0;
        if (typeof tenantConfig.authSecret === 'string' && tenantConfig.authSecret.trim().length > 0) {
            const decoded = this._decodeAuthKey(tenantConfig);
            if (decoded.quotas && Number.isInteger(decoded.quotas.dedup_ttl_ms_max)) {
                effectiveDedupTtlMs = Math.min(effectiveDedupTtlMs, decoded.quotas.dedup_ttl_ms_max >>> 0);
            }
        }

        const buffer = Buffer.alloc(1200);
        let pos = 0;
        
        // Generate unique request ID
        const uniqueId = crypto.randomBytes(16);
        const timestamp = BigInt(Date.now());
        
        // Tenant header
        buffer.writeUInt16LE(TLV_TENANT, pos); pos += 2;
        buffer.writeUInt16LE(40, pos); pos += 2;  // Total TLV size including header
        buffer.writeBigUInt64LE(BigInt(tenantConfig.keyId), pos); pos += 8;
        uniqueId.copy(buffer, pos); pos += 16;
        buffer.writeBigUInt64LE(timestamp, pos); pos += 8;
        buffer.writeUInt8(tenantConfig.steeringFeedback ? 1 : 0, pos); pos += 1;  // steering_feedback (boolean: 0=change port, 1=keep port)
        buffer.writeUInt8(0, pos); pos += 1;  // tenant_mgmt_flag (0 = regular operation, 1 = admin) - client never sends admin messages
        buffer.writeUInt8(0, pos); pos += 1;  // padding byte 1
        buffer.writeUInt8(0, pos); pos += 1;  // padding byte 2
        
        // Build PDU first for AES encryption - correct structure per spec
        let metricsLabelBytes = null;
        let metricsLabelTlvSize = 0;
        if (metricsLabel) {
            metricsLabelBytes = Buffer.from(metricsLabel, 'utf-8');
            const bodySize = 2 + metricsLabelBytes.length; // str_length + label data
            const paddedBodySize = Math.ceil(bodySize / 4) * 4; // Round up to 4-byte boundary
            metricsLabelTlvSize = 4 + paddedBodySize; // TLV header + padded body
        }
        
        const pduBodySize = 4 + guards.length * 40 + resources.length * 28 + metricsLabelTlvSize; // guard_count + resource_count + blocks + optional TLVs
        const pduSize = 8 + pduBodySize; // PDU header (8 bytes) + body
        const pduBuffer = Buffer.alloc(pduSize);
        let pduPos = 0;
        
        // PDU header
        pduBuffer.writeUInt16LE(PDU_RATE_REQUEST, pduPos); pduPos += 2;
        pduBuffer.writeUInt16LE(pduSize, pduPos); pduPos += 2;
        pduBuffer.writeUInt32LE(effectiveDedupTtlMs, pduPos); pduPos += 4;
        
        // Rate request data (counts only - unique_id/time_stamp are in Tenant Header)
        pduBuffer.writeUInt16LE(guards.length, pduPos); pduPos += 2;
        pduBuffer.writeUInt16LE(resources.length, pduPos); pduPos += 2;
        
        // Guards
        for (const guard of guards) {
            const serviceId = Buffer.from(guard.serviceId).subarray(0, 16);
            serviceId.copy(pduBuffer, pduPos);
            pduBuffer.fill(0, pduPos + serviceId.length, pduPos + 16); pduPos += 16;
            pduBuffer.writeUInt32LE(guard.ttlMs, pduPos); pduPos += 4;
            pduBuffer.writeUInt32LE(guard.maxSamples, pduPos); pduPos += 4;
            pduBuffer.writeUInt32LE(guard.bufferSize, pduPos); pduPos += 4;
            pduBuffer.writeUInt32LE(guard.minSampleThreshold, pduPos); pduPos += 4;
            pduBuffer.writeUInt32LE(Math.floor(guard.thresholdMs), pduPos); pduPos += 4;
            pduBuffer.writeUInt32LE(0, pduPos); pduPos += 4; // current_latency
        }
        
        // Resources
        for (const resource of resources) {
            const bucketId = Buffer.from(resource.bucketId).subarray(0, 16);
            bucketId.copy(pduBuffer, pduPos);
            pduBuffer.fill(0, pduPos + bucketId.length, pduPos + 16); pduPos += 16;
            pduBuffer.writeUInt32LE(resource.windowSizeMs, pduPos); pduPos += 4;
            pduBuffer.writeUInt32LE(resource.rateLimit, pduPos); pduPos += 4;
            pduBuffer.writeUInt16LE(resource.tokensRequested, pduPos); pduPos += 2;
            pduBuffer.writeUInt16LE(0, pduPos); pduPos += 2; // padding for alignment
        }
        
        // Optional TLV parameters
        if (metricsLabel) {
            const bodySize = 2 + metricsLabelBytes.length;
            const paddedBodySize = Math.ceil(bodySize / 4) * 4;
            pduBuffer.writeUInt16LE(TLV_METRICS_LABEL, pduPos); pduPos += 2;
            pduBuffer.writeUInt16LE(4 + paddedBodySize, pduPos); pduPos += 2; // TLV size including header
            pduBuffer.writeUInt16LE(metricsLabelBytes.length, pduPos); pduPos += 2; // str_length
            metricsLabelBytes.copy(pduBuffer, pduPos); pduPos += metricsLabelBytes.length;
            // Add padding to 4-byte boundary
            const paddingBytes = paddedBodySize - bodySize;
            pduBuffer.fill(0, pduPos, pduPos + paddingBytes); pduPos += paddingBytes;
        }
        
        // Auth header
        if (tenantConfig.authMethod === AuthMethod.NONE) {
            buffer.writeUInt16LE(TLV_AUTH_NONE, pos); pos += 2;
            buffer.writeUInt16LE(4, pos); pos += 2; // TLV size (header only)
            // Copy PDU directly
            pduBuffer.subarray(0, pduPos).copy(buffer, pos);
            pos += pduPos;
        } else if (tenantConfig.authMethod === AuthMethod.COOKIE) {
            const decoded = this._requireDecodedAuth(tenantConfig, 'cookie');
            buffer.writeUInt16LE(TLV_AUTH_COOKIE, pos); pos += 2;
            buffer.writeUInt16LE(36, pos); pos += 2;  // Total TLV size including header (32 bytes cookie + 4 bytes header)
            decoded.authSecret.copy(buffer, pos); pos += 32;
            // Copy PDU directly
            pduBuffer.subarray(0, pduPos).copy(buffer, pos);
            pos += pduPos;
        } else if (tenantConfig.authMethod === AuthMethod.AES_GCM) {
            const decoded = this._requireDecodedAuth(tenantConfig, 'aes');
            const aesKey = decoded.authSecret;
            buffer.writeUInt16LE(TLV_AUTH_AES, pos); pos += 2;
            buffer.writeUInt16LE(32, pos); pos += 2;  // Total TLV size including header
            const { nonce, encrypted, authTag } = this._encryptPDU(
                pduBuffer.subarray(0, pduPos),
                aesKey,
                buffer.subarray(0, pos)
            );
            nonce.copy(buffer, pos); pos += 12;
            authTag.copy(buffer, pos); pos += 16;
            encrypted.copy(buffer, pos); pos += encrypted.length;
        }
        
        return buffer.subarray(0, pos);
    }
    
    static createLatencyReport(tenantConfig, serviceLatencyBlocks) {
        const filteredBlocks = this._filterLatencyReports(tenantConfig, serviceLatencyBlocks);
        if (filteredBlocks.length === 0) {
            return null;
        }

        const buffer = Buffer.alloc(1200);
        let pos = 0;
        
        // Generate unique request ID
        const uniqueId = crypto.randomBytes(16);
        const timestamp = BigInt(Date.now());
        
        // Tenant header
        buffer.writeUInt16LE(TLV_TENANT, pos); pos += 2;
        buffer.writeUInt16LE(40, pos); pos += 2;  // Total TLV size including header
        buffer.writeBigUInt64LE(BigInt(tenantConfig.keyId), pos); pos += 8;
        uniqueId.copy(buffer, pos); pos += 16;
        buffer.writeBigUInt64LE(timestamp, pos); pos += 8;
        buffer.writeUInt8(tenantConfig.steeringFeedback ? 1 : 0, pos); pos += 1;  // steering_feedback (boolean: 0=change port, 1=keep port)
        buffer.writeUInt8(0, pos); pos += 1;  // tenant_mgmt_flag (0 = regular operation, 1 = admin) - client never sends admin messages
        buffer.writeUInt8(0, pos); pos += 1;  // padding byte 1
        buffer.writeUInt8(0, pos); pos += 1;  // padding byte 2
        
        // Build PDU first
        const pduSize = 12 + filteredBlocks.length * 40; // PDU header + service blocks (40 bytes each)
        const pduBuffer = Buffer.alloc(pduSize);
        let pduPos = 0;
        
        // PDU header
        pduBuffer.writeUInt16LE(PDU_LATENCY_REPORT, pduPos); pduPos += 2;
        pduBuffer.writeUInt16LE(pduSize, pduPos); pduPos += 2;
        pduBuffer.writeUInt32LE(0, pduPos); pduPos += 4; // reserved
        
        // Latency report counts
        pduBuffer.writeUInt16LE(filteredBlocks.length, pduPos); pduPos += 2; // service_count
        pduBuffer.writeUInt16LE(0, pduPos); pduPos += 2; // padding
        
        // Service Latency Blocks (40 bytes each)
        for (const block of filteredBlocks) {
            const serviceIdBytes = Buffer.from(block.serviceId).subarray(0, 16);
            serviceIdBytes.copy(pduBuffer, pduPos);
            pduBuffer.fill(0, pduPos + serviceIdBytes.length, pduPos + 16); pduPos += 16;
            pduBuffer.writeUInt32LE(block.ttlMs, pduPos); pduPos += 4;
            pduBuffer.writeUInt32LE(block.maxSamples, pduPos); pduPos += 4;
            pduBuffer.writeUInt32LE(block.bufferSize, pduPos); pduPos += 4;
            pduBuffer.writeUInt32LE(block.minSampleThreshold, pduPos); pduPos += 4;
            pduBuffer.writeUInt32LE(Math.floor(block.observedLatency), pduPos); pduPos += 4;
            pduBuffer.writeUInt32LE(0, pduPos); pduPos += 4; // padding (4 bytes) to match GuardBlock size
        }
        
        const pduData = pduBuffer.subarray(0, pduPos);
        
        // Auth header based on tenant config
        if (tenantConfig.authMethod === AuthMethod.NONE) {
            buffer.writeUInt16LE(TLV_AUTH_NONE, pos); pos += 2;
            buffer.writeUInt16LE(4, pos); pos += 2;
            pduData.copy(buffer, pos); pos += pduData.length;
        } else if (tenantConfig.authMethod === AuthMethod.COOKIE) {
            const decoded = this._requireDecodedAuth(tenantConfig, 'cookie');
            buffer.writeUInt16LE(TLV_AUTH_COOKIE, pos); pos += 2;
            buffer.writeUInt16LE(36, pos); pos += 2;  // Total TLV size including header
            decoded.authSecret.copy(buffer, pos); pos += 32;
            pduData.copy(buffer, pos); pos += pduData.length;
        } else if (tenantConfig.authMethod === AuthMethod.AES_GCM) {
            const decoded = this._requireDecodedAuth(tenantConfig, 'aes');
            const aesKey = decoded.authSecret;
            buffer.writeUInt16LE(TLV_AUTH_AES, pos); pos += 2;
            buffer.writeUInt16LE(32, pos); pos += 2;  // Total TLV size including header
            const { nonce, encrypted, authTag } = this._encryptPDU(
                pduData,
                aesKey,
                buffer.subarray(0, pos)
            );
            nonce.copy(buffer, pos); pos += 12;
            authTag.copy(buffer, pos); pos += 16;
            encrypted.copy(buffer, pos); pos += encrypted.length;
        }
        
        return buffer.subarray(0, pos);
    }
    
    static _decryptPDU(encryptedData, nonce, authTag, aesKey, aad) {
        const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, nonce);
        decipher.setAAD(aad);
        decipher.setAuthTag(authTag);
        
        let decrypted = decipher.update(encryptedData);
        decipher.final();
        
        console.log(`Decrypted PDU: ${decrypted.toString('hex')}`);
        return decrypted;
    }
    
    static parseRateResponse(data, tenantConfig = null) {
        let pos = 0;
        
        // Parse tenant header
        const tlvType = data.readUInt16LE(pos); pos += 2;
        const tlvSize = data.readUInt16LE(pos); pos += 2;
        if (tlvType !== TLV_TENANT) {
            throw new ProtocolError(`Invalid tenant TLV: ${tlvType.toString(16)}`);
        }
        
        const serverId = Number(data.readBigUInt64LE(pos)); pos += 8;
        pos += 16; // unique_id
        pos += 8;  // timestamp
        pos += 1;  // steering_feedback
        pos += 1;  // tenant_mgmt_flag
        pos += 2;  // padding
        
        // Parse auth header
        const authStart = pos;
        const authType = data.readUInt16LE(pos); pos += 2;
        const authSize = data.readUInt16LE(pos); pos += 2;
        
        let pduData;
        if (authType === TLV_AUTH_NONE) {
            if (authSize !== 4) {
                throw new ProtocolError(`Invalid AUTH_NONE size: ${authSize}`);
            }
            // AUTH_NONE has header only (size=4), no additional data to skip
            pduData = data.subarray(pos);
        } else if (authType === TLV_AUTH_COOKIE) {
            if (authSize !== 36) {
                throw new ProtocolError(`Invalid AUTH_COOKIE size: ${authSize}`);
            }
            const cookie = data.subarray(pos, pos + 32);
            pos += 32; // Skip cookie
            if (tenantConfig && tenantConfig.authMethod === AuthMethod.COOKIE) {
                const decoded = this._requireDecodedAuth(tenantConfig, 'cookie');
                if (!cookie.equals(decoded.authSecret)) {
                    throw new AuthenticationError('Cookie auth mismatch in response');
                }
            }
            pduData = data.subarray(pos);
        } else if (authType === TLV_AUTH_AES) {
            if (authSize !== 32) {
                throw new ProtocolError(`Invalid AUTH_AES size: ${authSize}`);
            }
            if (!tenantConfig) {
                throw new AuthenticationError('AES key required for encrypted response');
            }
            const decoded = this._requireDecodedAuth(tenantConfig, 'aes');
            
            const nonce = data.subarray(pos, pos + 12); pos += 12;
            const aad = data.subarray(0, authStart + 4 + 12);
            const authTag = data.subarray(pos, pos + 16); pos += 16;
            const encryptedData = data.subarray(pos);
            
            const aesKey = decoded.authSecret;
            pduData = this._decryptPDU(encryptedData, nonce, authTag, aesKey, aad);
        } else {
            throw new ProtocolError(`Unknown auth type: ${authType.toString(16)}`);
        }
        
        // Parse PDU
        pos = 0;
        const pduType = pduData.readUInt16LE(pos); pos += 2;
        const pduSize = pduData.readUInt16LE(pos); pos += 2;
        if (pduType !== PDU_RATE_RESPONSE) {
            throw new ProtocolError(`Expected rate response, got: ${pduType.toString(16)}`);
        }
        
        pos += 4; // reserved
        
        // Parse guard and resource counts (no unique_id/timestamp in PDU)
        const guardCount = pduData.readUInt16LE(pos); pos += 2;
        const resourceCount = pduData.readUInt16LE(pos); pos += 2;
        const guardResults = [];
        
        for (let i = 0; i < guardCount; i++) {
            const serviceIdBytes = pduData.subarray(pos, pos + 16); pos += 16;
            const ttlMs = pduData.readUInt32LE(pos); pos += 4;
            const maxSamples = pduData.readUInt32LE(pos); pos += 4;
            const bufferSize = pduData.readUInt32LE(pos); pos += 4;
            const minSampleThreshold = pduData.readUInt32LE(pos); pos += 4;
            const thresholdMs = pduData.readUInt32LE(pos); pos += 4;
            const currentLatencyMs = pduData.readUInt32LE(pos); pos += 4;
            
            const serviceId = serviceIdBytes.toString().replace(/\0+$/, '');
            const passed = currentLatencyMs <= thresholdMs;
            
            guardResults.push(new GuardResult(serviceId, thresholdMs, currentLatencyMs, passed));
        }
        
        // Parse resources
        const resourceResults = [];
        
        for (let i = 0; i < resourceCount; i++) {
            const bucketIdBytes = pduData.subarray(pos, pos + 16); pos += 16;
            const windowMs = pduData.readUInt32LE(pos); pos += 4;
            const actualRate = pduData.readUInt32LE(pos); pos += 4;
            const tokensDeficit = pduData.readUInt16LE(pos); pos += 2;
            const padding = pduData.readUInt16LE(pos); pos += 2; // skip alignment padding
            
            const bucketId = bucketIdBytes.toString().replace(/\0+$/, '');
            
            resourceResults.push(new ResourceResult(bucketId, tokensDeficit, actualRate));
        }
        
        return { serverId, guardResults, resourceResults };
    }
}

class ServerTracker {
    constructor(stabilityThresholdMs = 30000) {
        this.stabilityThresholdMs = stabilityThresholdMs;
        this.servers = new Map();
    }
    
    recordResponse(serverId, responseTimeMs) {
        const now = Date.now();
        
        if (!this.servers.has(serverId)) {
            this.servers.set(serverId, {
                firstSeen: now,
                lastSeen: now,
                responseCount: 0,
                stable: false
            });
        }
        
        const server = this.servers.get(serverId);
        server.lastSeen = now;
        server.responseCount++;
        
        // Mark as stable based on the server's encoded startup time.
        const ageMs = now - RClient.serverStartMsFromId(serverId);
        server.stable = ageMs >= this.stabilityThresholdMs;
    }
    
    isServerStable(serverId) {
        const server = this.servers.get(serverId);
        return server ? server.stable : false;
    }
    
    getStableServers() {
        return Array.from(this.servers.entries())
            .filter(([_, info]) => info.stable)
            .map(([id, _]) => id);
    }
}

class RClient {
    static serverStartSecondsFromId(serverId) {
        return SERVER_ID_EPOCH_S_2025 + Math.floor(serverId / (2 ** SERVER_ID_TIME_SHIFT));
    }

    static serverStartMsFromId(serverId) {
        return RClient.serverStartSecondsFromId(serverId) * 1000;
    }

    constructor(config) {
        this.config = config;
        this.serverTracker = new ServerTracker(config.serverStabilityThresholdMs);
        this.servers = [];
        this.lastDnsRefresh = 0;
        this.resolver = this._buildResolver();
        this.dnsResolverHintShown = false;
    }

    _buildResolver() {
        const dnsServer = process.env.RCLIENT_DNS_SERVER;
        if (!dnsServer || dnsServer.trim().length === 0) {
            return dns;
        }

        const resolver = new dns.Resolver();
        try {
            resolver.setServers([dnsServer.trim()]);
        } catch (error) {
            throw new RateLimitError(`Invalid RCLIENT_DNS_SERVER: ${dnsServer}`);
        }
        return resolver;
    }

    _parseServerIdFromTarget(target) {
        if (typeof target !== 'string') {
            return null;
        }
        const label = target.split('.')[0];
        if (!label.startsWith('s-') || label.length <= 2) {
            return null;
        }
        const digits = label.slice(2);
        if (!/^\d+$/.test(digits)) {
            return null;
        }
        const serverId = Number(digits);
        return Number.isSafeInteger(serverId) ? serverId : null;
    }

    _extractResponseServerId(response) {
        if (!Buffer.isBuffer(response) || response.length < 12) {
            return null;
        }
        if (response.readUInt16LE(0) !== TLV_TENANT) {
            return null;
        }
        const tlvSize = response.readUInt16LE(2);
        if (tlvSize < 40 || response.length < tlvSize) {
            return null;
        }
        const serverId = Number(response.readBigUInt64LE(4));
        return Number.isSafeInteger(serverId) ? serverId : null;
    }
    
    _refreshServers(callback) {
        if (!callback) {
            callback = () => {}; // No-op callback
        }

        if (this.config.tenant.servers && this.config.tenant.servers.length > 0) {
            callback(new RateLimitError('Explicit server lists are not supported; use SRV discovery'));
            return;
        }

        if (/^(\d{1,3}\.){3}\d{1,3}$/.test(this.config.tenant.dnsName)) {
            callback(new RateLimitError('Direct IP targets are not supported; use an SRV domain'));
            return;
        }

        const srvName = `_ratelimitly._udp.${this.config.tenant.dnsName}`;
        console.log(`Trying SRV lookup: ${srvName}`);
        this.resolver.resolveSrv(srvName, (srvError, srvRecords) => {
            console.log(`SRV lookup result - Error: ${srvError}, Records: ${JSON.stringify(srvRecords)}`);
            if (!srvError && srvRecords && srvRecords.length > 0) {
                const servers = [];
                const candidates = srvRecords
                    .map((srv) => ({
                        srv,
                        serverId: this._parseServerIdFromTarget(srv.name),
                    }))
                    .filter((candidate) => candidate.serverId !== null);

                if (candidates.length === 0) {
                    callback(new RateLimitError(`No valid SRV targets found for ${srvName}`));
                    return;
                }

                let pending = candidates.length;
                for (const candidate of candidates) {
                    this.resolver.resolve4(candidate.srv.name, (ipError, addresses) => {
                        if (!ipError && addresses) {
                            for (const ip of addresses) {
                                servers.push({ ip, port: candidate.srv.port, serverId: candidate.serverId });
                            }
                        }

                        pending--;
                        if (pending === 0) {
                            if (servers.length === 0) {
                                callback(new RateLimitError(`No valid SRV targets found for ${srvName}`));
                                return;
                            }
                            servers.sort((a, b) => {
                                const aStart = RClient.serverStartSecondsFromId(a.serverId);
                                const bStart = RClient.serverStartSecondsFromId(b.serverId);
                                if (aStart !== bStart) {
                                    return aStart - bStart;
                                }
                                return a.serverId - b.serverId;
                            });
                            this.servers = servers;
                            this.lastDnsRefresh = Date.now();
                            console.log(`Refreshed servers via SRV: ${servers.map(s => `${s.ip}:${s.port} (server_id=${s.serverId})`).join(', ')}`);
                            callback(null);
                        }
                    });
                }
                return;
            }

            if (srvError && !process.env.RCLIENT_DNS_SERVER && !this.dnsResolverHintShown) {
                this.dnsResolverHintShown = true;
                console.log('Notice: set `RCLIENT_DNS_SERVER=127.0.0.1[:port]` to use a local DNS resolver.');
            }
            callback(new RateLimitError(`SRV lookup failed for ${srvName}: ${srvError ? srvError.message : 'no records'}`));
        });
    }
    
    _shouldRefreshDns() {
        return (Date.now() - this.lastDnsRefresh) > (this.config.dnsRefreshIntervalS * 1000);
    }
    
    _sendRequest(packet, expectResponse, callback) {
        if (!callback) {
            callback = () => {}; // No-op callback
        }
        
        const refreshIfNeeded = (cb) => {
            if (!cb) cb = () => {};
            if (this._shouldRefreshDns()) {
                this._refreshServers(cb);
            } else {
                cb(null);
            }
        };
        
        refreshIfNeeded((error) => {
            if (error) {
                console.warn(`DNS refresh failed: ${error.message}`);
                // Continue with existing servers if any
                if (this.servers.length === 0) {
                    return callback(new RateLimitError('No servers available'));
                }
            }
            
            if (this.servers.length === 0) {
                return callback(new RateLimitError('No servers available'));
            }
            
            const socket = dgram.createSocket('udp4');
            const startTime = Date.now();
            let responseReceived = false;
            let socketClosed = false;
            
            const safeCloseSocket = () => {
                if (!socketClosed) {
                    socketClosed = true;
                    socket.close();
                }
            };
            
            // Set timeout
            const timeout = setTimeout(() => {
                if (!responseReceived) {
                    safeCloseSocket();
                    callback(new TimeoutError('No response received within timeout'));
                }
            }, this.config.timeoutMs);
            
            // Handle responses
            socket.on('message', (response, rinfo) => {
                try {
                    if (response.length >= 16) {
                        const serverId = this._extractResponseServerId(response);
                        if (serverId === null) {
                            return;
                        }
                        const trustedServer = this.servers.find((server) => server.serverId === serverId);
                        if (!trustedServer) {
                            return;
                        }

                        if (responseReceived) return;
                        responseReceived = true;

                        clearTimeout(timeout);
                        safeCloseSocket();

                        const responseTime = Date.now() - startTime;
                        this.serverTracker.recordResponse(serverId, responseTime);

                        callback(null, response);
                    } else {
                        if (!responseReceived) {
                            responseReceived = true;
                            clearTimeout(timeout);
                            safeCloseSocket();
                            callback(new ProtocolError('Invalid response format'));
                        }
                    }
                } catch (error) {
                    if (!responseReceived) {
                        responseReceived = true;
                        clearTimeout(timeout);
                        safeCloseSocket();
                        callback(error);
                    }
                }
            });
            
            socket.on('error', (error) => {
                clearTimeout(timeout);
                callback(error);
            });
            
            // Send to all servers
            for (const server of this.servers) {
                socket.send(packet, server.port, server.ip, (error) => {
                    if (error) {
                        console.warn(`Failed to send to ${server.ip}:${server.port}: ${error.message}`);
                    }
                });
            }
            
            if (!expectResponse) {
                // Give UDP packets time to be sent before closing socket
                setTimeout(() => {
                    clearTimeout(timeout);
                    safeCloseSocket();
                    callback(null, null);
                }, 10); // 10ms delay
            }
        });
    }
    
    checkRateLimit(resources, guards, metricsLabel, callback) {
        // Handle optional parameters
        if (typeof guards === 'string') {
            callback = metricsLabel;
            metricsLabel = guards;
            guards = [];
        } else if (typeof guards === 'function') {
            callback = guards;
            guards = [];
            metricsLabel = null;
        } else if (typeof metricsLabel === 'function') {
            callback = metricsLabel;
            metricsLabel = null;
        }
        
        if (!callback) {
            callback = () => {}; // No-op callback
        }
        
        // Create request packet
        const packet = WireProtocol.createRateRequest(
            this.config.tenant,
            resources,
            guards || [],
            metricsLabel,
            this.config.dedupTtlMs
        );
        
        // Send request and get response
        this._sendRequest(packet, true, (error, response) => {
            if (error) return callback(error);
            
            try {
                // Parse response
                const { serverId, guardResults, resourceResults } = WireProtocol.parseRateResponse(response, this.config.tenant);
                
                // Determine overall success
                const guardsPassed = guardResults.every(g => g.passed);
                const resourcesGranted = resourceResults.every(r => r.tokensDeficit === 0);
                const success = guardsPassed && resourcesGranted;
                
                const result = new RateLimitResult(success, guardResults, resourceResults, serverId);
                callback(null, result);
            } catch (parseError) {
                callback(parseError);
            }
        });
    }
    
    reportLatency(serviceLatencyBlocks, callback) {
        if (!Array.isArray(serviceLatencyBlocks)) {
            throw new Error('serviceLatencyBlocks must be an array of ServiceLatencyBlock instances');
        }
        
        if (!callback) {
            callback = () => {}; // No-op callback
        }
        
        const packet = WireProtocol.createLatencyReport(this.config.tenant, serviceLatencyBlocks);
        if (!packet) {
            callback(null);
            return;
        }
        this._sendRequest(packet, false, (error) => {
            if (error) {
                console.warn(`Failed to report latency: ${error.message}`);
            }
            callback(error);
        });
    }
    
    getServerStats() {
        return {
            servers: this.servers,
            stableServers: this.serverTracker.getStableServers(),
            lastDnsRefresh: this.lastDnsRefresh
        };
    }
}

// Convenience function
function createClient(dnsName, keyId, authMethod = AuthMethod.NONE, authSecret = null, servers = null, steeringFeedback = false) {
    const tenantConfig = new TenantConfig(dnsName, keyId, authMethod, authSecret, servers, steeringFeedback);
    const config = new RClientConfig(tenantConfig);
    return new RClient(config);
}

module.exports = {
    RClient,
    RClientConfig,
    TenantConfig,
    ResourceRequest,
    LatencyGuard,
    ServiceLatencyBlock,
    RateLimitResult,
    GuardResult,
    ResourceResult,
    AuthMethod,
    RateLimitError,
    TimeoutError,
    AuthenticationError,
    ProtocolError,
    WireProtocol,
    ServerTracker,
    createClient
};
