const assert = require('assert');
const {decodeApiKey} = require('./api_key_codec');
const info = decodeApiKey('rl-cookie1qgqsqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqz8scfwu4f');
assert.equal(info.formatVersion, 2);
assert.deepStrictEqual(info.quotas.rate_window_size_ms_max, {kind:'finite',milliseconds:31536000000});
console.log('v2 cap PASS');
