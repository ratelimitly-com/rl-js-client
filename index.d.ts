/// <reference types="node" />

import { Buffer } from 'buffer';
import { Socket } from 'dgram';

export type AuthMethodType = 'none' | 'cookie' | 'aes';

export const AuthMethod: {
  readonly NONE: 'none';
  readonly COOKIE: 'cookie';
  readonly AES_GCM: 'aes';
};

export const STEERING_PORT_MIN = 49152;
export const STEERING_PORT_MAX = 65535;
export const STEERING_PORT_COUNT = 16384;

/**
 * Advances monotonically once through the IANA dynamic port range (49152..65535).
 * Wraps to STEERING_PORT_MIN after 65535.
 */
export function nextSteeringPort(port: number): number;

/**
 * Checks if an error indicates an occupied port (EADDRINUSE, EACCES, 10048, 10013).
 */
export function isOccupiedError(err: unknown): boolean;

/**
 * Creates and exclusively binds a UDP socket to a wildcard address on the given port.
 */
export function createBoundUdpSocket(
  family: 'udp4' | 'udp6',
  port: number,
  socketFactory?: (type: 'udp4' | 'udp6') => Socket
): Promise<Socket>;

/**
 * Monotonically scans and binds the first available dynamic port starting at firstPort.
 * Never falls back to port 0.
 */
export function bindNextSteeringSocket(
  family: 'udp4' | 'udp6',
  firstPort?: number,
  socketFactory?: (type: 'udp4' | 'udp6') => Socket
): Promise<{
  socket: Socket;
  selectedPort: number;
  nextPort: number;
}>;

export interface Quotas {
  rate_buckets_max: number;
  latency_services_max: number;
  metrics_labels_max: number;
  latency_buffer_size_max: number;
  dedup_ttl_ms_max: number;
  rate_window_size_ms_max: number;
}

export class ResourceRequest {
  bucketName: string;
  bucketId: string;
  windowSizeMs: number;
  rateLimit: number;
  tokensRequested: number;

  constructor(
    bucketName: string,
    windowSizeMs: number,
    rateLimit: number,
    tokensRequested?: number
  );
}

export interface LatencyGuardOptions {
  latencyTrackerName?: string;
  serviceId?: string;
  thresholdMs: number;
  ttlMs: number;
  maxSamples?: number;
  bufferSize?: number;
  minSampleThreshold?: number;
}

export class LatencyGuard {
  latencyTrackerName: string;
  serviceId: string;
  thresholdMs: number;
  ttlMs: number;
  maxSamples: number;
  bufferSize: number;
  minSampleThreshold: number;

  constructor(config: LatencyGuardOptions);
}

export interface ServiceLatencyBlockOptions {
  latencyTrackerName?: string;
  serviceId?: string;
  observedLatency: number;
  ttlMs: number;
  maxSamples?: number;
  bufferSize?: number;
  minSampleThreshold?: number;
}

export class ServiceLatencyBlock {
  latencyTrackerName: string;
  serviceId: string;
  observedLatency: number;
  ttlMs: number;
  maxSamples: number;
  bufferSize: number;
  minSampleThreshold: number;

  constructor(config: ServiceLatencyBlockOptions);
}

export class ResourceResult {
  bucketName: string;
  bucketId: string;
  tokensDeficit: number;
  actualRate: number;
}

export class GuardResult {
  latencyTrackerName: string;
  serviceId: string;
  thresholdMs: number;
  currentLatencyMs: number;
  passed: boolean;
}

export class RateLimitResult {
  success: boolean;
  resourceResults: ResourceResult[];
  guardResults: GuardResult[];
  serverId: bigint | number | null;
  steeringFeedback: boolean;
  requestId: string | null;
}

export type HaScheduleKind = 'fixed' | 'linear' | 'exponential';

export class HaSchedule {
  readonly kind: HaScheduleKind;
  readonly initialUnits: number;
  readonly maxUnits: number;
  readonly growth: number;

  constructor(
    kind: HaScheduleKind,
    initialUnits: number,
    maxUnits: number,
    growth?: number
  );

  static fixed(units: number): HaSchedule;
  static linear(initialUnits: number, stepUnits: number, maxUnits: number): HaSchedule;
  static exponential(initialUnits: number, factor: number, maxUnits: number): HaSchedule;

  units(round: number): number;
}

export interface RequestPolicyOptions {
  unitMs?: number;
  replayCount?: number;
  replayGap?: HaSchedule;
  finalReceiveUnits?: number;
  completionDelivery?: boolean;
}

export class RequestPolicy {
  unitMs: number;
  replayCount: number;
  replayGap: HaSchedule;
  finalReceiveUnits: number;
  completionDelivery: boolean;

  constructor(options?: RequestPolicyOptions);

  horizonMs(dedupTtlMsMax?: number): number;
}

export interface ServerEndpoint {
  ip: string;
  port: number;
}

export class TenantConfig {
  dnsName: string;
  keyId: bigint | number;
  authMethod: string;
  authSecret: string | Uint8Array | null;
  servers: ServerEndpoint[] | null;
  steeringFeedback: boolean;

  constructor(
    dnsName: string,
    keyId: bigint | number,
    authMethod?: string,
    authSecret?: string | Uint8Array | null,
    servers?: ServerEndpoint[] | null,
    steeringFeedback?: boolean
  );
}

export interface RClientOptions {
  requestPolicy?: RequestPolicy;
  dnsRefreshIntervalS?: number;
  steeringFeedback?: boolean;
}

export class RClientConfig {
  tenant: TenantConfig;
  requestPolicy: RequestPolicy;
  dnsRefreshIntervalS: number;

  constructor(tenant: TenantConfig, options?: RClientOptions);
}

export class CanonicalIds {
  static bucketId(
    name: string | Buffer,
    windowSizeMs: number,
    rateLimit: number
  ): Buffer;

  static latencyTrackerId(
    name: string | Buffer,
    ttlMs: number,
    maxSamples: number,
    bufferSize: number,
    minSampleThreshold: number
  ): Buffer;
}

export class ServerTracker {
  servers: ServerEndpoint[];
  updateServers(newServers: ServerEndpoint[]): void;
  getStableServers(): ServerEndpoint[];
}

export class RClient {
  config: RClientConfig;
  tenantConfig: TenantConfig;
  quotas: Quotas | null;

  constructor(config: RClientConfig);

  checkRateLimit(
    resources: ResourceRequest[],
    guards?: LatencyGuard[] | null,
    metricsLabel?: string | null
  ): Promise<RateLimitResult>;

  checkRateLimit(
    resources: ResourceRequest[],
    callback: (error: Error | null, result?: RateLimitResult) => void
  ): void;

  checkRateLimit(
    resources: ResourceRequest[],
    guards: LatencyGuard[],
    callback: (error: Error | null, result?: RateLimitResult) => void
  ): void;

  checkRateLimit(
    resources: ResourceRequest[],
    guards: LatencyGuard[] | null | undefined,
    metricsLabel: string | null | undefined,
    callback: (error: Error | null, result?: RateLimitResult) => void
  ): void;

  reportLatency(
    serviceLatencyBlocks: ServiceLatencyBlock[]
  ): Promise<void>;

  reportLatency(
    serviceLatencyBlocks: ServiceLatencyBlock[],
    callback: (error: Error | null) => void
  ): void;

  getServerStats(): {
    servers: ServerEndpoint[];
    stableServers: ServerEndpoint[];
    lastDnsRefresh: number;
    steering?: {
      feedbackZeroCount: number;
      portChanges: number;
      lastPort: number | null;
      currentPort: number | null;
      nextPort: number | null;
    };
  };

  destroy(): void;
}

/**
 * Creates an RClient instance from a Bech32 API key string.
 *
 * @param authKey RateLimitly Bech32 API key (rl-none..., rl-cookie..., rl-aes...)
 * @param dnsName Optional explicit DNS discovery name (defaults to c-${keyId}.p0.ratelimitly.com)
 * @param options Optional client configuration (policies, DNS refresh, etc.)
 */
export function createClient(
  authKey: string,
  dnsName?: string | null,
  options?: RClientOptions
): RClient;

export class RateLimitError extends Error {
  readonly code: string;
}

export class TimeoutError extends RateLimitError {}
export class AuthenticationError extends RateLimitError {}
export class ProtocolError extends RateLimitError {}
