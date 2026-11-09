#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// One venue's frozen lookup table for the pool buy (card sol-pool-venue-tables): a tag 3 on a venue loads the pool, its
// pages and the venue's program-wide accounts from that venue's own table, since one table cannot serve every venue
// under 1,232 bytes (a PumpSwap buy on the pump curve's table is 1,384 B). A table is frozen, so a venue added later
// gets a table of its own and no table is ever changed.
//
//   node contracts/pool-solana/scripts/venue-table.mjs --cluster <mainnet|devnet> --venue <pump-curve|pumpswap> --dry-run
//     reads and builds everything, sends nothing, writes nothing: the list the table will freeze, every address on its
//     own line, the cost in SOL from the cluster's rent, each transaction built and its size, and the run's line
//   node contracts/pool-solana/scripts/venue-table.mjs --cluster <mainnet|devnet> --venue <venue> --return <address>
//     the run (on mainnet: the owner's paste, the line --dry-run prints)
//   node contracts/pool-solana/scripts/venue-table.mjs --resume <key folder> [--return <address>]
//     a stopped run, from its key folder (its journal is there): goes on from what the chain holds
//
// Steps:
//  1. The cluster's two RPCs (scripts/live-checks/pool-sol-deploy.mjs: MAINNET_RPCS or RPCS), each refused unless it
//     answers the cluster's genesis hash. The record: contracts/pool-solana/deployments/<cluster>.json (mainnet: the
//     pool's deploy record; devnet: made from scripts/live-checks/pool-sol-deploy.devnet.json's program and pool when
//     missing). A venue the record already names a table for is refused: a second table would lock its rent for good.
//  2. The list, never typed: the kit's readSolanaPoolTableVenue (the venue's global account at finalized on both RPCs,
//     the same bytes) and solanaPoolVenueTableList for the record's program and pool: what the builder loads
//     (packages/kit/test/solana-pool-venue-tables.test.ts; this script's test holds the two equal).
//  3. The cost: rent of the table (56 + 32 per address, the Rent sysvar read on both RPCs) and every transaction's fee
//     and priority bound (mainnet's own sends carry deploy.mjs's PRIORITY_MICRO_LAMPORTS on the default 200,000 CU per
//     instruction). Nothing is read about any key before the list and the cost are known.
//  4. A key made in memory, the funder: the table's authority and payer. Its file (the solana CLI's 64-byte form, 0600)
//     and the journal go to a 0700 folder under deploy.mjs's keysBase(), never OS temp, a repo or ~/.confidential-trenches,
//     and stay until the funder reads 0 on both RPCs. It prints the funder and the need, and waits until the funder holds
//     it on both RPCs (send it from --return; on mainnet that is the owner's move).
//  5. The table at a finalized slot's PDA [funder, slot]: create and extend with as many addresses as one transaction
//     holds, then the rest in further extends; read back at finalized on both RPCs, the same bytes, active, the funder its
//     authority and exactly the list; then frozen (authority none) and read back again the same way.
//  6. The record gains tables.<venue> = { table, addresses, txs }; the funder's lamports go back to --return in one
//     transfer; the key folder is removed once the funder reads 0 on both RPCs. A run that stops keeps the folder and
//     prints the --resume line; the resume freezes a table the funder still holds (extending it first when it holds a
//     prefix of the list), records a frozen one that holds exactly the list, and sweeps.
//  Then the live check: node scripts/live-checks/sol-pool-venue-tables.mjs; and the pin: SOL_POOL_TABLES in
//  packages/wallet/src/pool/solana.ts (packages/wallet/test/sol-pool-venue-tables.test.ts fails until it matches).
import "../../../scripts/net-window.mjs";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ALT_PROGRAM, FEE_PER_SIGNATURE, PRIORITY_MICRO_LAMPORTS, TABLE_META, TX_MAX, compileMessage, keysBase, newKey, priceIx, sendAndConfirm, signTx, solOf,
  tableIxs, tableProblems, transferIx,
} from "./deploy.mjs";
import { DEVNET_GENESIS, MAINNET_GENESIS, MAINNET_RPCS, RPCS as DEVNET_RPCS, account, address, b58encode, le, pda, rpc } from "../../../scripts/live-checks/pool-sol-deploy.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "../../..");
export const DEPLOYMENTS = path.join(REPO, "contracts/pool-solana/deployments");
const kit = await import(pathToFileURL(path.join(REPO, "packages/kit/src/trade/solana/pool-buy.ts")).href);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (s) => console.log(`venue-table: ${s}`);

export const CLUSTERS = Object.freeze({
  mainnet: { rpcs: MAINNET_RPCS, genesis: MAINNET_GENESIS, price: PRIORITY_MICRO_LAMPORTS },
  devnet: { rpcs: DEVNET_RPCS, genesis: DEVNET_GENESIS, price: 0n },
});
/** The default compute unit limit of a transaction with no SetComputeUnitLimit: 200,000 per instruction (not the
 *  compute budget's own), the bound the priority is priced on. */
const CU_PER_IX = 200_000n;

/** A public RPC answers 429 under load past rpc()'s own tries (shared devnet hosts): wait and ask again, up to 8 times. */
async function patient(f) {
  for (let i = 0; ; i++) {
    try {
      return await f();
    } catch (e) {
      if (i >= 7 || !/429|-32029|-32429|fetch failed/.test(String(e?.message))) throw e;
      await sleep(1_000 * 2 ** Math.min(i, 4));
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
export function tableSteps(funder, table, slot, bump, list, price) {
  const head = price > 0n ? [priceIx(price)] : [];
  const fits = (ixs) => {
    const m = compileMessage(funder, ixs, "11111111111111111111111111111111");
    return 1 + 64 * m.signers.length + m.bytes.length <= TX_MAX;
  };
  const steps = [];
  let at = 0;
  for (let first = true; first || at < list.length; first = false) {
    let n = list.length - at;
    const build = (k) => {
      const ix = tableIxs(funder, table, slot, bump, list.slice(at, at + k));
      return [...head, ...(first ? [ix.create] : []), ...(k > 0 ? [ix.extend] : [])];
    };
    while (n > 0 && !fits(build(n))) n--;
    if (n === 0 && !first) throw new Error("no address fits an extend");
    steps.push({ step: first ? `lookup table: create and extend with ${n} addresses` : `lookup table: extend with ${n} addresses`, ixs: build(n) });
    at += n;
  }
  steps.push({ step: "lookup table: freeze (authority none)", ixs: [...head, tableIxs(funder, table, slot, bump, []).freeze] });
  return steps;
}

/** The funder's need: the table's rent, and each transaction's fee and priority bound (the sweep's fee included). */
export function needOf(tableRent, steps, price) {
  const fees = BigInt(steps.length + 1) * FEE_PER_SIGNATURE;
  const priority = steps.reduce((s, x) => s + (BigInt(x.ixs.filter((i) => i.program !== "ComputeBudget111111111111111111111111111111").length) * CU_PER_IX * price + 999_999n) / 1_000_000n, 0n);
  return { lookup_table: tableRent, fees, priority, total: tableRent + fees + priority };
}

/** The paste line for a venue on a cluster. */
export const runLine = (cluster, venue) => `node contracts/pool-solana/scripts/venue-table.mjs --cluster ${cluster} --venue ${venue} --return <your Solana address, where the run's leftover SOL goes back>`;

/** The plan: both RPCs checked, the list from the kit's reader, the rent from both RPCs, the steps built. */
export async function plan(cluster, venue, { fetchFn = fetch, dir = DEPLOYMENTS } = {}) {
  const c = CLUSTERS[cluster];
  if (!c) throw new Error(`--cluster must be mainnet or devnet`);
  if (!kit.SOLANA_POOL_BUY_VENUES.includes(venue)) throw new Error(`--venue must be one of ${kit.SOLANA_POOL_BUY_VENUES.join(", ")}`);
  const call = c.rpcs.map((url) => Object.assign((method, params) => patient(() => rpc(fetchFn, url, method, params, sleep)), { url }));
  const gs = await Promise.all(call.map((f) => f("getGenesisHash", [])));
  gs.forEach((g, i) => { if (g !== c.genesis) throw new Error(`${c.rpcs[i]} answers genesis ${g}, not ${cluster}'s`); });
  const { file, record } = recordOf(cluster, dir);
  if (record.cluster !== cluster) throw new Error(`${file} is ${record.cluster}'s record`);
  const tv = await kit.readSolanaPoolTableVenue(call, venue);
  const list = kit.solanaPoolVenueTableList({ program: record.program_id, pool: record.pool }, tv);
  const rent = await kit.readSolanaRent(call);
  const tableRent = kit.solanaRentMin(rent, TABLE_META + 32 * list.length);
  return { cluster, venue, c, call, file, record, tv, list, tableRent };
}

/** The journal beside the key: every signed transaction, the table and the record's venue, written at each change. */
function journalOf(dir, init) {
  const file = path.join(dir, "journal.json");
  const j = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { ...init, txs: [] };
  const save = () => writeFileSync(file, JSON.stringify(j, null, 2) + "\n", { mode: 0o600 });
  save();
  return {
    j, save,
    signed: (step, tx) => (j.txs.push({ step, signature: tx.signature, state: "sent" }), save()),
    settled: (sig, state) => {
      const t = j.txs.find((x) => x.signature === sig);
      if (t) (t.state = state), save();
    },
  };
}

const read2 = (p, addr, commitment = "finalized") => Promise.all(p.c.rpcs.map((u) => account(fetch, u, addr, sleep, commitment)));
const same2 = (r) => r.every((x) => x && r[0] && x.owner === r[0].owner && Buffer.from(x.data).equals(Buffer.from(r[0].data)));
/** The table at finalized on both RPCs, the same bytes and tableProblems [] for (list, authority), within 90 s. */
async function readBack(p, table, list, authority) {
  let why = [];
  for (const until = Date.now() + 90_000; Date.now() < until; await sleep(2_000)) {
    const r = await read2(p, table).catch((e) => (why = [`not read: ${e.message}`], null));
    if (!r) continue;
    why = same2(r) ? tableProblems(r[0], list, authority) : ["the two RPCs read different bytes"];
    if (!why.length) return;
  }
  throw new Error(`lookup table ${table}: ${why.join("; ")}`);
}
const balance2 = async (p, id, commitment = "confirmed") => {
  const b = await Promise.all(p.call.map((f) => f("getBalance", [id, { commitment }]).then((x) => BigInt(x.value))));
  return b[0] < b[1] ? b[0] : b[1];
};

async function run(p, { returnTo, keyDir = null }) {
  const { cluster, venue, c, list } = p;
  const base = keysBase();
  let funder;
  if (keyDir) {
    const raw = Uint8Array.from(JSON.parse(readFileSync(path.join(keyDir, "funder.json"), "utf8")));
    funder = { secret: raw.slice(0, 32), pub: raw.slice(32), id: b58encode(raw.slice(32)) };
  } else {
    if (Object.hasOwn(p.record.tables ?? {}, venue)) throw new Error(`${p.file} already names a ${venue} table (${p.record.tables[venue].table}): a second one would lock its rent for good`);
    funder = newKey();
    keyDir = path.join(base, `venue-table-${cluster}-${venue}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
    mkdirSync(keyDir, { recursive: true, mode: 0o700 });
    chmodSync(keyDir, 0o700);
    writeFileSync(path.join(keyDir, "funder.json"), JSON.stringify([...funder.secret, ...funder.pub]), { mode: 0o600 });
  }
  const jr = journalOf(keyDir, { cluster, venue, funder: funder.id, return_to: returnTo, table: null, slot: null, list });
  if (JSON.stringify(jr.j.list) !== JSON.stringify(list)) throw new Error(`the kit's list now differs from the stopped run's (${keyDir}/journal.json): nothing is sent`);
  const resume = `node contracts/pool-solana/scripts/venue-table.mjs --resume ${keyDir} --return ${returnTo}`;
  try {
    const sc = (step, ixs) => sendAndConfirm(fetch, c.rpcs[0], ixs, funder, [funder], { step, journal: jr });
    // the table: a stopped run's when the chain holds it, else a new one at a finalized slot
    let t = null;
    let held = null;
    if (jr.j.table) {
      const r = await read2(p, jr.j.table);
      if (r[0] && r[0].owner === ALT_PROGRAM && same2(r)) (t = { address: jr.j.table, slot: BigInt(jr.j.slot), bump: jr.j.bump }), (held = r[0]);
    }
    const steps0 = tableSteps(funder.id, "11111111111111111111111111111111", 0n, 255, list, c.price);
    const need = needOf(p.tableRent, steps0, c.price);
    const have = await balance2(p, funder.id);
    if (!held && have < need.total) {
      log(`send ${need.total} lamports (${solOf(need.total)} SOL) to the funder ${funder.id} on ${cluster}, from ${returnTo}: the table's rent ${need.lookup_table}, fees ${need.fees}, priority ${need.priority}`);
      for (let b = have; b < need.total; b = await balance2(p, funder.id)) {
        if (b > 0n) log(`the funder holds ${b}: waiting for ${need.total}`);
        await sleep(10_000);
      }
      log(`the funder holds at least ${need.total} on both RPCs`);
    }
    if (!t) {
      const slot = BigInt(await p.call[0]("getSlot", [{ commitment: "finalized" }]));
      const at = pda([funder.pub, le(slot, 8)], ALT_PROGRAM);
      t = { address: at.address, slot, bump: at.bump };
      Object.assign(jr.j, { table: t.address, slot: String(slot), bump: t.bump });
      jr.save();
    }
    const steps = tableSteps(funder.id, t.address, t.slot, t.bump, list, c.price);
    // what the chain holds decides where the run goes on: nothing (create), a prefix under the funder (extend the rest),
    // the list under the funder (freeze), the list frozen (done); anything else stops with the table named
    let have2 = held ? tableProblems(held, list, null).length === 0 ? "frozen" : "partial" : "none";
    if (have2 === "none") {
      for (const s of steps.slice(0, -1)) await sc(s.step, s.ixs);
    } else if (have2 === "partial") {
      const got = [];
      for (let i = TABLE_META; i < held.data.length; i += 32) got.push(b58encode(held.data.subarray(i, i + 32)));
      if (held.data[21] !== 1 || b58encode(held.data.subarray(22, 54)) !== funder.id || got.some((a, i) => a !== list[i])) throw new Error(`lookup table ${t.address} is not the funder's or not a prefix of the list: ${tableProblems(held, list, funder.id).join("; ")}`);
      if (got.length < list.length) {
        const rest = tableSteps(funder.id, t.address, t.slot, t.bump, list.slice(got.length), c.price).slice(0, -1).map((s, i) => (i === 0 ? { step: s.step.replace("create and extend", "extend"), ixs: s.ixs.filter((x) => x.data[0] !== 0) } : s));
        for (const s of rest) await sc(s.step, s.ixs);
      }
    }
    if (have2 !== "frozen") {
      await readBack(p, t.address, list, funder.id);
      log(`lookup table ${t.address} holds the ${list.length} addresses on both RPCs at finalized, the funder its authority; freezing it`);
      const f = steps.at(-1);
      await sc(f.step, f.ixs);
    }
    await readBack(p, t.address, list, null);
    log(`lookup table ${t.address} is frozen (authority none) and holds exactly the ${list.length} addresses on both RPCs at finalized`);
    // the record
    const { file, record } = recordOf(cluster);
    record.tables = { ...(record.tables ?? {}), [venue]: { table: t.address, addresses: list, txs: jr.j.txs.filter((x) => x.state === "landed").map(({ step, signature }) => ({ step, signature })) } };
    writeFileSync(file, JSON.stringify(record, null, 2) + "\n");
    log(`${path.relative(REPO, file)}: tables.${venue} = ${t.address}`);
  } catch (e) {
    log(`stopped: ${e?.message ?? e}`);
    log(`the key folder ${keyDir} is kept (its journal names the table). Go on with: ${resume}`);
    await sweep(p, funder, returnTo, keyDir, jr).catch((x) => log(`the sweep stopped too: ${x.message}`));
    throw e;
  }
  await sweep(p, funder, returnTo, keyDir, jr);
}

/** Every lamport of the funder to `returnTo` (its own fee less), then the key folder removed once it reads 0 on both
 *  RPCs at finalized; kept, and said so, otherwise. A funder still the authority of a live table keeps its key. */
async function sweep(p, funder, returnTo, keyDir, jr) {
  if (jr.j.table) {
    const r = await read2(p, jr.j.table, "confirmed");
    if (r[0] && r[0].data[21] === 1) return log(`lookup table ${jr.j.table} still has the funder as its authority: the key stays in ${keyDir}`);
  }
  const b = await balance2(p, funder.id);
  if (b > FEE_PER_SIGNATURE) {
    const sig = await sendAndConfirm(fetch, p.c.rpcs[0], [transferIx(funder.id, returnTo, b - FEE_PER_SIGNATURE)], funder, [funder], { step: `sweep to ${returnTo}`, journal: jr });
    log(`swept ${b - FEE_PER_SIGNATURE} lamports to ${returnTo}: ${sig}`);
  }
  for (let i = 0; i < 30; i++, await sleep(5_000)) {
    if ((await balance2(p, funder.id, "finalized")) === 0n) {
      rmSync(keyDir, { recursive: true, force: true });
      return log(`the funder reads 0 on both RPCs at finalized: its key folder is removed`);
    }
  }
  log(`the funder does not read 0 yet: the key folder ${keyDir} is kept`);
}

/** --dry-run: everything read and built, nothing sent or written. */
async function dryRun(p) {
  const probe = newKey(); // never funded, never written: only to size the transactions
  const slot = BigInt(await p.call[0]("getSlot", [{ commitment: "finalized" }]));
  const t = pda([probe.pub, le(slot, 8)], ALT_PROGRAM);
  const steps = tableSteps(probe.id, t.address, slot, t.bump, p.list, p.c.price);
  const need = needOf(p.tableRent, steps, p.c.price);
  const bh = (await p.call[0]("getLatestBlockhash", [{ commitment: "confirmed" }])).value.blockhash;
  log(`${p.cluster}: program ${p.record.program_id}, pool ${p.record.pool}; the ${p.venue} venue read at finalized on ${p.c.rpcs.join(" and ")}, the same bytes`);
  log(`the table will freeze these ${p.list.length} addresses, in this order (the kit's solanaPoolVenueTableList):`);
  p.list.forEach((a, i) => console.log(`  ${String(i).padStart(2)} ${a}`));
  for (const s of [...steps, { step: "sweep (the funder's rest back)", ixs: [transferIx(probe.id, probe.id, 1n)] }]) {
    const size = Buffer.from(signTx(compileMessage(probe.id, s.ixs, bh), [probe]).base64, "base64").length;
    log(`built: ${s.step}: ${size} bytes`);
  }
  log(`cost: ${need.total} lamports = ${solOf(need.total)} SOL (the table's rent ${need.lookup_table} = ${solOf(need.lookup_table)} SOL, locked for good in the frozen table; fees ${need.fees}; priority ${need.priority}); the rest comes back`);
  log(`the run: ${runLine(p.cluster, p.venue)}`);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
  try {
    const keyDir = opt("--resume");
    const j = keyDir ? JSON.parse(readFileSync(path.join(keyDir, "journal.json"), "utf8")) : null;
    const cluster = j?.cluster ?? opt("--cluster");
    const venue = j?.venue ?? opt("--venue");
    const p = await plan(cluster, venue);
    if (args.includes("--dry-run")) await dryRun(p);
    else {
      const returnTo = opt("--return") ?? j?.return_to;
      if (!returnTo) throw new Error(`--return <address> is needed: ${runLine(cluster, venue)}`);
      address(returnTo);
      await run(p, { returnTo, keyDir: keyDir ?? null });
      log(`then: node scripts/live-checks/sol-pool-venue-tables.mjs, and pin it in SOL_POOL_TABLES (packages/wallet/src/pool/solana.ts)`);
    }
  } catch (e) {
    console.error(`venue-table: ERROR: ${String(e?.message ?? e).split("\n")[0]}`);
    process.exit(1);
  }
}
