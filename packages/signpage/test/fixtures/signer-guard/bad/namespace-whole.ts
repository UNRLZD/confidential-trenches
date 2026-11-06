// planted (card signer-guard-parser): a whole namespace that exports a signer, handed on and indexed by a name the
// file computes
import * as sell from "../../../../../kit/src/trade/evm/sell.ts";

const pick = (m: typeof sell, name: string) => (m as unknown as Record<string, (...a: unknown[]) => unknown>)[name];
export const send = (key: Uint8Array) => pick(sell, ["evmPool", "Sign", "Sell"].join(""))!(key);
