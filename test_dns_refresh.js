const assert = require('node:assert/strict');
const test = require('node:test');
const { RClient, RClientConfig, TenantConfig, createClient } = require('./client');
const { encodeApiKey } = require('./api_key_codec');

const SAMPLE_NONE_KEY_TENANT_1 = encodeApiKey('none', 1n, new Uint8Array(0), {
  rate_buckets_max: 65536,
  latency_services_max: 1024,
  metrics_labels_max: 4096,
  latency_buffer_size_max: 64,
  dedup_ttl_ms_max: 300,
  rate_window_size_ms_max: 0xffffffff
});

test('RClientConfig and createClient default dnsRefreshIntervalS to 10 seconds', () => {
  const tenantConfig = new TenantConfig('test.example.com', 1);
  const config = new RClientConfig(tenantConfig);
  assert.equal(config.dnsRefreshIntervalS, 10, 'Default dnsRefreshIntervalS should be 10 seconds');

  const customConfig = new RClientConfig(tenantConfig, { dnsRefreshIntervalS: 60 });
  assert.equal(customConfig.dnsRefreshIntervalS, 60, 'Custom dnsRefreshIntervalS should be preserved');

  const client = createClient(SAMPLE_NONE_KEY_TENANT_1);
  assert.equal(client.config.dnsRefreshIntervalS, 10, 'createClient should default dnsRefreshIntervalS to 10 seconds');

  const customClient = createClient(SAMPLE_NONE_KEY_TENANT_1, null, { dnsRefreshIntervalS: 45 });
  assert.equal(customClient.config.dnsRefreshIntervalS, 45, 'createClient should preserve custom dnsRefreshIntervalS');
});

test('DNS refresh respects address record TTL when shorter than configured interval', async () => {
  const tenantConfig = new TenantConfig('test.example.com', 1);
  const config = new RClientConfig(tenantConfig, { dnsRefreshIntervalS: 10 });
  const client = new RClient(config);

  client.resolver = {
    resolveSrv: (name, cb) => {
      cb(null, [{ name: 's-1.example.com', port: 29292, priority: 10, weight: 10 }]);
    },
    resolve4: (name, options, cb) => {
      const callback = typeof options === 'function' ? options : cb;
      callback(null, [{ address: '127.0.0.1', ttl: 3 }]);
    }
  };

  await new Promise((resolve, reject) => {
    client._refreshServers((err) => (err ? reject(err) : resolve()));
  });

  assert.equal(client._dnsRefreshTtlMs, 3000, '_dnsRefreshTtlMs should be set to 3000ms from address TTL');
  assert.equal(client.servers.length, 1);
  assert.equal(client.servers[0].ip, '127.0.0.1');

  // At elapsed = 2000ms: should NOT refresh yet (3000ms TTL has not passed)
  client.lastDnsRefresh = Date.now() - 2000;
  assert.equal(client._shouldRefreshDns(), false, 'Should not refresh before 3s TTL');

  // At elapsed = 3100ms: should refresh because 3s TTL < 10s default
  client.lastDnsRefresh = Date.now() - 3100;
  assert.equal(client._shouldRefreshDns(), true, 'Should refresh after 3s TTL');
});

test('DNS refresh caps at dnsRefreshIntervalS when address TTL is larger', async () => {
  const tenantConfig = new TenantConfig('test.example.com', 1);
  const config = new RClientConfig(tenantConfig, { dnsRefreshIntervalS: 10 });
  const client = new RClient(config);

  client.resolver = {
    resolveSrv: (name, cb) => {
      cb(null, [{ name: 's-1.example.com', port: 29292, priority: 10, weight: 10 }]);
    },
    resolve4: (name, options, cb) => {
      const callback = typeof options === 'function' ? options : cb;
      callback(null, [{ address: '127.0.0.1', ttl: 60 }]);
    }
  };

  await new Promise((resolve, reject) => {
    client._refreshServers((err) => (err ? reject(err) : resolve()));
  });

  assert.equal(client._dnsRefreshTtlMs, 60000, '_dnsRefreshTtlMs should be set to 60000ms');

  // At elapsed = 9000ms: should NOT refresh yet (10s has not passed)
  client.lastDnsRefresh = Date.now() - 9000;
  assert.equal(client._shouldRefreshDns(), false, 'Should not refresh before 10s');

  // At elapsed = 10100ms: should refresh because dnsRefreshIntervalS (10s) < 60s TTL
  client.lastDnsRefresh = Date.now() - 10100;
  assert.equal(client._shouldRefreshDns(), true, 'Should refresh after 10s fallback');
});

test('DNS refresh picks minimum positive TTL across multiple targets', async () => {
  const tenantConfig = new TenantConfig('test.example.com', 1);
  const config = new RClientConfig(tenantConfig, { dnsRefreshIntervalS: 10 });
  const client = new RClient(config);

  client.resolver = {
    resolveSrv: (name, cb) => {
      cb(null, [
        { name: 's-1.example.com', port: 29292, priority: 10, weight: 10 },
        { name: 's-2.example.com', port: 29292, priority: 10, weight: 10 }
      ]);
    },
    resolve4: (name, options, cb) => {
      const callback = typeof options === 'function' ? options : cb;
      if (name.startsWith('s-1')) {
        callback(null, [{ address: '127.0.0.1', ttl: 8 }]);
      } else {
        callback(null, [{ address: '127.0.0.2', ttl: 2 }]);
      }
    }
  };

  await new Promise((resolve, reject) => {
    client._refreshServers((err) => (err ? reject(err) : resolve()));
  });

  assert.equal(client._dnsRefreshTtlMs, 2000, '_dnsRefreshTtlMs should be min TTL (2000ms)');
  assert.equal(client.servers.length, 2);
});

test('DNS refresh falls back gracefully when plain string IP addresses are returned', async () => {
  const tenantConfig = new TenantConfig('test.example.com', 1);
  const config = new RClientConfig(tenantConfig, { dnsRefreshIntervalS: 10 });
  const client = new RClient(config);

  client.resolver = {
    resolveSrv: (name, cb) => {
      cb(null, [{ name: 's-1.example.com', port: 29292, priority: 10, weight: 10 }]);
    },
    resolve4: (name, options, cb) => {
      const callback = typeof options === 'function' ? options : cb;
      callback(null, ['127.0.0.1']);
    }
  };

  await new Promise((resolve, reject) => {
    client._refreshServers((err) => (err ? reject(err) : resolve()));
  });

  assert.equal(client._dnsRefreshTtlMs, 0, '_dnsRefreshTtlMs should be 0 when no TTL is provided');
  assert.equal(client.servers.length, 1);
  assert.equal(client.servers[0].ip, '127.0.0.1');

  // Should use 10s default
  client.lastDnsRefresh = Date.now() - 9000;
  assert.equal(client._shouldRefreshDns(), false);
  client.lastDnsRefresh = Date.now() - 10500;
  assert.equal(client._shouldRefreshDns(), true);
});
