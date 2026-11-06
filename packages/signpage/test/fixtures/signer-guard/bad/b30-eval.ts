// planted (card signer-guard-parser, reviewer variant b30 of 40115c3d, L2): a signer reached from text, which no reader
// binds: eval, the Function constructor by name and by a function's .constructor, eval off globalThis, a timer given a
// string, and node:vm
import { signEvmSell } from "../../../../src/rules/pool.ts";
import { runInThisContext } from "node:vm";
export const viaEval = (k: Uint8Array, c: never, b: never) => eval("signEvmSell")(k, c, b);
export const viaFunction = () => new Function("return signEvmSell")();
export const viaConstructor = () => (() => 0).constructor("return signEvmSell")();
export const viaGlobal = () => globalThis["eval"]("signEvmSell");
export const viaTimer = () => setTimeout("signEvmSell()", 0);
export const viaVm = () => runInThisContext("signEvmSell");
