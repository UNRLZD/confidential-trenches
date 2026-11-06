// planted (card signer-guard-parser, review of 1a367f1e, H1c, the reviewer's exact case): schnorr read off the curve
// package's namespace by a literal name
import * as nc from "@noble/curves/secp256k1.js";
export const viaNs = (m: Uint8Array, k: Uint8Array) => nc.schnorr.sign(m, k);
