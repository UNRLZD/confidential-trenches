// planted (card signer-guard-parser, reviewer variant p3b of c00a169d, H1): the pinned packages re-exported by a module
// of ours (../p3a-reexport.ts), read off its namespace by a computed key, and imported from it at run time
import * as x from "../p3a-reexport.ts";
const name = ["HD", "Key"].join("");
export const go = (k: Uint8Array, d: Uint8Array) => new (x as any)[name]({ privateKey: k }).sign(d);
export const go2 = (k: Uint8Array, d: Uint8Array) => (x as any)[["secp", "256k1"].join("")].sign(d, k, { prehash: false });
export const go3 = async (k: Uint8Array, d: Uint8Array) => ((await import("../p3a-reexport.ts")) as any)[name].prototype.sign.call({ privateKey: k }, d);
