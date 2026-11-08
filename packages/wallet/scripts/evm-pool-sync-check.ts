// The device half of card notes-per-pool-evm's live check (scripts/live-checks/notes-per-pool-evm.mjs runs it as a
// child process): the wallet's own EVM pool sync, src/pool/evm.ts, run once on a deployed pool, with no second
// implementation of any check. Its two RPCs are a bridge over stdio, so the live check makes every network call (and
// records or replays it) and this file makes none:
//   node packages/wallet/scripts/evm-pool-sync-check.ts '{"network":"base-sepolia","pool":"0x…","fromBlock":"123",
//     "urls":["https://…","https://…"],"wait":true}'
// stdout, one JSON object a line: {"rpc":{"id","k","method","params"}} for each call, then {"done":report} or
// {"fail":message}; stdin, one a line: {"id","result"} or {"id","error"}.
// What it runs, all on both RPCs, each check the sync's own:
//   1. a full round from the deploy block (depthAt(fromBlock)): eth_chainId is the network's, SCOPE() is
//      evmPoolScopeOf(pool, chainId), the finalized and the newest agreed anchors each have one hash on both, and the
//      trees rebuilt from every Deposited, Withdrawn and Bought log since the deploy block are the pool's currentRoot,
//      currentTreeSize, currentLabelRoot and currentLabelTreeSize at the newest anchor (pages shrink on a range cap);
//   2. the cut at the pool's time (trees(evmNow)): stateRootTimes and labelRootTimes of its roots are the time of the
//      block of its last leaf. A pool with no leaf before that time answers "no leaf before": the report says so
//      (cut: null) and it is not a failure.
// The report adds what the sync read in its last round (the anchors, the views), from the calls it made.
import { createInterface } from "node:readline";
import { bridgeAnswers } from "./bridge-answers.ts";
import { EVM_NEWEST_TAG, EVM_POOL_TAG, evmNow, evmTreeSync, type EvmNetwork, type EvmRpc } from "../src/pool/evm.ts";

type Args = { network: EvmNetwork; pool: string; fromBlock: string; urls: [string, string]; wait: boolean };
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

/** What the sync read in its last round: the anchors (the lower tag block, then that number on both) and the views. */
function lastRound(from: number) {
  const rs = calls.slice(from).filter((c) => c.result !== undefined);
  const anchor = (t: string) => {
    const tops = [0, 1].map((k) => rs.filter((c) => c.k === k && c.method === "eth_getBlockByNumber" && c.params[0] === t).at(-1)?.result as { number: string } | undefined);
    if (tops.some((b) => b === undefined)) return null;
    const n = tops.map((b) => BigInt(b!.number)).reduce((x, y) => (x < y ? x : y));
    const at = [0, 1].map((k) => rs.filter((c) => c.k === k && c.method === "eth_getBlockByNumber" && c.params[0] === `0x${n.toString(16)}`).at(-1)?.result as { hash: string } | undefined);
    return { number: n.toString(), hashes: at.map((b) => b?.hash ?? null) };
  };
  const newest = anchor(EVM_NEWEST_TAG);
  const views: Record<string, (string | null)[]> = {};
  for (const c of rs)
    if (c.method === "eth_call" && (c.params[1] as { blockHash?: string })?.blockHash === newest?.hashes[0]) {
      const sel = String((c.params[0] as { data: string }).data).slice(0, 10);
      (views[sel] ??= [null, null])[c.k] = BigInt(c.result as string).toString();
    }
  return { finalized: anchor(EVM_POOL_TAG), newest, views };
}

try {
  const rpcs: [EvmRpc, EvmRpc] = [bridge(0), bridge(1)];
  const sleep = a.wait ? undefined : async () => {};
  const sync = evmTreeSync({ rpcs, pin: { network: a.network, pool: a.pool, feeRecipient: a.pool, fromBlock: BigInt(a.fromBlock) }, ...(sleep ? { sleep } : {}) });
  const at = calls.length;
  const depth = await sync.depthAt(BigInt(a.fromBlock));
  const chainIds = calls.filter((c) => c.method === "eth_chainId").map((c) => BigInt(c.result as string).toString());
  const round = lastRound(at);
  let cut: { beforeMs: string; stateRoot: string; labelRoot: string; stateSize: number; labelSize: number } | null = null;
  const now = await evmNow(rpcs);
  try {
    const t = await sync.trees(now);
    cut = { beforeMs: now.toString(), stateRoot: t.stateRoot.toString(), labelRoot: t.labelRoot.toString(), stateSize: t.stateTree.size, labelSize: t.labelTree.size };
  } catch (e) {
    if (!/no leaf before/.test(String((e as Error).message))) throw e;
  }
  out({ done: { chainIds, depth, ...round, cut, nowMs: now.toString() } });
  process.exit(0);
} catch (e) {
  out({ fail: String((e as Error)?.message ?? e) });
  process.exit(0);
}
