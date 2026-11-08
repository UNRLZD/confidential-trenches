// The device half of card wallet-rpc-hex-case's live check (scripts/live-checks/wallet-rpc-hex-case.mjs runs it as a
// child process): the wallet's own check of an EVM RPC pair, src/pool/evm.ts, the one a restore runs on its Transfer
// pair before any W is read, with no second implementation of any check. Its two RPCs are a bridge over stdio, as in
// ./evm-pool-sync-check.ts, so the live check makes every network call (and records or replays it) and this file
// makes none:
//   node packages/wallet/scripts/rpc-hex-case-check.ts '{"chainId":"46630","urls":["https://…","https://…"],"wait":true}'
// stdout, one JSON object a line: {"rpc":{"id","k","method","params"}} for each call, then {"done":report} or
// {"fail":message}; stdin, one a line: {"id","result"} or {"id","error"}.
// What it runs, on both RPCs: the finalized anchor (evmAgreedBlock: the lower of the two finalized blocks, read by
// number on both, one hash on both), then evmHoldsAnchor: eth_chainId read by the wallet's parser on each RPC must be
// `chainId` on both, and the anchor's height must hold its hash on both. The report adds each RPC's raw eth_chainId
// answer and the wallet's reading of it (evmRpcHex).
import { createInterface } from "node:readline";
import { bridgeAnswers } from "./bridge-answers.ts";
import { EVM_POOL_TAG, evmAgreedBlock, evmHoldsAnchor, evmRetryLag, evmRpcHex, type EvmRpc } from "../src/pool/evm.ts";

type Args = { chainId: string; urls: [string, string]; wait: boolean };
type Call = { k: number; method: string; params: readonly unknown[]; result?: unknown };

const a = JSON.parse(process.argv[2] ?? "null") as Args;
const out = (o: unknown) => process.stdout.write(`${JSON.stringify(o)}\n`);
const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let next = 0;
const calls: Call[] = [];
// a replay's answers are handed one at a time in the read's own order (./bridge-answers.ts, card spares-replay-order)
const take = bridgeAnswers<{ id: number; result?: unknown; error?: string }>(a.wait !== false, (m) => {
  const w = waiting.get(m.id);
  if (w === undefined) return;
  waiting.delete(m.id);
  if (m.error !== undefined) w.reject(new Error(m.error));
  else w.resolve(m.result);
}, () => waiting.size);
createInterface({ input: process.stdin }).on("line", (line) => take(JSON.parse(line)));
const bridge = (k: number): EvmRpc =>
  Object.assign(
    (method: string, params: readonly unknown[]) =>
      new Promise<unknown>((resolve, reject) => {
        const id = next++;
        const c: Call = { k, method, params };
        calls.push(c);
        waiting.set(id, { resolve: (v) => ((c.result = v), resolve(v)), reject });
        out({ rpc: { id, k, method, params } });
      }),
    { url: a.urls[k] },
  );

try {
  const rpcs: [EvmRpc, EvmRpc] = [bridge(0), bridge(1)];
  const sleep = a.wait ? undefined : async () => {};
  const anchor = await evmRetryLag(() => evmAgreedBlock(rpcs, EVM_POOL_TAG), sleep);
  await evmRetryLag(() => evmHoldsAnchor(rpcs, BigInt(a.chainId), anchor), sleep);
  const raw = [0, 1].map((k) => calls.filter((c) => c.k === k && c.method === "eth_chainId").at(-1)?.result ?? null);
  out({ done: { chainIds: raw, read: raw.map((v) => evmRpcHex(v)), anchor: { number: anchor.number.toString(), hash: anchor.hash } } });
  process.exit(0);
} catch (e) {
  out({ fail: String((e as Error)?.message ?? e) });
  process.exit(0);
}
