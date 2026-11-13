import { Quotas as CodecQuotas, DecodedApiKey, decodeApiKey } from './api_key_codec';
import { Quotas as ClientQuotas, RClient } from './index';
declare const cq: CodecQuotas;
declare const rq: ClientQuotas;
declare const client: RClient;
const codecCap: number = cq.rate_window_size_ms_max;
const requestCap: number = rq.rate_window_size_ms_max;
const decoded: DecodedApiKey = decodeApiKey('synthetic');
if (decoded.quotas) { const cap: number = decoded.quotas.rate_window_size_ms_max; }
if (client.quotas) { const cap: number = client.quotas.rate_window_size_ms_max; }
void codecCap; void requestCap;
