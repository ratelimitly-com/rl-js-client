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

test('DNS refresh triggers after default 10 seconds', async () => {
  const tenantConfig = new TenantConfig('test.example.com', 1);
  const config = new RClientConfig(tenantConfig);
  const client = new RClient(config);

  client.resolver = {
    resolveSrv: (name, cb) => {
      cb(null, [{ name: 's-1.example.com', port: 29292, priority: 10, weight: 10 }]);
    },
    resolve4: (name, cb) => {
      cb(null, ['127.0.0.1']);
    }
  };

  await new Promise((resolve, reject) => {
    client._refreshServers((err) => (err ? reject(err) : resolve()));
  });

  assert.equal(client.servers.length, 1);
  assert.equal(client.servers[0].ip, '127.0.0.1');

  // At elapsed = 9000ms: should NOT refresh yet (10s has not passed)
  client.lastDnsRefresh = Date.now() - 9000;
  assert.equal(client._shouldRefreshDns(), false, 'Should not refresh before 10s default interval');

  // At elapsed = 10100ms: should refresh
  client.lastDnsRefresh = Date.now() - 10100;
  assert.equal(client._shouldRefreshDns(), true, 'Should refresh after 10s default interval');
});
