'use strict';

const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const { test } = require('node:test');
const { createClient } = require('./client');
const { encodeApiKey } = require('./api_key_codec');

const key = encodeApiKey('none', 1n, new Uint8Array(0), {
  rate_buckets_max: 65536, latency_services_max: 1024, metrics_labels_max: 4096,
  latency_buffer_size_max: 32, dedup_ttl_ms_max: 2000,
  rate_window_size_ms_max: 0xffffffff,
});

function acquire(client) {
  return new Promise((resolve, reject) => {
    client._getTransport('udp4', (error, transport) => error ? reject(error) : resolve(transport));
  });
}

test('repeated rotations release retired transports and listeners without a fixed sleep', async () => {
  const client = createClient(key, 'example.test');
  try {
    let current = await acquire(client);
    for (let i = 0; i < 32; i++) {
      const previous = current;
      const closed = once(previous.socket, 'close');
      client._applySteeringFeedback('udp4');
      current = await acquire(client);
      assert.notEqual(current, previous);
      await closed;
      assert.equal(previous.retired, true);
      assert.equal(client._retiredTransports.length, 0);
      assert.equal(previous.socket.listenerCount('message'), 0);
      assert.equal(previous.socket.listenerCount('error'), 0);
      assert.equal(previous.inFlight.size, 0);
      assert.equal(previous.drainCallbacks.length, 0);
    }
  } finally { client.destroy(); }
});

test('retirement never closes an acquired transport until it drains', async () => {
  const client = createClient(key, 'example.test');
  try {
    const previous = await acquire(client);
    const closed = once(previous.socket, 'close');
    client._applySteeringFeedback('udp4');
    // Model a reference acquired while the asynchronous bind is in progress.
    previous.inFlightCount++;
    await acquire(client);
    assert.equal(client._retiredTransports.length, 1);
    assert.doesNotThrow(() => previous.socket.address());
    previous.inFlightCount--;
    for (const callback of previous.drainCallbacks.splice(0)) callback();
    await closed;
    assert.equal(client._retiredTransports.length, 0);
    assert.equal(previous.socket.listenerCount('error'), 0);
  } finally { client.destroy(); }
});

test('destroy cleans both active and still-draining retired sockets', async () => {
  const client = createClient(key, 'example.test');
  const previous = await acquire(client);
  const oldClosed = once(previous.socket, 'close');
  client._applySteeringFeedback('udp4');
  previous.inFlightCount++;
  const current = await acquire(client);
  const newClosed = once(current.socket, 'close');
  assert.equal(client._retiredTransports.length, 1);
  client.destroy();
  client.destroy();
  await Promise.all([oldClosed, newClosed]);
  assert.equal(client._retiredTransports.length, 0);
  assert.equal(client._transports.size, 0);
  for (const transport of [previous, current]) {
    assert.equal(transport.socket.listenerCount('message'), 0);
    assert.equal(transport.socket.listenerCount('error'), 0);
    assert.equal(transport.inFlightCount, 0);
    assert.equal(transport.drainCallbacks.length, 0);
  }
});

test('closing sockets retain error protection until close completes', () => {
  const client = createClient(key, 'example.test');
  const socket = new EventEmitter();
  socket.close = () => {}; // Completion is asynchronous; deliver it explicitly below.
  socket.on('message', () => {});
  socket.on('error', () => {});
  client._transports.set('udp4', {
    socket, inFlight: new Map(), inFlightCount: 0, drainCallbacks: [],
  });
  client.destroy();
  try {
    assert.equal(socket.listenerCount('message'), 0);
    assert.doesNotThrow(() => socket.emit('error', new Error('queued I/O error')));
  } finally { socket.emit('close'); }
  assert.equal(socket.listenerCount('error'), 0);
});
