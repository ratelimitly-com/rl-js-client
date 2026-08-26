#!/usr/bin/env node
'use strict';

const assert = require('assert');
const dgram = require('dgram');
const {
  AuthMethod,
  CanonicalIds,
  RClient,
  RClientConfig,
  RequestPolicy,
  ResourceRequest,
  TenantConfig,
  STEERING_PORT_MIN,
  STEERING_PORT_MAX,
  nextSteeringPort
} = require('./client');
const { encodeApiKey } = require('./api_key_codec');

const quotas = {
  rate_buckets_max: 65536,
  latency_services_max: 1024,
  metrics_labels_max: 4096,
  latency_buffer_size_max: 32,
  dedup_ttl_ms_max: 300,
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

async function createMockServer(serverId, responseQueue) {
  const socket = dgram.createSocket('udp4');
  await new Promise((resolve) => socket.bind(0, '127.0.0.1', resolve));
  const receivedRequests = [];

  socket.on('message', (msg, rinfo) => {
    receivedRequests.push({
      port: rinfo.port,
      address: rinfo.address,
      requestId: msg.subarray(12, 28).toString('hex')
    });

    const nextResp = responseQueue.shift() || { delay: 0, keepPort: true };
    setTimeout(() => {
      const resource = new ResourceRequest('test_bucket', 1000, 100, 1);
      const resp = buildResponse(msg, serverId, nextResp.keepPort, resource);
      socket.send(resp, rinfo.port, rinfo.address);
    }, nextResp.delay);
  });

  return {
    socket,
    port: socket.address().port,
    receivedRequests,
    close: () => socket.close()
  };
}

function createTestClient(serverPort, serverId) {
  const tenant = new TenantConfig('example.test', 1n, AuthMethod.NONE, testKey, null, true);
  const client = new RClient(new RClientConfig(tenant, {
    requestPolicy: new RequestPolicy({
      unitMs: 100,
      replayCount: 0,
      finalReceiveUnits: 0,
      completionDelivery: false,
    }),
  }));
  client.servers = [
    { ip: '127.0.0.1', port: serverPort, serverId }
  ];
  client.lastDnsRefresh = Date.now();
  return client;
}

function checkRateLimitAsync(client, resource) {
  return new Promise((resolve, reject) => {
    client.checkRateLimit([resource], [], (error, decision) => {
      if (error) reject(error);
      else resolve(decision);
    });
  });
}

async function testSourcePortPersistenceAndSteering() {
  console.log('Testing source port persistence and steering feedback...');
  const serverId = 1000;
  const mockServer = await createMockServer(serverId, [
    { delay: 5, keepPort: true },   // Request 1: keep port
    { delay: 5, keepPort: false },  // Request 2: advise rebind
    { delay: 5, keepPort: true },   // Request 3: new port should be used
  ]);

  const client = createTestClient(mockServer.port, serverId);
  const resource = new ResourceRequest('test_bucket', 1000, 100, 1);

  try {
    // Request 1
    const res1 = await checkRateLimitAsync(client, resource);
    assert.strictEqual(res1.success, true);
    assert.strictEqual(res1.steeringFeedback, true);

    // Request 2
    const res2 = await checkRateLimitAsync(client, resource);
    assert.strictEqual(res2.success, true);
    assert.strictEqual(res2.steeringFeedback, false);

    // Allow async steering rebind to complete
    await new Promise((r) => setTimeout(r, 50));

    // Request 3
    const res3 = await checkRateLimitAsync(client, resource);
    assert.strictEqual(res3.success, true);
    assert.strictEqual(res3.steeringFeedback, true);

    assert.strictEqual(mockServer.receivedRequests.length, 3);
    const [req1, req2, req3] = mockServer.receivedRequests;

    // Requests 1 and 2 should share the persistent source port
    assert.strictEqual(req1.port, req2.port, 'Request 1 and 2 must use the same persistent source port');
    assert(req1.port >= STEERING_PORT_MIN && req1.port <= STEERING_PORT_MAX);

    // Request 3 must use a different, monotonically advanced port
    assert.notStrictEqual(req3.port, req2.port, 'Request 3 must use a newly steered source port');
    assert.strictEqual(req3.port, nextSteeringPort(req2.port), 'Port must advance monotonically');

    console.log(`✅ Source port persistence and steering verified (ports: ${req1.port} -> ${req3.port})`);
  } finally {
    client.destroy();
    mockServer.close();
  }
}

async function testConcurrentInFlightDrainingBeforeSteering() {
  console.log('Testing concurrent in-flight request draining before steering rebind...');
  const serverId = 2000;
  const CONCURRENT_COUNT = 10;
  const responseQueue = [];

  // 10 concurrent requests, all returning keepPort: false
  for (let i = 0; i < CONCURRENT_COUNT; i++) {
    responseQueue.push({ delay: 5 + i * 2, keepPort: false });
  }
  // Followed by 1 final request
  responseQueue.push({ delay: 5, keepPort: true });

  const mockServer = await createMockServer(serverId, responseQueue);
  const client = createTestClient(mockServer.port, serverId);
  const resource = new ResourceRequest('test_bucket', 1000, 100, 1);

  try {
    const promises = [];
    for (let i = 0; i < CONCURRENT_COUNT; i++) {
      promises.push(checkRateLimitAsync(client, resource));
    }

    const results = await Promise.all(promises);
    for (const res of results) {
      assert.strictEqual(res.success, true);
    }

    // Allow drain and rebind
    await new Promise((r) => setTimeout(r, 50));

    // Next request
    const finalRes = await checkRateLimitAsync(client, resource);
    assert.strictEqual(finalRes.success, true);

    assert.strictEqual(mockServer.receivedRequests.length, CONCURRENT_COUNT + 1);

    // All concurrent requests must have used the exact same initial port
    const initialPort = mockServer.receivedRequests[0].port;
    for (let i = 0; i < CONCURRENT_COUNT; i++) {
      assert.strictEqual(
        mockServer.receivedRequests[i].port,
        initialPort,
        `Concurrent request ${i} must use initial port`
      );
    }

    // Final request must use the rebound port
    const reboundPort = mockServer.receivedRequests[CONCURRENT_COUNT].port;
    assert.strictEqual(reboundPort, nextSteeringPort(initialPort), 'Rebound port must be next port');

    console.log(`✅ Concurrent in-flight draining verified (drained ${CONCURRENT_COUNT} on port ${initialPort}, rebound to ${reboundPort})`);
  } finally {
    client.destroy();
    mockServer.close();
  }
}

async function run() {
  try {
    await testSourcePortPersistenceAndSteering();
    await testConcurrentInFlightDrainingBeforeSteering();
    console.log('🎉 All steering integration tests passed successfully!');
  } catch (err) {
    console.error('❌ Steering integration test failed:', err);
    process.exit(1);
  }
}

run();
