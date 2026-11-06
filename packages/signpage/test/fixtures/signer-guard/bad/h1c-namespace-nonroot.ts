// planted (card signer-guard-parser, review of 1a367f1e, H1c): a pinned package's export that is not a root it may
// import (schnorr, a signer of its own) read off its namespace by a literal name, by a literal key, by a destructuring,
// and off a module of ours that re-exports the package
import * as nc from "@noble/curves/secp256k1.js";
import * as x from "../p3a-reexport.ts";
export const viaNs = (m: Uint8Array, k: Uint8Array) => nc.schnorr.sign(m, k);
export const viaKey = (m: Uint8Array, k: Uint8Array) => nc["schnorr"].sign(m, k);
export const viaDestructure = (m: Uint8Array, k: Uint8Array) => {
  const { schnorr } = nc;
  return schnorr.sign(m, k);
};
export const viaReexport = (m: Uint8Array, k: Uint8Array) => x.schnorr.sign(m, k);
