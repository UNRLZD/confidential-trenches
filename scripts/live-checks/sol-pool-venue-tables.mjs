#!/usr/bin/env node
// Live check of card sol-pool-venue-tables: a private buy on Solana loads its accounts from one of its venue's frozen
// address lookup tables, a list of generations per venue the kit builds (the kit's SOLANA_POOL_BUY_VENUES), each holding
// a range of the pool's tree pages (contracts/pool-solana/deployments/<cluster>.json, tables.<venue>: [{ table, pages,
// addresses, txs }], oldest first). For each cluster (mainnet, devnet) and venue:
//   - the pins: the wallet's SOL_POOL_TABLES literals (packages/wallet/src/pool/solana.ts, both builds' branches). A
//     venue's pinned tables must be the record's generations from the first, in order: a pinned table with no record
//     row FAILs. A record generation past the pins is the named state `deployed, not pinned yet` (the owner's paste
//     before its pin commit), neither a pass nor a failure. Neither pinned nor in the record: `not deployed yet`.
//   - each recorded generation, on the cluster's two RPCs of two operators, both answering the cluster's genesis hash:
//     the table read at finalized is the same bytes on both, owned by the address lookup table program, active,
//     authority none (frozen), holding exactly the record's addresses; the newest also exactly the kit's own list for
//     its pages (solanaPoolVenueTableList over the venue's global account, read at finalized on the same two RPCs), so
//     a venue account that changed since (a new fee recipient) FAILs, naming the next generation as the fix; and every
//     tx the record lists for it reads back succeeded at finalized on the money gate's two transaction readers (TX_RPCS).
//   - the trees: the pool account's two tree sizes on both RPCs (the larger is judged). For a venue whose buy outgrows
//     a generation (PumpSwap; the curve fits at any tree size: packages/kit/test/solana-pool-venue-tables.test.ts), the
//     row FAILs once either tree passes 80 percent of the newest pinned generation's range, naming the entries left.
//     The arithmetic: PumpSwap's generation 1 covers state entries to 139,264 and label entries to 92,160 and warns at
//     111,411 and 73,728, leaving 27,853 state and 18,432 label entries. A buy and its sell add 3 state entries and 2
//     label entries, so the warning comes about 9,200 buys before the end: about 31 days at 300 buys a day, about 9
//     days at 1,000. Every later generation has the same width. The fix is the same paste for the next generation
//     (contracts/pool-solana/scripts/venue-table.mjs), then its pin.
// Every read goes through provider-answer.mjs's rpcAnswer: a provider's no-answer (a 429, an empty or cut body, a rate
// limit) is never judged as a wrong answer; a row with one is INCONCLUSIVE, named on its own line.
// The bytes are decoded by the kit's solanaDecodeLookupTable (its type, size and authority-tag checks) beside the one
// read it does not return, the authority at byte 21: a script outside Blindfill may not import the deploy script's own
// tableProblems (check:imports, kit-public-entry-only).
//   node scripts/live-checks/sol-pool-venue-tables.mjs [--dir <deployments folder>] [--record <file>]
//     PASS exit 0 (every deployed row passes), FAIL exit 1, error exit 2, INCONCLUSIVE exit 3 (a row a provider did not
//     answer, and no row failing). The last line names the counts:
//     `live-check sol-pool-venue-tables: PASS (3 deployed, 1 not deployed yet, 0 not pinned yet)`.
// --record writes every RPC answer read, with the records and pins they were read for, to <file>.
// Runs: once, a contract deploy's read-back (each venue's frozen lookup tables, made by venue-table.mjs on the owner's paste or a devnet run); no host deploy changes it
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
/** Where a generation's txs are read back: the money gate's own transaction readers per chain (scripts/ci/money-gate.mjs
 *  RPCS.solana and RPCS["solana-devnet"]; the test holds them equal). publicnode keeps no history that far back: it
 *  answered null for the mainnet curve table's create of 8 Nov on 10 Nov 00:50Z, which api.mainnet-beta read. */
export const TX_RPCS = Object.freeze({
  mainnet: ["https://api.mainnet-beta.solana.com", "https://public.rpc.solanavibestation.com"],
  devnet: ["https://api.devnet.solana.com", "https://solana-devnet.api.onfinality.io/public"],
});
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

/** The wallet's pins as its source writes them: { mainnet: { venue: [table, ...] }, devnet: {...} }. Throws when the
 *  literal is not found in its shape, so a reshaped pin is an error (exit 2), never an empty pass. */
export const PINS_SOURCE = path.join(HERE, "../../packages/wallet/src/pool/solana.ts");
export function parsePins(text) {
  const block = /export const SOL_POOL_TABLES\b[^=]*=\s*Object\.freeze\(([\s\S]*?)\n\);/.exec(String(text));
  if (!block) throw new Error("SOL_POOL_TABLES not found in its literal shape");
  const out = {};
  for (const c of block[1].matchAll(/\b(devnet|mainnet): Object\.freeze\(\{([^}]*)\}\)/g)) {
    if (Object.hasOwn(out, c[1])) throw new Error(`${c[1]} pinned twice`);
    out[c[1]] = {};
    for (const v of c[2].matchAll(/("pump-curve"|pumpswap): Object\.freeze\(\[([^\]]*)\]\)/g)) {
      const venue = v[1].replaceAll('"', "");
      const list = [...v[2].matchAll(/"([^"]*)"/g)].map((m) => m[1]);
      if (list.length === 0 || !list.every((a) => BASE58.test(a)) || v[2].replace(/"[^"]*"/g, "").replace(/[\s,]/g, "") !== "") throw new Error(`${c[1]} ${venue}: the pin is not a list of address literals`);
      out[c[1]][venue] = list;
    }
  }
  if (!out.mainnet || !out.devnet) throw new Error("SOL_POOL_TABLES names no mainnet or no devnet branch in its literal shape");
  return out;
}

/** Venues whose buy outgrows a table generation as the trees grow: the tree alarm applies to them. */
export const GROWS = Object.freeze(["pumpswap"]);
const PAGES_OK = (p) => p && typeof p === "object" && ["state", "label"].every((t) => Array.isArray(p[t]) && p[t].length === 2 && p[t].every((n) => Number.isSafeInteger(n) && n >= 0) && p[t][0] <= p[t][1]);
const SIG = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;

/** What is wrong with a record's cluster, program and pool, as a list (judged before any read). */
function recordProblems(rec, cluster) {
  const out = [];
  if (rec.cluster !== cluster) out.push(`the record's cluster is ${cluster}: ${String(rec.cluster).slice(0, 20)}`);
  for (const k of ["program_id", "pool"]) if (typeof rec[k] !== "string" || !BASE58.test(rec[k])) out.push(`the record's ${k} is not an address`);
  return out;
}

/** What is wrong with one generation of a record, as a list (the record is read, never trusted). */
function entryProblems(rec, cluster, g) {
  const out = [];
  if (!g || typeof g !== "object" || typeof g.table !== "string" || !BASE58.test(g.table)) out.push("the record's table is not an address");
  else {
    if (!Array.isArray(g.addresses) || g.addresses.length < 1 || g.addresses.length > TABLE_MAX || !g.addresses.every((a) => typeof a === "string" && BASE58.test(a))) out.push(`the record's addresses are not a list of 1 to ${TABLE_MAX} addresses`);
    if (!PAGES_OK(g.pages)) out.push("the record's pages are not two [from, to] page ranges");
    if (!Array.isArray(g.txs) || g.txs.length < 1 || !g.txs.every((t) => t && SIG.test(String(t.signature)))) out.push("the record's txs are not a list of signatures");
  }
  return out;
}

/** One deployed generation: its table, list and txs read on the cluster's two RPCs and judged. */
async function checkRow({ cluster, venue, k, newest, rec, fetchFn, call }) {
  const { rpcs } = CLUSTERS[cluster];
  const at = `${cluster} ${venue} g${k + 1}`;
  const lines = [];
  let ok = true, quiet = false;
  const say = (pass, text) => {
    lines.push(`${pass ? "ok  " : "FAIL"} ${at}: ${text}`);
    ok &&= pass;
  };
  const g = rec.tables[venue][k];
  const bad = entryProblems(rec, cluster, g);
  bad.forEach((b) => say(false, b));
  if (bad.length) return { ok, quiet, lines };
  try {
    const reads = await Promise.all(rpcs.map((url) => account(fetchFn, url, g.table)));
    const same = reads.every((r) => r && reads[0] && r.owner === reads[0].owner && Buffer.from(r.data).equals(Buffer.from(reads[0].data)));
    say(same, `the table ${g.table} reads the same bytes at finalized on ${rpcs.join(" and ")}: ${same}`);
    say(reads[0]?.owner === ALT_PROGRAM, `the table is the lookup table program's: ${reads[0] ? reads[0].owner : "missing"}`);
    if (!same) return { ok, quiet, lines };
    const against = (name, list) => {
      const p = tableProblems(reads[0], list);
      say(p.length === 0, `the table is active, authority none (frozen), and holds exactly ${name} (${list.length} addresses, in order)${p.length ? `: ${p.join("; ")}` : ""}`);
    };
    against("the record's list", g.addresses);
    if (newest) {
      // the kit's own list for this program, pool and range, from the venue's global account read on the same two RPCs
      const tv = await kit.readSolanaPoolTableVenue(call, venue);
      const own = kit.solanaPoolVenueTableList({ program: rec.program_id, pool: rec.pool }, tv, g.pages);
      const p = tableProblems(reads[0], own);
      say(p.length === 0, `the newest generation holds exactly the kit's list for this program, pool and pages (${own.length} addresses, in order)${p.length ? `: ${p.join("; ")}: the venue's accounts changed, make the next generation (venue-table.mjs)` : ""}`);
    }
    for (const t of g.txs) {
      const got = await Promise.all(TX_RPCS[cluster].map((url) => read(fetchFn, url, "getTransaction", [t.signature, { encoding: "base64", commitment: "finalized", maxSupportedTransactionVersion: 0 }])));
      const landed = got.every((x) => x && x.meta && x.meta.err === null);
      say(landed, `${String(t.step ?? "tx").slice(0, 60)} ${t.signature.slice(0, 12)}... reads back succeeded at finalized on ${TX_RPCS[cluster].join(" and ")}: ${landed}`);
    }
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
 * The check on `records` ({ mainnet, devnet }, each a parsed deploy record or null) and `pins` (parsePins of the
 * wallet's source). Rows run in order, cluster then venue then generation. Returns { ok, verdict, lines, deployed,
 * failed, unanswered, notDeployed, notPinned, summary }: `summary` is the verdict line.
 */
export async function checkTables({ records, pins, fetchFn = fetch }) {
  const lines = [];
  let deployed = 0, failed = 0, notDeployed = 0, unanswered = 0, notPinned = 0;
  for (const cluster of Object.keys(CLUSTERS)) {
    const rec = records[cluster];
    const pinned = pins?.[cluster] ?? {};
    const { rpcs, genesis } = CLUSTERS[cluster];
    let reader = null; // the cluster's RPC pair, its genesis and its pool's tree sizes, read once
    const open = async () => {
      if (reader) return reader;
      const out = { ok: true, lines: [], quiet: false };
      const call = rpcs.map((url) => Object.assign((method, params) => read(fetchFn, url, method, params), { url }));
      const op = operatorProblems(rpcs, cluster);
      out.lines.push(`${op.length ? "FAIL" : "ok  "} ${cluster}: the RPCs ${rpcs.join(" and ")} are two operators of ${cluster}${op.length ? `: ${op.join("; ")}` : ""}`);
      if (op.length) return (reader = { ...out, ok: false });
      try {
        const gs = await Promise.all(call.map((c) => c("getGenesisHash", [])));
        gs.forEach((g, i) => out.lines.push(`${g === genesis ? "ok  " : "FAIL"} ${cluster}: genesis ${String(g).slice(0, 12)} is ${cluster}'s on ${rpcs[i]}`));
        if (gs.some((g) => g !== genesis)) return (reader = { ...out, ok: false });
        const pools = await Promise.all(rpcs.map((url) => account(fetchFn, url, rec.pool)));
        const sizes = pools.map((a) => (a ? kit.solanaPoolTreeSizes({ owner: a.owner, data: a.data }, rec.program_id) : null));
        if (sizes.some((x) => x === null)) throw new Error(`the pool ${rec.pool} is not read on both`);
        out.sizes = { state: Math.max(...sizes.map((x) => x.stateSize)), label: Math.max(...sizes.map((x) => x.labelSize)) };
        out.lines.push(`ok   ${cluster}: the pool's trees hold ${out.sizes.state} state and ${out.sizes.label} label entries (the larger of the two RPCs' reads)`);
      } catch (e) {
        let n = e;
        while (n && !(n instanceof NoAnswer)) n = n.cause;
        if (n instanceof NoAnswer) return (reader = { ...out, quiet: true, lines: [...out.lines, `quiet ${cluster}: a provider gave no answer, not judged: ${String(n.message).slice(0, 200)}`] });
        return (reader = { ...out, ok: false, lines: [...out.lines, `FAIL ${cluster}: not read: ${String(e.message).split("\n")[0].slice(0, 200)}`] });
      }
      return (reader = { ...out, call });
    };
    for (const venue of VENUES) {
      const gens = rec && typeof rec === "object" && rec.tables && typeof rec.tables === "object" && Object.hasOwn(rec.tables, venue) ? rec.tables[venue] : null;
      const pin = Object.hasOwn(pinned, venue) ? pinned[venue] : [];
      if ((gens === null || (Array.isArray(gens) && gens.length === 0)) && pin.length === 0) {
        lines.push(`${cluster} ${venue}: not deployed yet`);
        notDeployed++;
        continue;
      }
      deployed++;
      const at = `${cluster} ${venue}`;
      const row = [];
      let ok = true, quiet = false;
      const say = (pass, text) => {
        row.push(`${pass ? "ok  " : "FAIL"} ${at}: ${text}`);
        ok &&= pass;
      };
      if (!Array.isArray(gens)) say(false, gens === null ? "pinned, with no record row" : "the record's tables entry is not a list of generations");
      else {
        // the pins: the record's generations from the first, in order
        pin.forEach((t, i) => say(gens[i]?.table === t, `pinned g${i + 1} ${t} is the record's generation ${i + 1}${gens[i]?.table === t ? "" : `: the record has ${gens[i] ? gens[i].table : "no row"}`}`));
        recordProblems(rec, cluster).forEach((b) => say(false, b));
      }
      if (ok && Array.isArray(gens)) {
        const r = await open();
        if (!r.shown) row.push(...r.lines); // the cluster's own lines, once
        r.shown = true;
        if (!r.ok) ok = false;
        if (r.quiet) quiet = true;
        if (r.ok && !r.quiet) {
          for (let k = 0; k < gens.length; k++) {
            if (k >= pin.length) {
              row.push(`${at} g${k + 1}: deployed, not pinned yet (${String(gens[k]?.table).slice(0, 44)})`);
              notPinned++;
            }
            const c = await checkRow({ cluster, venue, k, newest: k === gens.length - 1, rec, fetchFn, call: r.call });
            row.push(...c.lines);
            ok &&= c.ok;
            quiet ||= c.quiet;
          }
          // the tree alarm, on the newest pinned generation
          const newest = pin.length > 0 ? gens[pin.length - 1] : null;
          if (GROWS.includes(venue) && newest && PAGES_OK(newest.pages)) {
            const warn = kit.solanaPoolRangeWarn(newest.pages), end = kit.solanaPoolRangeEnd(newest.pages);
            for (const t of ["state", "label"]) {
              const past = r.sizes[t] >= warn[t];
              say(!past, `the ${t} tree at ${r.sizes[t]} is ${past ? "past" : "under"} 80 percent of generation ${pin.length} (warns at ${warn[t]}, ends at ${end[t]}): ${end[t] - r.sizes[t]} entries left${past ? ": make the next generation (venue-table.mjs) and pin it" : ""}`);
            }
          }
        }
      }
      lines.push(...row);
      if (!ok) failed++;
      else if (quiet) unanswered++;
    }
  }
  const verdict = verdictOf(failed > 0, unanswered > 0);
  const ok = verdict === "PASS";
  const tail = `${notDeployed} not deployed yet, ${notPinned} not pinned yet`;
  const summary = {
    PASS: `PASS (${deployed} deployed, ${tail})`,
    FAIL: `FAIL (${failed} of ${deployed} deployed failing, ${tail})`,
    INCONCLUSIVE: `INCONCLUSIVE (${unanswered} of ${deployed} deployed not answered by both providers, ${tail})`,
  }[verdict];
  return { ok, verdict, lines, deployed, failed, unanswered, notDeployed, notPinned, summary };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (n, dflt) => (args.includes(n) ? args[args.indexOf(n) + 1] : dflt);
  try {
    const dir = opt("--dir", DEPLOYMENTS);
    const records = Object.fromEntries(Object.keys(CLUSTERS).map((c) => [c, readRecord(c, dir)]));
    const pins = parsePins(readFileSync(PINS_SOURCE, "utf8"));
    const rec = recorder();
    const r = await checkTables({ records, pins, fetchFn: opt("--record") ? rec.fetchFn : fetch });
    if (opt("--record")) writeFileSync(opt("--record"), JSON.stringify({ records, pins, answers: rec.answers }) + "\n");
    for (const l of r.lines) console.log(`live-check ${KEY}: ${l}`);
    console.log(`live-check ${KEY}: ${r.summary}`);
    process.exit(EXIT[r.verdict]);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${String(e.message).split("\n")[0]}`);
    process.exit(EXIT.ERROR);
  }
}
