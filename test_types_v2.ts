import {decodeApiKeyVersioned, encodeApiKey, WindowCap, QuotasV2} from './api_key_codec';
import {RClient} from './index';
const decoded=decodeApiKeyVersioned('synthetic');
if (decoded.formatVersion === 2) {
  const tagged: WindowCap=decoded.quotas.rate_window_size_ms_max;
  // @ts-expect-error tagged v2 values cannot masquerade as numeric legacy caps
  const invalid: number=decoded.quotas.rate_window_size_ms_max;
  encodeApiKey(decoded.authMethod,decoded.keyId,decoded.authSecret,decoded.quotas,2);
} else if (decoded.quotas) {
  const cap: number=decoded.quotas.rate_window_size_ms_max;
}
declare const quotas: QuotasV2;
// @ts-expect-error a v2 writer must explicitly select version 2
encodeApiKey('none',1n,new Uint8Array(),quotas);
encodeApiKey('none',1n,new Uint8Array(),quotas,2);
declare const client: RClient;
if(client.quotas) { const cap: number=client.quotas.rate_window_size_ms_max; }
if(client.versionedQuotas) {
  // @ts-expect-error the full-cap accessor is truthfully version-aware
  const cap: number=client.versionedQuotas.rate_window_size_ms_max;
}
