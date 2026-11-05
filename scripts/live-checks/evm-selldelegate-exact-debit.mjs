#!/usr/bin/env node
// Live check of card evm-selldelegate-exact-debit: the sell delegate with the exact-debit check (SellDelegate.sell
// reverts unless W's balance of the token sold fell by exactly the signed amount, on v3 and v4) redeployed alone
// (contracts/pool-evm/script/deploy.mjs --only SellDelegate) on Base Sepolia and Robinhood testnet, pinned by the kit,
// and sold through on each chain.
//   - Each redeploy (evm-selldelegate-exact-debit.<chain>.json), on two RPCs of two operators: the checks of
//     evm-sell-v4.mjs (its code, both immutables and getters, no admin, the run's transactions, the swept run key), with
//     its code the build with the exact-debit check, frozen to these redeploys' addresses (pool-evm-deploy.build.json
//     `frozen` "SellDelegate.exact-debit") since pool review round 2 moved the build on; and the kit's pinned
//     sellDelegate for the chain is the record's address.
//   - Each testnet run through it (evm-selldelegate-exact-debit.run.<chain>.json, written by
//     contracts/pool-evm/script/testnet-run.mjs --out; a run that stopped part way, .run.<chain>.stopped[-n].json, is
//     read back too): pool-evm-testnet-run.mjs's check (every transaction read back on both RPCs, each sell a type 4
//     transaction whose one authorization names the delegate redeployed before the run, its pool deposit, W's
//     designator), and every chain has a run that sold.
//   node scripts/live-checks/evm-selldelegate-exact-debit.mjs [--record <file>] [--write-record]
//     PASS exit 0, FAIL exit 1, error exit 2
// --record writes { notes, rpcs, deployments, good, runs } to <file> (evm-selldelegate-exact-debit.answers.json, which
// the test replays); --write-record, on PASS, writes the run record evm-selldelegate-exact-debit.md (Money path: yes,
// one Tx line per transaction of the redeploys and the runs), which the money gate reads back.
// Runs: once, a contract deploy and its testnet runs read back on chain; no host deploy changes them
import "../net-window.mjs";
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evmPoolVenues } from "../../packages/kit/src/index.ts";
import { check as sellCheck, runRecordFor } from "./evm-sell-v4.mjs";
import { BUILD, pinnedBuild, recorder as deployRecorder } from "./pool-evm-deploy.mjs";
import { recorder as runRecorder } from "./notes-per-pool-evm.mjs";
import { check as runCheck, runRecord as runLinesOf, spoil } from "./pool-evm-testnet-run.mjs";

export const KEY = "evm-selldelegate-exact-debit";
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CHAINS = Object.freeze(["base-sepolia", "robinhood-testnet"]);
export const deployFile = (c) => path.join(HERE, `${KEY}.${c}.json`);
/** Each chain's run, then its runs that stopped part way (`.run.<chain>.stopped[-n].json`), in name order */
export const runFiles = (c) => readdirSync(HERE).filter((f) => f === `${KEY}.run.${c}.json` || new RegExp(`^${KEY}\\.run\\.${c}\\.stopped(-\\d+)?\\.json$`).test(f)).sort((a, b) => (a.endsWith(`${c}.json`) ? -1 : b.endsWith(`${c}.json`) ? 1 : a.localeCompare(b))).map((f) => path.join(HERE, f));
const RUN_RECORD = path.join(HERE, `${KEY}.md`);

/** evm-sell-v4's check on the exact-debit build frozen to this record's address, plus: the kit pins this record's
 * delegate on its chain */
export async function check(o) {
  const r = await sellCheck(o);
  const a = String(o.deployment?.contracts?.SellDelegate?.address ?? "").toLowerCase();
  const frozen = BUILD.frozen?.["SellDelegate.exact-debit"];
  const pinned = !!frozen && pinnedBuild(o.deployment?.chain, "SellDelegate", a) === frozen;
  r.lines.push(`${pinned ? "ok  " : "FAIL"} SellDelegate ${a} is pinned to the exact-debit build the build file froze`);
  const venues = o.venues ?? evmPoolVenues();
  const pin = Object.hasOwn(venues, o.deployment?.chain) ? venues[o.deployment.chain].sellDelegate : undefined;
  const pass = !!pin && pin.toLowerCase() === a;
  r.lines.push(`${pass ? "ok  " : "FAIL"} the kit pins SellDelegate ${a} on ${o.deployment?.chain}: ${pin ?? "none"}`);
  return { ok: r.ok && pinned && pass, lines: r.lines };
}

/** The runs through the delegate: each read back, and each chain with a run that sold through this card's delegate */
export async function checkRuns(runs, transportOf, deployments) {
  const lines = [];
  let ok = true;
  for (const run of runs) {
    const r = await runCheck(run.record, transportOf(run), run.urls);
    for (const l of r.lines) lines.push(`${r.ok ? "ok  " : "FAIL"} run ${run.record.chain}: ${l}`);
    ok &&= r.ok;
  }
  for (const c of CHAINS) {
    const d = String(deployments[c]?.contracts?.SellDelegate?.address ?? "").toLowerCase();
    const sold = runs.some((x) => x.record.chain === c && !x.record.stopped && Date.parse(x.record.at) >= Date.parse(deployments[c]?.at) && x.record.txs.some((t) => t.kind === "sell"));
    lines.push(`${sold ? "ok  " : "FAIL"} ${c}: a run that sold, after the redeploy of ${d || "(none)"}`);
    ok &&= sold;
  }
  return { ok, lines };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
  try {
    const out = { notes: [], rpcs: {}, deployments: {}, good: {}, runs: [] };
    let ok = true;
    for (const c of CHAINS) {
      if (!existsSync(deployFile(c))) throw new Error(`no record ${path.basename(deployFile(c))}`);
      const d = JSON.parse(readFileSync(deployFile(c), "utf8"));
      const rec = deployRecorder();
      const r = await check({ deployment: d, fetchFn: rec.fetchFn });
      for (const l of r.lines) console.log(`live-check ${KEY} ${c}: ${l}`);
      ok &&= r.ok;
      Object.assign(out.deployments, { [c]: d });
      Object.assign(out.rpcs, { [c]: [...new Set(rec.answers.map((a) => a.url))].slice(0, 2) });
      Object.assign(out.good, { [c]: rec.answers });
    }
    const recs = new Map();
    const runs = CHAINS.flatMap(runFiles).map((f) => {
      const record = JSON.parse(readFileSync(f, "utf8"));
      return { record, urls: undefined, file: path.basename(f) };
    });
    const r = await checkRuns(runs, (run) => {
      const x = runRecorder();
      recs.set(run, x);
      return x.transport;
    }, out.deployments);
    for (const l of r.lines) console.log(`live-check ${KEY}: ${l}`);
    ok &&= r.ok;
    for (const run of runs) {
      const log = recs.get(run).log;
      out.runs.push({ record: run.record, urls: [...new Set(log.map((a) => a.url))].slice(0, 2), good: log, bad: spoil(log) });
    }
    if (opt("--record")) {
      out.notes.push(`Recorded ${new Date().toISOString()} by: node scripts/live-checks/${KEY}.mjs --record; the deployed chains and the runs through the delegate. ${KEY}.test.mjs makes each bad answer from the good ones; each run's bad answers are pool-evm-testnet-run's spoil (a spent nullifier the pool never marked).`);
      writeFileSync(opt("--record"), JSON.stringify(out) + "\n");
    }
    console.log(`live-check ${KEY}: ${ok ? "PASS" : "FAIL"}`);
    if (ok && args.includes("--write-record")) {
      const ds = CHAINS.map((c) => out.deployments[c]);
      const head = runRecordFor(KEY, ds).split("\n");
      const runText = runLinesOf(runs.map((x) => x.record)).split("\n");
      const tx = [...head.filter((l) => l.startsWith("Tx: ")), ...runText.filter((l) => l.startsWith("Tx: "))];
      const text = [head[0], head[1], ...tx, "", ...head.filter((l) => !l.startsWith("Tx: ")).slice(2), ...runText.filter((l) => !l.startsWith("Tx: ")).slice(2)].join("\n");
      writeFileSync(RUN_RECORD, text);
      console.log(`live-check ${KEY}: wrote ${path.relative(process.cwd(), RUN_RECORD)}`);
    }
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${String(e.message).split("\n")[0]}`);
    process.exit(2);
  }
}
