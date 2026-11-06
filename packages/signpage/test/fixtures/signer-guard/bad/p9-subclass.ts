// planted (card signer-guard-parser, reviewer variant p9 of c00a169d): a subclass of HDKey, whose instances are not of a
// pinned type, signs through this.sign
import { HDKey } from "../../../../../wallet/node_modules/@scure/bip32/index.js";
class K extends HDKey {
  s(d: Uint8Array) { return this.sign(d); }
}
export const go = (seed: Uint8Array, d: Uint8Array) => (K.fromMasterSeed(seed) as K).s(d);
