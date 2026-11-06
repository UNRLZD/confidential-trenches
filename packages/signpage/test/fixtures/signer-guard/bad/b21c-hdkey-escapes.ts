// planted (card signer-guard-parser, review of 40115c3d, H1): an HD key's sign reached past the member list: through a
// cast, a destructuring, a computed key, a hand-on to an untyped helper, and a name bip32 exports but the wallet never uses
import { HDKey, HARDENED_OFFSET } from "../../../../../wallet/node_modules/@scure/bip32/index.js";
const anyOf = (x: unknown) => x as { sign(d: Uint8Array): Uint8Array };
export const cast = (seed: Uint8Array, d: Uint8Array) => (HDKey.fromMasterSeed(seed) as any).sign(d);
export const destructured = (seed: Uint8Array, d: Uint8Array) => {
  const { sign } = HDKey.fromMasterSeed(seed);
  return sign(d);
};
export const keyed = (seed: Uint8Array, d: Uint8Array, k: "sign") => HDKey.fromMasterSeed(seed)[k](d);
export const handed = (seed: Uint8Array, d: Uint8Array) => anyOf(HDKey.fromMasterSeed(seed)).sign(d);
export const offset = () => HARDENED_OFFSET;
