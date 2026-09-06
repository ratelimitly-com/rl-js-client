#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
  AuthMethod,
  RClient,
  RClientConfig,
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

async function testRetiredTransportsCleanedUpAfterRetirement() {
  console.log('Testing retired transports removed and listeners cleaned up after rotation...');
  const tenant = new TenantConfig('test.domain', 1n, AuthMethod.NONE, testKey, null, true);
  const client = new RClient(new RClientConfig(tenant));

  // Initialize transport
  const initialTransport = await new Promise((resolve, reject) => {
    client._getTransport('udp4', (err, t) => {
      if (err) reject(err);
      else resolve(t);
    });
  });

  const retiredSockets = [];

  // Trigger 4 consecutive steering rotations
  for (let i = 0; i < 4; i++) {
    const prevTransport = client._transports.get('udp4');
    retiredSockets.push(prevTransport.socket);

    client._applySteeringFeedback('udp4');

    // Wait for async bindNextSteeringSocket inside _applySteeringFeedback to finish
    await new Promise((r) => setTimeout(r, 20));

    // Verify retired transport was queued for retirement
    assert.strictEqual(
      prevTransport.retired,
      true,
      `Transport in iteration ${i} must be marked retired`
    );
  }

  // Before retirement timer (500ms), _retiredTransports should track the retired transports
  assert.strictEqual(
    client._retiredTransports.length,
    4,
    'All 4 rotated transports should be in _retiredTransports during retirement delay'
  );

  // Wait 550ms for the 500ms retirement timer to expire
  await new Promise((r) => setTimeout(r, 550));

  // After retirement delay, _retiredTransports MUST be empty (no memory leak)
  assert.strictEqual(
    client._retiredTransports.length,
    0,
    `_retiredTransports must be 0 after retirement delay, found ${client._retiredTransports.length}`
  );

  // Sockets must have had their listeners removed
  for (const socket of retiredSockets) {
    assert.strictEqual(
      socket.listenerCount('message'),
      0,
      'Retired socket message listeners must be removed'
    );
    assert.strictEqual(
      socket.listenerCount('error'),
      0,
      'Retired socket error listeners must be removed'
    );
  }

  client.destroy();
  console.log('✅ Retired transport cleanup verified');
}

async function testDestroyCleansOutstandingRetiredTransports() {
  console.log('Testing destroy cleans outstanding retired transports...');
  const tenant = new TenantConfig('test.domain', 1n, AuthMethod.NONE, testKey, null, true);
  const client = new RClient(new RClientConfig(tenant));

  await new Promise((resolve, reject) => {
    client._getTransport('udp4', (err, t) => {
      if (err) reject(err);
      else resolve(t);
    });
  });

  const socket = client._transports.get('udp4').socket;
  client._applySteeringFeedback('udp4');
  await new Promise((r) => setTimeout(r, 20));

  assert.strictEqual(client._retiredTransports.length, 1);

  // Destroy immediately before the 500ms timer expires
  client.destroy();

  assert.strictEqual(
    client._retiredTransports.length,
    0,
    '_retiredTransports must be cleared on destroy'
  );
  assert.strictEqual(
    socket.listenerCount('message'),
    0,
    'Retired socket message listener must be removed on destroy'
  );

  console.log('✅ Destroy cleanup of outstanding retired transports verified');
}

async function runAll() {
  await testRetiredTransportsCleanedUpAfterRetirement();
  await testDestroyCleansOutstandingRetiredTransports();
  console.log('🎉 All steering transport cleanup tests passed!');
}

runAll().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
