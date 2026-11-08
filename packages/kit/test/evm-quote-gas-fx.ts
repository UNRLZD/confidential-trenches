// The buy's swap-gas reads in a replay of test/fixtures/evm-quote.json (card evm-buy-gas-floor). The recording predates
// the check, so a batch holding one of those reads has no recorded answer: each swap-gas read in it is answered as a
// swap that ran (one word, 1) and each other call by its own recorded answer, the same call at the same block. Every
// recorded case's swap ran within the cap on its two pinned providers when run live at 07:08Z on 2026-11-08 (Base:
// publicnode and blastapi; Robinhood: publicnode and drpc), the outcomes as recorded; the refusals are held on the
// modelled chain (test/evm-quote-attacks.test.ts, the GF tests).
import { EVM_READ_CALL_GAS, EVM_READ_GAS_CODE, type EvmRpcCall } from "../src/checks/evm/quote.ts";

const MULTICALL3 = "0xca11bde05977b3631167028862be2a173976ca11";
/** `calls` as the recording sent them (card evm-quote-read-gas-starve): the recording predates the per-read gas, so an
 *  aggregate3 call is matched without its gas (EVM_READ_CALL_GAS) and without EVM_READ_GAS_CODE's override at
 *  Multicall3, the hook's override kept where it has one; any other call as it is. Each recorded read ran with the call's
 *  whole gas on Multicall3 itself, and every recorded case's outcome is the one recorded. */
export function asRecorded(calls: readonly EvmRpcCall[]): EvmRpcCall[] {
  return calls.map((c) => {
    const [tx, at, over, ...rest] = c.params as [Record<string, unknown>, unknown, Record<string, unknown> | undefined, ...unknown[]];
    if (c.method !== "eth_call" || String(tx?.to).toLowerCase() !== MULTICALL3 || tx.gas !== "0x" + EVM_READ_CALL_GAS.toString(16)) return c;
    const code = Object.entries(over ?? {}).find(([a]) => a.toLowerCase() === MULTICALL3);
    if (code === undefined || (code[1] as { code?: unknown }).code !== EVM_READ_GAS_CODE) return c;
    const { gas: _g, ...bare } = tx;
    const hook = Object.fromEntries(Object.entries(over!).filter(([a]) => a.toLowerCase() !== MULTICALL3));
    return { ...c, params: Object.keys(hook).length === 0 ? [bare, at, ...rest] : [bare, at, hook, ...rest] };
  });
}

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
