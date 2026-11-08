// The buy's swap-gas reads in a replay of test/fixtures/evm-quote.json (card evm-buy-gas-floor). The recording predates
// the check, so a batch holding one of those reads has no recorded answer: each swap-gas read in it is answered as a
// swap that ran (one word, 1) and each other call by its own recorded answer, the same call at the same block. Every
// recorded case's swap ran within the cap on its two pinned providers when run live at 07:08Z on 2026-11-08 (Base:
// publicnode and blastapi; Robinhood: publicnode and drpc), the outcomes as recorded; the refusals are held on the
// modelled chain (test/evm-quote-attacks.test.ts, the GF tests).
import type { EvmRpcCall } from "../src/checks/evm/quote.ts";

const SEL_BUY_SWAP = "0x25faf2a3";
const isGas = (c: EvmRpcCall) => c.method === "eth_call" && String((c.params[0] as { data?: unknown } | undefined)?.data).startsWith(SEL_BUY_SWAP);
/** The answers to `calls` from `recorded` where any is a swap-gas read, or undefined (where none is, or a call has no
 *  recorded answer). */
export function gasRoundAnswers(recorded: readonly { calls: readonly EvmRpcCall[]; answers: readonly unknown[] }[], calls: readonly EvmRpcCall[]): unknown[] | undefined {
  if (!calls.some(isGas)) return undefined;
  const one = new Map<string, unknown>();
  for (const x of recorded) x.calls.forEach((c, i) => one.set(JSON.stringify(c), x.answers[i]));
  const out = calls.map((c, id) => (isGas(c) ? { jsonrpc: "2.0", id, result: "0x" + "0".repeat(63) + "1" } : one.get(JSON.stringify(c))));
  return out.some((a) => a === undefined) ? undefined : structuredClone(out);
}
