#!/usr/bin/env node
// What a Base or Robinhood landing sent each pool host in a mainnet copy (pool-fork-evm-carry-withdraw.mjs), sent again
// once to the real providers, read-only: how many each provider refused (HTTP 429, or a JSON-RPC rate error).
// - A record with the window's sends (the "ready inside 10 s" step's sentInWindow, review of 584af1495, P3-2): every
//   request from 10 s before the deposit's block to the proof, as sent: each batch at its own time after the first send
//   and as one batch, every host at once, as the page sent them (sentPlan).
// - An older record (its "first leaf" step's hostWindowMax alone): the busiest 10 s per host, the same count per method
//   spread evenly over 10 s (replayPlan).
// Every host of the record's windows is replayed, from the page's pool, fee and history lists. Never a send:
// eth_sendRawTransaction is replayed as eth_chainId, and every eth_call goes to the pool with its recorded selector alone
// (a revert is an answer, not a refusal).
//   node packages/signpage/scripts/evm-landing-replay.mjs <record.json> [<record.json> ...]
// Prints one line per record and host; exit 0 when no provider refused, 1 otherwise, 2 on error.
// Its plan (replayPlan) is tested offline: scripts/evm-landing-replay.test.mjs.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const WINDOW_MS = 10_000;
const STEP = "first leaf: a ready proof inside its first minute";
const hex = (n) => `0x${n.toString(16)}`;

/** One read-only request of `m` (a record's method key) for `pool` at `head`. */
export const asRead = (m, pool, head) => {
  if (m.startsWith("eth_call ")) return ["eth_call", [{ to: pool, data: m.slice(9) }, "latest"]];
  switch (m) {
    case "eth_getBlockByNumber":
      return ["eth_getBlockByNumber", ["latest", false]];
    case "eth_getLogs":
      return ["eth_getLogs", [{ address: pool, fromBlock: hex(head - 100n), toBlock: hex(head) }]];
    case "eth_getBalance":
    case "eth_getTransactionCount":
      return [m, [pool, "latest"]];
    case "eth_estimateGas":
      return ["eth_estimateGas", [{ to: pool, data: "0x" }]];
    case "eth_getTransactionReceipt":
      return ["eth_getTransactionReceipt", [`0x${"00".repeat(32)}`]];
    default:
      return ["eth_chainId", []];
  }
};

/** A record's replay: per host of its busiest windows, the URL it was (from `lists`, the page's lists for the chain) and
 *  its methods, each as many times as recorded. A host in no list is an error (nothing sent to a guess). */
export const replayPlan = (rec, lists) => {
  const step = rec.steps.find((s) => s.name === STEP);
  const windows = step?.detail?.hostWindowMax ?? step?.hostWindowMax;
  if (!windows) throw new Error("no hostWindowMax in the record's first-leaf step");
  const urlOf = new Map(lists.map((u) => [new URL(u).host, u]));
  return Object.entries(windows)
    .filter(([, w]) => w.n > 0)
    .map(([host, w]) => {
      const url = urlOf.get(host);
      if (url === undefined) throw new Error(`${host}: in no list the page reads`);
      return { host, url, n: w.n, methods: Object.entries(w.by).flatMap(([m, k]) => Array.from({ length: k }, () => m)) };
    });
};

const SENT_STEP = "first leaf: ready inside 10 s, each pool host inside its window";
/** A record's window as sent: per host, its batches in order, each at its ms after the window's first send, with its
 *  methods; null for a record without one. A host in no list is an error, as replayPlan's. */
export const sentPlan = (rec, lists) => {
  const sent = rec.steps.find((s) => s.name === SENT_STEP)?.sentInWindow;
  if (!Array.isArray(sent) || sent.length === 0) return null;
  const urlOf = new Map(lists.map((u) => [new URL(u).host, u]));
  const zero = Math.min(...sent.map((x) => x.ms));
  const hosts = new Map();
  for (const x of [...sent].sort((a, b) => a.ms - b.ms)) {
    const url = urlOf.get(x.host);
    if (url === undefined) throw new Error(`${x.host}: in no list the page reads`);
    let h = hosts.get(x.host);
    if (h === undefined) hosts.set(x.host, (h = { host: x.host, url, n: 0, batches: new Map() }));
    let b = h.batches.get(x.batch);
    if (b === undefined) h.batches.set(x.batch, (b = { atMs: x.ms - zero, methods: [] }));
    b.methods.push(x.m);
    h.n++;
  }
  return [...hosts.values()].map((h) => ({ host: h.host, url: h.url, n: h.n, batches: [...h.batches.values()] }));
};

export const refused = (a) => a.status === 429 || /rate|limit|too many/i.test(String(a.body?.error?.message ?? "")) || a.body?.error?.code === -32005;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  globalThis.__SIGN_NETWORK__ = "mainnet";
  const { MAINNET_EVM_FEE_RPCS, MAINNET_POOL_HISTORY, MAINNET_POOL_RPCS } = await import("../src/pool-testnet.ts");
  const { EVM_POOLS } = await import("../../wallet/src/pool/evm.ts");
  const { evmPoolVenues } = await import("../../kit/src/trade/evm/buy-unpinned.ts");
  const urlsIn = (v, acc = []) => {
    if (typeof v === "string" && /^https:\/\//.test(v)) acc.push(v);
    else if (v && typeof v === "object") for (const x of Object.values(v)) urlsIn(x, acc);
    return acc;
  };
  const rpc = async (url, method, params) => {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(10_000) });
    const text = await r.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {}
    return { status: r.status, body };
  };
  let bad = 0;
  try {
    for (const file of process.argv.slice(2)) {
      const rec = JSON.parse(readFileSync(file, "utf8"));
      const chain = rec.chain;
      const pool = EVM_POOLS[chain].pool;
      // the page's pool, fee and history lists, and the kit's venue providers (the copy routes them all)
      const lists = [...MAINNET_POOL_RPCS[chain], ...MAINNET_EVM_FEE_RPCS[chain], ...MAINNET_POOL_HISTORY[chain], ...urlsIn(evmPoolVenues()[chain])];
      const asSent = sentPlan(rec, lists);
      if (asSent !== null) {
        // every host at once, each batch at its own time, as one request
        const heads = new Map(await Promise.all(asSent.map(async (p) => [p.host, BigInt((await rpc(p.url, "eth_blockNumber", [])).body?.result ?? "0x0")])));
        const t0 = Date.now();
        const lines = await Promise.all(asSent.map(async (p) => {
          const answers = (await Promise.all(p.batches.map((b) => new Promise((r) => setTimeout(r, b.atMs)).then(async () => {
            const reads = b.methods.map((m) => asRead(m, pool, heads.get(p.host)));
            const body = reads.map(([m, q], i) => ({ jsonrpc: "2.0", id: i + 1, method: m, params: q }));
            const one = await fetch(p.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body.length === 1 ? body[0] : body), signal: AbortSignal.timeout(10_000) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }), (e) => ({ status: 0, body: { error: { message: String(e?.name ?? e) } } }));
            // a batch's answer is one per request; a refusal of the whole batch counts for each
            return Array.isArray(one.body) ? one.body.map((x) => ({ status: one.status, body: x })) : reads.map(() => one);
          })))).flat();
          const n429 = answers.filter(refused).length;
          const others = answers.filter((a) => !refused(a) && (a.status !== 200 || a.body?.error !== undefined));
          bad += n429;
          return `${file.split("/").at(-1)} ${chain} ${p.host}: ${p.n} reads in ${p.batches.length} batches as sent over ${Date.now() - t0} ms, ${n429} refused for rate, ${others.length} other errors${others.length ? ` (${[...new Set(others.map((a) => `${a.status} ${String(a.body?.error?.message ?? "").slice(0, 60)}`))].join("; ")})` : ""}`;
        }));
        for (const l of lines) console.log(l);
        continue;
      }
      for (const p of replayPlan(rec, lists)) {
        const head = BigInt((await rpc(p.url, "eth_blockNumber", [])).body?.result ?? "0x0");
        const reads = p.methods.map((m) => asRead(m, pool, head));
        const gap = WINDOW_MS / reads.length;
        const t0 = Date.now();
        const answers = await Promise.all(reads.map(([m, q], i) => new Promise((r) => setTimeout(r, i * gap)).then(() => rpc(p.url, m, q).catch((e) => ({ status: 0, body: { error: { message: String(e?.name ?? e) } } })))));
        const n429 = answers.filter(refused).length;
        const others = answers.filter((a) => !refused(a) && a.status !== 200);
        const other = `${others.length}${others.length ? ` (${[...new Set(others.map((a) => `${a.status} ${String(a.body?.error?.message ?? "").slice(0, 80)}`))].join("; ")})` : ""}`;
        bad += n429;
        console.log(`${file.split("/").at(-1)} ${chain} ${p.host}: ${reads.length} reads in ${Date.now() - t0} ms, ${n429} refused for rate, ${other} other non-200`);
      }
    }
  } catch (e) {
    console.error(`evm-landing-replay: ${e?.message ?? e}`);
    process.exit(2);
  }
  process.exit(bad === 0 ? 0 : 1);
}
