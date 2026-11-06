#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Live check of card pool-sol-deploy-after-run: no lamport of the owner's is left behind a key of the Solana pool
// deploy's runs on mainnet. It takes the deployment record (contracts/pool-solana/deployments/mainnet.json) and every
// journal kept beside it (mainnet.*.journal.json: the pastes that stopped, and paste 2's own), and on mainnet's two RPCs
// of two operators (pool-sol-deploy.mjs MAINNET_RPCS), each answering mainnet's genesis hash, reads at finalized:
//   - every run key they name: each funder, each payer of the record that is a run key (pool-sol-deploy.mjs payersOf:
//     only a payer whose every transaction in the record is one plain System Transfer into a run key is a funding
//     wallet, its balance its own), and each buffer named by a `buffer` field: 0 lamports, or FAIL;
//   - each buffer the runs deployed through or closed, read from their own transactions (the upgradeable loader's
//     DeployWithMaxDataLen, its buffer at accounts[3]; its Close, the account closed at accounts[0]): 0 lamports;
//   - each program id: no lamports, or a deployed program (executable, the upgradeable loader's), whose rent is its own.
//   node scripts/live-checks/pool-sol-deploy-after-run.mjs [--rpc <url>,<url>] [--record <file>]
//     PASS exit 0, FAIL exit 1, error exit 2
// --record writes the inputs and every RPC answer read to <file>, for the test's replay.
// Runs: once, a contract deploy's read-back (the mainnet pool's run keys); no host deploy changes it
import "../net-window.mjs";
import { readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LOADER_V3, MAINNET_GENESIS, MAINNET_RPCS, b58decode, operatorProblems, payersOf, recorder, rpc } from "./pool-sol-deploy.mjs";

const KEY = "pool-sol-deploy-after-run";
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DIR = path.join(HERE, "../../contracts/pool-solana/deployments");

/** What the check reads from the committed files: the record and each kept journal's run keys and transactions. */
export function inputs(dir = DIR) {
  const read = (f) => JSON.parse(readFileSync(path.join(dir, f), "utf8"));
  const pick = (file, d) => ({
    file, funder: d.funder ?? null, funders: d.funders ?? null, return_to: d.return_to, program_id: d.program_id ?? null, buffer: d.buffer ?? null,
    txs: (d.txs ?? []).filter((t) => (t.state ?? "landed") === "landed" && !t.cli).map(({ step, signature }) => ({ step, signature })),
    // the CLI's own closes: the account each closed is a buffer (or the programdata) of the run's
    closes: (d.txs ?? []).filter((t) => t.state === "landed" && /program close/.test(t.step)).map((t) => t.signature),
  });
  const journals = readdirSync(dir).filter((f) => /^mainnet\..+\.journal\.json$/.test(f)).sort();
  return { record: pick("mainnet.json", read("mainnet.json")), journals: journals.map((f) => pick(f, read(f))) };
}

/** The loader instruction's account at `at` in `x` (getTransaction, json) whose u32 tag is `tag`: [] when none. */
const loaderAccounts = (x, tag, at) => {
  const keys = x?.transaction?.message?.accountKeys ?? [];
  return (x?.transaction?.message?.instructions ?? []).filter((i) => keys[i.programIdIndex] === LOADER_V3).filter((i) => {
    const d = b58decode(i.data);
    return d.length >= 4 && (d[0] | (d[1] << 8) | (d[2] << 16) | (d[3] << 24)) === tag;
  }).map((i) => keys[i.accounts[at]]).filter(Boolean);
};

export async function check({ record, journals, fetchFn = fetch, rpcs = MAINNET_RPCS, sleep }) {
  const lines = [];
  let ok = true;
  const say = (pass, text) => {
    ok &&= pass;
    lines.push(`${pass ? "ok  " : "FAIL"} ${text}`);
  };
  for (const p of operatorProblems(rpcs, "mainnet")) say(false, p);
  for (const url of rpcs.slice(0, 2)) {
    const at = `on ${url}`;
    try {
      const g = await rpc(fetchFn, url, "getGenesisHash", [], sleep);
      say(g === MAINNET_GENESIS, `genesis ${g} is mainnet's ${at}`);
      const keys = new Map(); // address -> why it is a run key
      const programs = new Map();
      const tx = (sig) => rpc(fetchFn, url, "getTransaction", [sig, { encoding: "json", commitment: "finalized", maxSupportedTransactionVersion: 0 }], sleep);
      for (const d of [record, ...journals]) {
        const name = d.file;
        if (d.funder) keys.set(d.funder, `${name}'s funder`);
        if (d.buffer) keys.set(d.buffer, `${name}'s buffer`);
        if (d.program_id) programs.set(d.program_id, `${name}'s program id`);
        if (d === record) {
          const kinds = (d.funders ?? []).some((f) => f !== d.funder) ? await payersOf(fetchFn, url, d, sleep) : { runKeys: d.funders ?? [], foreign: [] };
          for (const k of kinds.runKeys) if (!keys.has(k)) keys.set(k, `a run key paying ${name}'s transactions`);
          for (const f of kinds.foreign) lines.push(`info ${f} only funded ${name} (each of its transactions one plain System Transfer into a run key): its balance is its own ${at}`);
        }
        for (const t of d.txs.filter((x) => /^deploy with the upgradeable loader/.test(x.step))) {
          for (const b of loaderAccounts(await tx(t.signature), 2, 3)) keys.set(b, `the buffer ${name}'s deploy ${t.signature} drained`);
        }
        for (const sig of d.closes) for (const b of loaderAccounts(await tx(sig), 5, 0)) keys.set(b, `the account ${name}'s CLI closed in ${sig}`);
      }
      for (const [k, why] of keys) {
        const b = (await rpc(fetchFn, url, "getBalance", [k, { commitment: "finalized" }], sleep))?.value;
        say(b === 0, `${k} (${why}) holds 0 lamports ${at}: ${b}`);
      }
      for (const [p, why] of programs) {
        const a = (await rpc(fetchFn, url, "getAccountInfo", [p, { encoding: "base64", commitment: "finalized" }], sleep))?.value;
        const deployed = !!a && a.executable && a.owner === LOADER_V3;
        say(!a || a.lamports === 0 || deployed, `${p} (${why}) holds no lamports or is a deployed program ${at}: ${a ? `${a.lamports} lamports, owner ${a.owner}, executable ${a.executable}` : "no account"}`);
      }
    } catch (e) {
      say(false, `read ${at}: ${String(e.message).split("\n")[0]}`);
    }
  }
  return { ok, lines };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (n, dflt) => (args.includes(n) ? args[args.indexOf(n) + 1] : dflt);
  try {
    const { record, journals } = inputs();
    const rpcs = opt("--rpc") ? opt("--rpc").split(",") : MAINNET_RPCS;
    const rec = recorder();
    const r = await check({ record, journals, rpcs, fetchFn: opt("--record") ? rec.fetchFn : fetch });
    if (opt("--record")) writeFileSync(opt("--record"), JSON.stringify({ record, journals, rpcs, good: rec.answers }) + "\n");
    for (const l of r.lines) console.log(`live-check ${KEY}: ${l}`);
    console.log(`live-check ${KEY}: ${r.ok ? "PASS" : "FAIL"}`);
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${String(e.message).split("\n")[0]}`);
    process.exit(2);
  }
}
