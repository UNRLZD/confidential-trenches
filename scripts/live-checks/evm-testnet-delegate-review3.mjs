#!/usr/bin/env node
// Live check of card evm-testnet-delegate-review3: the testnet pools sell through the SellDelegate at the pool-review-3
// build (the 11-field Sell the kit, the signing page and the helper build, its fee paid to the Sell's feeRecipient),
// redeployed alone (contracts/pool-evm/script/deploy.mjs --only SellDelegate) on Base Sepolia and Robinhood testnet,
// pinned by the kit, and sold through by HELPER_HOST on each chain. For each redeploy
// (evm-testnet-delegate-review3.<chain>.json), on two RPCs of two operators:
//   - the checks of evm-sell-v4.mjs (its code, both immutables and getters, no admin, the run's transactions, the swept
//     run key) with `current`: its code the current build of pool-evm-deploy.build.json, never one the build file froze
//     (main's pins at the exact-debit delegates held a frozen 10-field build and passed evm-venues-pin);
//   - its code dispatches the 11-field sell the kit signs (PUSH4 0x0c2cb9ca, pool-evm-testnet-run.mjs SELL_SELECTOR)
//     and not the 10-field one (0xbea5695c, SELL_SELECTOR_10), which main's pinned delegates dispatch;
//   - the kit's pinned sellDelegate for the chain is the record's address.
// Then:
//   - HELPER_HOST's fee answer for each testnet pool (GET /v1/pool/fee?pool=): fee_collector is the kit's feeCollector
//     pin and sell_sender the kit's sellSender pin;
//   - each run through it (evm-testnet-delegate-review3.run.<chain>.json, written by contracts/pool-evm/script/
//     testnet-run.mjs --sell-helper --out): pool-evm-testnet-run's checkSells (the whole run on both RPCs, each helper
//     sell a type-4 transaction from the fee answer's sell_sender whose one authorization names the record's delegate),
//     and each helper sell's receipt, on both RPCs, carries the kit's FeeCollector's Paid(W, fee): from the collector,
//     topics [Paid, W], one data word at least the sell's fee; and every chain has a run that sold through the helper
//     after its redeploy.
//   node scripts/live-checks/evm-testnet-delegate-review3.mjs [--base <url>] [--record <file>] [--write-record]
//     PASS exit 0, FAIL exit 1, error exit 2
// --record writes { notes, rpcs, deployments, good, bad, helper, runs } to <file> (evm-testnet-delegate-review3.answers.json,
// which the test replays), keeping the file's recorded bad answers (main 0628a2d5's pins); --write-record, on PASS,
// writes the run record evm-testnet-delegate-review3.md (Money path: yes, one Tx line per transaction of the redeploys,
// the runs and each run key's funding), which the money gate reads back.
// Runs: after each helper deploy (scripts/ci/helper-live-checks.mjs): the fee answer is HELPER_HOST's; the rest is
// chain state that a later deploy cannot change but a kit pin move would
import "../net-window.mjs";
import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evmPoolVenues } from "../../packages/kit/src/index.ts";
import { check as sellCheck, runRecordFor } from "./evm-sell-v4.mjs";
import { BASE, checkSells } from "./helper-evm-sender.mjs";
import { recorder as runRecorder } from "./notes-per-pool-evm.mjs";
import { keccak, recorder as deployRecorder, rpc } from "./pool-evm-deploy.mjs";
import { RPCS as RUN_RPCS, SELL_SELECTOR, SELL_SELECTOR_10, runRecord as runLinesOf, spoil } from "./pool-evm-testnet-run.mjs";

export const KEY = "evm-testnet-delegate-review3";
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CHAINS = Object.freeze(["base-sepolia", "robinhood-testnet"]);
export const deployFile = (c) => path.join(HERE, `${KEY}.${c}.json`);
export const runFile = (c) => path.join(HERE, `${KEY}.run.${c}.json`);
/** The chain's runs through the helper: the one that sold (runFile), then each stopped one (`.stopped-<n>.json`, its
 *  record carrying why it stopped), read back the same way */
export const runFiles = (c) => [runFile(c), ...readdirSync(HERE).filter((f) => f.startsWith(`${KEY}.run.${c}.stopped-`) && f.endsWith(".json")).sort().map((f) => path.join(HERE, f))].filter(existsSync);
const ANSWERS = path.join(HERE, `${KEY}.answers.json`);
const RUN_RECORD = path.join(HERE, `${KEY}.md`);
// FeeCollector's Paid(address indexed from, uint256 value) (contracts/pool-evm/src/FeeCollector.sol)
export const PAID = keccak(new TextEncoder().encode("Paid(address,uint256)"));
const lower = (a) => String(a ?? "").toLowerCase();
const ADDRESS = /^0x[0-9a-f]{40}$/;
// The fundings of the redeploys' run keys from the team's testnet wallet E (scripts/devwallet/devwallet-evm.mjs,
// research repo), each read back as succeeded on both of its chain's RPCs, 6 Nov 17:04Z
export const FUNDINGS = Object.freeze({
  "base-sepolia": "0xe8d66aff401710d088505b78efdaae4fc9c485f26b901cd08d0fa678e545c54c",
  "robinhood-testnet": "0x372530f30ff7b2f84c7d368e24b1c991e9f05389ade7ec7b8e2145b1517052fa",
});
const push4 = (sel) => `63${sel.slice(2)}`;

/** evm-sell-v4's check with `current` (the build, never a frozen one), plus: the code at the record's address dispatches
 *  the 11-field sell and not the 10-field one on both RPCs, and the kit pins that address */
export async function check(o) {
  const r = await sellCheck({ ...o, current: true });
  const a = String(o.deployment?.contracts?.SellDelegate?.address ?? "").toLowerCase();
  let ok = r.ok;
  for (const url of (o.rpcs ?? []).slice(0, 2)) {
    let pass = false;
    let said = "";
    try {
      const code = String(await rpc(o.fetchFn, url, "eth_getCode", [a, "latest"], o.sleep)).toLowerCase();
      const has11 = code.includes(push4(SELL_SELECTOR));
      const has10 = code.includes(push4(SELL_SELECTOR_10));
      pass = has11 && !has10;
      said = `${SELL_SELECTOR} ${has11 ? "dispatched" : "absent"}, ${SELL_SELECTOR_10} ${has10 ? "dispatched" : "absent"}`;
    } catch (e) {
      said = String(e.message).split("\n")[0];
    }
    r.lines.push(`${pass ? "ok  " : "FAIL"} SellDelegate ${a} dispatches the 11-field sell the kit signs, not the 10-field one, on ${url}: ${said}`);
    ok &&= pass;
  }
  const venues = o.venues ?? evmPoolVenues();
  const pin = Object.hasOwn(venues, o.deployment?.chain) ? venues[o.deployment.chain].sellDelegate : undefined;
  const pinned = !!pin && pin.toLowerCase() === a;
  r.lines.push(`${pinned ? "ok  " : "FAIL"} the kit pins SellDelegate ${a} on ${o.deployment?.chain}: ${pin ?? "none"}`);
  return { ok: ok && pinned, lines: r.lines };
}

// The fundings of the sell runs' run keys from wallet E, by run key, each read back as succeeded on both of its
// chain's RPCs, 6 Nov 18:21-18:51Z
export const RUN_FUNDINGS = Object.freeze({
  // robinhood-testnet, the run that sold
  "0x07aae601c1f2c9178680624134d2b3d928b2631a": "0x76880738426140d5e7f25a81fb61d5f40bf58a91aa0b044fcf5d57860a031c11",
  // base-sepolia: run 1, its syncs held at sepolia.base.org's 200-block log cap (its own entry when it ends)
  "0x75cafd9315fcc8a68aa75c8437f381a4dfa51431": "0x43c3add967cbe23d14d26d8150eae4813f079c195b8564a9e49eefac7a4df5b9",
  // base-sepolia: run 2, stopped (v4 had no liquidity)
  "0xa25c61ded77b60653a7eedec8d11ca275f68147b": "0xce1abea343de87a3bad0835d52a9bdad65244e29d807bc1ae7e5948064cb8f52",
  // base-sepolia: run 3, the run that sold (v3)
  "0xf8351fe1ddc748f51c08b42d14868abf181d8c4a": "0x0047b367037dbf268969919630fb7e8c41f9e5266a8fa8893378a8150289c267",
});
const E = "0x49f2425b7f33f3a10912de8add6839226ce663a2";

/** The run record: runRecordFor's (each redeploy's deploy and sweep) and each run's (pool-evm-testnet-run's), with each
 *  run key's funding from E */
export function runRecord(ds, runs = [], runFundings = RUN_FUNDINGS, paid = []) {
  const head = runRecordFor(KEY, ds).split("\n");
  const fund = ds.map((d) => `Tx: ${d.chain} ${FUNDINGS[d.chain]}`);
  const i = head.findIndex((l) => l === "");
  const notes = ds.map((d) => `${d.chain}: the run key ${d.deployer} was funded from the team's testnet wallet E (${E}) by ${FUNDINGS[d.chain]}, read back as succeeded on both RPCs.`);
  if (runs.length === 0) return [...head.slice(0, i), ...fund, ...head.slice(i), ...notes, ""].join("\n");
  const fundOf = (r) => runFundings[String(r.relayer).toLowerCase()];
  for (const r of runs) if (!/^0x[0-9a-f]{64}$/.test(fundOf(r) ?? "")) throw new Error(`no funding recorded for the ${r.chain} run's key ${r.relayer}`);
  const run = runLinesOf(runs).split("\n");
  const runTx = run.filter((l) => l.startsWith("Tx: "));
  const runFund = runs.map((r) => `Tx: ${r.chain} ${fundOf(r)}`);
  const runNotes = runs.map((r) => `${r.chain}: the sell run's key ${r.relayer} was funded from the team's testnet wallet E (${E}) by ${fundOf(r)}, read back as succeeded on both RPCs.`);
  for (const p of paid) runNotes.push(`${p.chain}: the helper's sell ${p.hash} carries Paid(from ${p.w}, value ${p.value} wei), emitted by the FeeCollector ${p.collector}, the kit's pin, on ${p.urls.join(" and ")}.`);
  return [...head.slice(0, i), ...fund, ...runTx, ...runFund, ...head.slice(i), ...notes, ...runNotes, "", ...run.slice(run.findIndex((l) => l === "") + 1)].join("\n");
}

/** HELPER_HOST's fee answer for each chain's pool: its fee_collector and sell_sender are the kit's pins; the senders */
export function checkHelper(answers, venues = evmPoolVenues()) {
  const lines = [];
  const senders = {};
  for (const c of CHAINS) {
    const a = (answers ?? []).find((x) => x.network === c);
    let b = null;
    try {
      b = a && a.status === 200 ? JSON.parse(a.body) : null;
    } catch {}
    const v = venues[c] ?? {};
    const col = lower(b?.fee_collector);
    const snd = lower(b?.sell_sender);
    lines.push(`${ADDRESS.test(col) && col === lower(v.feeCollector) ? "ok  " : "FAIL"} ${c}: the helper's fee answer names the fee collector ${b?.fee_collector ?? "(none)"}, the kit's pin ${v.feeCollector ?? "(none)"} (status ${a?.status ?? "none"})`);
    lines.push(`${ADDRESS.test(snd) && snd === lower(v.sellSender) ? "ok  " : "FAIL"} ${c}: the helper's fee answer names the sell sender ${b?.sell_sender ?? "(none)"}, the kit's pin ${v.sellSender ?? "(none)"}`);
    senders[c] = ADDRESS.test(snd) ? snd : null;
  }
  return { ok: lines.every((l) => l.startsWith("ok")), lines, senders };
}

/** Whether receipt `r` carries `collector`'s Paid(W, value >= fee), not removed */
export function paidIn(r, collector, w, fee) {
  const word = (x) => "0x" + lower(x).replace(/^0x/, "").padStart(64, "0");
  return (r?.logs ?? []).some((l) => l && l.removed !== true && lower(l.address) === collector && Array.isArray(l.topics) && l.topics.length === 2 && lower(l.topics[0]) === PAID && lower(l.topics[1]) === word(w) && /^0x[0-9a-f]{64}$/.test(lower(l.data)) && BigInt(l.data) >= fee);
}

/** The runs through the delegate: checkSells, each helper sell's Paid log on both RPCs, and each chain with a helper
 *  sell after its redeploy */
export async function checkRuns(runs, transportOf, deployments, senders, venues = evmPoolVenues()) {
  const s = await checkSells(runs, transportOf, senders);
  const lines = s.lines.map((l) => (l.startsWith("ok ") ? `ok   ${l.slice(3)}` : `FAIL ${l.slice(4)}`));
  let ok = s.ok;
  const paid = [];
  for (const run of runs) {
    const rec = run.record;
    const collector = lower(venues[rec.chain]?.feeCollector);
    const urls = run.urls ?? RUN_RPCS[rec.chain];
    const transport = transportOf(run);
    for (const t of rec.txs.filter((x) => x.kind === "sell" && x.via === "helper")) {
      let pass = false;
      let said = "";
      try {
        // sell(Sell, uint256 fee, bytes): the fee is the call's second head word
        const tx = await transport(urls[0], "eth_getTransactionByHash", [t.hash]);
        const fee = BigInt(`0x${String(tx.result?.input).slice(10 + 64, 10 + 128)}`);
        const rs = await Promise.all(urls.map((u) => transport(u, "eth_getTransactionReceipt", [t.hash])));
        pass = ADDRESS.test(collector) && fee > 0n && rs.every((x) => !("error" in x) && x.result?.status === "0x1" && paidIn(x.result, collector, t.w, fee));
        const log = pass ? rs[0].result.logs.find((l) => lower(l.address) === collector && lower(l.topics?.[0]) === PAID) : null;
        if (log) paid.push({ chain: rec.chain, hash: t.hash, collector, w: lower(t.w), value: String(BigInt(log.data)), urls });
        said = `fee ${fee}${log ? `, Paid value ${BigInt(log.data)}` : ""}`;
      } catch (e) {
        said = String(e.message).split("\n")[0];
      }
      lines.push(`${pass ? "ok  " : "FAIL"} ${rec.chain} sell ${t.hash}: its receipt carries the FeeCollector ${collector || "(none)"}'s Paid(W ${lower(t.w)}, at least the fee) on ${urls.join(" and ")}: ${said}`);
      ok &&= pass;
    }
  }
  for (const c of CHAINS) {
    const d = deployments[c];
    const sold = runs.some((x) => x.record.chain === c && !x.record.stopped && Date.parse(x.record.at) >= Date.parse(d?.at) && x.record.txs.some((t) => t.kind === "sell" && t.via === "helper"));
    lines.push(`${sold ? "ok  " : "FAIL"} ${c}: a run that sold through the helper, after the redeploy of ${lower(d?.contracts?.SellDelegate?.address) || "(none)"}`);
    ok &&= sold;
  }
  return { ok, lines, paid };
}

/** HELPER_HOST's fee answer for each chain's pool (the kit's pinned pool) */
export async function readHelper(base, fetchFn = fetch, venues = evmPoolVenues()) {
  const out = [];
  for (const c of CHAINS) {
    const pool = venues[c]?.pool;
    const r = await fetchFn(`${base}/v1/pool/fee?pool=${encodeURIComponent(pool)}`, { redirect: "error", signal: AbortSignal.timeout(15_000) });
    out.push({ network: c, pool, status: r.status, body: (await r.text()).slice(0, 2_000), commit: r.headers.get("x-helper-commit") });
  }
  return out;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
  try {
    const out = { notes: [], rpcs: {}, deployments: {}, good: {}, helper: [], runs: [] };
    let ok = true;
    for (const c of CHAINS) {
      if (!existsSync(deployFile(c))) throw new Error(`no record ${path.basename(deployFile(c))}`);
      const d = JSON.parse(readFileSync(deployFile(c), "utf8"));
      const rec = deployRecorder();
      const { CHAINS: DEPLOYED } = await import("./pool-evm-deploy.mjs");
      const r = await check({ deployment: d, fetchFn: rec.fetchFn, rpcs: DEPLOYED[c].rpcs });
      for (const l of r.lines) console.log(`live-check ${KEY} ${c}: ${l}`);
      ok &&= r.ok;
      Object.assign(out.deployments, { [c]: d });
      Object.assign(out.rpcs, { [c]: DEPLOYED[c].rpcs.slice(0, 2) });
      Object.assign(out.good, { [c]: rec.answers });
    }
    out.helper = await readHelper(opt("--base") ?? BASE);
    const h = checkHelper(out.helper);
    for (const l of h.lines) console.log(`live-check ${KEY}: ${l}`);
    ok &&= h.ok;
    const recs = new Map();
    const runs = CHAINS.flatMap((c) => runFiles(c).map((f) => ({ record: JSON.parse(readFileSync(f, "utf8")), urls: RUN_RPCS[c] })));
    const r = await checkRuns(runs, (run) => {
      if (!recs.has(run)) recs.set(run, runRecorder());
      return recs.get(run).transport;
    }, out.deployments, h.senders);
    for (const l of r.lines) console.log(`live-check ${KEY}: ${l}`);
    ok &&= r.ok;
    for (const run of runs) {
      const log = recs.get(run)?.log ?? [];
      out.runs.push({ record: run.record, urls: run.urls, good: log, bad: spoil(log) });
    }
    if (opt("--record")) {
      // the bad answers are main 0628a2d5's pins, read once; a later recording keeps them
      const prev = existsSync(ANSWERS) ? JSON.parse(readFileSync(ANSWERS, "utf8")) : {};
      out.bad = prev.bad ?? {};
      out.notes.push(`Recorded ${new Date().toISOString()} by: node scripts/live-checks/${KEY}.mjs --record; the redeploys at the kit's pins, HELPER_HOST's fee answers (commit ${out.helper.map((x) => x.commit).join(", ")}) and the runs through the delegate; each run's bad answers are pool-evm-testnet-run's spoil (a spent nullifier the pool never marked).`, ...(prev.notes ?? []).filter((n) => n.startsWith("bad: ")));
      writeFileSync(opt("--record"), JSON.stringify(out) + "\n");
    }
    console.log(`live-check ${KEY}: ${ok ? "PASS" : "FAIL"}`);
    if (ok && args.includes("--write-record")) {
      writeFileSync(RUN_RECORD, runRecord(CHAINS.map((c) => out.deployments[c]), runs.map((x) => x.record), RUN_FUNDINGS, r.paid));
      console.log(`live-check ${KEY}: wrote ${path.relative(process.cwd(), RUN_RECORD)}`);
    }
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${String(e.message).split("\n")[0]}`);
    process.exit(2);
  }
}
