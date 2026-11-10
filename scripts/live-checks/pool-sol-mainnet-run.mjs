#!/usr/bin/env node
// Live check of card pool-sol-mainnet-run: the Solana pool's books after a run of deposits, buys, sells and an exit, read
// at finalized on two RPCs of two operators (the money gate's: money-gate.mjs RPCS). Each read must give the same
// answer on both:
//   - the pool account: the program's, 2,179 bytes, "bfpool01"; its counters: deposits (nonce), deposited, spent, and
//     each tree's size; the label tree holds one leaf per deposit, and the state tree one more per release;
//   - the balance: the pool holds its own rent plus deposited less spent, every lamport of every note, and no less (a
//     stranger may send lamports to it; any surplus is named);
//   - the marks: one precommitment mark (17 bytes, tagged) per deposit, their values summing to deposited, and one spent
//     mark (13 bytes, tagged) per release, their withdrawnValues summing to spent;
//   - the roots: each tree's newest page holds exactly the entries its size says, its last root not zero;
//   - with --expect, at least the run's own deposits and releases (from its record: each deposit, sell deposited back
//     and sweep is a deposit; each buy and exit release a release), so a run that never landed fails.
//   node scripts/live-checks/pool-sol-mainnet-run.mjs [--cluster mainnet|devnet] [--expect deposits=N,releases=N]
//     [--rpc <url>,<url>] [--record <answers.json>]
//   PASS exit 0, FAIL exit 1, error exit 2, INCONCLUSIVE exit 3 (a provider gave no answer: provider-answer.mjs).
// Runs: once, after the owner's run on mainnet: the pool has no upgrade path, so no host deploy changes its books
import "../net-window.mjs";
import { realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { EXIT } from "./provider-answer.mjs";
import { answer, CLUSTERS, KEY, NoAnswer, pda, recorder } from "./pool-sol-mainnet-run.record.mjs";

const POOL_LEN = 2179;
const PRE_LEN = 17;
const SPENT_LEN = 13;
const TAG = 1;
const PAGE_ENTRIES = 1024;
const PAGE_HEADER = 16;
const ENTRY = 72;
const le32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const u64 = (d, o) => Buffer.from(d).readBigUInt64LE(o);
const u128 = (d, o) => u64(d, o) + (u64(d, o + 8) << 64n);
const b64 = (s) => new Uint8Array(Buffer.from(s, "base64"));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** The pool account's fields (contracts/pool-solana/src/state.rs): bump 8, nonce 9, deposited 17, spent 33, trees 49. */
export function poolOf(d) {
  if (d.length !== POOL_LEN || Buffer.from(d.subarray(0, 8)).toString() !== "bfpool01") return null;
  const tree = (o) => ({ size: u64(d, o), depth: d[o + 8] });
  return { nonce: u64(d, 9), deposited: u128(d, 17), spent: u128(d, 33), state: tree(49), label: tree(49 + 8 + 1 + 33 * 32) };
}

export async function check({ cluster = "mainnet", expect = {}, fetchFn = fetch, rpcs, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const c = CLUSTERS[cluster];
  const urls = rpcs ?? c.rpcs;
  const lines = [];
  const say = (ok, t) => lines.push(`${ok ? "PASS" : "FAIL"} ${t}`);
  const on = (method, params) => Promise.all(urls.map((u) => answer(fetchFn, u, method, params, sleep)));
  const acct = async (addr) => (await on("getAccountInfo", [addr, { encoding: "base64", commitment: "finalized" }])).map((r) => (r?.value ? { owner: r.value.owner, lamports: r.value.lamports, data: b64(r.value.data[0]) } : null));

  // the pool, the same bytes and lamports on both (read again once: an insert may land between the two reads)
  let pools = await acct(c.pool);
  if (!same(pools[0] && [...pools[0].data, pools[0].lamports], pools[1] && [...pools[1].data, pools[1].lamports])) pools = await acct(c.pool);
  const [pa, pb] = pools;
  const alike = pa && pb && pa.lamports === pb.lamports && Buffer.compare(Buffer.from(pa.data), Buffer.from(pb.data)) === 0;
  say(alike, `the pool ${c.pool}: the same bytes and lamports on ${urls.map((u) => new URL(u).host).join(" and ")}`);
  const p = pa && pa.owner === c.program ? poolOf(pa.data) : null;
  say(p !== null, `the pool is the program's, ${POOL_LEN} bytes, bfpool01`);
  if (!alike || !p) return { ok: false, lines };
  const releases = p.state.size - p.label.size;
  say(p.label.size === p.nonce && p.state.size >= p.label.size, `trees: label ${p.label.size} = deposits ${p.nonce}; state ${p.state.size} = deposits + ${releases} releases`);

  // the balance: rent(POOL_LEN) at the Rent sysvar both read, plus deposited less spent
  const rents = (await on("getMinimumBalanceForRentExemption", [POOL_LEN, { commitment: "finalized" }])).map(BigInt);
  const held = p.deposited - p.spent;
  const want = rents[0] + held;
  const have = BigInt(pa.lamports);
  say(rents[0] === rents[1] && have >= want, `the balance: ${have} lamports held, rent ${rents[0]} + deposited ${p.deposited} - spent ${p.spent} = ${want}${have > want ? ` (${have - want} more: a stranger's send)` : ""}`);

  // the marks, by size and tag, the same set on both
  const marks = async (len) => {
    const r = await on("getProgramAccounts", [c.program, { encoding: "base64", commitment: "finalized", filters: [{ dataSize: len }] }]);
    const sets = r.map((list) => list.map((a) => ({ k: a.pubkey, d: b64(a.account.data[0]) })).filter((a) => a.d[len - 1] === TAG).sort((x, y) => (x.k < y.k ? -1 : 1)));
    return { alike: same(sets[0].map((a) => [a.k, [...a.d]]), sets[1].map((a) => [a.k, [...a.d]])), list: sets[0] };
  };
  const pre = await marks(PRE_LEN);
  const sum = (l) => l.reduce((s, a) => s + u64(a.d, 0), 0n);
  say(pre.alike && BigInt(pre.list.length) === p.nonce && sum(pre.list) === p.deposited, `deposit marks: ${pre.list.length} for ${p.nonce} deposits, values ${sum(pre.list)} for deposited ${p.deposited}${pre.alike ? "" : ", the two RPCs list different marks"}`);
  const spent = await marks(SPENT_LEN);
  say(spent.alike && BigInt(spent.list.length) === releases && sum(spent.list) === p.spent, `spent marks: ${spent.list.length} for ${releases} releases, withdrawn ${sum(spent.list)} for spent ${p.spent}${spent.alike ? "" : ", the two RPCs list different marks"}`);

  // the roots: each tree's newest page, its entries as many as the size says, its last root not zero, alike on both
  for (const [name, tree, t] of [["state", 0, p.state], ["label", 1, p.label]]) {
    if (t.size === 0n) {
      say(true, `${name} tree: empty, no page`);
      continue;
    }
    const no = Number((t.size - 1n) / BigInt(PAGE_ENTRIES));
    const n = Number(t.size - BigInt(no) * BigInt(PAGE_ENTRIES));
    const [ga, gb] = await acct(pda([Buffer.from("page"), Buffer.of(tree), le32(no)], c.program).address);
    const ok = ga && gb && ga.owner === c.program && Buffer.compare(Buffer.from(ga.data), Buffer.from(gb.data)) === 0 && ga.data.length === PAGE_HEADER + ENTRY * n;
    const root = ok ? Buffer.from(ga.data.subarray(PAGE_HEADER + ENTRY * (n - 1) + 32, PAGE_HEADER + ENTRY * (n - 1) + 64)) : null;
    say(ok && root.some((x) => x !== 0), `${name} tree: page ${no} holds ${n} entries alike on both, newest root ${root ? root.toString("hex") : "none"}`);
  }

  // the run's own: at least its deposits and releases
  for (const [k, v] of [["deposits", p.nonce], ["releases", releases]])
    if (expect[k] !== undefined) say(v >= BigInt(expect[k]), `${k}: ${v}, the run's record needs at least ${expect[k]}`);
  return { ok: !lines.some((l) => l.startsWith("FAIL")), lines, books: { deposits: p.nonce, releases, deposited: p.deposited, spent: p.spent } };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
  try {
    const cluster = opt("--cluster", "mainnet");
    if (!CLUSTERS[cluster]) throw new Error(`--cluster mainnet|devnet, not ${cluster}`);
    const expect = Object.fromEntries((opt("--expect", "") || "").split(",").filter(Boolean).map((kv) => kv.split("=")));
    for (const [k, v] of Object.entries(expect)) if (!["deposits", "releases"].includes(k) || !/^\d+$/.test(v ?? "")) throw new Error(`--expect ${k}=${v}: want deposits=N,releases=N`);
    const rpcs = opt("--rpc") ? opt("--rpc").split(",") : undefined;
    const rec = recorder();
    const r = await check({ cluster, expect, rpcs, fetchFn: opt("--record") ? rec.fetchFn : fetch });
    if (opt("--record")) writeFileSync(opt("--record"), JSON.stringify({ cluster, expect, rpcs: rpcs ?? CLUSTERS[cluster].rpcs, answers: rec.answers }) + "\n");
    for (const l of r.lines) console.log(`live-check ${KEY}: ${l}`);
    console.log(`live-check ${KEY}: ${r.ok ? "PASS" : "FAIL"}`);
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ${e instanceof NoAnswer ? "INCONCLUSIVE" : "ERROR"}: ${String(e.message).split("\n")[0]}`);
    process.exit(e instanceof NoAnswer ? EXIT.INCONCLUSIVE : EXIT.ERROR);
  }
}
