// Records two facts about each chain's two pinned providers that the device's trade simulation rests on (card
// evm-quote-exec-sim, step 1), for test/evm-sim-facts.test.ts to replay. Reads only: no key, no transaction.
//   1. An eth_call at a block hash (EIP-1898, requireCanonical) runs with that block's own timestamp and number: code
//      that returns TIMESTAMP and NUMBER, put at an empty address by state override.
//   2. An EIP-7702 delegation designator given as override code (0xef0100 ‖ delegate) is followed: the call runs the
//      delegate's code in the account's own context. A synthetic delegate returns ADDRESS and SELFBALANCE (the account,
//      and the balance the override gives it); where a chain pins a SellDelegate, its nonce() reads the account's own
//      storage slot the override sets; and the delegate's runtime code itself, as override code, answers the same.
//   node packages/kit/test/evm-sim-facts-record.ts     writes test/fixtures/evm-sim-facts.json
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { evmJsonRpc, type EvmRpc, type EvmRpcCall } from "../src/checks/evm/quote.ts";
import { evmPoolVenues, type EvmPoolChain } from "../src/trade/evm/buy-unpinned.ts";

// TIMESTAMP PUSH1 0 MSTORE NUMBER PUSH1 32 MSTORE PUSH1 64 PUSH1 0 RETURN
export const TS_CODE = "0x426000524360205260406000f3";
// ADDRESS PUSH1 0 MSTORE SELFBALANCE PUSH1 32 MSTORE PUSH1 64 PUSH1 0 RETURN
export const CTX_CODE = "0x306000524760205260406000f3";
// empty addresses (no code, no key known): the timestamp reader, the account, the synthetic delegate
export const T_ADDR = "0x00000000000000000000000000000000b1f00701";
export const A_ADDR = "0x00000000000000000000000000000000b1f00a01";
export const D_ADDR = "0x00000000000000000000000000000000b1f00d01";
// SellDelegate's ERC-7201 storage slot (contracts/pool-evm/src/SellDelegate.sol SELL_STORAGE) and nonce()
export const SELL_STORAGE = "0xd19ce3d034be62269d1d8903d496806b7944251c1f2a9fe8014ceeba63edbd00";
export const SEL_NONCE = "0xaffed0e0";
export const CHAINS: EvmPoolChain[] = ["base", "robinhood", "base-sepolia", "robinhood-testnet"];

/** The calls of one chain's facts at block `hash`, the same on both providers. */
export function factCalls(hash: string, delegate: string | undefined, delegateCode: string | undefined): EvmRpcCall[] {
  const at = { blockHash: hash, requireCanonical: true };
  const calls: EvmRpcCall[] = [
    { method: "eth_call", params: [{ to: T_ADDR, data: "0x" }, at, { [T_ADDR]: { code: TS_CODE } }] },
    { method: "eth_call", params: [{ to: A_ADDR, data: "0x" }, at, { [A_ADDR]: { code: "0xef0100" + D_ADDR.slice(2), balance: "0x5" }, [D_ADDR]: { code: CTX_CODE } }] },
  ];
  if (delegate !== undefined) {
    const slot = { [SELL_STORAGE]: "0x" + (7n).toString(16).padStart(64, "0") };
    calls.push({ method: "eth_getCode", params: [delegate, at] });
    calls.push({ method: "eth_call", params: [{ to: A_ADDR, data: SEL_NONCE }, at, { [A_ADDR]: { code: "0xef0100" + delegate.slice(2), stateDiff: slot } }] });
    if (delegateCode !== undefined) calls.push({ method: "eth_call", params: [{ to: A_ADDR, data: SEL_NONCE }, at, { [A_ADDR]: { code: delegateCode, stateDiff: slot } }] });
  }
  return calls;
}

type Exchange = { calls: readonly EvmRpcCall[]; answers: readonly unknown[] };
const json = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x), 1);

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out: Record<string, { block: { number: string; hash: string; timestamp: string }; exchanges: [Exchange[], Exchange[]] }> = {};
  for (const chain of CHAINS) {
    const v = evmPoolVenues()[chain];
    const [p1, p2]: EvmRpc[] = v.providers!.map((u) => evmJsonRpc(u, fetch, 1 << 22));
    const logs: [Exchange[], Exchange[]] = [[], []];
    const ask = async (i: 0 | 1, calls: EvmRpcCall[]) => {
      // a provider's 429: asked again, a little later
      let answers: readonly unknown[] | undefined;
      for (let t = 0; answers === undefined; t++) {
        try {
          answers = await [p1, p2][i]!(calls);
        } catch (e) {
          if (t === 6 || !String(e).includes("429")) throw e;
          await new Promise((r) => setTimeout(r, 1500 * (t + 1)));
        }
      }
      logs[i].push({ calls, answers });
      return answers as { result?: unknown; error?: unknown }[];
    };
    // a block a few behind provider 1's head, which both providers hold under the same hash
    const head = (await ask(0, [{ method: "eth_getBlockByNumber", params: ["latest", false] }]))[0]!.result as { number: string };
    const n = "0x" + (BigInt(head.number) - 5n).toString(16);
    const bs = await Promise.all(([0, 1] as const).map((i) => ask(i, [{ method: "eth_getBlockByNumber", params: [n, false] }])));
    const [b1, b2] = bs.map((a) => a[0]!.result as { number: string; hash: string; timestamp: string });
    if (b1!.hash !== b2!.hash) throw new Error(`${chain}: the providers hold different blocks at ${n}`);
    const delegate = v.sellDelegate === undefined ? undefined : v.sellDelegate.toLowerCase();
    let code: string | undefined;
    if (delegate !== undefined) {
      const c = await ask(0, [{ method: "eth_getCode", params: [delegate, { blockHash: b1!.hash, requireCanonical: true }] }]);
      code = c[0]!.result as string;
    }
    const calls = factCalls(b1!.hash, delegate, code);
    const answers = await Promise.all(([0, 1] as const).map((i) => ask(i, calls)));
    out[chain] = { block: { number: b1!.number, hash: b1!.hash, timestamp: b1!.timestamp }, exchanges: logs };
    console.log(chain, "block", BigInt(b1!.number), "ts", BigInt(b1!.timestamp));
    answers.forEach((a, i) => console.log("  provider", i + 1, v.providers![i], JSON.stringify(a.map((x) => x.result !== undefined ? (String(x.result).length > 140 ? `code ${String(x.result).length} chars` : x.result) : x.error))));
  }
  writeFileSync(fileURLToPath(new URL("./fixtures/evm-sim-facts.json", import.meta.url)), json(out) + "\n");
}
