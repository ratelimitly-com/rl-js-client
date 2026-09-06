#!/usr/bin/env node
'use strict';

const assert = require('assert');
const dgram = require('dgram');
const {
  AuthMethod,
  CanonicalIds,
  RClient,
  RClientConfig,
  RateLimitError,
  RequestPolicy,
  ResourceRequest,
  TenantConfig
} = require('./client');
const { encodeApiKey } = require('./api_key_codec');

const quotas = {
  rate_buckets_max: 65536,
  latency_services_max: 1024,
  metrics_labels_max: 4096,
  latency_buffer_size_max: 32,
  dedup_ttl_ms_max: 2000,
  rate_window_size_ms_max: 0xffffffff,
};
const testKey = encodeApiKey('none', 1n, new Uint8Array(0), quotas);

function buildResponse(request, serverId, keepPort, resource) {
  const packet = Buffer.alloc(40 + 4 + 8 + 4 + 28);
  let pos = 0;
  packet.writeUInt16LE(0x4c52, pos); pos += 2;
  packet.writeUInt16LE(40, pos); pos += 2;
  packet.writeBigUInt64LE(BigInt(serverId), pos); pos += 8;
  request.subarray(12, 28).copy(packet, pos); pos += 16;
  packet.writeBigUInt64LE(BigInt(Date.now()), pos); pos += 8;
  packet.writeUInt8(keepPort ? 1 : 0, pos++); // steering_feedback
  packet.writeUInt8(0, pos++);
  packet.writeUInt16LE(0, pos); pos += 2;
  packet.writeUInt16LE(0x414e, pos); pos += 2;
  packet.writeUInt16LE(4, pos); pos += 2;
  packet.writeUInt16LE(0x5252, pos); pos += 2;
  packet.writeUInt16LE(40, pos); pos += 2;
  packet.writeUInt32LE(0, pos); pos += 4;
  packet.writeUInt16LE(0, pos); pos += 2;
  packet.writeUInt16LE(1, pos); pos += 2;
  CanonicalIds.bucketId(resource.bucketName, resource.windowSizeMs, resource.rateLimit).copy(packet, pos);
  pos += 16;
  packet.writeUInt32LE(resource.windowSizeMs, pos); pos += 4;
  packet.writeUInt32LE(100, pos); pos += 4;
  packet.writeUInt16LE(0, pos); pos += 2; // deficit = 0
  packet.writeUInt16LE(0, pos);
  return packet;
}

async function createMockServer(serverId) {
  const socket = dgram.createSocket('udp4');
  await new Promise((resolve) => socket.bind(0, '127.0.0.1', resolve));
  const receivedRequests = [];

  socket.on('message', (msg, rinfo) => {
    receivedRequests.push({
      port: rinfo.port,
      address: rinfo.address,
      msg
    });
  });

  return {
    socket,
    port: socket.address().port,
    receivedRequests,
    close: () => new Promise((resolve) => socket.close(resolve))
  };
}

function createTestClient(serverPort, serverId, policyOptions = {}) {
  const tenant = new TenantConfig('example.test', 1n, AuthMethod.NONE, testKey, null, true);
  const client = new RClient(new RClientConfig(tenant, {
    requestPolicy: new RequestPolicy({
      unitMs: 50,
      replayCount: 2,
      finalReceiveUnits: 1,
      completionDelivery: false,
      ...policyOptions
    }),
  }));
  client.servers = [
    { ip: '127.0.0.1', port: serverPort, serverId }
  ];
  client.lastDnsRefresh = Date.now();
  return client;
}

async function testDestroyCancelsRetryTimersAndSettlesRequests() {
  console.log('Testing destroy cancels retry timers and settles pending requests...');
  const serverId = 1001;
  const mockServer = await createMockServer(serverId);
  const client = createTestClient(mockServer.port, serverId, { unitMs: 40, replayCount: 3 });
  const resource = new ResourceRequest('test_bucket', 1000, 100, 1);

  let unhandledError = null;
  const errorListener = (err) => { unhandledError = err; };
  process.on('uncaughtException', errorListener);

  try {
    let settled = false;
    let settleError = null;
    const reqPromise = client.checkRateLimit([resource], []).catch((err) => {
      settled = true;
      settleError = err;
      return 'rejected';
    });

    // Wait 10ms for request to send round 0
    await new Promise((r) => setTimeout(r, 10));

    // Destroy the client while round 0 is pending and retry timer is active
    client.destroy();

    // Assert that the pending request settles promptly with a RateLimitError
    const res = await Promise.race([
      reqPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Pending request hung and did not settle promptly after destroy()')), 200))
    ]);
    assert.strictEqual(res, 'rejected', 'Pending request must reject when client is destroyed');
    assert(settleError instanceof RateLimitError || (settleError && settleError.message.includes('destroyed')),
      `Expected destruction error, got: ${settleError ? settleError.message : settleError}`);

    // Wait longer than the retry policy duration (40ms * 3 rounds = 120ms)
    await new Promise((r) => setTimeout(r, 160));

    // Verify no uncaught exceptions occurred during timer ticks
    assert.strictEqual(unhandledError, null, `Uncaught exception fired after destroy: ${unhandledError}`);
  } finally {
    process.removeListener('uncaughtException', errorListener);
    await mockServer.close();
  }
}

async function testSubsequentCallsRejectedAfterDestroy() {
  console.log('Testing subsequent calls rejected after destroy...');
  const serverId = 1002;
  const mockServer = await createMockServer(serverId);
  const client = createTestClient(mockServer.port, serverId);
  const resource = new ResourceRequest('test_bucket', 1000, 100, 1);

  try {
    client.destroy();
    assert.strictEqual(typeof client.isDestroyed === 'function' && client.isDestroyed(), true, 'isDestroyed() should return true');

    // checkRateLimit Promise rejection
    await assert.rejects(
      Promise.race([
        client.checkRateLimit([resource], []),
        new Promise((_, reject) => setTimeout(() => reject(new Error('checkRateLimit hung after destroy()')), 200))
      ]),
      /destroyed/i,
      'checkRateLimit should reject when client is destroyed'
    );

    // checkRateLimit callback rejection
    await Promise.race([
      new Promise((resolve, reject) => {
        client.checkRateLimit([resource], [], (err) => {
          if (err && /destroyed/i.test(err.message)) resolve();
          else reject(new Error(`Expected destroyed error in callback, got: ${err}`));
        });
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('checkRateLimit callback hung after destroy()')), 200))
    ]);

    // reportLatency Promise rejection
    await assert.rejects(
      Promise.race([
        client.reportLatency([]),
        new Promise((_, reject) => setTimeout(() => reject(new Error('reportLatency hung after destroy()')), 200))
      ]),
      /destroyed/i,
      'reportLatency should reject when client is destroyed'
    );
  } finally {
    await mockServer.close();
  }
}

async function testDestroyDuringAsyncBindDoesNotLeakSocket() {
  console.log('Testing destroy during initial async bind does not leak socket...');
  const serverId = 1003;
  const mockServer = await createMockServer(serverId);
  const client = createTestClient(mockServer.port, serverId);
  const resource = new ResourceRequest('test_bucket', 1000, 100, 1);

  try {
    // Start request which initiates async bindNextSteeringSocket
    const reqPromise = client.checkRateLimit([resource], []).catch((e) => e);

    // Synchronously destroy before bindNextSteeringSocket completes
    client.destroy();

    const err = await Promise.race([
      reqPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Request during async bind hung after destroy()')), 200))
    ]);
    assert(err instanceof Error, 'Request should reject');

    // Give time for any background promise continuation to execute
    await new Promise((r) => setTimeout(r, 50));

    // Client transports should remain empty and destroyed
    assert.strictEqual(client._transports.size, 0, 'No transport should be retained after destroy');
    assert.strictEqual(typeof client.isDestroyed === 'function' && client.isDestroyed(), true);
  } finally {
    await mockServer.close();
  }
}

async function testSteeringRebindWithSynchronousCallbackAndLongHorizon() {
  console.log('Testing steering rebind with callback-started request and long horizon...');
  const serverId = 1004;
  const mockServer = await createMockServer(serverId);

  // Set up mock server to reply with steeringFeedback = false for first request,
  // and delay response for second request by 600ms (longer than the old 500ms retirement timer)
  mockServer.socket.on('message', (msg, rinfo) => {
    const resource = new ResourceRequest('test_bucket', 1000, 100, 1);
    if (mockServer.receivedRequests.length === 1) {
      // First request: advise rebind
      const resp = buildResponse(msg, serverId, false, resource);
      mockServer.socket.send(resp, rinfo.port, rinfo.address);
    } else if (mockServer.receivedRequests.length === 2) {
      // Second request: reply after 600ms
      setTimeout(() => {
        try {
          const resp = buildResponse(msg, serverId, true, resource);
          mockServer.socket.send(resp, rinfo.port, rinfo.address);
        } catch (_) {}
      }, 600);
    }
  });

  const client = createTestClient(mockServer.port, serverId, {
    unitMs: 100,
    replayCount: 8, // 900ms horizon
    finalReceiveUnits: 1
  });
  const resource = new ResourceRequest('test_bucket', 1000, 100, 1);

  try {
    let secondRequestCompleted = false;
    let secondRequestError = null;

    // Start request 1
    const res1 = await Promise.race([
      new Promise((resolve, reject) => {
        client.checkRateLimit([resource], [], (err1, decision1) => {
          if (err1) return reject(err1);

          // In the callback of request 1, synchronously start request 2 with long horizon
          client.checkRateLimit([resource], [], (err2, decision2) => {
            secondRequestCompleted = true;
            secondRequestError = err2;
            if (err2) reject(err2);
            else resolve(decision2);
          });
        });
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Steering rebind request timed out or hung')), 2000))
    ]);

    assert.strictEqual(secondRequestCompleted, true, 'Second request must complete successfully');
    assert.strictEqual(secondRequestError, null, 'Second request must not encounter closed socket');
  } finally {
    client.destroy();
    await mockServer.close();
  }
}

async function runAllTests() {
  await testDestroyCancelsRetryTimersAndSettlesRequests();
  await testSubsequentCallsRejectedAfterDestroy();
  await testDestroyDuringAsyncBindDoesNotLeakSocket();
  await testSteeringRebindWithSynchronousCallbackAndLongHorizon();
  console.log('✅ All destroy and lifecycle tests passed!');
}

runAllTests().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
