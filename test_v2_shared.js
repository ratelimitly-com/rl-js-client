const assert=require('assert');
const {decodeApiKeyVersioned,encodeApiKey}=require('./api_key_codec');
const {CanonicalIds,WireProtocol,TenantConfig,AuthMethod,ResourceRequest}=require('./client');
const keys=require('./tests/fixtures/api_key_v2_test_vectors.json');
for(const v of [...keys.valid_credentials,...keys.historical_v2_credentials]) {
 const d=decodeApiKeyVersioned(v.bech32); assert.equal(d.formatVersion,2); assert.deepStrictEqual(d.quotas,v.quotas);
 assert.equal(encodeApiKey(d.authMethod,d.keyId,d.authSecret,d.quotas,2),v.bech32);
}
for(const v of keys.invalid_credentials) assert.throws(()=>decodeApiKeyVersioned(v.bech32));
for(const v of require('./tests/fixtures/resource_id_v2_vectors.json').vectors) assert.equal(CanonicalIds.bucketId(Buffer.from(v.bucket_name_hex,'hex'),v.window_size_ms,v.rate_limit).toString('hex'),v.bucket_id_hex);
const key="rl-cookie1qgyqwps9qspsyqgqqypqxpq9qcrsszg2pvxq6rs0zqg3yyc5z5tpwxqergd3c8g7ragtruhc7885pu";
const tenant=new TenantConfig(null,decodeApiKeyVersioned(key).keyId,AuthMethod.COOKIE,key);
tenant.wideRateRequests=true;
for(const v of require('./tests/fixtures/rate_window_v2_vectors.json').vectors) {
 const rs=(v.resources||[v]).map(r=>new ResourceRequest('checkout',r.window_size_ms,100,1));
 // Wire fixture resource IDs are based on the shared 'checkout' name.
 const wide=v.request_tag==='QW';
 const packet=WireProtocol.createRateRequest(tenant,rs,[],null,300,wide);
 assert.equal(packet.subarray(76).toString('hex'),v.request_pdu_hex,v.name);
 const response=Buffer.concat([packet.subarray(0,76),Buffer.from(v.response_pdu_hex,'hex')]);
 const result=WireProtocol.parseRateResponse(response,tenant,rs,[],null,wide);
 assert.equal(result.resourceResults.length,rs.length);
}
console.log('shared v2 caps/IDs/wire PASS');
