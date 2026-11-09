// The device half of card evm-pool-leaves-any-source's live check (scripts/live-checks/evm-pool-leaves-any-source.mjs
// runs it as a child process): the wallet's own EVM pool sync, src/pool/evm.ts evmTreeSync, run once on a mainnet pool
// with its logs taken from the sources alone, with no second implementation of any check. Its RPCs are a bridge over
// stdio, as in ./evm-pool-sync-check.ts, so the live check makes every network call (through provider-answer.mjs, and
// records or replays it) and this file makes none:
//   node packages/wallet/scripts/evm-pool-sources-check.ts '{"network":"base","pool":"0x…","fromBlock":"123",
//     "list":["https://…","https://…"],"helper":"https://…/v1/rpc/base?keyed=only","wait":true}'
// stdout, one JSON object a line: {"rpc":{"id","url","method","params"}} for each call, then {"done":report} or
// {"fail":message}; stdin, one a line: {"id","result"} or {"id","error"}.
// What it runs: the sync's seats are the list's providers (the page's mainnet list, two operators) for the head, the
// anchors and the pool's views, as on the device, but each seat's eth_getLogs is refused here, so every log comes from
// the sources: the helper's keyed-only route (operator "helper", as src/pool/buy-wallets.ts evmHelperKeyedRpc names it)
// and the list's own providers, each its URL's operator (evmSourceOperator). The sync takes the logs only when two
// operators give them byte for byte and their trees are the pool's views at the anchor's hash; else it refuses.
// The report: the anchor, the events' count and the trees' sizes and roots, and each operator's eth_getLogs calls.
import { createInterface } from "node:readline";
import { VaultTree } from "@blindfill/kit";
import { bridgeAnswers } from "./bridge-answers.ts";
import { evmSourceOperator, evmTreeSync, type EvmNetwork, type EvmRpc } from "../src/pool/evm.ts";

type Args = { network: EvmNetwork; pool: string; fromBlock: string; list: [string, string]; helper: string; wait: boolean };

const a = JSON.parse(process.argv[2] ?? "null") as Args;
const out = (o: unknown) => process.stdout.write(`${JSON.stringify(o)}\n`);
const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let next = 0;
const logs = new Map<string, { answered: number; refused: number }>();
// a replay's answers are handed one at a time in the read's own order (./bridge-answers.ts, card spares-replay-order)
const take = bridgeAnswers<{ id: number; result?: unknown; error?: string }>(a.wait !== false, (m) => {
  const w = waiting.get(m.id);
  if (w === undefined) return;
  waiting.delete(m.id);
  if (m.error !== undefined) w.reject(new Error(m.error));
  else w.resolve(m.result);
}, () => waiting.size);
createInterface({ input: process.stdin }).on("line", (line) => take(JSON.parse(line)));
const bridge = (url: string, more: Record<string, string> = {}): EvmRpc => {
  const r = Object.assign(
    (method: string, params: readonly unknown[]) =>
      new Promise<unknown>((resolve, reject) => {
        const id = next++;
        const n = method === "eth_getLogs" ? (logs.get(evmSourceOperator(r) ?? url) ?? { answered: 0, refused: 0 }) : null;
        if (n !== null) logs.set(evmSourceOperator(r) ?? url, n);
        waiting.set(id, { resolve: (v) => (n && n.answered++, resolve(v)), reject: (e) => (n && n.refused++, reject(e)) });
        out({ rpc: { id, url, method, params } });
      }),
    { url, ...more },
  ) as EvmRpc;
  return r;
};

try {
  const list = a.list.map((u) => bridge(u));
  // the seats: the list's providers, their logs refused here (a URL of their own, so their pages are not the sources')
  const seats = a.list.map((u, k) =>
    Object.assign(
      async (method: string, params: readonly unknown[]) => {
        if (method === "eth_getLogs") throw new Error("this check reads the pool's logs from the sources alone");
        return list[k]!(method, params);
      },
      { url: `${u}#seat` },
    ),
  ) as EvmRpc[];
  const helper = bridge(a.helper, { operator: "helper" });
  const sleep = a.wait ? undefined : async () => {};
  const sync = evmTreeSync({ rpcs: seats, pin: { network: a.network, pool: a.pool, feeRecipient: a.pool, fromBlock: BigInt(a.fromBlock) }, history: [helper, ...list], ...(sleep ? { sleep } : {}) });
  const r = await sync.events();
  // the trees the sync held to the pool's views at the anchor, as it builds them
  const state = new VaultTree(r.events.map((e) => e.state));
  const label = new VaultTree(r.events.flatMap((e) => (e.label === null ? [] : [e.label])));
  out({ done: { anchor: { number: r.anchor.number.toString(), hash: r.anchor.hash }, events: r.events.length, stateSize: state.size, stateRoot: (state.root ?? 0n).toString(), labelSize: label.size, labelRoot: (label.root ?? 0n).toString(), logs: Object.fromEntries(logs) } });
  process.exit(0);
} catch (e) {
  out({ fail: String((e as Error)?.message ?? e), logs: Object.fromEntries(logs) });
  process.exit(0);
}
