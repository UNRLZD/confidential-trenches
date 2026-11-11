#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// A venue's next frozen lookup table generation for the pool buy (card sol-pool-venue-tables): a tag 3 on a venue loads
// the pool, its pages and the venue's program-wide accounts from that venue's own table, since one table cannot serve
// every venue under 1,232 bytes (a PumpSwap buy on the pump curve's table is 1,384 B). A table is frozen and holds at
// most 256 addresses, so each venue has an ordered list of generations, each a page range of the two trees; as the
// trees grow past one, the next is made, and no table is ever changed.
//
//   node contracts/pool-solana/scripts/venue-table.mjs --cluster <mainnet|devnet> --venue <pump-curve|pumpswap> --dry-run
//     reads and builds everything, sends nothing, writes nothing: the generation, its page range, the entries it covers
//     and where it warns, the list the table will freeze (every address on its own line), each transaction built and
//     its size, the cost in SOL from the cluster's rent, and the run's line
//   node contracts/pool-solana/scripts/venue-table.mjs --cluster <mainnet|devnet> --venue <venue> --return <address>
//     the run (on mainnet: the owner's paste, the line --dry-run prints)
//   node contracts/pool-solana/scripts/venue-table.mjs --resume <key folder> [--return <address>]
//     a stopped run, from its key folder (its journal is there): goes on with the same generation from what the chain holds
//
// Steps:
//  1. The cluster's two RPCs (scripts/live-checks/pool-sol-deploy.mjs: MAINNET_RPCS or RPCS), each refused unless it
//     answers the cluster's genesis hash. The record: contracts/pool-solana/deployments/<cluster>.json (mainnet: the
//     pool's deploy record; devnet: made from scripts/live-checks/pool-sol-deploy.devnet.json's program and pool when
//     missing); its pool must be its program's pool account. Its tables.<venue> is the venue's generations, oldest first.
//  2. The range, never typed: the pool account read at finalized on both RPCs (the program's, else refused), each tree's
//     size the smaller of the two reads; the kit's solanaPoolNextTableRange for those sizes. The list: the kit's
//     readSolanaPoolTableVenue (the venue's global account at finalized on both RPCs, the same bytes) and
//     solanaPoolVenueTableList for the record's program, pool and that range: what the builder loads
//     (packages/kit/test/solana-pool-venue-tables.test.ts). A venue whose buy fits at any tree size (the pump curve: not
//     in the kit's SOLANA_POOL_TABLE_GROWS) is refused "nothing to add" by name while its newest generation holds the
//     kit's list for its range: its next range is its first, so only changed venue accounts make one. Else refused
//     "nothing to add" when the newest generation's range
//     holds every page of it in both trees and its addresses are the kit's list for its own range (a changed fee
//     recipient is a reason for a new generation). A resume takes its range and sizes from its journal.
//  3. The cost: rent of the table (56 + 32 per address, the Rent sysvar read on both RPCs) and every transaction's fee
//     and priority bound (mainnet's own sends carry deploy.mjs's PRIORITY_MICRO_LAMPORTS on the default 200,000 CU per
//     instruction), and the funder's own floor. Nothing is read about any key before the list and the cost are known.
//  4. --return through deploy.mjs's returnProblems on both RPCs (a wallet: on the curve, a system account holding SOL),
//     and never the record's program or pool, before anything is made or printed. A key made in memory, the funder: the
//     table's authority and payer. Refused first when a run of this cluster and venue holds its key folder (a live run's
//     lock, SOL on its funder, a table its journal names that the chain holds or may still make, or a run that did not
//     stop here): it is named with its resume line. Its file (the solana CLI's 64-byte form, 0600) and the journal go to a
//     0700 folder under deploy.mjs's keysBase(), never OS temp, a repo or ~/.confidential-trenches, locked (run.lock, made
//     whole with its pid by a hard link, so one run at a time holds a folder; released on every exit, SIGINT and SIGTERM
//     included; a dead pid's lock is taken over and said so). The folder and the resume line are printed before anything
//     else; then the funder and the need, and it waits until the funder holds it on both RPCs (send it from --return; on
//     mainnet that is the owner's move). A read that fails there (a node's JSON-RPC error, HTTP 5xx or 429, the network)
//     is read again: only stopping the process ends the wait.
//  5. The table at a recent slot's PDA [funder, slot]: create and extend with as many addresses as one transaction
//     holds, then the rest in further extends; read back at finalized on both RPCs, the same bytes, active, the funder its
//     authority and exactly the list; then frozen (authority none) and read back again the same way. Each send is
//     journaled with its table and last valid block height before it goes, and marked landed once confirmed.
//  6. The record's tables.<venue> gains { table, pages, made_at, addresses, txs } at its end, once, read back from the
//     file; the funder's lamports go back to --return in one transfer; then, and only then, the key folder is removed,
//     once both RPCs read the table frozen and the funder at 0 at finalized. No stop path removes it: a run that stops
//     sends the funder's lamports back when it can, says how otherwise, and keeps the folder and its journal. A funder
//     left with one fee or less is said so with what to do; that folder does not stop a later paste unless its journal
//     names a table the chain holds or may still make.
//  A resume whose journal names a table first reads every journaled send to it (create, extend or freeze) that is not
//  landed, and goes on only when each can no longer land (an error status, or no status and its last valid block height
//  passed on both RPCs at finalized); then both RPCs must read that same lookup table at confirmed and at finalized, all
//  four the same bytes, holding exactly the addresses the journal's landed sends put in it (a prefix of the list under
//  the funder: extend the rest and freeze; the list frozen: record, nothing sent), or all read nothing and no create of
//  it landed. Reads behind the landed sends, or a send that may still land, stop with nothing sent and the key kept
//  ("resume again in a minute"); the journal's table is never replaced while a create of it may have landed. Every
//  extend, in a run or a resume, goes only after both RPCs read the table at confirmed holding exactly the landed count
//  (the extend instruction appends wherever the table ends, so this read is what keeps an extend from a stale start).
//  Recovery: a table that holds more than its landed sends explain, or is not the list's prefix under the funder, stops
//  by name with its recovery printed (recoveryLines): send the funder two fees, `solana address-lookup-table deactivate`
//  with the kept key, `close` to --return some 4 minutes later, sweep the funder, remove the folder, paste again.
//  A mainnet run or resume (not --dry-run) first passes the source gate (sourceProblems): HEAD on REPO's main as git
//  ls-remote answers it now, and the record, this script and the kit's pool-buy.ts each main's blob and uncommitted
//  nowhere, so a paste from a stale checkout never plans a generation the record already holds.
//  Then the live check: node scripts/live-checks/sol-pool-venue-tables.mjs; and the pin: SOL_POOL_TABLES in
//  packages/wallet/src/pool/solana.ts (packages/wallet/test/sol-pool-venue-tables.test.ts fails until it matches).
import "../../../scripts/net-window.mjs";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ALT_PROGRAM, FEE_PER_SIGNATURE, PRIORITY_MICRO_LAMPORTS, TABLE_META, TX_MAX, compileMessage, keysBase, newKey, priceIx, returnProblems, sendAndConfirm,
  signTx, solOf, tableIxs, tableProblems, transferIx,
} from "./deploy.mjs";
import { DEVNET_GENESIS, MAINNET_GENESIS, MAINNET_RPCS, RPCS as DEVNET_RPCS, account, b58encode, le, pda, rpc } from "../../../scripts/live-checks/pool-sol-deploy.mjs";
import { REPO as SOURCE_REPO, mainProblems } from "../../vault/scripts/source-gate.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "../../..");
export const DEPLOYMENTS = path.join(REPO, "contracts/pool-solana/deployments");
const kit = await import(pathToFileURL(path.join(REPO, "packages/kit/src/trade/solana/pool-buy.ts")).href);
const { solanaPoolTreeSizes } = await import(pathToFileURL(path.join(REPO, "packages/kit/src/trade/solana/pool-deposit.ts")).href);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (s) => console.log(`venue-table: ${s}`);

export const CLUSTERS = Object.freeze({
  mainnet: { rpcs: MAINNET_RPCS, genesis: MAINNET_GENESIS, price: PRIORITY_MICRO_LAMPORTS },
  devnet: { rpcs: DEVNET_RPCS, genesis: DEVNET_GENESIS, price: 0n },
});
/** The default compute unit limit of a transaction with no SetComputeUnitLimit: 200,000 per instruction (not the
 *  compute budget's own), the bound the priority is priced on. */
const CU_PER_IX = 200_000n;
const LANDED = ["confirmed", "finalized"];

/** A public RPC answers 429 under load past rpc()'s own tries (shared devnet hosts): wait and ask again, up to 8 times. */
async function patient(f, wait = sleep) {
  for (let i = 0; ; i++) {
    try {
      return await f();
    } catch (e) {
      if (i >= 7 || !/429|-32029|-32429|fetch failed/.test(String(e?.message))) throw e;
      await wait(1_000 * 2 ** Math.min(i, 4));
    }
  }
}

/** The cluster's record: its own file, or on devnet one made from the devnet deploy's program and pool. */
export function recordOf(cluster, dir = DEPLOYMENTS) {
  const file = path.join(dir, `${cluster}.json`);
  if (existsSync(file)) return { file, record: JSON.parse(readFileSync(file, "utf8")) };
  if (cluster !== "devnet") throw new Error(`${file} is missing: the pool's deploy record names the program and pool`);
  const d = JSON.parse(readFileSync(path.join(REPO, "scripts/live-checks/pool-sol-deploy.devnet.json"), "utf8"));
  return { file, record: { cluster: "devnet", genesis_hash: d.genesis_hash, program_id: d.program_id, pool: d.pool, tables: {} } };
}

/** The table's transactions for `list`, each under TX_MAX: create with the first addresses that fit, the rest in
 *  extends of as many as fit, then the freeze. Each is { step, ixs } (a priced cluster's start with its price). */
export function tableSteps(funder, table, slot, bump, list, price, { create = true } = {}) {
  const head = price > 0n ? [priceIx(price)] : [];
  const fits = (ixs) => {
    const m = compileMessage(funder, ixs, "11111111111111111111111111111111");
    return 1 + 64 * m.signers.length + m.bytes.length <= TX_MAX;
  };
  const steps = [];
  let at = 0;
  for (let first = true; (first && create) || at < list.length; first = false) {
    let n = list.length - at;
    const build = (k) => {
      const ix = tableIxs(funder, table, slot, bump, list.slice(at, at + k));
      return [...head, ...(first && create ? [ix.create] : []), ...(k > 0 ? [ix.extend] : [])];
    };
    while (n > 0 && !fits(build(n))) n--;
    if (n === 0 && !(first && create)) throw new Error("no address fits an extend");
    steps.push({ step: first && create ? `lookup table: create and extend with ${n} addresses` : `lookup table: extend with ${n} addresses`, ixs: build(n) });
    at += n;
  }
  steps.push({ step: "lookup table: freeze (authority none)", ixs: [...head, tableIxs(funder, table, slot, bump, []).freeze] });
  return steps;
}

/** The funder's need: the table's rent still to pay (`tableRent`), each transaction's fee and priority bound (the
 *  sweep's fee included), and the funder's own floor, rent(0): between its sends the funder must stay rent-exempt, or
 *  the runtime refuses the send that would leave it under that (the devnet run of 9 Nov 23:12Z: its second extend was
 *  refused "insufficient funds for rent"). The sweep sends the floor back with the rest. */
export function needOf(tableRent, steps, price, floor) {
  const fees = BigInt(steps.length + 1) * FEE_PER_SIGNATURE;
  const priority = steps.reduce((s, x) => s + (BigInt(x.ixs.filter((i) => i.program !== "ComputeBudget111111111111111111111111111111").length) * CU_PER_IX * price + 999_999n) / 1_000_000n, 0n);
  return { lookup_table: tableRent, fees, priority, funder_floor: floor, total: tableRent + fees + priority + floor };
}

export const SLOT_HASHES = "SysvarS1otHashes111111111111111111111111111";
/** How far back from the SlotHashes sysvar's newest entry the table's slot is taken (pool-table-devnet.mjs's way): the
 *  create is refused "is not a recent slot" (invalid instruction data) unless the node that runs it holds that slot in
 *  its SlotHashes, and a load-balanced RPC's getSlot can come from a node ahead of the one that simulates. */
export const SLOT_BACK = 32;
export const CREATE_TRIES = 3;
/** A recent slot as `call` holds it: entry SLOT_BACK (or its oldest) of its SlotHashes sysvar at confirmed. */
export async function recentSlot(call) {
  const v = (await call("getAccountInfo", [SLOT_HASHES, { encoding: "base64", commitment: "confirmed", dataSlice: { offset: 0, length: 8 + 40 * (SLOT_BACK + 1) } }])).value;
  if (!v || v.owner !== "Sysvar1111111111111111111111111111111111111") throw new Error("no SlotHashes sysvar");
  const d = Buffer.from(v.data[0], "base64");
  const held = Math.min(d.length >= 8 ? Number(d.readBigUInt64LE(0)) : 0, Math.floor((d.length - 8) / 40));
  if (held < 1) throw new Error("the SlotHashes sysvar holds no slot");
  return d.readBigUInt64LE(8 + 40 * Math.min(SLOT_BACK, held - 1));
}

/** The paste line for a venue on a cluster. */
export const runLine = (cluster, venue) => `node contracts/pool-solana/scripts/venue-table.mjs --cluster ${cluster} --venue ${venue} --return <your Solana address, where the run's leftover SOL goes back>`;
const resumeLine = (keyDir, returnTo) => `node contracts/pool-solana/scripts/venue-table.mjs --resume ${keyDir} --return ${returnTo}`;
/** The last line of a run stopped by Ctrl-C or SIGTERM: nothing is given back on a signal, so it says how. */
const signalLine = (keyDir, returnTo) => `stopped by a signal: whatever SOL the funder holds stays on it, and the key in ${keyDir}; it comes back to ${returnTo} (or the run goes on) with: ${resumeLine(keyDir, returnTo)}`;
const pagesText = (r) => `state pages ${r.state[0]} to ${r.state[1]}, label pages ${r.label[0]} to ${r.label[1]}`;
const isRange = (r) => r && [r.state, r.label].every((x) => Array.isArray(x) && x.length === 2 && x.every(Number.isSafeInteger) && x[0] >= 0 && x[0] <= x[1]);
const holds = (outer, inner) => ["state", "label"].every((t) => outer[t][0] <= inner[t][0] && outer[t][1] >= inner[t][1]);

/**
 * The plan: both RPCs checked, the record's pool its program's, the trees' sizes from the pool account, the next
 * generation's range and list from the kit, the rent from both RPCs. `journal` (a resume's): its range and sizes are
 * the generation's, and "nothing to add" is not asked again.
 */
export async function plan(cluster, venue, { fetchFn = fetch, dir = DEPLOYMENTS, wait = sleep, journal = null } = {}) {
  const c = CLUSTERS[cluster];
  if (!c) throw new Error(`--cluster must be mainnet or devnet`);
  if (!kit.SOLANA_POOL_BUY_VENUES.includes(venue)) throw new Error(`--venue must be one of ${kit.SOLANA_POOL_BUY_VENUES.join(", ")}`);
  const call = c.rpcs.map((url) => Object.assign((method, params) => patient(() => rpc(fetchFn, url, method, params, wait), wait), { url }));
  const gs = await Promise.all(call.map((f) => f("getGenesisHash", [])));
  gs.forEach((g, i) => { if (g !== c.genesis) throw new Error(`${c.rpcs[i]} answers genesis ${g}, not ${cluster}'s`); });
  const { file, record } = recordOf(cluster, dir);
  if (record.cluster !== cluster) throw new Error(`${file} is ${record.cluster}'s record`);
  const want = kit.solanaPoolAccount(record.program_id);
  if (record.pool !== want) throw new Error(`${file}: pool ${record.pool} is not the program's pool account ${want}`);
  const cfg = { program: record.program_id, pool: record.pool };
  const gens = record.tables?.[venue] ?? [];
  if (!Array.isArray(gens) || !gens.every((g) => isRange(g?.pages) && Array.isArray(g.addresses))) throw new Error(`${file}: tables.${venue} is not a list of generations, each with its pages and addresses`);
  const tv = await kit.readSolanaPoolTableVenue(call, venue);
  // the trees' sizes: the pool account at finalized on both RPCs, the program's, each tree the smaller of the two
  const reads = await Promise.all(c.rpcs.map((u) => patient(() => account(fetchFn, u, record.pool, wait, "finalized"), wait)));
  const trees = reads.map((a, i) => {
    if (!a) throw new Error(`the pool account ${record.pool} is missing on ${c.rpcs[i]}`);
    if (a.owner !== record.program_id) throw new Error(`the pool account ${record.pool} on ${c.rpcs[i]} is not the program's (owner ${a.owner})`);
    return solanaPoolTreeSizes(a, record.program_id);
  });
  let sizes = { state: Math.min(trees[0].stateSize, trees[1].stateSize), label: Math.min(trees[0].labelSize, trees[1].labelSize) };
  let range = kit.solanaPoolNextTableRange(cfg, tv, sizes);
  let generation = gens.length + 1;
  if (journal) {
    if (!isRange(journal.pages) || !Number.isSafeInteger(journal.made_at?.state) || !Number.isSafeInteger(journal.made_at?.label)) throw new Error("the journal names no page range: it is not a run of this script's");
    range = journal.pages;
    sizes = { state: journal.made_at.state, label: journal.made_at.label };
    const at = gens.findIndex((g) => g.table === journal.table);
    if (at >= 0) generation = at + 1;
  } else {
    const newest = gens.at(-1);
    // a generation whose pages, with the venue's accounts as they are now, no longer fit one table (the venue gained an
    // account since: GlobalConfig's reserved fee recipient, card sol-pool-buys-mayhem-coins) is not the kit's list
    const same = (g) => {
      try {
        return JSON.stringify(g.addresses) === JSON.stringify(kit.solanaPoolVenueTableList(cfg, tv, g.pages));
      } catch {
        return false;
      }
    };
    if (newest && !kit.SOLANA_POOL_TABLE_GROWS.includes(venue) && same(newest)) {
      throw new Error(`nothing to add: ${venue}'s buy fits 1,232 bytes at any tree size on its generation ${gens.length} (${newest.table}): a new generation is made for it only when the venue's accounts change`);
    }
    if (newest && holds(newest.pages, range) && same(newest)) {
      throw new Error(`nothing to add: ${venue}'s generation ${gens.length} (${newest.table}, ${pagesText(newest.pages)}) holds every page of the next range (${pagesText(range)}, for trees of ${sizes.state} and ${sizes.label} entries) and the venue's accounts are unchanged`);
    }
  }
  const list = kit.solanaPoolVenueTableList(cfg, tv, range);
  const rent = await kit.readSolanaRent(call);
  const tableRent = kit.solanaRentMin(rent, TABLE_META + 32 * list.length);
  const rentOf = (n) => kit.solanaRentMin(rent, n);
  return { cluster, venue, c, call, file, record, tv, cfg, sizes, range, generation, list, tableRent, rentOf, fetchFn, wait };
}

/** The journal beside the key: every signed transaction (its table and last valid block height), the table, the
 *  generation's range and list, written at each change. */
function journalOf(dir, init) {
  const file = path.join(dir, "journal.json");
  const j = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { ...init, txs: [] };
  const save = () => writeFileSync(file, JSON.stringify(j, null, 2) + "\n", { mode: 0o600 });
  save();
  return {
    j, save,
    /** A sendAndConfirm journal for sends on `table` (null: not a table's). */
    on: (table) => ({
      signed: (step, tx, lastValid) => (j.txs.push({ step, signature: tx.signature, state: "sent", table, last_valid: lastValid ?? null }), save()),
      settled: (sig, state) => {
        const t = j.txs.find((x) => x.signature === sig);
        if (t) (t.state = state), save();
      },
    }),
  };
}

const read2 = (p, addr, commitment = "finalized") => Promise.all(p.c.rpcs.map((u) => patient(() => account(p.fetchFn, u, addr, p.wait, commitment), p.wait)));
const same2 = (r) => r.every((x) => x && r[0] && x.owner === r[0].owner && Buffer.from(x.data).equals(Buffer.from(r[0].data)));
/** The table at finalized on both RPCs, the same bytes and tableProblems [] for (list, authority), within 90 s. */
async function readBack(p, table, list, authority, { wait, now }) {
  let why = [];
  for (const until = now() + 90_000; now() < until; await wait(2_000)) {
    const r = await read2(p, table).catch((e) => (why = [`not read: ${e.message}`], null));
    if (!r) continue;
    why = [...(same2(r) ? [] : ["the two RPCs read different bytes"]), ...new Set(r.flatMap((x, i) => tableProblems(x, list, authority).map((s) => `${p.c.rpcs[i]}: ${s}`)))];
    if (!why.length) return;
  }
  throw new Error(`lookup table ${table}: ${why.join("; ")}`);
}
/** The funder's balance at `commitment`: the smaller of the two RPCs' reads, or both when `each`. */
const balances = (p, id, commitment) => Promise.all(p.call.map((f) => f("getBalance", [id, { commitment }]).then((x) => BigInt(x.value))));
const balance2 = async (p, id, commitment = "confirmed") => {
  const b = await balances(p, id, commitment);
  return b[0] < b[1] ? b[0] : b[1];
};

/**
 * Whether a journaled create can still put a table on chain: "landed" (marked so, or a status says so), "failed" (it
 * landed with an error), "expired" (no status on either RPC and both past its last valid block height at finalized: it
 * can never land), or "open". A create with no last valid height recorded is open until a status says otherwise.
 */
async function createState(p, x) {
  if (x.state === "landed" || x.state === "failed") return x.state;
  const st = await Promise.all(p.call.map((f) => f("getSignatureStatuses", [[x.signature], { searchTransactionHistory: true }]).then((r) => r.value[0])));
  if (st.some((s) => s && !s.err && LANDED.includes(s.confirmationStatus))) return "landed";
  // an error status counts once confirmed: that block holds the transaction (its fee taken, its signature spent), so it
  // can never land again, and one RPC's confirmed word is enough, as for "landed"; a processed one may be on a fork
  // that is dropped, while the same transaction lands on another
  if (st.some((s) => s?.err && LANDED.includes(s.confirmationStatus))) return "failed";
  if (st.some((s) => s) || x.last_valid == null) return "open";
  const h = await Promise.all(p.call.map((f) => f("getBlockHeight", [{ commitment: "finalized" }])));
  return h.every((v) => BigInt(v) > BigInt(x.last_valid)) ? "expired" : "open";
}
/** Why a create of `table` may have landed (a reason, or null when none can): every journaled create of it read. */
async function createMayHaveLanded(p, jr, table) {
  for (const x of jr.j.txs.filter((t) => t.table === table && /^lookup table: create/.test(t.step))) {
    const s = await createState(p, x);
    if (s === "landed") return `its create ${x.signature} landed`;
    if (s === "open") return `its create ${x.signature} may still land${x.last_valid == null ? "" : ` (valid until block height ${x.last_valid})`}`;
    if (x.state === "sent") (x.state = s), jr.save();
  }
  return null;
}

/** Why a journaled send to `table` that is not marked landed may still land (a reason naming it), or null: each one's
 *  createState read (a confirmed status: landed; an error: failed; no status on either RPC and both past its last valid
 *  block height at finalized: expired), the journal updated with what it reads. */
async function sendMayLand(p, jr, table) {
  for (const x of jr.j.txs.filter((t) => t.table === table && /^lookup table: /.test(t.step) && !["landed", "failed", "expired"].includes(t.state))) {
    const s = await createState(p, x);
    if (s === "open") return `its ${x.step.replace(/^lookup table: /, "")} ${x.signature} may still land${x.last_valid == null ? "" : ` (valid until block height ${x.last_valid})`}`;
    if (x.state !== s) (x.state = s), jr.save();
  }
  return null;
}

/** The addresses the journal's landed sends put in `table`: the sum of each landed create's and extend's "with N
 *  addresses" (the journal holds every send before it goes, so this is what the table holds once the reads catch up). */
const landedOf = (jr, table) => jr.j.txs.filter((x) => x.table === table && x.state === "landed").reduce((s, x) => s + Number(/ with (\d+) addresses$/.exec(x.step)?.[1] ?? 0), 0);
const countOf = (acc) => (acc.data.length - TABLE_META) / 32;
/** A table no resume can finish (more addresses than the journal's landed sends explain, or not the list's prefix under
 *  the funder): the run stops by name, and its catch says the recovery with the kept key. */
const stranded = (msg) => Object.assign(new Error(msg), { stranded: true });

/** What the chain holds of the journal's table: null (none, and no create of it landed or can still land) or the
 *  account both RPCs read at confirmed and at finalized, all four the same bytes, a lookup table holding exactly the
 *  addresses the journal's landed sends put in it. The statuses come first: every journaled send to the table (create,
 *  extend or freeze) not landed must be past landing (one refused by this node may be taken by another while its
 *  blockhash lives) before the table is read, so a send that lands between the reads and the statuses is never taken
 *  as the table's. Then the table must hold what the landed sends say: fewer (the reads are behind a landed send) stops
 *  with "resume again in a minute", more is not explainable and stops by name; either way nothing is sent and the key
 *  is kept. An extend from a stale count would put addresses in the table twice. */
async function journalTable(p, jr) {
  const T = jr.j.table;
  if (!T) return null;
  const may = await sendMayLand(p, jr, T);
  if (may) throw new Error(`lookup table ${T}: ${may}: nothing is sent and the key is kept; resume again in a minute`);
  const [cf, fin] = await Promise.all([read2(p, T, "confirmed"), read2(p, T)]);
  const create = jr.j.txs.find((x) => x.table === T && x.state === "landed" && /^lookup table: create/.test(x.step));
  if (!fin[0] && !fin[1]) {
    if (create) throw new Error(`lookup table ${T}: its create ${create.signature} landed, and neither RPC reads it at finalized yet: nothing is sent and the key is kept; resume again in a minute`);
    if (!cf[0] && !cf[1]) return null;
  }
  const r = [...cf, ...fin];
  if (!(r[0] && r[0].owner === ALT_PROGRAM && same2(r))) {
    const what = (x) => (!x ? "nothing" : x.owner !== ALT_PROGRAM ? `an account of ${x.owner}` : `a table of ${countOf(x)} addresses, authority ${x.data[21] === 1 ? b58encode(x.data.subarray(22, 54)) : "none"}`);
    const reads = ["confirmed", "finalized"].flatMap((c, k) => p.c.rpcs.map((u, i) => `${u} at ${c}: ${what(r[2 * k + i])}`));
    throw new Error(`the two RPCs do not read lookup table ${T} the same at confirmed and at finalized (${reads.join("; ")}): nothing is sent and the key is kept; resume again in a minute`);
  }
  const n = countOf(fin[0]), want = landedOf(jr, T);
  if (n < want) throw new Error(`lookup table ${T}: both RPCs read ${n} addresses, and the journal's landed sends put in ${want}: the reads are behind; nothing is sent and the key is kept; resume again in a minute`);
  if (n > want) throw stranded(`lookup table ${T} holds ${n} addresses, more than the ${want} the journal's landed sends put in: nothing is sent and the key is kept`);
  return fin[0];
}

/** Before each extend: both RPCs read the table at confirmed, the same bytes, holding exactly the journal's landed
 *  count, the list's prefix under the funder; reads behind are read again for 90 s, then the run stops ("resume again
 *  in a minute"); a table past the count or off the list stops by name. The extend instruction appends wherever the table
 *  ends (no expected length in it), so this read is what keeps an extend from a stale start. */
async function extendGuard(p, jr, T, list, funderId, { wait, now }) {
  const want = landedOf(jr, T);
  let last = "not read";
  for (const until = now() + 90_000; ; await wait(2_000)) {
    const r = await read2(p, T, "confirmed").catch((e) => ((last = `not read: ${e.message}`), null));
    if (r && r[0] && r[0].owner === ALT_PROGRAM && same2(r)) {
      const v = r[0], n = countOf(v);
      const got = [];
      for (let i = TABLE_META; i < v.data.length; i += 32) got.push(b58encode(v.data.subarray(i, i + 32)));
      if (n > want || got.some((a, i) => a !== list[i]) || v.data[21] !== 1 || b58encode(v.data.subarray(22, 54)) !== funderId) {
        throw stranded(`lookup table ${T} holds ${n} addresses where the journal's landed sends put in ${want}${got.some((a, i) => a !== list[i]) ? ", not the list's prefix" : ""}${v.data[21] !== 1 || b58encode(v.data.subarray(22, 54)) !== funderId ? ", not under the funder" : ""}: no extend is sent`);
      }
      if (n === want) return;
      last = `both RPCs read ${n} addresses, the journal's landed sends put in ${want}`;
    } else if (r) last = "the two RPCs' reads at confirmed are not the same";
    if (now() >= until) throw new Error(`lookup table ${T}: ${last}: no extend is sent and the key is kept; resume again in a minute`);
  }
}

/** The recovery of a table no resume can finish: its rent back to `returnTo` with the kept key, by the solana CLI
 *  (agave v4.4.0, as mainnet-deploy.sh fetches it: `address-lookup-table deactivate` and `close`, the funder the fee
 *  payer), then the folder removed by hand; a fresh paste then makes the generation again. */
export function recoveryLines(url, table, keyDir, funderId, returnTo) {
  const k = path.join(keyDir, "funder.json");
  return [
    `lookup table ${table} cannot be finished by a resume; its rent comes back to ${returnTo} with the kept key:`,
    `  1. send 10000 lamports (two fees) to the funder ${funderId}`,
    `  2. solana address-lookup-table deactivate ${table} --authority ${k} --keypair ${k} --url ${url} --bypass-warning`,
    `  3. some 4 minutes later (512 slots after the deactivation): solana address-lookup-table close ${table} --recipient ${returnTo} --authority ${k} --keypair ${k} --url ${url}`,
    `  4. solana transfer --url ${url} --keypair ${k} --fee-payer ${k} ${returnTo} ALL --allow-unfunded-recipient`,
    `  5. once neither RPC reads the table and the funder holds nothing: rm -r ${keyDir}; then paste the run's line again`,
  ];
}

/** Why the journal's table needs its folder kept (a reason), or null: no RPC reads it at confirmed or finalized and no
 *  create of it landed or can still land. A frozen table needs it too until the record holds its row. */
async function tableNeedsFolder(p, jr) {
  const T = jr.j.table;
  if (!T) return null;
  const r = [...(await read2(p, T, "confirmed")), ...(await read2(p, T))];
  if (r.some(Boolean)) return `its journal names lookup table ${T}, which the chain holds`;
  const why = await createMayHaveLanded(p, jr, T);
  return why && `lookup table ${T}: ${why}`;
}

/** The lock of a key folder: one run at a time. Its file holds the pid and that process's start time, made whole before
 *  it is visible (a hard link of a written file), so a reader never sees a half-written lock, and a pid that now
 *  belongs to another process (a restart, pids reused) is a dead lock. */
export const LOCK = "run.lock";
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
};
/** A process's start time as ps prints it (lstart), or null when there is none. */
const startOf = (pid) => {
  try {
    return execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
};
const lockText = () => `${process.pid}\n${startOf(process.pid) ?? ""}\n`;
/** The live run a lock file names ({ pid, start }), or null: no file, no pid, the pid gone, or the pid now another
 *  process's (its start time not the one the lock holds). A lock with no start time (an older run's) goes by its pid. */
function liveIn(file) {
  let pid, start;
  try {
    [pid, start] = readFileSync(file, "utf8").split("\n").map((x) => x.trim());
    pid = Number(pid);
  } catch {
    return null;
  }
  if (!Number.isSafeInteger(pid) || pid <= 0 || !alive(pid)) return null;
  if (start && startOf(pid) !== start) return null;
  return { pid, start: start || "unknown" };
}
/** The live run that holds `dir`'s lock ({ pid, start }), or null. */
const lockHolder = (dir) => liveIn(path.join(dir, LOCK));
/** Takes `dir`'s lock for this process, or throws when a live run holds it; a dead lock is taken over and said so (moved
 *  aside by a rename, so of two runs taking over the same dead lock only one does). Returns release(), which runs on
 *  every exit: the run's own end, process.exit, SIGINT (exit 130), SIGTERM (143), each saying `onSignal` first. */
export function lockFolder(dir, { say = log, onSignal = null } = {}) {
  const file = path.join(dir, LOCK);
  const take = () => {
    const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}`;
    writeFileSync(tmp, lockText(), { mode: 0o600 });
    try {
      linkSync(tmp, file);
    } finally {
      rmSync(tmp, { force: true });
    }
  };
  const held = (h) => new Error(`another run (pid ${h?.pid ?? "unknown"}, started ${h?.start ?? "unknown"}) holds ${file}: nothing is sent; let that run end or stop it, then paste this line again`);
  try {
    take();
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    const h = lockHolder(dir);
    if (h !== null) throw held(h);
    let was = "unknown";
    try {
      was = readFileSync(file, "utf8").split("\n")[0].trim() || was;
    } catch {}
    const aside = `${file}.gone.${process.pid}.${randomBytes(6).toString("hex")}`;
    try {
      renameSync(file, aside);
    } catch (x) {
      if (x.code !== "ENOENT") throw x;
    }
    // what was moved aside is a live run's lock when another run took the dead one over between the read and the rename:
    // it goes back, and this run stops
    const moved = existsSync(aside) ? liveIn(aside) : null;
    if (moved) {
      try {
        linkSync(aside, file);
      } catch {}
      rmSync(aside, { force: true });
      throw held(moved);
    }
    rmSync(aside, { force: true });
    try {
      take();
    } catch (x) {
      if (x.code === "EEXIST") throw held(lockHolder(dir));
      throw x;
    }
    say(`the lock of a run that is gone (pid ${was}) in ${dir} is taken over`);
  }
  let on = true;
  const release = () => {
    if (!on) return;
    on = false;
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
    process.off("exit", release);
    try {
      if (readFileSync(file, "utf8").split("\n")[0].trim() === String(process.pid)) unlinkSync(file);
    } catch {}
  };
  const onInt = () => (onSignal && say(onSignal), release(), process.exit(130));
  const onTerm = () => (onSignal && say(onSignal), release(), process.exit(143));
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  process.on("exit", release);
  return release;
}

/** Why a key folder of this cluster and venue under `base` stops a fresh paste (a reason), or null when it does not: a
 *  live run holds it, or its run did not stop here with one fee or less on its funder, or its funder holds more now, or
 *  its journal names a table the chain holds or may still make. A read that fails stops the paste too. */
async function inTheWay(p, dir) {
  const h = lockHolder(dir);
  if (h !== null) return `another run (pid ${h.pid}, started ${h.start}) holds its lock ${path.join(dir, LOCK)}`;
  let j;
  try {
    j = JSON.parse(readFileSync(path.join(dir, "journal.json"), "utf8"));
  } catch (e) {
    return `its journal is not read (${e.code ?? e.message})`;
  }
  if (!/^\d+$/.test(String(j.stopped_left ?? ""))) return "its run did not stop with its funder read";
  if (BigInt(j.stopped_left) > FEE_PER_SIGNATURE) return `its funder held ${j.stopped_left} lamports when it stopped`;
  try {
    const b = await balances(p, j.funder, "confirmed");
    const most = b[0] > b[1] ? b[0] : b[1];
    if (most > FEE_PER_SIGNATURE) return `its funder ${j.funder} holds ${most} lamports`;
    return await tableNeedsFolder(p, { j, save: () => {} });
  } catch (e) {
    return `not read: ${e.message}`;
  }
}
/** The key folders of this cluster and venue under `base` that stop a fresh paste: [{ dir, returnTo, why }]. */
async function keptFolders(p, base, say) {
  if (!existsSync(base)) return [];
  const out = [];
  for (const n of readdirSync(base).filter((n) => n.startsWith(`venue-table-${p.cluster}-${p.venue}-`))) {
    const dir = path.join(base, n);
    let returnTo = null;
    try {
      returnTo = JSON.parse(readFileSync(path.join(dir, "journal.json"), "utf8")).return_to ?? null;
    } catch {}
    const why = await inTheWay(p, dir);
    if (why) out.push({ dir, returnTo, why });
    else say(`the stopped run's folder ${dir} holds no SOL and no table: it is left as it is (its key kept) and does not stop this paste`);
  }
  return out;
}

/** Why `returnTo` cannot take the funder's rest, as deploy.mjs's returnProblems reads it on both RPCs (a wallet: on the
 *  curve, a system account holding lamports), or as the record's program or pool. */
async function returnRefusal(p, returnTo) {
  // the record's own two accounts are refused from the record itself, before any read: the RPCs' reads below refuse
  // them too (a program, a program's account), and these two lines keep that refusal from resting on an RPC's answer
  if (returnTo === p.record.program_id) return "is the pool's program, not a wallet";
  if (returnTo === p.record.pool) return "is the pool's account, not a wallet";
  for (const u of p.c.rpcs) {
    const why = await returnProblems(p.fetchFn, u, returnTo);
    if (why) return why;
  }
  return null;
}

/** A balance read's fault the funding wait reads again through: rpc()'s transient (HTTP 5xx or 429, the network, past
 *  its tries) or a node's JSON-RPC error answer. */
const readFault = (e) => e?.transient === true || /^getBalance: HTTP \d+ \{"code":/.test(String(e?.message));

/**
 * The run (or a resume, with `keyDir`): the table made, read back, frozen and read back, recorded; the funder swept.
 * `base` is the key folders' home (keysBase()); `say`, `wait` and `now` the output and clock (a test's are its own).
 */
export async function run(p, { returnTo, keyDir = null, base, say = log, wait = sleep, now = Date.now }) {
  const { cluster, venue } = p;
  const refused = await returnRefusal(p, returnTo);
  if (refused) throw new Error(`--return ${returnTo} ${refused}: nothing is made or sent`);
  let funder, release;
  const resumed = keyDir !== null;
  if (keyDir) {
    release = lockFolder(keyDir, { say, onSignal: signalLine(keyDir, returnTo) });
    try {
      const raw = Uint8Array.from(JSON.parse(readFileSync(path.join(keyDir, "funder.json"), "utf8")));
      funder = { secret: raw.slice(0, 32), pub: raw.slice(32), id: b58encode(raw.slice(32)) };
    } catch (e) {
      release();
      throw e;
    }
  } else {
    base ??= keysBase();
    const kept = await keptFolders(p, base, say);
    if (kept.length) throw new Error(`a stopped ${venue} run on ${cluster} kept its key folder: ${kept.map((k) => `${k.dir} (${k.why}; go on with: ${resumeLine(k.dir, k.returnTo ?? returnTo)})`).join("; ")}`);
    funder = newKey();
    keyDir = path.join(base, `venue-table-${cluster}-${venue}-${new Date(now()).toISOString().replace(/[:.]/g, "-")}`);
    mkdirSync(keyDir, { recursive: true, mode: 0o700 });
    chmodSync(keyDir, 0o700);
    release = lockFolder(keyDir, { say, onSignal: signalLine(keyDir, returnTo) });
    writeFileSync(path.join(keyDir, "funder.json"), JSON.stringify([...funder.secret, ...funder.pub]), { mode: 0o600 });
  }
  try {
    await runLocked(p, { returnTo, keyDir, funder, say, wait, now, resumed });
  } finally {
    release();
  }
}

async function runLocked(p, { returnTo, keyDir, funder, say, wait, now, resumed = false }) {
  const { cluster, venue, c, list, range, sizes } = p;
  const jr = journalOf(keyDir, { cluster, venue, funder: funder.id, return_to: returnTo, table: null, slot: null, bump: null, pages: range, made_at: sizes, list });
  // a stop's mark holds only until a run takes the folder again: one killed in its funding wait leaves none
  if ("stopped_left" in jr.j) delete jr.j.stopped_left, jr.save();
  const resume = resumeLine(keyDir, returnTo);
  say(`the funder's key and the run's journal are in ${keyDir}; a stopped run goes on with: ${resume}`);
  const o = { say, wait, now };
  try {
    if (jr.j.funder !== funder.id) throw new Error(`${keyDir}: the journal's funder ${jr.j.funder} is not the key file's ${funder.id}`);
    if (JSON.stringify(jr.j.list) !== JSON.stringify(list)) throw new Error(`the kit's list now differs from the stopped run's (${keyDir}/journal.json): nothing is sent to a table`);
    const sc = (table, step, ixs) => sendAndConfirm(p.fetchFn, c.rpcs[0], ixs, funder, [funder], { step, journal: jr.on(table), wait, now });
    // every extend goes only once both RPCs read the table holding exactly what the journal's landed sends put in it
    const extend = async (table, s) => (await extendGuard(p, jr, table, list, funder.id, o), sc(table, s.step, s.ixs));
    // the table: the journal's when both RPCs read it, else a new one; what it holds decides where the run goes on:
    // nothing (create), a prefix of the list under the funder (extend the rest), the list under the funder (freeze),
    // the list frozen (record); anything else stops with the table named
    const held = await journalTable(p, jr);
    // a resume that has made no table first asks the fresh paste's "nothing to add": another run may have made this
    // generation since (the record holds it); then it only gives the SOL back. Otherwise it goes on with its journal's
    // range, as a resume does
    if (!held && resumed) {
      let why = null;
      try {
        await plan(cluster, venue, { fetchFn: p.fetchFn, dir: path.dirname(p.file), wait: p.wait });
      } catch (e) {
        if (!/^nothing to add/.test(String(e?.message))) throw e;
        why = e.message;
      }
      if (why) throw Object.assign(new Error(`this stopped run made no table, and ${why}: nothing is made; the funder's SOL goes back to ${returnTo}`), { noTable: true });
    }
    let t = held ? { address: jr.j.table, slot: BigInt(jr.j.slot), bump: jr.j.bump } : null;
    const got = [];
    if (held) for (let i = TABLE_META; i < held.data.length; i += 32) got.push(b58encode(held.data.subarray(i, i + 32)));
    const have2 = !held ? "none" : tableProblems(held, list, null).length === 0 ? "frozen" : "partial";
    if (have2 === "partial" && (held.data[21] !== 1 || b58encode(held.data.subarray(22, 54)) !== funder.id || got.length > list.length || got.some((a, i) => a !== list[i]))) {
      throw stranded(`lookup table ${t.address} is not the funder's or not a prefix of the list: ${tableProblems(held, list, funder.id).join("; ")}`);
    }
    const P0 = "11111111111111111111111111111111";
    const left = have2 === "frozen" ? [] : tableSteps(funder.id, t?.address ?? P0, t?.slot ?? 0n, t?.bump ?? 255, list.slice(got.length), c.price, { create: have2 === "none" });
    if (have2 !== "frozen") {
      // a frozen table needs no send: only its record row, and the sweep of what the funder holds
      const owed = p.rentOf(TABLE_META + 32 * list.length) - (held ? p.rentOf(TABLE_META + 32 * got.length) : 0n);
      const need = needOf(owed, left, c.price, p.rentOf(0));
      // the funder's balance, read again through a node's error or an outage: the owner may be sending SOL to it now, so
      // only stopping the process ends the wait
      let faults = 0;
      const read = async () => {
        for (;;) {
          try {
            const b = await balance2(p, funder.id);
            faults = 0;
            return b;
          } catch (e) {
            if (!readFault(e)) throw e;
            if (faults++ % 30 === 0) say(`a balance read failed (${String(e.message).slice(0, 160)}): reading again every 10 s; only stopping this process ends the wait`);
            await wait(10_000);
          }
        }
      };
      const have = await read();
      if (have < need.total) {
        say(`send ${need.total - have} lamports (${solOf(need.total - have)} SOL) to the funder ${funder.id} on ${cluster}, from ${returnTo}: it needs ${need.total} (the table's rent ${need.lookup_table}, fees ${need.fees}, priority ${need.priority}, its own floor ${need.funder_floor}, which comes back) and holds ${have}`);
        for (let b = have; b < need.total; b = await read()) await wait(10_000);
        say(`the funder holds at least ${need.total} on both RPCs`);
      }
    }
    if (have2 === "none") {
      // the create at a slot the sending node holds; refused as not recent, it is built again from a new read once that
      // create can no longer land (its blockhash expired with no status), so the journal never loses a table
      for (let i = 1; ; i++) {
        const slot = await recentSlot(p.call[0]);
        const at = pda([funder.pub, le(slot, 8)], ALT_PROGRAM);
        t = { address: at.address, slot, bump: at.bump };
        Object.assign(jr.j, { table: t.address, slot: String(slot), bump: t.bump });
        jr.save();
        const first = tableSteps(funder.id, t.address, t.slot, t.bump, list, c.price)[0];
        try {
          await sc(t.address, first.step, first.ixs);
          break;
        } catch (e) {
          if (i >= CREATE_TRIES || !/invalid instruction data|not a recent slot/i.test(String(e?.message))) throw e;
          for (const until = now() + 180_000; ; await wait(5_000)) {
            const why = await createMayHaveLanded(p, jr, t.address);
            if (!why) break;
            if (/landed/.test(why) || now() > until) throw new Error(`lookup table ${t.address}: ${why}: the run stops with the journal naming it`);
          }
          say(`slot ${slot} is not recent on the sending node and that create can no longer land: reading again (try ${i + 1} of ${CREATE_TRIES})`);
        }
      }
      const n0 = tableSteps(funder.id, t.address, t.slot, t.bump, list, c.price)[0].ixs.find((x) => x.data[0] === 2);
      const done = n0 ? Number(Buffer.from(n0.data).readBigUInt64LE(4)) : 0;
      for (const s of tableSteps(funder.id, t.address, t.slot, t.bump, list.slice(done), c.price, { create: false }).slice(0, -1)) await extend(t.address, s);
    } else if (have2 === "partial") {
      for (const s of left.slice(0, -1)) await extend(t.address, s);
    }
    if (have2 !== "frozen") {
      await readBack(p, t.address, list, funder.id, o);
      say(`lookup table ${t.address} holds the ${list.length} addresses on both RPCs at finalized, the funder its authority; freezing it`);
      const f = tableSteps(funder.id, t.address, t.slot, t.bump, list, c.price).at(-1);
      await sc(t.address, f.step, f.ixs);
    }
    await readBack(p, t.address, list, null, o);
    say(`lookup table ${t.address} is frozen (authority none) and holds exactly the ${list.length} addresses on both RPCs at finalized`);
    // the record: the generation at the end of the venue's list, once, then read back from the file
    const { record } = recordOf(cluster, path.dirname(p.file));
    const gens = record.tables?.[venue] ?? [];
    if (!gens.some((g) => g.table === t.address)) {
      const txs = jr.j.txs.filter((x) => x.table === t.address && x.state === "landed").map(({ step, signature }) => ({ step, signature }));
      record.tables = { ...(record.tables ?? {}), [venue]: [...gens, { table: t.address, pages: range, made_at: sizes, addresses: list, txs }] };
      writeFileSync(p.file, JSON.stringify(record, null, 2) + "\n");
      say(`${path.relative(REPO, p.file)}: tables.${venue} generation ${gens.length + 1} = ${t.address} (${pagesText(range)})`);
    }
    const back = (JSON.parse(readFileSync(p.file, "utf8")).tables?.[venue] ?? []).filter((g) => g?.table === t.address);
    if (back.length !== 1 || JSON.stringify(back[0].addresses) !== JSON.stringify(list)) throw new Error(`${p.file} does not read back one tables.${venue} row for ${t.address} with the list`);
    // the success path, and the only one that removes the key folder: the sweep landed, the table frozen on both RPCs,
    // the funder at 0 on both at finalized
    await giveBack(p, funder, returnTo, jr, o);
    const why = await keyNeeded(p, jr);
    if (why) return say(`${why}: the key stays in ${keyDir}`);
    for (let i = 0; i < 30; i++, await wait(5_000)) {
      if ((await balances(p, funder.id, "finalized")).every((x) => x === 0n)) {
        rmSync(keyDir, { recursive: true, force: true });
        return say(`the funder reads 0 on both RPCs at finalized: its key folder is removed, so any SOL that reaches the funder ${funder.id} from now on is lost (no key is left for it)`);
      }
    }
    say(`the funder does not read 0 on both RPCs yet: the key folder ${keyDir} is kept`);
  } catch (e) {
    // a stop: the funder's SOL goes back when it can; the folder and its journal stay, whatever the table reads
    say(`stopped: ${e?.message ?? e}`);
    await giveBack(p, funder, returnTo, jr, o).catch((x) => {
      say(`the sweep stopped too: ${x.message}`);
      say(`the funder's SOL goes back with: solana transfer --url ${c.rpcs[0]} --keypair ${path.join(keyDir, "funder.json")} --fee-payer ${path.join(keyDir, "funder.json")} ${returnTo} ALL --allow-unfunded-recipient`);
    });
    const most = await balances(p, funder.id, "confirmed").then((b) => (b[0] > b[1] ? b[0] : b[1]), () => null);
    if (most !== null) (jr.j.stopped_left = String(most)), jr.save();
    const why = await keyNeeded(p, jr).catch((x) => `the table was not read (${x.message})`);
    if (why) say(`${why}: the key stays in ${keyDir}`);
    const table = await tableNeedsFolder(p, jr).catch((x) => `the table was not read (${x.message})`);
    if (most !== null && most <= FEE_PER_SIGNATURE && !table) {
      say(`the funder ${funder.id} holds ${most} lamports, too little to send back: nothing is left to do, and this folder does not stop a fresh paste. SOL that lands on the funder later comes back with: ${resume} (a resume makes no table once a paste made this generation, it only gives back).`);
    }
    // a table no resume can finish: its recovery, said last (after the sweep, which it does not need)
    if (e?.stranded) for (const l of recoveryLines(c.rpcs[0], jr.j.table, keyDir, funder.id, returnTo)) say(l);
    else say(`the key folder ${keyDir} is kept, the funder's key and the journal in it. Go on with: ${resume}`);
    throw e;
  }
}

/** Every lamport of the funder to `returnTo` (its own fee less), when it holds more than that fee. */
async function giveBack(p, funder, returnTo, jr, { say, wait, now }) {
  const b = await balance2(p, funder.id);
  if (b > FEE_PER_SIGNATURE) {
    const sig = await sendAndConfirm(p.fetchFn, p.c.rpcs[0], [transferIx(funder.id, returnTo, b - FEE_PER_SIGNATURE)], funder, [funder], { step: `sweep to ${returnTo}`, journal: jr.on(null), wait, now });
    say(`swept ${b - FEE_PER_SIGNATURE} lamports to ${returnTo}: ${sig}`);
  }
}

/** Why the key must stay for the journal's table (a reason), or null: both RPCs read it frozen at finalized, the same
 *  bytes, or neither reads it and no create of it landed or can still land. */
async function keyNeeded(p, jr) {
  const T = jr.j.table;
  if (!T) return null;
  const r = await read2(p, T);
  if (r.some((x) => x && x.owner === ALT_PROGRAM && x.data[21] === 1)) return `lookup table ${T} still has the funder as its authority`;
  if (!r[0] && !r[1]) {
    const why = await createMayHaveLanded(p, jr, T);
    return why && `lookup table ${T}: ${why}`;
  }
  if (same2(r) && r[0].owner === ALT_PROGRAM && r[0].data[21] === 0) return null;
  return `the two RPCs do not read lookup table ${T} the same at finalized`;
}

/** --dry-run: everything read and built, nothing sent or written. */
export async function dryRun(p, { say = log } = {}) {
  const probe = newKey(); // never funded, never written: only to size the transactions
  const slot = BigInt(await p.call[0]("getSlot", [{ commitment: "finalized" }]));
  const t = pda([probe.pub, le(slot, 8)], ALT_PROGRAM);
  const steps = tableSteps(probe.id, t.address, slot, t.bump, p.list, p.c.price);
  const need = needOf(p.tableRent, steps, p.c.price, p.rentOf(0));
  const bh = (await p.call[0]("getLatestBlockhash", [{ commitment: "confirmed" }])).value.blockhash;
  const end = kit.solanaPoolRangeEnd(p.range);
  const warn = kit.solanaPoolRangeWarn(p.range);
  say(`${p.cluster}: program ${p.record.program_id}, pool ${p.record.pool}; the ${p.venue} venue read at finalized on ${p.c.rpcs.join(" and ")}, the same bytes`);
  say(`generation ${p.generation} of the ${p.venue} table: ${pagesText(p.range)} (the trees hold ${p.sizes.state} and ${p.sizes.label} entries: the pool account at finalized on both RPCs, the smaller of each)`);
  say(`it serves a buy up to entry ${end.state - 1} of the state tree and ${end.label - 1} of the label tree; it warns once the state tree holds ${warn.state} or the label tree ${warn.label}`);
  say(`the table will freeze these ${p.list.length} addresses, in this order (the kit's solanaPoolVenueTableList):`);
  p.list.forEach((a, i) => say(`  ${String(i).padStart(3)} ${a}`));
  for (const s of [...steps, { step: "sweep (the funder's rest back)", ixs: [transferIx(probe.id, probe.id, 1n)] }]) {
    const size = Buffer.from(signTx(compileMessage(probe.id, s.ixs, bh), [probe]).base64, "base64").length;
    say(`built: ${s.step}: ${size} bytes`);
  }
  say(`cost: ${need.total} lamports = ${solOf(need.total)} SOL (the table's rent ${need.lookup_table} = ${solOf(need.lookup_table)} SOL, locked for good in the frozen table; fees ${need.fees}; priority ${need.priority}; the funder's own floor ${need.funder_floor}, which comes back); the rest comes back`);
  say(`the run: ${runLine(p.cluster, p.venue)}`);
}

/** What a mainnet run's plan rests on: the record (its generations), this script and the kit's list and builder. */
export const GATED = Object.freeze(["contracts/pool-solana/deployments/mainnet.json", "contracts/pool-solana/scripts/venue-table.mjs", "packages/kit/src/trade/solana/pool-buy.ts"]);
/** git in `root` with no global or system config and no GIT_* of the caller's (source-gate.mjs's gitIn), so a global
 *  url.insteadOf never answers for REPO. */
function gitAt(root) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
  Object.assign(env, { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_NO_REPLACE_OBJECTS: "1", GIT_TERMINAL_PROMPT: "0" });
  return (...a) => execFileSync("git", ["-C", root, ...a], { env, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 << 20 }).toString("utf8");
}
/** Keys sorted at every level, for comparing two records whatever their key order. */
const canon = (v) => JSON.stringify(v, (_, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));

/**
 * The mainnet source gate: [] when the checkout at `root` may run a mainnet paste or resume. HEAD is an ancestor of (or
 * equal to) `remote`'s main as git ls-remote answers it now, fetched when missing (source-gate.mjs's mainProblems);
 * GATED's three files each have the same blob at HEAD as at main; and `git status` shows no tracked file changed. A resume
 * (`journal`) may find the record changed by its own row for the journal's table alone, at the end of its venue's list:
 * a stop after the record write.
 * source-gate.mjs's full cloneProblems cannot hold here: the owner's checkout is not a fresh clone (its .git/config
 * holds includeIf keys of its own and its info/exclude a pattern, both of which cloneProblems refuses), so this gate
 * holds what the generation rests on: the record main has, read by the code main has.
 */
export function sourceProblems({ root = REPO, remote = SOURCE_REPO, journal = null } = {}) {
  const raw = gitAt(root);
  let listed = "";
  const git = (...a) => {
    const out = raw(...a);
    if (a[0] === "ls-remote") listed = out;
    return out;
  };
  let head;
  try {
    head = git("rev-parse", "--verify", "HEAD^{commit}").trim();
  } catch (e) {
    return [`${root} is not a git checkout with a commit: ${String(e.stderr || e.message).trim().split("\n")[0]}`];
  }
  const off = mainProblems(git, head, remote);
  if (off.length) return off;
  const main = listed.split("\n").map((l) => l.split("\t")).find((f) => f.length === 2 && f[1] === "refs/heads/main")[0];
  const blob = (rev, f) => {
    try {
      return git("rev-parse", "--verify", "--quiet", `${rev}:${f}`).trim();
    } catch {
      return null;
    }
  };
  const p = [];
  for (const f of GATED) {
    const [a, b] = [blob(head, f), blob(main, f)];
    if (!a || a !== b) p.push(`${f} at HEAD ${head.slice(0, 12)} is not main's ${main.slice(0, 12)} (${a ?? "missing"}, main ${b ?? "missing"}): bring the checkout to main (git pull --ff-only origin main), then paste the line again`);
  }
  const ownRow = () => {
    if (!journal?.table || !journal?.venue) return false;
    try {
      const w = JSON.parse(readFileSync(path.join(root, GATED[0]), "utf8"));
      const h = JSON.parse(git("show", `${head}:${GATED[0]}`));
      const rows = w.tables?.[journal.venue];
      // the run appends its row at the end, once: anywhere else it is not the run's own write
      if (!Array.isArray(rows) || rows.filter((g) => g?.table === journal.table).length !== 1 || rows.at(-1)?.table !== journal.table) return false;
      const rest = rows.filter((g) => g?.table !== journal.table);
      w.tables = { ...w.tables, [journal.venue]: rest };
      if (h.tables?.[journal.venue] === undefined && rest.length === 0) delete w.tables[journal.venue];
      return canon(w) === canon(h);
    } catch {
      return false;
    }
  };
  // every tracked file, not only GATED's: the paste also runs deploy.mjs (the sends, the key folder), the live check's
  // RPC list and the kit's other pool code, so a checkout with any tracked change is refused
  const changed = git("status", "--porcelain", "--untracked-files=no").split("\n").filter(Boolean).map((l) => l.slice(3));
  for (const f of changed) if (!(f === GATED[0] && ownRow())) p.push(`${f} has changes not committed: a mainnet paste runs only main's files (commit and merge them, or restore them), then paste the line again`);
  return p;
}

/** The command line: a mainnet run or resume (not --dry-run) passes `gate` before anything is read. */
export async function cli(args, { fetchFn = fetch, gate = sourceProblems, dir = DEPLOYMENTS, base, say = log, wait = sleep, now = Date.now } = {}) {
  const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
  const keyDir = opt("--resume");
  const j = keyDir ? JSON.parse(readFileSync(path.join(keyDir, "journal.json"), "utf8")) : null;
  const cluster = j?.cluster ?? opt("--cluster");
  const venue = j?.venue ?? opt("--venue");
  const dry = args.includes("--dry-run");
  if (cluster === "mainnet" && !dry) {
    const why = await gate({ journal: j });
    if (why.length) throw new Error(`the source gate refuses this checkout, nothing read or sent: ${why.join("; ")}`);
  }
  const p = await plan(cluster, venue, { fetchFn, dir, wait, journal: j });
  if (dry) return dryRun(p, { say });
  const returnTo = opt("--return") ?? j?.return_to;
  if (!returnTo) throw new Error(`--return <address> is needed: ${runLine(cluster, venue)}`);
  await run(p, { returnTo, keyDir: keyDir ?? null, base, say, wait, now });
  say(`then: node scripts/live-checks/sol-pool-venue-tables.mjs, and pin it in SOL_POOL_TABLES (packages/wallet/src/pool/solana.ts)`);
}

if (import.meta.main) {
  try {
    await cli(process.argv.slice(2));
  } catch (e) {
    console.error(`venue-table: ERROR: ${String(e?.message ?? e).split("\n")[0]}`);
    process.exit(1);
  }
}
