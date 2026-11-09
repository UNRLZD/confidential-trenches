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
// Every read goes through provider-answer.mjs's rpcAnswer: a provider's no-answer (a 429, an empty or cut body, a rate
// limit) is never judged as a wrong answer; a row with one is INCONCLUSIVE, named on its own line.
// The bytes are decoded by the kit's solanaDecodeLookupTable (its type, size and authority-tag checks) beside the one
// read it does not return, the authority at byte 21: a script outside Blindfill may not import the deploy script's own
// tableProblems (check:imports, kit-public-entry-only).
//   node scripts/live-checks/sol-pool-venue-tables.mjs [--dir <deployments folder>] [--record <file>]
//     PASS exit 0 (every deployed row passes), FAIL exit 1, error exit 2, INCONCLUSIVE exit 3 (a row a provider did not
//     answer, and no row failing). The last line names the counts:
//     `live-check sol-pool-venue-tables: PASS (1 deployed, 3 not deployed yet)`.
// --record writes every RPC answer read, with the records they were read for, to <file>.
// Runs: once, a contract deploy's read-back (each venue's frozen lookup table, made by venue-table.mjs on the owner's paste or a devnet run); no host deploy changes it
import "../net-window.mjs";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as kit from "../../packages/kit/src/index.ts";
import { ALT_PROGRAM, b58encode, DEVNET_GENESIS, MAINNET_GENESIS, MAINNET_RPCS, operatorProblems, RPCS as DEVNET_RPCS } from "./pool-sol-deploy.mjs";
import { EXIT, rpcAnswer, verdictOf } from "./provider-answer.mjs";

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

/** A provider that gave no answer (rpcAnswer's noAnswer): the row is not judged on it. */
class NoAnswer extends Error {}
/** One read through the shared module: its result; a no-answer throws NoAnswer, a JSON-RPC error throws (judged). */
async function read(fetchFn, url, method, params) {
  const a = await rpcAnswer(url, method, params, { fetchFn });
  if (a.noAnswer !== undefined) throw new NoAnswer(a.noAnswer);
  if (a.error !== undefined) throw new Error(`${new URL(url).host}: ${method} answered ${JSON.stringify(a.error).slice(0, 120)}`);
  return a.result;
}
async function account(fetchFn, url, addr) {
  const v = (await read(fetchFn, url, "getAccountInfo", [addr, { encoding: "base64", commitment: "finalized" }]))?.value;
  return v ? { owner: v.owner, data: new Uint8Array(Buffer.from(v.data[0], "base64")) } : null;
}
/** A fetch that keeps every answer it reads ({ url, method, params, status, json }), for --record. */
function recorder(fetchFn = fetch) {
  const answers = [];
  const wrapped = async (url, init) => {
    const { method, params } = JSON.parse(init.body);
    const r = await fetchFn(url, init);
    const text = await r.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    answers.push({ url, method, params, status: r.status, json });
    return new Response(text, { status: r.status });
  };
  return { answers, fetchFn: wrapped };
}

const U64_MAX = 0xffff_ffff_ffff_ffffn;
/** What keeps `acc` from being a lookup table of the table program that is active, has no authority (frozen) and holds
 * exactly `list` in order: [] when nothing does. */
export function tableProblems(acc, list) {
  if (!acc || acc.owner !== ALT_PROGRAM) return [`not a lookup table (${acc ? `owner ${acc.owner}` : "missing"})`];
  let t;
  try {
    t = kit.solanaDecodeLookupTable(acc.data);
  } catch (e) {
    return [String(e.message).slice(0, 120)];
  }
  const out = [];
  if (t.deactivationSlot !== U64_MAX) out.push(`deactivated at slot ${t.deactivationSlot}`);
  if (acc.data[21] === 1) out.push(`authority ${b58encode(acc.data.subarray(22, 54))}, not none`);
  if (t.addresses.length !== list.length || t.addresses.some((a, i) => a !== list[i])) out.push(`holds ${t.addresses.length} addresses, not exactly the list of ${list.length}`);
  return out;
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

/** One deployed row: the venue's table read on the cluster's two RPCs and judged. Returns { ok, quiet, lines }. */
async function checkRow({ cluster, venue, rec, fetchFn }) {
  const { rpcs, genesis } = CLUSTERS[cluster];
  const at = `${cluster} ${venue}`;
  const lines = [];
  let ok = true, quiet = false;
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
    const call = rpcs.map((url) => Object.assign((method, params) => read(fetchFn, url, method, params), { url }));
    const gs = await Promise.all(call.map((c) => c("getGenesisHash", [])));
    gs.forEach((g, i) => say(g === genesis, `genesis ${String(g).slice(0, 12)} is ${cluster}'s on ${rpcs[i]}`));
    if (gs.some((g) => g !== genesis)) return { ok, lines };
    const reads = await Promise.all(rpcs.map((url) => account(fetchFn, url, entry.table)));
    const same = reads.every((r) => r && reads[0] && r.owner === reads[0].owner && Buffer.from(r.data).equals(Buffer.from(reads[0].data)));
    say(same, `the table ${entry.table} reads the same bytes at finalized on ${rpcs.join(" and ")}: ${same}`);
    say(reads[0]?.owner === ALT_PROGRAM, `the table is the lookup table program's: ${reads[0] ? reads[0].owner : "missing"}`);
    if (!same) return { ok, lines };
    // the kit's own list for this program and pool, from the venue's global account read on the same two RPCs
    const tv = await kit.readSolanaPoolTableVenue(call, venue);
    const own = kit.solanaPoolVenueTableList({ program: rec.program_id, pool: rec.pool }, tv);
    const against = (name, list) => {
      const p = tableProblems(reads[0], list);
      say(p.length === 0, `the table is active, authority none (frozen), and holds exactly ${name} (${list.length} addresses, in order)${p.length ? `: ${p.join("; ")}` : ""}`);
    };
    against("the record's list", entry.addresses);
    against("the kit's list for this program and pool", own);
  } catch (e) {
    // the kit's reader wraps a provider's throw in its own words: a no-answer is found by its class on the chain
    let n = e;
    while (n && !(n instanceof NoAnswer)) n = n.cause;
    if (n instanceof NoAnswer || /\bno answer\b|HTTP 429/.test(String(e?.message))) {
      quiet = true;
      lines.push(`quiet ${at}: a provider gave no answer, not judged: ${String((n ?? e).message).split("\n")[0].slice(0, 200)}`);
    } else say(false, `not read: ${String(e.message).split("\n")[0].slice(0, 200)}`);
  }
  return { ok, quiet, lines };
}

/**
 * The check on `records` ({ mainnet, devnet }, each a parsed deploy record or null). Rows run in order, cluster then
 * venue. Returns { ok, lines, deployed, failed, notDeployed, summary }: `summary` is the verdict line.
 */
export async function checkTables({ records, fetchFn = fetch }) {
  const lines = [];
  let deployed = 0, failed = 0, notDeployed = 0, unanswered = 0;
  for (const cluster of Object.keys(CLUSTERS)) {
    for (const venue of VENUES) {
      const rec = records[cluster];
      if (!rec || typeof rec !== "object" || !rec.tables || typeof rec.tables !== "object" || !Object.hasOwn(rec.tables, venue)) {
        lines.push(`${cluster} ${venue}: not deployed yet`);
        notDeployed++;
        continue;
      }
      deployed++;
      const r = await checkRow({ cluster, venue, rec, fetchFn });
      lines.push(...r.lines);
      if (!r.ok) failed++;
      else if (r.quiet) unanswered++;
    }
  }
  const verdict = verdictOf(failed > 0, unanswered > 0);
  const ok = verdict === "PASS";
  const summary = {
    PASS: `PASS (${deployed} deployed, ${notDeployed} not deployed yet)`,
    FAIL: `FAIL (${failed} of ${deployed} deployed failing, ${notDeployed} not deployed yet)`,
    INCONCLUSIVE: `INCONCLUSIVE (${unanswered} of ${deployed} deployed not answered by both providers, ${notDeployed} not deployed yet)`,
  }[verdict];
  return { ok, verdict, lines, deployed, failed, unanswered, notDeployed, summary };
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
    process.exit(EXIT[r.verdict]);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${String(e.message).split("\n")[0]}`);
    process.exit(EXIT.ERROR);
  }
}
