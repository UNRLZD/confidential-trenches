#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Live check of card pool-sol-deploy-sweep: the Solana pool deploy gives back every lamport however it stops. It reads
// the journal of a devnet run of contracts/pool-solana/scripts/deploy.mjs that was stopped by SIGHUP (a terminal
// closing) during its funding wait, before any funding (pool-sol-deploy-sweep.devnet.journal.json, as deploy.mjs and
// its --sweep-kept wrote it: complete false, stopped_at, every transaction with its state, the keys' state). The run
// kept its keys; the funding landed after the run had ended, and the journal's own --sweep-kept command swept it back
// to the funding's source. On two RPCs of two operators, each answering devnet's genesis hash, it reads:
//   - every transaction of the journal: none is left "sent", and each landed one is found at finalized with no error;
//   - the funding: a System transfer that raised the funder's balance, in a block whose time is after the stop;
//   - the sweeps: each paid by the funder, each its one transfer to the run's return address or to a sender of the
//     funding, each in a slot after the funding's, the last one leaving the funder at 0;
//   - the funder now: 0 lamports at finalized, and the journal says its keys were removed, so no lamport is left
//     behind a run key.
//   node scripts/live-checks/pool-sol-deploy-sweep.mjs [--deployment <file>] [--rpc <url>,<url>] [--record <file>]
//     [--write-record]
//     PASS exit 0, FAIL exit 1, error exit 2
// --record writes every RPC answer read to <file>, for the test's replay. --write-record, on PASS, writes the run
// record scripts/live-checks/pool-sol-deploy-sweep.md (Money path: yes, one Tx line per transaction).
// Runs: once, a devnet run's read-back; no host deploy changes it
import "../net-window.mjs";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEVNET_GENESIS, RPCS, SYSTEM, operatorProblems, recorder, rpc } from "./pool-sol-deploy.mjs";

const KEY = "pool-sol-deploy-sweep";
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEPLOYMENT = path.join(HERE, `${KEY}.devnet.journal.json`);
export const RECORD = path.join(HERE, `${KEY}.md`);
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

export async function check({ deployment: d, fetchFn = fetch, rpcs = RPCS, sleep = sleepMs }) {
  const lines = [];
  let ok = true;
  const say = (pass, text) => {
    ok &&= pass;
    lines.push(`${pass ? "ok  " : "FAIL"} ${text}`);
  };
  say(d.cluster === "devnet" && d.genesis_hash === DEVNET_GENESIS, `the record is a devnet run's: ${d.cluster} ${d.genesis_hash}`);
  say(d.complete === false && ["SIGHUP", "SIGINT", "SIGTERM"].includes(d.stopped), `the run was stopped by a signal: ${d.stopped}`);
  const stopSec = Math.floor(Date.parse(d.stopped_at) / 1000);
  say(Number.isFinite(stopSec), `the journal says when the stop came: ${d.stopped_at}`);
  say(d.keys?.state === "removed", `the journal says the run's keys were removed: ${d.keys?.state} (${(d.keys?.why ?? []).join("; ")})`);
  for (const p of operatorProblems(rpcs, "devnet")) say(false, p);
  const open = d.txs.filter((t) => t.state !== "landed" && t.state !== "expired" && t.state !== "failed");
  say(open.length === 0, `no transaction of the record is left unsettled: ${open.map((t) => `${t.step} ${t.signature} ${t.state}`).join(", ") || "none"}`);
  const landed = d.txs.filter((t) => t.state === "landed");
  const funding = landed.filter((t) => t.step === "funding (to the funder)");
  const sweeps = landed.filter((t) => t.step.startsWith("sweep"));
  say(funding.length >= 1 && sweeps.length >= 1, `the record lists the funding and its sweep: ${funding.length} funding, ${sweeps.length} sweep(s)`);
  for (const url of rpcs.slice(0, 2)) {
    const at = `on ${url}`;
    const call = (m, p) => rpc(fetchFn, url, m, p, sleep);
    say((await call("getGenesisHash", [])) === DEVNET_GENESIS, `answers devnet's genesis hash ${at}`);
    const read = {};
    for (const t of landed) {
      const x = await call("getTransaction", [t.signature, { encoding: "json", commitment: "finalized", maxSupportedTransactionVersion: 0 }]);
      say(!!x && x.meta?.err === null, `${t.step} ${t.signature} is finalized with no error ${at}`);
      if (x) read[t.signature] = x;
    }
    const bal = (x, who) => {
      const i = x.transaction.message.accountKeys.indexOf(who);
      return i < 0 ? null : { pre: BigInt(x.meta.preBalances[i]), post: BigInt(x.meta.postBalances[i]) };
    };
    const fundSlot = Math.max(...funding.map((t) => read[t.signature]?.slot ?? Infinity));
    const senders = new Set();
    for (const t of funding) {
      const x = read[t.signature];
      const b = x && bal(x, d.funder);
      say(!!b && b.post > b.pre, `the funding ${t.signature} raised the funder's balance ${b ? `${b.pre} -> ${b.post}` : "(not read)"} ${at}`);
      say(!!x && x.blockTime >= stopSec, `the funding ${t.signature} landed after the stop: block time ${x?.blockTime} >= ${stopSec} ${at}`);
      const keys = x?.transaction.message.accountKeys ?? [];
      for (const ix of x?.transaction.message.instructions ?? []) if (keys[ix.programIdIndex] === SYSTEM && keys[ix.accounts[1]] === d.funder) senders.add(keys[ix.accounts[0]]);
    }
    sweeps.forEach((t, i) => {
      const x = read[t.signature];
      if (!x) return say(false, `the sweep ${t.signature} was read ${at}`);
      const keys = x.transaction.message.accountKeys;
      const ix = x.transaction.message.instructions[0];
      const to = keys[ix.accounts[1]];
      const toSystem = x.transaction.message.instructions.length === 1 && keys[ix.programIdIndex] === SYSTEM && (to === d.return_to || senders.has(to));
      say(keys[0] === d.funder && toSystem, `the sweep ${t.signature} is the funder's one transfer to the return address or the funding's sender (${to}) ${at}`);
      say(x.slot > fundSlot, `the sweep ${t.signature} (slot ${x.slot}) came after the funding (slot ${fundSlot}) ${at}`);
      if (i === sweeps.length - 1) say(bal(x, d.funder)?.post === 0n, `the last sweep left the funder at ${bal(x, d.funder)?.post} lamports ${at}`);
    });
    const now = BigInt((await call("getBalance", [d.funder, { commitment: "finalized" }])).value);
    say(now === 0n, `the funder ${d.funder} holds ${now} lamports at finalized ${at}`);
  }
  return { ok, lines };
}

/** The run record's text after a PASS: every landed transaction of the run, devnet, money path. */
export function runRecord(d, rpcs) {
  const landed = d.txs.filter((t) => t.state === "landed");
  return [
    `CARD ${KEY} / live: PASS`,
    "Money path: yes",
    ...landed.map((t) => `Tx: solana-devnet ${t.signature}`),
    "",
    `The run: contracts/pool-solana/scripts/deploy.mjs on Solana devnet, stopped by ${d.stopped} at ${d.stopped_at} during its funding wait, before any funding; it kept its keys. Its steps, in the order of the Tx lines above: ${landed.map((t) => t.step.replace(/ [1-9A-HJ-NP-Za-km-z]{32,44}/g, "")).join(", ")}.`,
    `The funding came after the run had ended, from the team's devnet wallet; the journal's --sweep-kept command swept it back to the funding's sender and removed the keys once the funder read 0. This live check reads the funder ${d.funder} at 0 lamports on ${rpcs.join(" and ")}. Its program id ${d.program_id} was never deployed.`,
    "The live check reads each Tx line above finalized with no error on both RPCs, every sweep after the funding's slot.",
    "",
  ].join("\n");
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (n, dflt) => (args.includes(n) ? args[args.indexOf(n) + 1] : dflt);
  try {
    const deployment = JSON.parse(readFileSync(opt("--deployment", DEPLOYMENT), "utf8"));
    const rpcs = opt("--rpc") ? opt("--rpc").split(",") : RPCS;
    const rec = recorder();
    const r = await check({ deployment, rpcs, fetchFn: opt("--record") ? rec.fetchFn : fetch });
    if (opt("--record")) writeFileSync(opt("--record"), JSON.stringify(rec.answers) + "\n");
    for (const l of r.lines) console.log(`live-check ${KEY}: ${l}`);
    console.log(`live-check ${KEY}: ${r.ok ? "PASS" : "FAIL"}`);
    if (r.ok && args.includes("--write-record")) {
      writeFileSync(RECORD, runRecord(deployment, rpcs));
      console.log(`live-check ${KEY}: wrote ${path.relative(process.cwd(), RECORD)}`);
    }
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${String(e.message).split("\n")[0]}`);
    process.exit(2);
  }
}
