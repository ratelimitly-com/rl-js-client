#!/usr/bin/env node
"use strict";

/**
 * Live production protocol smoke test.
 *
 * This is a protocol smoke test, not a load test. It sends a small, bounded
 * number of requests to production and proves two pieces of server state:
 *
 *   1. A distinctive latency sample can be read back from the same tracker.
 *   2. A one-token rate bucket admits once and then rejects the next request.
 *
 * The `production-smoke` job in .github/workflows/ci.yml supplies a per-run
 * namespace so the test never relies on state left by another CI job. The
 * authentication key is read from the environment and is deliberately never
 * copied into diagnostics, and neither is anything derived from it.
 *
 * This file is intentionally NOT part of `npm test`. It needs a real
 * credential and a reachable production cluster, so it must fail loudly rather
 * than skip -- the opposite of the integration sub-tests in test_client.js,
 * which print "Integration test skipped (no server)" and pass.
 *
 * Wait-loop note (see rl-c-client#63). One logical request goes on the wire as
 * several packets -- one per discovered server, replayed `replayCount + 1`
 * times -- and the server's dedup cache answers every copy, so most of the
 * replies for a request are already stale when they land. rl-c-client's probe
 * originally charged every poll wakeup against its retry budget, so the
 * previous request's stale duplicates exhausted the next request's patience and
 * it reported a timeout while the real answer was still in flight. The
 * JavaScript client cannot repeat that, and this file must not reintroduce it:
 * RClient._sendRateRequest advances its rounds from setTimeout deadlines only,
 * receiving a datagram never advances the round counter, each request gets its
 * own UDP socket, and WireProtocol.parseRateResponse drops any response whose
 * request_id does not match the in-flight request.
 */

const {
    HaSchedule,
    LatencyGuard,
    RequestPolicy,
    ResourceRequest,
    ServiceLatencyBlock,
    createClient
} = require("./client");

const MAX_NAMESPACE_LENGTH = 48;
const NAMESPACE_PATTERN = /^[A-Za-z0-9_-]+$/;

const WINDOW_SIZE_MS = 60000;
const LATENCY_PROBE_RATE_LIMIT = 1000;
const RATE_PROBE_RATE_LIMIT = 1;
const LATENCY_THRESHOLD_MS = 1000;
const LATENCY_TTL_MS = 10000;
const REPORTED_LATENCY_MS = 37;
const LATENCY_POLL_ATTEMPTS = 20;
const LATENCY_POLL_DELAY_MS = 150;
const LATENCY_REREPORT_EVERY = 5;
const OVERALL_TIMEOUT_MS = 60000;

// Same request profile rl-c-client applies to its production probe
// (RATELIMITLY_REQUEST_UNIT_MS=25, RATELIMITLY_REQUEST_REPLAY_COUNT=3). This
// client takes it as code rather than from the environment, so the two stay
// comparable only if this block is kept in step with that profile.
const REQUEST_UNIT_MS = 25;
const REQUEST_REPLAY_COUNT = 3;
const REQUEST_FINAL_RECEIVE_UNITS = 1;

// Production discovery must be derived exclusively from the credential.
// The first three are the house-wide names; RCLIENT_DNS_SERVER is this
// client's own discovery override (see RClient._buildResolver in client.js).
const DISCOVERY_OVERRIDES = [
    "RATELIMITLY_TENANT",
    "RATELIMITLY_EXAMPLE_SERVER_HOST",
    "RATELIMITLY_EXAMPLE_SERVER_PORT",
    "RCLIENT_DNS_SERVER"
];

class SmokeFailure extends Error {
    constructor(message, options) {
        super(message, options);
        this.name = "SmokeFailure";
    }
}

// Published for the failure path so a diagnostic can report what discovery saw.
let activeClient = null;

function fail(message) {
    throw new SmokeFailure(message);
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function requestPolicy() {
    return new RequestPolicy({
        unitMs: REQUEST_UNIT_MS,
        replayCount: REQUEST_REPLAY_COUNT,
        replayGap: HaSchedule.fixed(1),
        finalReceiveUnits: REQUEST_FINAL_RECEIVE_UNITS
    });
}

function scopedName(testNamespace, suffix) {
    return `p0-${testNamespace}-${suffix}`;
}

function readNamespace() {
    const testNamespace = process.env.RATELIMITLY_P0_TEST_NAMESPACE;
    if (!testNamespace) {
        fail("RATELIMITLY_P0_TEST_NAMESPACE is required");
    }
    if (testNamespace.length > MAX_NAMESPACE_LENGTH || !NAMESPACE_PATTERN.test(testNamespace)) {
        fail("RATELIMITLY_P0_TEST_NAMESPACE must be 1..48 safe ASCII characters");
    }
    return testNamespace;
}

function readAuthKey() {
    const authKey = process.env.RATELIMITLY_AUTH_KEY;
    if (!authKey || authKey.trim().length === 0) {
        fail("RATELIMITLY_AUTH_KEY is required; this test never skips when it is missing");
    }
    return authKey.trim();
}

function refuseDiscoveryOverrides() {
    for (const variable of DISCOVERY_OVERRIDES) {
        const value = process.env[variable];
        if (value !== undefined && value !== "") {
            fail(`${variable} must not override key-derived production discovery`);
        }
        // Remove even empty values so nothing downstream can observe them.
        delete process.env[variable];
    }
}

/** Latency and rate probes differ only in these fields; see the C reference. */
function latencyProbeShape(testNamespace) {
    return {
        bucketName: scopedName(testNamespace, "latency-bucket"),
        rateLimit: LATENCY_PROBE_RATE_LIMIT,
        latencyTrackerName: scopedName(testNamespace, "latency-service"),
        // One slot makes the real sample replace the speculative admission value.
        maxSamples: 1,
        bufferSize: 1,
        minSampleThreshold: 1,
        metricsLabel: "production-smoke-latency-probe"
    };
}

function rateProbeShape(testNamespace) {
    return {
        bucketName: scopedName(testNamespace, "rate-bucket"),
        rateLimit: RATE_PROBE_RATE_LIMIT,
        latencyTrackerName: scopedName(testNamespace, "rate-service"),
        // Keep two speculative samples below activation so only rate can deny.
        maxSamples: 3,
        bufferSize: 3,
        minSampleThreshold: 3,
        metricsLabel: "production-smoke-rate-probe"
    };
}

function guardFor(shape) {
    return new LatencyGuard({
        latencyTrackerName: shape.latencyTrackerName,
        thresholdMs: LATENCY_THRESHOLD_MS,
        ttlMs: LATENCY_TTL_MS,
        maxSamples: shape.maxSamples,
        bufferSize: shape.bufferSize,
        minSampleThreshold: shape.minSampleThreshold
    });
}

function resourceFor(shape) {
    return new ResourceRequest(shape.bucketName, WINDOW_SIZE_MS, shape.rateLimit, 1);
}

function latencyBlockFor(shape, observedLatency) {
    return new ServiceLatencyBlock({
        latencyTrackerName: shape.latencyTrackerName,
        observedLatency,
        ttlMs: LATENCY_TTL_MS,
        maxSamples: shape.maxSamples,
        bufferSize: shape.bufferSize,
        minSampleThreshold: shape.minSampleThreshold
    });
}

function admit(client, shape) {
    return new Promise((resolve, reject) => {
        client.checkRateLimit(
            [resourceFor(shape)],
            [guardFor(shape)],
            shape.metricsLabel,
            (error, result) => (error ? reject(error) : resolve(result))
        );
    });
}

function reportLatency(client, shape, observedLatency) {
    return new Promise((resolve, reject) => {
        client.reportLatency(
            [latencyBlockFor(shape, observedLatency)],
            (error) => (error ? reject(error) : resolve())
        );
    });
}

/** A response carries exactly one guard and one resource; both must be present. */
function readOutcome(result, phase) {
    const guard = result.guardResults[0];
    const resource = result.resourceResults[0];
    if (!guard || !resource) {
        fail(
            `${phase}: response carried ${result.guardResults.length} guard results and ` +
            `${result.resourceResults.length} resource results, expected one of each`
        );
    }
    return {
        allowed: result.success,
        rateLimited: resource.tokensDeficit > 0,
        tokensDeficit: resource.tokensDeficit,
        actualRate: resource.actualRate,
        latencyLimited: !guard.passed,
        currentLatencyMs: guard.currentLatencyMs
    };
}

function describe(outcome) {
    return `allowed=${outcome.allowed} rate=${outcome.rateLimited} ` +
        `deficit=${outcome.tokensDeficit} latency=${outcome.latencyLimited} ` +
        `current=${outcome.currentLatencyMs}`;
}

async function proveLatencyTracker(client, testNamespace) {
    const shape = latencyProbeShape(testNamespace);

    const initial = readOutcome(await admit(client, shape), "latency tracker proof");
    if (!initial.allowed) {
        fail(`fresh latency admission was denied (${describe(initial)})`);
    }
    await reportLatency(client, shape, REPORTED_LATENCY_MS);

    let last = initial;
    for (let attempt = 0; attempt < LATENCY_POLL_ATTEMPTS; attempt++) {
        // The latency report is a fire-and-forget datagram (RClient.reportLatency
        // sends without expecting a response), so re-send it periodically rather
        // than let a single dropped packet decide the run. Re-reporting the same
        // value into a one-slot buffer is idempotent.
        if (attempt > 0 && attempt % LATENCY_REREPORT_EVERY === 0) {
            await reportLatency(client, shape, REPORTED_LATENCY_MS);
        }

        const outcome = readOutcome(await admit(client, shape), "latency tracker proof");
        if (outcome.allowed && !outcome.latencyLimited &&
            outcome.currentLatencyMs === REPORTED_LATENCY_MS) {
            console.log(
                `latency read-back confirmed after ${attempt + 1} attempt(s): ` +
                `current=${outcome.currentLatencyMs}ms`
            );
            return;
        }
        last = outcome;
        if (attempt + 1 < LATENCY_POLL_ATTEMPTS) {
            await sleep(LATENCY_POLL_DELAY_MS);
        }
    }

    fail(
        `latency read-back expected=${REPORTED_LATENCY_MS} but the tracker never ` +
        `returned it in ${LATENCY_POLL_ATTEMPTS} attempts (${describe(last)})`
    );
}

async function proveRateLimiter(client, testNamespace) {
    const shape = rateProbeShape(testNamespace);

    const first = readOutcome(await admit(client, shape), "rate limiter proof");
    if (!first.allowed) {
        fail(`first rate admission was denied (${describe(first)})`);
    }

    const second = readOutcome(await admit(client, shape), "rate limiter proof");
    if (second.allowed || !second.rateLimited || second.tokensDeficit === 0 ||
        second.latencyLimited) {
        fail(`second rate admission was not a pure rate denial (${describe(second)})`);
    }
    console.log(
        `one-token bucket admitted once then denied: deficit=${second.tokensDeficit} ` +
        `rate=${second.actualRate}`
    );
}

async function run() {
    const testNamespace = readNamespace();
    const authKey = readAuthKey();
    refuseDiscoveryOverrides();

    const policy = requestPolicy();
    let client;
    try {
        // No DNS name: discovery is derived from the credential alone.
        client = createClient(authKey, null, { requestPolicy: policy });
    } catch (error) {
        throw new SmokeFailure(
            `client initialization failed: ${error.message}`,
            { cause: error }
        );
    }
    activeClient = client;
    console.log(
        `namespace=${testNamespace} request horizon=` +
        `${policy.horizonMs(client.quotas.dedup_ttl_ms_max)}ms ` +
        `(unit=${REQUEST_UNIT_MS}ms replay=${REQUEST_REPLAY_COUNT})`
    );

    await proveLatencyTracker(client, testNamespace);
    await proveRateLimiter(client, testNamespace);

    console.log("test_production_smoke: PASS (latency read-back, rate denial)");
}

function diagnose() {
    if (!activeClient) {
        return;
    }
    // Counts only: no address, tenant or key material reaches CI logs.
    const stats = activeClient.getServerStats();
    console.error(
        `test_production_smoke: discovery saw ${stats.servers.length} server endpoint(s), ` +
        `${stats.stableServers.length} stable`
    );
}

function main() {
    const watchdog = setTimeout(() => {
        console.error(
            `test_production_smoke: FAIL: exceeded the ${OVERALL_TIMEOUT_MS}ms overall budget`
        );
        diagnose();
        process.exit(1);
    }, OVERALL_TIMEOUT_MS);

    run()
        .then(() => {
            clearTimeout(watchdog);
        })
        .catch((error) => {
            clearTimeout(watchdog);
            const detail = error instanceof SmokeFailure
                ? error.message
                : `${error.name}: ${error.message}`;
            console.error(`test_production_smoke: FAIL: ${detail}`);
            diagnose();
            process.exitCode = 1;
        });
}

main();
