#!/usr/bin/env node
// Live check of card pool-sol-deploy-mainnet: the Blindfill pool program on Solana mainnet, deployed by the owner's paste
// (contracts/pool-solana/scripts/mainnet-deploy.sh), nobody able to upgrade it or its buy's lookup table. On mainnet's two
// RPCs of two operators (pool-sol-deploy.mjs MAINNET_RPCS), each answering mainnet's genesis hash, it reads (the check
// is pool-sol-deploy.mjs's, mainnet mode):
//   - the program: executable, the upgradeable loader's, pointing at the programdata its id derives;
//   - the programdata: upgrade authority none, code sha256 of the record's so_len bytes equal to the record's, which the
//     deploy refused unless it was the pin (contracts/pool-solana/scripts/pin.mjs), every byte after it 0;
//   - the pool at ["pool"]: the program's, POOL_LEN bytes, "bfpool01", its canonical bump;
//   - the lookup table: the table program's, active, authority none, exactly the record's list in order, a list that
//     holds this pool and its pages up to entry 2,047 of each tree;
//   - the programdata and the table the same bytes on both RPCs;
//   - every funder of the run at 0 lamports.
//   node scripts/live-checks/pool-sol-deploy-mainnet.mjs [--deployment <file>] [--rpc <url>,<url>] [--record <file>] [--write-record]
//     PASS exit 0, FAIL exit 1, error exit 2
// --record writes every RPC answer read to <file> (the paste records the good answer with it); --write-record, on PASS,
// writes the run record scripts/live-checks/pool-sol-deploy-mainnet.md (Money path: yes, one Tx: solana line per tx).
// Runs: once, a contract deploy's read-back; no host deploy changes it
import "../net-window.mjs";
import { readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { check, mainnetRunRecord, recorder, MAINNET_RPCS } from "./pool-sol-deploy.mjs";

const KEY = "pool-sol-deploy-mainnet";
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEPLOYMENT = path.join(HERE, "../../contracts/pool-solana/deployments/mainnet.json");
export const RECORD = path.join(HERE, `${KEY}.md`);

/** The journals of earlier pastes that stopped (contracts/pool-solana/deployments/mainnet.attempt-<n>.journal.json, kept
 * and committed as they were), oldest first, for the run's record to name. */
export function earlierAttempts(dir = path.dirname(DEPLOYMENT)) {
  return readdirSync(dir)
    .map((f) => [f, /^mainnet\.attempt-(\d+)\.journal\.json$/.exec(f)])
    .filter(([, m]) => m)
    .map(([f, m]) => ({ n: Number(m[1]), file: `contracts/pool-solana/deployments/${f}`, journal: JSON.parse(readFileSync(path.join(dir, f), "utf8")) }))
    .sort((a, b) => a.n - b.n);
}

/** The check on a mainnet record: pool-sol-deploy.mjs's, mainnet mode, on mainnet's two RPCs unless told otherwise. */
export const checkMainnet = ({ deployment, fetchFn = fetch, rpcs = MAINNET_RPCS, sleep }) => check({ deployment, fetchFn, rpcs, sleep, mainnet: true });

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (n, dflt) => (args.includes(n) ? args[args.indexOf(n) + 1] : dflt);
  try {
    const deployment = JSON.parse(readFileSync(opt("--deployment", DEPLOYMENT), "utf8"));
    const rpcs = opt("--rpc") ? opt("--rpc").split(",") : MAINNET_RPCS;
    const rec = recorder();
    const r = await checkMainnet({ deployment, rpcs, fetchFn: opt("--record") ? rec.fetchFn : fetch });
    if (opt("--record")) writeFileSync(opt("--record"), JSON.stringify({ deployment, rpcs, answers: rec.answers }) + "\n");
    for (const l of r.lines) console.log(`live-check ${KEY}: ${l}`);
    console.log(`live-check ${KEY}: ${r.ok ? "PASS" : "FAIL"}`);
    if (r.ok && args.includes("--write-record")) {
      writeFileSync(RECORD, mainnetRunRecord(deployment, rpcs, earlierAttempts(), r.foreign));
      console.log(`live-check ${KEY}: wrote ${path.relative(process.cwd(), RECORD)}`);
    }
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${String(e.message).split("\n")[0]}`);
    process.exit(2);
  }
}
