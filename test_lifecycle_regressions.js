'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const { encodeApiKey } = require('./api_key_codec');

const key = encodeApiKey('none', 1n, new Uint8Array(0), {
  rate_buckets_max: 65536, latency_services_max: 1024, metrics_labels_max: 4096,
  latency_buffer_size_max: 32, dedup_ttl_ms_max: 2000,
  rate_window_size_ms_max: 0xffffffff,
});

class FakeSocket extends EventEmitter {
  constructor() { super(); this.sent = []; this.closed = false; }
  ref() {}
  unref() {}
  close() { this.closed = true; queueMicrotask(() => this.emit('close')); }
  send(packet, port, ip, callback) {
    assert.equal(this.closed, false, 'must not send on a closed socket');
    this.sent.push({ packet, port, ip });
    callback(null);
  }
}

// Control bind completion without adding production test hooks or using DNS.
function fixture() {
  const steering = require('./steering');
  const originalBind = steering.bindNextSteeringSocket;
  const clientPath = require.resolve('./client');
  const originalModule = require.cache[clientPath];
  const binds = [];
  steering.bindNextSteeringSocket = () => new Promise((resolve, reject) => {
    binds.push({ resolve, reject });
  });
  delete require.cache[clientPath];
  let api;
  try { api = require('./client'); } finally {
    steering.bindNextSteeringSocket = originalBind;
    delete require.cache[clientPath];
    if (originalModule) require.cache[clientPath] = originalModule;
  }
  const client = api.createClient(key, 'example.test', {
    requestPolicy: new api.RequestPolicy({ unitMs: 100, replayCount: 1, completionDelivery: true }),
  });
  client.servers = [
    { serverId: 1, ip: '127.0.0.1', port: 10001 },
    { serverId: 2, ip: '127.0.0.1', port: 10002 },
  ];
  client.lastDnsRefresh = Date.now();
  async function completeBind(socket = new FakeSocket()) {
    const pending = binds.shift();
    assert(pending, 'a bind must be pending');
    pending.resolve({ socket, selectedPort: 49152, nextPort: 49153 });
    await new Promise(setImmediate);
    return socket;
  }
  return { api, client, binds, completeBind };
}

function response(request, deficit) {
  const packet = Buffer.from(request);
  packet.writeBigUInt64LE(1n, 4);
  packet.writeUInt8(1, 36);
  packet.writeUInt16LE(0x5252, 44);
  packet.writeUInt16LE(deficit, 80);
  return packet;
}

test('completion delivery replays identical bytes after both grant and denial', async () => {
  for (const deficit of [0, 1]) {
    const { api, client, completeBind } = fixture();
    try {
      const result = client.checkRateLimit([new api.ResourceRequest('bucket', 1000, 100, 1)]);
      const socket = await completeBind();
      assert.equal(socket.sent.length, 2);
      socket.emit('message', response(socket.sent[0].packet, deficit));
      assert.equal((await result).success, deficit === 0);
      assert.equal(socket.sent.length, 3, 'resend once to the unanswered server');
      assert.equal(socket.sent[2].port, 10002);
      assert.deepEqual(socket.sent[2].packet, socket.sent[0].packet);
      assert.equal(client._activeRateRequests.size, 0);
    } finally { client.destroy(); }
  }
});

test('destroy settles a pending initial transport acquisition exactly once', async () => {
  const { client, completeBind } = fixture();
  let calls = 0;
  client._getTransport('udp4', (error) => {
    calls++;
    assert.match(error.message, /destroyed/);
  });
  client.destroy();
  const socket = await completeBind();
  assert.equal(socket.closed, true);
  assert.equal(calls, 1);
  assert.equal(client._transports.size, 0);
});

test('rebind flush permits synchronous follow-up operations on success or failure', async () => {
  for (const fails of [false, true]) {
    const { client, binds, completeBind } = fixture();
    try {
      client._getTransport('udp4', assert.ifError);
      await completeBind();
      client._applySteeringFeedback('udp4');
      let followup = false;
      client._getTransport('udp4', (error) => {
        assert.ifError(error);
        // Empty checks and latency-report callbacks can re-enter synchronously.
        client._getTransport('udp4', (nextError) => {
          assert.ifError(nextError);
          followup = true;
        });
      });
      if (fails) {
        binds.shift().reject(new Error('simulated bind failure'));
        await new Promise(setImmediate);
      } else {
        await completeBind();
      }
      assert.equal(followup, true, 'follow-up acquisition must not be stranded');
      assert.equal(client._transportInitQueue.size, 0);
    } finally { client.destroy(); }
  }
});

test('destroy during replacement bind rejects queued calls and closes late socket', async () => {
  const { client, completeBind } = fixture();
  client._getTransport('udp4', assert.ifError);
  const oldSocket = await completeBind();
  client._applySteeringFeedback('udp4');
  let calls = 0;
  client._getTransport('udp4', (error) => {
    calls++;
    assert.match(error.message, /destroyed/);
  });
  client.destroy();
  const newSocket = await completeBind();
  assert.equal(calls, 1);
  assert(oldSocket.closed && newSocket.closed);
  assert.equal(client._transports.size, 0);
});

test('steering waiting for drain does not strand requests behind another request horizon', async () => {
  const { client, binds, completeBind } = fixture();
  try {
    client._getTransport('udp4', assert.ifError);
    await completeBind();
    const current = client._transports.get('udp4');
    current.inFlightCount++;
    client._applySteeringFeedback('udp4');
    assert.equal(binds.length, 0, 'replacement has not started while old operations drain');
    let acquired = false;
    client._getTransport('udp4', (error, transport) => {
      assert.ifError(error);
      assert.equal(transport, current);
      acquired = true;
    });
    assert.equal(acquired, true, 'a queued old request must not age a fresh packet past its TTL');
  } finally { client.destroy(); }
});

test('synchronous send failure leaves no retry timer armed', async (t) => {
  const { api, client, completeBind } = fixture();
  const socket = new FakeSocket();
  socket.send = () => { throw new Error('send failed synchronously'); };
  const originalTimeout = globalThis.setTimeout;
  let armed = 0;
  t.mock.method(globalThis, 'setTimeout', (...args) => {
    armed++;
    return originalTimeout(...args);
  });
  try {
    const pending = assert.rejects(
      client.checkRateLimit([new api.ResourceRequest('bucket', 1000, 100, 1)]),
      /send failed synchronously/,
    );
    await completeBind(socket);
    await pending;
    assert.equal(armed, 0);
    assert.equal(client._activeRateRequests.size, 0);
  } finally { client.destroy(); }
});

test('late DNS results cannot start more lookups or republish membership after destroy', async () => {
  for (const stage of ['srv', 'address']) {
    const { api, client } = fixture();
    let srvCallback;
    let addressCallback;
    client.servers = [];
    client.lastDnsRefresh = 0;
    client.resolver = {
      resolveSrv: (_, callback) => { srvCallback = callback; },
      resolve4: (_, callback) => { addressCallback = callback; },
    };
    const pending = assert.rejects(
      client.checkRateLimit([new api.ResourceRequest('bucket', 1000, 100, 1)]), /destroyed/,
    );
    const records = [{ name: 's-1.example.test', port: 10001 }];
    if (stage === 'address') srvCallback(null, records);
    client.destroy();
    await pending;
    if (stage === 'address') addressCallback(null, ['127.0.0.1']);
    else srvCallback(null, records);
    if (stage === 'srv') assert.equal(addressCallback, undefined);
    assert.deepEqual(client.servers, []);
    assert.equal(client.lastDnsRefresh, 0);
  }
});
