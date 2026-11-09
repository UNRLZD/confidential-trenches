#!/usr/bin/env node
// Live check of card sol-pool-venue-tables: a private buy on Solana loads its accounts from a frozen address lookup table,
// one table per venue the kit builds (the kit's SOLANA_POOL_BUY_VENUES). For each cluster (mainnet, devnet) and each venue,
// from the deploy record contracts/pool-solana/deployments/<cluster>.json (`tables.<venue>`: table, addresses, txs):
//   - the venue is absent in the record, or the record file is: `<cluster> <venue>: not deployed yet`, a named state that is
//     neither a pass row nor a failure (no network read is made for it);
//   - the venue is there: on the cluster's two RPCs of two operators, both answering the cluster's genesis hash, the table
//     account read at finalized is the same bytes on both, owned by the address lookup table program, active (deactivation
//     slot u64 max), authority none (frozen), and holds exactly, in order, (a) the record's `addresses` and (b) the kit's
//     own list for the record's program_id and pool (solanaPoolVenueTableList over the venue's global account, which
//     readSolanaPoolTableVenue reads at finalized on the same two RPCs and which must agree there).
// The bytes are judged by contracts/pool-solana/scripts/deploy.mjs's tableProblems (the deploy's own read-back), not a
// second decoder.
//   node scripts/live-checks/sol-pool-venue-tables.mjs [--dir <deployments folder>] [--record <file>]
//     PASS exit 0 (every deployed row passes), FAIL exit 1, error exit 2. The last line names the counts:
//     `live-check sol-pool-venue-tables: PASS (1 deployed, 3 not deployed yet)`.
// --record writes every RPC answer read, with the records they were read for, to <file>.
// Runs: after a deploy that writes a table (the owner's paste, a devnet run); no host deploy changes it. Reads only.
import "../net-window.mjs";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as kit from "../../packages/kit/src/index.ts";
import { tableProblems } from "../../contracts/pool-solana/scripts/deploy.mjs";
import { account, ALT_PROGRAM, DEVNET_GENESIS, MAINNET_GENESIS, MAINNET_RPCS, operatorProblems, recorder, rpc, RPCS as DEVNET_RPCS } from "./pool-sol-deploy.mjs";

const KEY = "sol-pool-venue-tables";
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEPLOYMENTS = path.join(HERE, "../../contracts/pool-solana/deployments");
export const CLUSTERS = Object.freeze({
  mainnet: { rpcs: MAINNET_RPCS, genesis: MAINNET_GENESIS },
  devnet: { rpcs: DEVNET_RPCS, genesis: DEVNET_GENESIS },
});
export const VENUES = kit.SOLANA_POOL_BUY_VENUES;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** An address lookup table holds at most 256 addresses. */
const TABLE_MAX = 256;

/** The record file of `cluster` in `dir`, parsed, or null when there is none (the named state "not deployed yet"). */
export function readRecord(cluster, dir = DEPLOYMENTS) {
  const file = path.join(dir, `${cluster}.json`);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
}

/** What is wrong with a venue's entry in a record, as a list (the record is read, never trusted). */
function entryProblems(rec, cluster, entry) {
  const out = [];
  if (rec.cluster !== cluster) out.push(`the record's cluster is ${cluster}: ${String(rec.cluster).slice(0, 20)}`);
  for (const k of ["program_id", "pool"]) if (typeof rec[k] !== "string" || !BASE58.test(rec[k])) out.push(`the record's ${k} is not an address`);
  if (!entry || typeof entry !== "object" || typeof entry.table !== "string" || !BASE58.test(entry.table)) out.push("the record's table is not an address");
  else if (!Array.isArray(entry.addresses) || entry.addresses.length < 1 || entry.addresses.length > TABLE_MAX || !entry.addresses.every((a) => typeof a === "string" && BASE58.test(a))) {
    out.push(`the record's addresses are not a list of 1 to ${TABLE_MAX} addresses`);
  }
  return out;
}

/** One deployed row: the venue's table read on the cluster's two RPCs and judged. Returns { ok, lines }. */
async function checkRow({ cluster, venue, rec, fetchFn, sleep }) {
  const { rpcs, genesis } = CLUSTERS[cluster];
  const at = `${cluster} ${venue}`;
  const lines = [];
  let ok = true;
  const say = (pass, text) => {
    lines.push(`${pass ? "ok  " : "FAIL"} ${at}: ${text}`);
    ok &&= pass;
  };
  const entry = rec.tables[venue];
  const bad = entryProblems(rec, cluster, entry);
  bad.forEach((b) => say(false, b));
  if (bad.length) return { ok, lines };
  const op = operatorProblems(rpcs, cluster);
  say(op.length === 0, `the RPCs ${rpcs.join(" and ")} are two operators of ${cluster}${op.length ? `: ${op.join("; ")}` : ""}`);
  if (op.length) return { ok, lines };
  try {
    const call = rpcs.map((url) => Object.assign((method, params) => rpc(fetchFn, url, method, params, sleep), { url }));
    const gs = await Promise.all(call.map((c) => c("getGenesisHash", [])));
    gs.forEach((g, i) => say(g === genesis, `genesis ${String(g).slice(0, 12)} is ${cluster}'s on ${rpcs[i]}`));
    if (gs.some((g) => g !== genesis)) return { ok, lines };
    const reads = await Promise.all(rpcs.map((url) => account(fetchFn, url, entry.table, sleep)));
    const same = reads.every((r) => r && reads[0] && r.owner === reads[0].owner && Buffer.from(r.data).equals(Buffer.from(reads[0].data)));
    say(same, `the table ${entry.table} reads the same bytes at finalized on ${rpcs.join(" and ")}: ${same}`);
    say(reads[0]?.owner === ALT_PROGRAM, `the table is the lookup table program's: ${reads[0] ? reads[0].owner : "missing"}`);
    if (!same) return { ok, lines };
    // the kit's own list for this program and pool, from the venue's global account read on the same two RPCs
    const tv = await kit.readSolanaPoolTableVenue(call, venue);
    const own = kit.solanaPoolVenueTableList({ program: rec.program_id, pool: rec.pool }, tv);
    const against = (name, list) => {
      const p = tableProblems(reads[0], list, null);
      say(p.length === 0, `the table is active, authority none (frozen), and holds exactly ${name} (${list.length} addresses, in order)${p.length ? `: ${p.join("; ")}` : ""}`);
    };
    against("the record's list", entry.addresses);
    against("the kit's list for this program and pool", own);
  } catch (e) {
    say(false, `not read: ${String(e.message).split("\n")[0].slice(0, 200)}`);
  }
  return { ok, lines };
}

/**
 * The check on `records` ({ mainnet, devnet }, each a parsed deploy record or null). Rows run in order, cluster then
 * venue. Returns { ok, lines, deployed, failed, notDeployed, summary }: `summary` is the verdict line.
 */
export async function checkTables({ records, fetchFn = fetch, sleep }) {
  const lines = [];
  let deployed = 0, failed = 0, notDeployed = 0;
  for (const cluster of Object.keys(CLUSTERS)) {
    for (const venue of VENUES) {
      const rec = records[cluster];
      if (!rec || typeof rec !== "object" || !rec.tables || typeof rec.tables !== "object" || !Object.hasOwn(rec.tables, venue)) {
        lines.push(`${cluster} ${venue}: not deployed yet`);
        notDeployed++;
        continue;
      }
      deployed++;
      const r = await checkRow({ cluster, venue, rec, fetchFn, sleep });
      lines.push(...r.lines);
      if (!r.ok) failed++;
    }
  }
  const ok = failed === 0;
  const summary = ok ? `PASS (${deployed} deployed, ${notDeployed} not deployed yet)` : `FAIL (${failed} of ${deployed} deployed failing, ${notDeployed} not deployed yet)`;
  return { ok, lines, deployed, failed, notDeployed, summary };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (n, dflt) => (args.includes(n) ? args[args.indexOf(n) + 1] : dflt);
  try {
    const dir = opt("--dir", DEPLOYMENTS);
    const records = Object.fromEntries(Object.keys(CLUSTERS).map((c) => [c, readRecord(c, dir)]));
    const rec = recorder();
    const r = await checkTables({ records, fetchFn: opt("--record") ? rec.fetchFn : fetch });
    if (opt("--record")) writeFileSync(opt("--record"), JSON.stringify({ records, answers: rec.answers }) + "\n");
    for (const l of r.lines) console.log(`live-check ${KEY}: ${l}`);
    console.log(`live-check ${KEY}: ${r.summary}`);
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${String(e.message).split("\n")[0]}`);
    process.exit(2);
  }
}
