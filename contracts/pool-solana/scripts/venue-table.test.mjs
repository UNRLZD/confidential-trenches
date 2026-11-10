// SPDX-License-Identifier: Apache-2.0
// node --test contracts/pool-solana/scripts/venue-table.test.mjs (card sol-pool-venue-tables): the venue table script's
// list is the kit's own for the record's program and pool and the next generation's page range, and it is exactly what
// the pool buy builder loads from the table; every transaction it builds fits 1,232 bytes and together they extend
// exactly the list; a cluster RPC on another genesis, an unknown venue, a record whose pool is not its program's and a
// generation with nothing to add are refused. Then run() on a fake cluster (an in-memory chain behind a fake fetch that
// checks each signature, charges fees, priority and rent, and lands, drops or refuses each send): the next generation is
// made, read back and recorded; a resume never makes a second table while the first may have landed; the key folder
// stays while a table may still need it or the funder holds anything. Offline: the venue and rent answers are the
// LiteSVM run's recorded mainnet reads (packages/kit/test/fixtures/solana-pool-buy.json); records are written in temp
// folders only.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compileMessage, newKey, priceIx, PRIORITY_MICRO_LAMPORTS, TX_MAX } from "./deploy.mjs";
import { CLUSTERS, needOf, plan, runLine, tableSteps } from "./venue-table.mjs";
import * as vt from "./venue-table.mjs";
import { b58decode, b58encode, le, pda } from "../../../scripts/live-checks/pool-sol-deploy.mjs";
import * as sourceGate from "../../vault/scripts/source-gate.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "../../..");
const fx = JSON.parse(readFileSync(path.join(REPO, "packages/kit/test/fixtures/solana-pool-buy.json"), "utf8"));
const kit = await import(path.join(REPO, "packages/kit/src/index.ts"));
const MAINNET_FILE = path.join(REPO, "contracts/pool-solana/deployments/mainnet.json");
const MAINNET = JSON.parse(readFileSync(MAINNET_FILE, "utf8"));
const FX = { "pump-curve": "pump", pumpswap: "pumpswap" };
const { release: fxRelease, FEE_PAYER, W, rent } = await import(path.join(REPO, "packages/kit/test/solana-pool-buy-fx.ts"));
const req = (kind) => ({ wallet: W, feePayer: FEE_PAYER, token: fx[FX[kind]].mint, spend: 5_000_000n, minOut: 1n, tip: 0n, cuPrice: 1n, cluster: "devnet" });
const { ed25519 } = await import(pathToFileURL(createRequire(path.join(REPO, "packages/kit/package.json")).resolve("@noble/curves/ed25519.js")).href);

const ALT = "AddressLookupTab1e1111111111111111111111111";
const SYSTEM = "11111111111111111111111111111111";
const CB = "ComputeBudget111111111111111111111111111111";
const RENT = kit.solanaRentOf({ owner: fx.rent.answers[0].owner, data: Buffer.from(fx.rent.answers[0].data, "base64") });
const rentMin = (n) => kit.solanaRentMin(RENT, n);
const RETURN = b58encode(new Uint8Array(32).fill(9));
const CFG = { program: MAINNET.program_id, pool: MAINNET.pool };

/** Each venue's global account as the recorded run read it: the third account of the buy's [mint, curve or pool, global]. */
function globalOf(kind, p) {
  const rec = fx[FX[kind]];
  const k = Object.keys(rec.reads[p]).find((x) => JSON.parse(x).length === 3);
  const ans = rec.reads[p][k];
  return { at: JSON.parse(k)[2], value: ans.value[2], context: ans.context };
}
const tvOf = (kind, edit = (d) => d) => {
  const g = globalOf(kind, 0);
  return kit.solanaPoolTableVenueOf(kind, { owner: g.value.owner, data: edit(Buffer.from(g.value.data[0], "base64")) });
};
/** pump Global with another fee recipient (at 41): the venue's accounts changed. */
const newFeeRecipient = (d) => (Buffer.from(d).fill(5, 41, 73));
/** PumpSwap GlobalConfig with another protocol fee recipient (its first, at 57). */
const newProtocolFeeRecipient = (d) => (Buffer.from(d).fill(5, 57, 89));
/** The pool account (2,179 bytes, "bfpool01", the two tree sizes at 49 and 1,114) owned by `owner`. */
function poolData({ state, label }) {
  const d = Buffer.alloc(2179);
  d.write("bfpool01", 0, "latin1");
  d.writeBigUInt64LE(BigInt(state), 49);
  d.writeBigUInt64LE(BigInt(label), 49 + 8 + 1 + 33 * 32);
  return d;
}
const tableData = (authority, list) => {
  const meta = Buffer.alloc(56);
  meta.writeUInt32LE(1, 0);
  meta.writeBigUInt64LE(0xffff_ffff_ffff_ffffn, 4);
  if (authority) (meta[21] = 1), Buffer.from(b58decode(authority)).copy(meta, 22);
  return Buffer.concat([meta, ...list.map((a) => Buffer.from(b58decode(a)))]);
};
const answer = (result) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200, headers: { "content-type": "application/json" } });
const refusal = (message, code = -32002) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code, message } }), { status: 200, headers: { "content-type": "application/json" } });
const cu16 = (b, o) => {
  let v = 0;
  for (let s = 0; ; s += 7) {
    const x = b[o++];
    v |= (x & 0x7f) << s;
    if (!(x & 0x80)) return [v, o];
  }
};
/** A legacy transaction's signatures, signers, keys and instructions. */
function decodeTx(buf) {
  let [n, o] = cu16(buf, 0);
  const sigs = Array.from({ length: n }, (_, i) => buf.subarray(o + 64 * i, o + 64 * i + 64));
  o += 64 * n;
  const msg = buf.subarray(o);
  const signersN = buf[o];
  o += 3;
  let nk;
  [nk, o] = cu16(buf, o);
  const keys = Array.from({ length: nk }, (_, i) => b58encode(buf.subarray(o + 32 * i, o + 32 * i + 32)));
  o += 32 * nk + 32;
  let ni;
  [ni, o] = cu16(buf, o);
  const ixs = [];
  for (let i = 0; i < ni; i++) {
    const prog = keys[buf[o++]];
    let na, dl;
    [na, o] = cu16(buf, o);
    const acc = [...buf.subarray(o, o + na)].map((k) => keys[k]);
    o += na;
    [dl, o] = cu16(buf, o);
    ixs.push({ prog, acc, data: Buffer.from(buf.subarray(o, o + dl)) });
    o += dl;
  }
  return { sig: b58encode(sigs[0]), sigs, msg, signers: keys.slice(0, signersN), keys, ixs };
}
const kindOf = (x) => (x.prog === SYSTEM ? "transfer" : x.prog === ALT ? ["create", "freeze", "extend"][x.data.readUInt32LE(0)] : null);

/**
 * A cluster in memory behind a fake fetch, on both of the cluster's RPCs. Every account keeps its history; a read at
 * finalized sees it as it was `fin` ms ago. A send is checked like the runtime (each signature, the fee and priority,
 * rent, the lookup table program's rules) and then lands, is dropped or is refused as `onSend` says. `view(i, addr,
 * commitment, value)` changes what RPC i answers. The clock is virtual: `wait` moves it.
 */
function fakeCluster({ cluster = "mainnet", sizes = [{ state: 0, label: 0 }, { state: 0, label: 0 }], fin = 3_000, view = (i, a, c, v) => v, onSend = () => "land", poolOwner = () => CFG.program, global = (kind) => kind, kinds = {} } = {}) {
  let t = 1_000_000;
  const now = () => t;
  const wait = async (ms) => void (t += ms);
  const slotAt = (x) => 10_000n + BigInt(Math.floor(x / 400));
  const heightAt = (x) => 5_000 + Math.floor(x / 400);
  const hist = new Map();
  const set = (a, v, at = t) => (hist.get(a) ?? hist.set(a, []).get(a)).push({ at, v });
  const get = (a, commitment = "confirmed") => {
    let v = null;
    for (const e of hist.get(a) ?? []) if (e.at <= (commitment === "finalized" ? t - fin : t)) v = e.v;
    return v;
  };
  const statuses = new Map();
  const sends = [];
  const late = [];
  const logs = [];
  const paid = new Set();
  let hashes = 0;
  const hooks = { balance: () => {} };
  set(RETURN, { owner: SYSTEM, data: Buffer.alloc(0), lamports: 1_000_000_000n }, 0);
  const c = CLUSTERS[cluster];
  function simulate(tx) {
    const st = new Map();
    const cur = (a) => (st.has(a) ? st.get(a) : get(a));
    const lam = (a) => BigInt(cur(a)?.lamports ?? 0n);
    const add = (a, d) => {
      const v = cur(a) ?? { owner: SYSTEM, data: Buffer.alloc(0), lamports: 0n };
      st.set(a, { ...v, lamports: BigInt(v.lamports) + d });
    };
    let price = 0n;
    for (const x of tx.ixs) if (x.prog === CB && x.data[0] === 3) price = x.data.readBigUInt64LE(1);
    const fee = 5_000n * BigInt(tx.sigs.length) + (BigInt(tx.ixs.filter((x) => x.prog !== CB).length) * 200_000n * price + 999_999n) / 1_000_000n;
    if (lam(tx.keys[0]) < fee) return { err: "Attempt to debit an account but found no record of a prior credit." };
    add(tx.keys[0], -fee);
    for (const [k, x] of tx.ixs.entries()) {
      const fail = (m) => ({ err: `Error processing Instruction ${k}: ${m}` });
      if (x.prog === CB) continue;
      if (x.prog === SYSTEM) {
        const amount = x.data.readBigUInt64LE(4);
        if (x.data.readUInt32LE(0) !== 2 || !tx.signers.includes(x.acc[0])) return fail("not a signed transfer");
        if (lam(x.acc[0]) < amount) return fail("custom program error: 0x1");
        add(x.acc[0], -amount), add(x.acc[1], amount);
        continue;
      }
      if (x.prog !== ALT) return fail("unknown program");
      const [table, auth, payer] = x.acc;
      if (!tx.signers.includes(auth)) return fail("missing required signature for instruction");
      const tv = cur(table);
      const tag = x.data.readUInt32LE(0);
      if (tag === 0) {
        const slot = x.data.readBigUInt64LE(4);
        if (slot > slotAt(t) || slotAt(t) - slot >= 512n) return fail(`invalid instruction data (${slot} is not a recent slot)`);
        const d = pda([b58decode(auth), le(slot, 8)], ALT);
        if (d.address !== table || d.bump !== x.data[12]) return fail("invalid instruction data (not the derived address)");
        if (tv && tv.owner === ALT) return fail("account already initialized");
        const r = rentMin(56);
        if (lam(payer) < r) return fail("insufficient lamports");
        add(payer, -r);
        st.set(table, { owner: ALT, data: tableData(auth, []), lamports: r });
        continue;
      }
      if (!tv || tv.owner !== ALT) return fail("invalid account owner");
      if (tv.data[21] !== 1) return fail("Lookup table is frozen");
      if (b58encode(tv.data.subarray(22, 54)) !== auth) return fail("Incorrect lookup table authority");
      if (tag === 2) {
        const n = Number(x.data.readBigUInt64LE(4));
        const data = Buffer.concat([tv.data, x.data.subarray(12, 12 + 32 * n)]);
        if (n === 0 || (data.length - 56) / 32 > 256) return fail("invalid instruction data");
        const r = rentMin(data.length) - BigInt(tv.lamports);
        if (lam(payer) < r) return fail("insufficient lamports");
        add(payer, -r);
        st.set(table, { ...tv, data, lamports: BigInt(tv.lamports) + r });
      } else if (tag === 1) {
        if (tv.data.length === 56) return fail("Empty lookup tables cannot be frozen");
        const data = Buffer.from(tv.data);
        data[21] = 0;
        st.set(table, { ...tv, data });
      } else return fail("invalid instruction data");
    }
    for (const [a, v] of st) {
      if (v.lamports < 0n) return { err: `${a} would go below 0` };
      if (v.owner === SYSTEM && v.data.length === 0 && v.lamports > 0n && v.lamports < rentMin(0)) return { err: `Transaction results in an account (${a}) with insufficient funds for rent` };
    }
    return { changes: st };
  }
  const acct = (v) => (v ? { owner: v.owner, data: [Buffer.from(v.data).toString("base64"), "base64"], lamports: Number(v.lamports), executable: false, rentEpoch: 0 } : null);
  const fetchFn = async (url, init) => {
    const { method, params } = JSON.parse(init.body);
    for (const x of late.filter((x) => x.at <= t)) {
      late.splice(late.indexOf(x), 1);
      const sim = simulate(x.tx);
      if (!sim.err) for (const [a, v] of sim.changes) set(a, v);
      statuses.set(x.tx.sig, { at: t, slot: slotAt(t) });
    }
    const i = c.rpcs.indexOf(url);
    assert.ok(i >= 0, `a read of ${url}, not one of the cluster's RPCs`);
    const ctx = { slot: Number(slotAt(t)) };
    if (method === "getGenesisHash") return answer(c.genesis);
    if (method === "getMultipleAccounts") {
      const kind = ["pump-curve", "pumpswap"].find((k) => globalOf(k, 0).at === params[0][0]);
      assert.ok(kind && params[0].length === 1 && params[1].commitment === "finalized", `unexpected read ${JSON.stringify(params)}`);
      const g = globalOf(kind, i);
      const edit = kinds[kind] ?? ((d) => d);
      return answer({ context: g.context, value: [{ ...g.value, data: [edit(Buffer.from(g.value.data[0], "base64")).toString("base64"), "base64"] }] });
    }
    if (method === "getAccountInfo") {
      const [a, o] = params;
      if (a === fx.rent.account) return answer({ context: ctx, value: { owner: fx.rent.answers[i].owner, data: [fx.rent.answers[i].data, "base64"], lamports: 1, executable: false } });
      if (a === "SysvarS1otHashes111111111111111111111111111") {
        const d = Buffer.alloc(8 + 40 * 512);
        d.writeBigUInt64LE(512n, 0);
        for (let k = 0; k < 512; k++) d.writeBigUInt64LE(slotAt(t) - BigInt(k), 8 + 40 * k);
        const s = o.dataSlice ? d.subarray(o.dataSlice.offset, o.dataSlice.offset + o.dataSlice.length) : d;
        return answer({ context: ctx, value: { owner: "Sysvar1111111111111111111111111111111111111", data: [s.toString("base64"), "base64"], lamports: 1, executable: false } });
      }
      if (a === CFG.pool) {
        assert.equal(o.commitment, "finalized", "the pool account is read at finalized");
        const owner = poolOwner(i);
        return answer({ context: ctx, value: owner ? { owner, data: [poolData(sizes[i]).toString("base64"), "base64"], lamports: 1, executable: false } : null });
      }
      return answer({ context: ctx, value: acct(view(i, a, o.commitment, get(a, o.commitment))) });
    }
    if (method === "getBalance") {
      hooks.balance(params[0], i);
      const owed = logs.map((l) => /send (\d+) lamports .*to the funder (\w+)/.exec(l)).filter((m, k) => m && m[2] === params[0] && !paid.has(k));
      if (owed.length) {
        const k = logs.findIndex((l, j) => !paid.has(j) && /send (\d+) lamports .*to the funder/.test(l) && l.includes(params[0]));
        paid.add(k);
        const v = get(params[0]) ?? { owner: SYSTEM, data: Buffer.alloc(0), lamports: 0n };
        set(params[0], { ...v, lamports: BigInt(v.lamports) + BigInt(owed[0][1]) });
      }
      const v = view(i, params[0], params[1]?.commitment, get(params[0], params[1]?.commitment));
      return answer({ context: ctx, value: Number(v?.lamports ?? 0n) });
    }
    if (method === "getSlot") return answer(Number(slotAt(t)));
    if (method === "getBlockHeight") return answer(heightAt(params[0]?.commitment === "finalized" ? t - fin : t));
    // a new blockhash at every read, as the chain gives one: a transaction built again from the same instructions is a
    // new transaction with its own signature, never hidden as a duplicate of one that was refused or dropped
    if (method === "getLatestBlockhash") return answer({ context: ctx, value: { blockhash: b58encode(Uint8Array.from({ length: 32 }, (_, j) => (j < 4 ? (++hashes >> (8 * j)) & 0xff : 7))), lastValidBlockHeight: heightAt(t) + 150 } });
    if (method === "getSignatureStatuses") {
      return answer({ context: ctx, value: params[0].map((s) => {
        const x = statuses.get(s);
        return x ? { slot: Number(x.slot), confirmations: null, err: null, confirmationStatus: t - x.at >= fin ? "finalized" : "confirmed" } : null;
      }) });
    }
    if (method === "sendTransaction") {
      assert.equal(i, 0, "sends go to the first RPC");
      const tx = decodeTx(Buffer.from(params[0], "base64"));
      tx.signers.forEach((s, k) => assert.ok(ed25519.verify(tx.sigs[k], tx.msg, b58decode(s)), `the signature of ${s}`));
      if (statuses.has(tx.sig)) return refusal("Transaction simulation failed: This transaction has already been processed");
      const kindsOf = tx.ixs.map(kindOf).filter(Boolean);
      const sim = simulate(tx);
      if (sim.err) return refusal(`Transaction simulation failed: ${sim.err}`);
      if (!sends.some((s) => s.sig === tx.sig)) sends.push({ sig: tx.sig, kinds: kindsOf, tx, at: t });
      const how = onSend({ kinds: kindsOf, tx, n: sends.length, t });
      // "land", "drop" (taken, never lands), { refuse } (the node's refusal, nothing lands), or { refuse, late: ms }
      // (this node refuses it while another took it: it lands that much later all the same)
      if (how === "land") {
        for (const [a, v] of sim.changes) set(a, v);
        statuses.set(tx.sig, { at: t, slot: slotAt(t) });
      }
      if (how?.late) late.push({ tx, at: t + how.late });
      if (how?.refuse) return refusal(how.refuse);
      return answer(tx.sig);
    }
    throw new Error(`unexpected ${method}`);
  };
  const say = (s) => logs.push(s);
  return { fetchFn, wait, now, say, logs, sends, get, set, statuses, hooks, heightAt: () => heightAt(t), slotAt: () => slotAt(t), advance: (ms) => void (t += ms), setFin: (ms) => void (fin = ms) };
}
const sent = (k, kind) => k.sends.filter((s) => s.kinds.includes(kind));
/** A temp folder holding a copy of the mainnet record, with `tables` replaced when given. */
function recordDir(tables) {
  const dir = mkdtempSync(path.join(tmpdir(), "venue-table-rec-"));
  writeFileSync(path.join(dir, "mainnet.json"), JSON.stringify(tables === undefined ? MAINNET : { ...MAINNET, tables }, null, 2) + "\n");
  return dir;
}
/** PumpSwap's narrow first generation (pages 0 and 1, as devnet's 4kG4g4fb… holds), so a run makes its generation 2. */
const SWAP_G1 = { table: b58encode(new Uint8Array(32).fill(8)), pages: { state: [0, 1], label: [0, 1] }, made_at: { state: 0, label: 0 }, txs: [] };
const withSwapG1 = () => recordDir({ ...MAINNET.tables, pumpswap: [{ ...SWAP_G1, addresses: kit.solanaPoolVenueTableList(CFG, tvOf("pumpswap"), SWAP_G1.pages) }] });
const keyBase = () => mkdtempSync(path.join(tmpdir(), "venue-table-keys-"));
const recOf = (dir) => JSON.parse(readFileSync(path.join(dir, "mainnet.json"), "utf8"));
const planOn = (k, venue, dir, extra = {}) => plan("mainnet", venue, { fetchFn: k.fetchFn, dir, wait: k.wait, ...extra });
const runOn = (k, p, base, extra = {}) => vt.run(p, { returnTo: RETURN, base, say: k.say, wait: k.wait, now: k.now, ...extra });
/** A stopped run's key folder: the funder's key file and its journal, naming `table` with `txs`. */
function keptFolder(base, p, { funder = newKey(), table = null, slot = "123", txs = [], list = p.list, cluster = "mainnet", name = `venue-table-${cluster}-${p.venue}-2026-11-10T00-00-00-000Z` } = {}) {
  const dir = path.join(base, name);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(dir, "funder.json"), JSON.stringify([...funder.secret, ...funder.pub]), { mode: 0o600 });
  writeFileSync(path.join(dir, "journal.json"), JSON.stringify({ cluster, venue: p.venue, funder: funder.id, return_to: RETURN, table, slot, bump: 255, pages: p.range, made_at: p.sizes, list, txs }));
  return { dir, funder };
}
const sigOf = (n) => b58encode(new Uint8Array(64).fill(n));
const fund = (k, id, lamports) => k.set(id, { owner: SYSTEM, data: Buffer.alloc(0), lamports }, 0);

// ------------------------------------------------------------------------------------------------ the list and the plan

test("the list is the kit's own for the record's program and pool and the next range, and exactly what the builder loads", async () => {
  for (const kind of ["pump-curve", "pumpswap"]) {
    const k = fakeCluster();
    const p = await planOn(k, kind, recordDir({})); // no generation yet: a first one
    const tv = tvOf(kind);
    const range = kit.solanaPoolNextTableRange(CFG, tv, { state: 0, label: 0 });
    assert.deepEqual(p.range, range, kind);
    assert.deepEqual(p.list, kit.solanaPoolVenueTableList(CFG, tv, range), kind);
    assert.ok(p.list.length <= 256);
    // the venue's accounts as the frozen mainnet curve table holds them for its own range
    if (kind === "pump-curve") assert.deepEqual(kit.solanaPoolVenueTableList(CFG, tv, MAINNET.tables["pump-curve"][0].pages), MAINNET.tables["pump-curve"][0].addresses);
    // the builder: a buy on the recorded venue with this table loads every one of its program-wide accounts from it
    const venue = await kit.readSolanaPoolBuyVenue([0, 1].map((i) => async (_m, params) => fx[FX[kind]].reads[i][JSON.stringify(params[0])]), kind, fx[FX[kind]].mint, () => 0);
    const meta = new Uint8Array(56);
    new DataView(meta.buffer).setUint32(0, 1, true);
    new DataView(meta.buffer).setBigUint64(4, (1n << 64n) - 1n, true);
    const table = kit.solanaDecodeLookupTable(Uint8Array.from([...meta, ...p.list.flatMap((a) => [...b58decode(a)])]));
    const instructions = kit.solanaPoolBuyInstructions(CFG, fxRelease, venue, req(kind), 6, rent, null, true);
    const used = new Set(instructions.flatMap((x) => [x.program, ...x.accounts.map((a) => a.key)]));
    const built = kit.solanaCompileV0(FEE_PAYER, instructions, "11111111111111111111111111111111", [{ address: b58encode(new Uint8Array(32).fill(9)), table }], [FEE_PAYER, W]);
    const m = kit.solanaDecodeMessage(built.message);
    const loaded = m.lookups.flatMap((l) => [...l.writable, ...l.readonly].map((i) => table.addresses[i]));
    for (const a of p.list) if (used.has(a)) assert.ok(loaded.includes(a), `${kind}: ${a} is used and in the table, so it loads from it`);
    for (const a of loaded) assert.ok(p.list.includes(a));
  }
});

test("generations: the trees' sizes are the smaller of the two finalized pool reads; the generation counts the record's", async () => {
  const k = fakeCluster({ sizes: [{ state: 5_000, label: 2_900 }, { state: 5_100, label: 2_800 }] });
  const g1 = { table: b58encode(new Uint8Array(32).fill(8)), pages: { state: [0, 1], label: [0, 1] }, made_at: { state: 0, label: 0 }, addresses: kit.solanaPoolVenueTableList(CFG, tvOf("pumpswap"), { state: [0, 1], label: [0, 1] }), txs: [] };
  const p = await planOn(k, "pumpswap", recordDir({ ...MAINNET.tables, pumpswap: [g1] }));
  assert.deepEqual(p.sizes, { state: 5_000, label: 2_800 });
  assert.deepEqual(p.range, kit.solanaPoolNextTableRange(CFG, tvOf("pumpswap"), { state: 5_000, label: 2_800 }));
  assert.equal(p.range.state[0], 3, "from the page before the state tree's end");
  assert.equal(p.range.label[0], 1);
  assert.equal(p.generation, 2, "the record holds PumpSwap's first generation");
  const q = await planOn(fakeCluster(), "pumpswap", recordDir());
  assert.equal(q.generation, 1, "no pumpswap table yet");
});

test("refused by name: a venue whose buy fits at any tree size (the pump curve) never gets a generation for its trees; only changed venue accounts make one, on its first range", async () => {
  assert.deepEqual(kit.SOLANA_POOL_TABLE_GROWS, ["pumpswap"]);
  // the mainnet curve table (generation 1, pages 0 and 1) at small and at huge trees: refused, nothing read about a key
  for (const sizes of [{ state: 0, label: 0 }, { state: 5_000, label: 2_800 }, { state: 0xffff_fff0, label: 0xffff_fff0 }])
    await assert.rejects(planOn(fakeCluster({ sizes: [sizes, sizes] }), "pump-curve", recordDir()), /^Error: nothing to add: pump-curve's buy fits 1,232 bytes at any tree size on its generation 1 \(BShWZ8Fb\S+\): a new generation is made for it only when the venue's accounts change$/);
  // a changed fee recipient: generation 2, on the first range again (25 addresses), never a 256-address table
  const changed = await planOn(fakeCluster({ sizes: [{ state: 9_000, label: 3_000 }, { state: 9_000, label: 3_000 }], kinds: { "pump-curve": newFeeRecipient } }), "pump-curve", recordDir());
  assert.equal(changed.generation, 2);
  assert.deepEqual(changed.range, kit.SOLANA_POOL_CURVE_FIRST_RANGE);
  assert.equal(changed.list.length, 25);
  // no curve table at all (a new cluster): its first, on the first range
  const first = await planOn(fakeCluster({ sizes: [{ state: 9_000, label: 3_000 }, { state: 9_000, label: 3_000 }] }), "pump-curve", recordDir({}));
  assert.deepEqual([first.generation, first.range, first.list.length], [1, kit.SOLANA_POOL_CURVE_FIRST_RANGE, 25]);
});

test("refused: nothing to add when the newest generation holds every page of the next range and the venue's accounts", async () => {
  const sizes = { state: 5_000, label: 3_000 };
  const tv = tvOf("pumpswap");
  const range = kit.solanaPoolNextTableRange(CFG, tv, sizes);
  const gen = (r, t = tv) => ({ table: b58encode(new Uint8Array(32).fill(8)), pages: r, made_at: sizes, addresses: kit.solanaPoolVenueTableList(CFG, t, r), txs: [] });
  const g1 = gen({ state: [0, 1], label: [0, 1] });
  const tables = { ...MAINNET.tables, pumpswap: [g1, gen(range)] };
  const k = () => fakeCluster({ sizes: [sizes, sizes] });
  await assert.rejects(planOn(k(), "pumpswap", recordDir(tables)), /^Error: nothing to add: pumpswap's generation 2/);
  // a newest generation whose recorded addresses are not the kit's for its pages: a new generation
  const off = await planOn(k(), "pumpswap", recordDir({ ...MAINNET.tables, pumpswap: [{ ...gen(range), addresses: gen(range).addresses.slice(1) }] }));
  assert.equal(off.generation, 2);
  // the trees grew past the newest's start: a new generation
  const grown = await planOn(fakeCluster({ sizes: [{ state: 9_000, label: 3_000 }, { state: 9_000, label: 3_000 }] }), "pumpswap", recordDir(tables));
  assert.equal(grown.generation, 3);
  // a changed fee recipient: the newest generation's accounts are not the venue's now, so a new generation
  const changed = await planOn(fakeCluster({ sizes: [sizes, sizes], kinds: { pumpswap: newProtocolFeeRecipient } }), "pumpswap", recordDir(tables));
  assert.equal(changed.generation, 3);
  assert.deepEqual(changed.list, kit.solanaPoolVenueTableList(CFG, tvOf("pumpswap", newProtocolFeeRecipient), range));
  // the other venue is its own list: the curve's generation 1 is the record's, unchanged, so nothing to add there
  await assert.rejects(planOn(k(), "pump-curve", recordDir(tables)), /nothing to add: pump-curve's buy fits/);
});

test("each built transaction fits 1,232 B; the create comes first, the freeze last; the extends hold exactly the list", () => {
  const funder = b58encode(new Uint8Array(32).fill(3));
  const table = b58encode(new Uint8Array(32).fill(4));
  for (const n of [1, 25, 34, 60, 256])
    for (const price of [0n, PRIORITY_MICRO_LAMPORTS]) {
      const list = Array.from({ length: n }, (_, i) => b58encode(Uint8Array.from({ length: 32 }, (_, j) => (i * 7 + j + 1) & 0xff)));
      const steps = tableSteps(funder, table, 123n, 254, list, price);
      const got = [];
      steps.forEach((s, i) => {
        const m = compileMessage(funder, s.ixs, "11111111111111111111111111111111");
        assert.ok(1 + 64 * m.signers.length + m.bytes.length <= TX_MAX, `${n} ${price} step ${i}`);
        assert.equal(s.ixs[0].program === priceIx(1n).program, price > 0n, "a priced cluster's sends carry the price");
        for (const x of s.ixs.filter((x) => x.program === "AddressLookupTab1e1111111111111111111111111")) {
          const tag = x.data[0];
          if (tag === 0) assert.equal(i, 0, "create first");
          if (tag === 1) assert.equal(i, steps.length - 1, "freeze last");
          if (tag === 2) for (let o = 12; o < x.data.length; o += 32) got.push(b58encode(x.data.subarray(o, o + 32)));
        }
      });
      assert.deepEqual(got, list, `${n} ${price}`);
    }
});

test("the need: the table's rent, a fee per transaction and the sweep, and mainnet's priority bound", () => {
  const funder = b58encode(new Uint8Array(32).fill(3));
  const steps = tableSteps(funder, funder, 1n, 255, Array.from({ length: 34 }, (_, i) => b58encode(new Uint8Array(32).fill(i + 10))), PRIORITY_MICRO_LAMPORTS);
  assert.equal(steps.length, 3, "create and extend 28, extend 6, freeze");
  assert.deepEqual(needOf(6_461_760n, steps, PRIORITY_MICRO_LAMPORTS, 650_240n), { lookup_table: 6_461_760n, fees: 20_000n, priority: 80_000n, funder_floor: 650_240n, total: 7_212_000n });
  assert.equal(needOf(1n, steps, 0n, 0n).priority, 0n);
  // a resume: the rest of the list in extends only, then the freeze; nothing left to add: the freeze alone
  const rest = tableSteps(funder, funder, 1n, 255, Array.from({ length: 4 }, (_, i) => b58encode(new Uint8Array(32).fill(i + 10))), 0n, { create: false });
  assert.deepEqual(rest.map((s) => s.step), ["lookup table: extend with 4 addresses", "lookup table: freeze (authority none)"]);
  assert.ok(rest[0].ixs.every((x) => x.data[0] === 2));
  assert.deepEqual(tableSteps(funder, funder, 1n, 255, [], 0n, { create: false }).map((s) => s.step), ["lookup table: freeze (authority none)"]);
  assert.match(runLine("mainnet", "pumpswap"), /^node contracts\/pool-solana\/scripts\/venue-table\.mjs --cluster mainnet --venue pumpswap --return </);
});

test("refused: an RPC on another genesis, an unknown venue or cluster, a record of another cluster, a pool that is not the program's", async () => {
  const k = fakeCluster();
  const mk = (over) => plan("mainnet", "pumpswap", { fetchFn: k.fetchFn, wait: k.wait, dir: recordDir(), ...over });
  const devnetK = fakeCluster({ cluster: "devnet" });
  await assert.rejects(plan("mainnet", "pumpswap", { fetchFn: async (u, i) => devnetK.fetchFn(CLUSTERS.devnet.rpcs[CLUSTERS.mainnet.rpcs.indexOf(u)], i), wait: k.wait, dir: recordDir() }), /not mainnet's/);
  await assert.rejects(plan("mainnet", "raydium", { fetchFn: k.fetchFn }), /--venue must be/);
  await assert.rejects(plan("testnet", "pumpswap", { fetchFn: k.fetchFn }), /--cluster must be/);
  const dir = mkdtempSync(path.join(tmpdir(), "venue-table-"));
  writeFileSync(path.join(dir, "mainnet.json"), JSON.stringify({ ...MAINNET, cluster: "devnet" }));
  await assert.rejects(mk({ dir }), /devnet's record/);
  // the record's pool is not its program's pool account
  const bad = mkdtempSync(path.join(tmpdir(), "venue-table-"));
  writeFileSync(path.join(bad, "mainnet.json"), JSON.stringify({ ...MAINNET, pool: MAINNET.program_id }));
  await assert.rejects(mk({ dir: bad }), /not the program's pool account/);
  // the pool account missing on one RPC, or owned by another program on one
  await assert.rejects(plan("mainnet", "pumpswap", { fetchFn: fakeCluster({ poolOwner: (i) => (i === 1 ? null : CFG.program) }).fetchFn, wait: k.wait, dir: recordDir() }), /pool account .* missing/);
  await assert.rejects(plan("mainnet", "pumpswap", { fetchFn: fakeCluster({ poolOwner: (i) => (i === 1 ? SYSTEM : CFG.program) }).fetchFn, wait: k.wait, dir: recordDir() }), /not the program's/);
  // the two providers disagree on the venue's global account
  const flip = (d) => Buffer.from(d.map((b, i) => (i === 900 ? b ^ 1 : b)));
  const k2 = fakeCluster({ kinds: { pumpswap: flip } });
  const mixed = async (u, init) => (u === CLUSTERS.mainnet.rpcs[1] ? k2 : k).fetchFn(u, init);
  await assert.rejects(plan("mainnet", "pumpswap", { fetchFn: mixed, wait: k.wait, dir: recordDir() }), /disagree/);
});

test("regression (devnet 9 Nov 23:12Z): the need keeps the funder's rent floor; the create's slot is SLOT_BACK back in the sending node's SlotHashes", async () => {
  const funder = b58encode(new Uint8Array(32).fill(3));
  const steps = tableSteps(funder, funder, 1n, 255, Array.from({ length: 34 }, (_, i) => b58encode(new Uint8Array(32).fill(i + 10))), 0n);
  // the run's funder must hold the rent, the fees and rent(0) until the sweep: without the floor the second extend was refused
  assert.equal(needOf(6_461_760n, steps, 0n, 650_240n).total, 6_461_760n + 20_000n + 650_240n);
  const { recentSlot, SLOT_BACK, SLOT_HASHES } = await import("./venue-table.mjs");
  const d = Buffer.alloc(8 + 40 * 40);
  d.writeBigUInt64LE(512n, 0);
  for (let i = 0; i < 40; i++) d.writeBigUInt64LE(1000n - BigInt(i), 8 + 40 * i);
  const call = async (m, params) => {
    assert.equal(m, "getAccountInfo");
    assert.equal(params[0], SLOT_HASHES);
    return { value: { owner: "Sysvar1111111111111111111111111111111111111", data: [d.subarray(0, 8 + 40 * (SLOT_BACK + 1)).toString("base64"), "base64"] } };
  };
  assert.equal(await recentSlot(call), 1000n - BigInt(SLOT_BACK));
});

test("--dry-run: the generation, its range, the entries it covers and where it warns, the list, each send's size and the cost", async () => {
  const k = fakeCluster({ sizes: [{ state: 5_000, label: 3_000 }, { state: 5_000, label: 3_000 }] });
  const p = await planOn(k, "pumpswap", withSwapG1());
  const out = [];
  await vt.dryRun(p, { say: (s) => out.push(s) });
  const text = out.join("\n");
  const end = kit.solanaPoolRangeEnd(p.range), warn = kit.solanaPoolRangeWarn(p.range);
  assert.match(text, new RegExp(`generation 2 of the pumpswap table: state pages ${p.range.state[0]} to ${p.range.state[1]}, label pages ${p.range.label[0]} to ${p.range.label[1]}`));
  assert.match(text, new RegExp(`up to entry ${end.state - 1} of the state tree and ${end.label - 1} of the label tree`));
  assert.match(text, new RegExp(`warns once the state tree holds ${warn.state} or the label tree ${warn.label}`));
  assert.match(text, /the trees hold 5000 and 3000 entries/);
  for (const a of p.list) assert.ok(text.includes(a));
  assert.ok(out.filter((l) => /^built: lookup table: (create|extend)/.test(l)).length >= 2);
  assert.match(text, /^built: sweep .*: \d+ bytes$/m);
  assert.match(text, /cost: \d+ lamports .*the funder's own floor \d+/);
  assert.equal(k.sends.length, 0, "a dry run sends nothing");
});

// ------------------------------------------------------------------------------------------------ run() on a fake cluster

test("run: a record with one generation and grown trees makes generation 2 with the right range, read back frozen, recorded, swept", async () => {
  const sizes = [{ state: 5_000, label: 3_000 }, { state: 5_200, label: 3_100 }];
  const k = fakeCluster({ sizes });
  const dir = withSwapG1();
  const base = keyBase();
  const repoBefore = readFileSync(MAINNET_FILE);
  let atFunding = null;
  k.hooks.balance = (addr) => {
    if (atFunding || addr === RETURN) return;
    const folder = readdirSync(base).map((n) => path.join(base, n))[0];
    atFunding = { logs: [...k.logs], folder, dirMode: statSync(folder).mode & 0o777, keyMode: statSync(path.join(folder, "funder.json")).mode & 0o777 };
  };
  const p = await planOn(k, "pumpswap", dir);
  await runOn(k, p, base);
  // the resume line and the key folder were said before the funding wait, the folder 0700 and the key 0600
  assert.ok(atFunding.logs.some((l) => l.includes(atFunding.folder) && l.includes(`--resume ${atFunding.folder} --return ${RETURN}`)), "the resume line before the funding wait");
  assert.equal(atFunding.dirMode, 0o700);
  assert.equal(atFunding.keyMode, 0o600);
  const rec = recOf(dir);
  const gens = rec.tables.pumpswap;
  assert.equal(gens.length, 2);
  assert.deepEqual(gens[0], JSON.parse(readFileSync(path.join(dir, "mainnet.json"), "utf8")).tables.pumpswap[0], "the first generation is kept as it was");
  assert.deepEqual(rec.tables["pump-curve"], MAINNET.tables["pump-curve"], "the other venue's generations are untouched");
  const want = kit.solanaPoolNextTableRange(CFG, tvOf("pumpswap"), { state: 5_000, label: 3_000 });
  assert.deepEqual(gens[1].pages, { state: [...want.state], label: [...want.label] });
  assert.deepEqual(gens[1].made_at, { state: 5_000, label: 3_000 });
  assert.deepEqual(gens[1].addresses, kit.solanaPoolVenueTableList(CFG, tvOf("pumpswap"), want));
  assert.equal(gens[1].addresses.length, 256);
  // the chain holds it frozen with exactly the list; the record's txs are the table's own, landed, create first
  const onChain = k.get(gens[1].table, "finalized");
  assert.equal(onChain.data[21], 0);
  assert.equal(onChain.data.length, 56 + 32 * 256);
  assert.match(gens[1].txs[0].step, /^lookup table: create/);
  assert.match(gens[1].txs.at(-1).step, /^lookup table: freeze/);
  assert.deepEqual(gens[1].txs.map((x) => x.signature), k.sends.filter((s) => !s.kinds.includes("transfer")).map((s) => s.sig));
  assert.deepEqual(Object.keys(gens[1]), ["table", "pages", "made_at", "addresses", "txs"]);
  // funded exactly its need, it swept the rest back to 0 and the key folder is gone
  const funder = k.sends[0].tx.keys[0];
  assert.equal(k.get(funder, "finalized")?.lamports ?? 0n, 0n);
  assert.equal(sent(k, "transfer").length, 1);
  assert.deepEqual(readdirSync(base), [], "the key folder is removed");
  assert.ok(readFileSync(MAINNET_FILE).equals(repoBefore), "the repo's record is untouched");
});

test("run: an RPC that reads the table otherwise before the freeze: nothing is frozen, nothing recorded, the key kept", async () => {
  let table = null;
  const k = fakeCluster({ view: (i, a, c, v) => (i === 1 && a === table && v ? { ...v, data: v.data.subarray(0, v.data.length - 32) } : v), onSend: ({ kinds, tx }) => ((table ??= kinds.includes("create") ? tx.ixs.find((x) => x.prog === ALT).acc[0] : null), "land") });
  const dir = recordDir();
  const base = keyBase();
  const p = await planOn(k, "pumpswap", dir);
  await assert.rejects(runOn(k, p, base), /lookup table .*different bytes|not the same/);
  assert.equal(sent(k, "freeze").length, 0, "no freeze without both RPCs reading the list under the funder");
  assert.equal(recOf(dir).tables.pumpswap, undefined);
  assert.equal(readdirSync(base).length, 1, "the key folder is kept");
  assert.ok(k.logs.some((l) => /the key stays/.test(l)));
});

test("run: a freeze that lands but an RPC still reads the funder as authority: nothing recorded, the key kept", async () => {
  let table = null;
  const k = fakeCluster({
    view: (i, a, c, v) => (i === 1 && a === table && v && v.data[21] === 0 ? { ...v, data: Buffer.concat([v.data.subarray(0, 21), Buffer.from([1]), v.data.subarray(22)]) } : v),
    onSend: ({ kinds, tx }) => ((table ??= kinds.includes("create") ? tx.ixs.find((x) => x.prog === ALT).acc[0] : null), "land"),
  });
  const dir = recordDir();
  const base = keyBase();
  const p = await planOn(k, "pumpswap", dir);
  await assert.rejects(runOn(k, p, base), /authority/);
  assert.equal(sent(k, "freeze").length, 1);
  assert.equal(recOf(dir).tables.pumpswap, undefined, "no record before both RPCs read it frozen");
  assert.equal(readdirSync(base).length, 1, "a live authority on one RPC keeps the key");
});

test("run: a freeze refused: the funder's SOL goes back, the key folder is kept while the table has the funder as its authority", async () => {
  const k = fakeCluster({ onSend: ({ kinds }) => (kinds.includes("freeze") ? { refuse: "Transaction simulation failed: Error processing Instruction 1: custom program error" } : "land") });
  const dir = recordDir();
  const base = keyBase();
  const p = await planOn(k, "pumpswap", dir);
  await assert.rejects(runOn(k, p, base), /custom program error/);
  assert.equal(readdirSync(base).length, 1);
  const funder = k.sends[0].tx.keys[0];
  assert.equal(k.get(funder)?.lamports ?? 0n, 0n, "swept back");
  assert.ok(k.logs.some((l) => /still has the funder as its authority/.test(l)));
});

test("run: the folder is removed only when both RPCs read the funder at 0", async () => {
  const k = fakeCluster({ view: (i, a, c, v) => (i === 1 && v && v.owner === SYSTEM && a !== RETURN && c === "finalized" && v.lamports === 0n ? { ...v, lamports: 1n } : v) });
  const base = keyBase();
  const p = await planOn(k, "pumpswap", recordDir());
  await runOn(k, p, base);
  assert.equal(readdirSync(base).length, 1, "one RPC reads 1 lamport: kept");
  assert.ok(k.logs.some((l) => /does not read 0/.test(l)));
});

test("P2-2: a resume whose journal names a table stops, key kept, no new create, unless both RPCs read that same table", async () => {
  for (const [name, setup, why] of [
    ["one RPC reads null", (k, T, f, list) => (k.set(T, { owner: ALT, data: tableData(f, list.slice(0, 28)), lamports: 1n }, 0), (i, a, c, v) => (i === 1 && a === T ? null : v)), /do not read lookup table .* the same/],
    ["the RPCs read different bytes", (k, T, f, list) => (k.set(T, { owner: ALT, data: tableData(f, list.slice(0, 28)), lamports: 1n }, 0), (i, a, c, v) => (i === 1 && a === T ? { ...v, data: tableData(f, list.slice(0, 27)) } : v)), /do not read lookup table .* the same/],
    ["both null just after a landed create", () => (i, a, c, v) => v, /landed/],
    ["both null with a create that may still land", () => (i, a, c, v) => v, /may still land/],
  ]) {
    let viewFn = (i, a, c, v) => v;
    const k = fakeCluster({ view: (...x) => viewFn(...x) });
    const base = keyBase();
    const dir = recordDir();
    const p = await planOn(k, "pumpswap", dir);
    const T = b58encode(new Uint8Array(32).fill(4));
    const state = /may still land/.test(String(why)) ? "sent" : "landed";
    const { dir: kd, funder } = keptFolder(base, p, { table: T, txs: [{ step: "lookup table: create and extend with 28 addresses", signature: sigOf(1), state, table: T, last_valid: k.heightAt() + 100 }] });
    fund(k, funder.id, 50_000_000n);
    viewFn = setup(k, T, funder.id, p.list);
    const q = await planOn(k, "pumpswap", dir, { journal: JSON.parse(readFileSync(path.join(kd, "journal.json"), "utf8")) });
    await assert.rejects(runOn(k, q, base, { keyDir: kd }), why, name);
    const j = JSON.parse(readFileSync(path.join(kd, "journal.json"), "utf8"));
    assert.equal(j.table, T, `${name}: the journal's table is never overwritten`);
    assert.equal(sent(k, "create").length + sent(k, "extend").length + sent(k, "freeze").length, 0, `${name}: nothing sent to a table`);
    assert.ok(existsSync(path.join(kd, "funder.json")), `${name}: the key is kept`);
    assert.equal(recOf(dir).tables.pumpswap, undefined);
  }
});

test("P2-2: a resume whose journaled create expired unlanded makes a new table and finishes", async () => {
  const k = fakeCluster();
  const base = keyBase();
  const dir = recordDir();
  const p = await planOn(k, "pumpswap", dir);
  const T = b58encode(new Uint8Array(32).fill(4));
  const { dir: kd } = keptFolder(base, p, { table: T, txs: [{ step: "lookup table: create and extend with 28 addresses", signature: sigOf(1), state: "sent", table: T, last_valid: k.heightAt() - 200 }] });
  const q = await planOn(k, "pumpswap", dir, { journal: JSON.parse(readFileSync(path.join(kd, "journal.json"), "utf8")) });
  await runOn(k, q, base, { keyDir: kd });
  const g = recOf(dir).tables.pumpswap;
  assert.equal(g.length, 1);
  assert.notEqual(g[0].table, T);
  assert.deepEqual(g[0].addresses, p.list);
  assert.deepEqual(readdirSync(base), []);
});

test("P2-2 end to end: an extend that never lands stops the run; a resume before the create is final stops; a later one finishes", async () => {
  let drop = true;
  const k = fakeCluster({ fin: 200_000, onSend: ({ kinds }) => (drop && kinds.includes("extend") && !kinds.includes("create") ? "drop" : "land") });
  const base = keyBase();
  const dir = withSwapG1();
  const p = await planOn(k, "pumpswap", dir); // 256 addresses: create and extend, then extends
  await assert.rejects(runOn(k, p, base), /not confirmed/);
  const [name] = readdirSync(base);
  const kd = path.join(base, name);
  const j1 = JSON.parse(readFileSync(path.join(kd, "journal.json"), "utf8"));
  assert.ok(j1.table && j1.txs.some((x) => /create/.test(x.step) && x.state === "landed" && x.table === j1.table));
  assert.ok(k.logs.some((l) => l.includes(`--resume ${kd} --return ${RETURN}`)));
  assert.equal(sent(k, "create").length, 1);
  // at once: the create landed but is not final, so neither RPC reads the table at finalized: stop, no second create
  drop = false;
  await assert.rejects(runOn(k, await planOn(k, "pumpswap", dir, { journal: j1 }), base, { keyDir: kd }), /landed/);
  assert.equal(sent(k, "create").length, 1);
  assert.equal(JSON.parse(readFileSync(path.join(kd, "journal.json"), "utf8")).table, j1.table);
  // once final (and finality back to its usual seconds): it extends the funder's prefix, freezes and records the one table
  k.advance(210_000);
  k.setFin(3_000);
  await runOn(k, await planOn(k, "pumpswap", dir, { journal: j1 }), base, { keyDir: kd });
  const g = recOf(dir).tables.pumpswap;
  assert.equal(g.length, 2);
  assert.equal(g[1].table, j1.table);
  assert.equal(sent(k, "create").length, 1);
  assert.ok(g[1].txs.every((x) => k.statuses.has(x.signature)), "every recorded tx landed");
  assert.ok(g[1].txs.every((x) => /^lookup table: /.test(x.step)), "only the table's own txs, not the stop's sweep");
  assert.equal(k.get(g[1].table, "finalized").data[21], 0);
});

test("a fresh run that finds a kept folder for the same cluster and venue stops and names it with its resume line", async () => {
  const k = fakeCluster();
  const base = keyBase();
  const p = await planOn(k, "pumpswap", recordDir());
  const { dir: kd } = keptFolder(base, p);
  keptFolder(base, p, { cluster: "devnet", name: "venue-table-devnet-pumpswap-x" });
  await assert.rejects(runOn(k, p, base), (e) => e.message.includes(kd) && e.message.includes(`--resume ${kd} --return ${RETURN}`));
  assert.equal(readdirSync(base).length, 2, "no key made");
  assert.equal(k.sends.length, 0);
  // another venue's folder does not stop it
  const k2 = fakeCluster();
  const p2 = await planOn(k2, "pump-curve", recordDir({}));
  await runOn(k2, p2, base);
});

test("a resume whose kit list changed sends the funder's SOL back before it stops; when it cannot, it prints how", async () => {
  const k = fakeCluster();
  const base = keyBase();
  const p = await planOn(k, "pumpswap", recordDir());
  const { dir: kd, funder } = keptFolder(base, p, { list: p.list.slice(1) });
  fund(k, funder.id, 50_000_000n);
  const before = k.get(RETURN).lamports;
  const q = await planOn(k, "pumpswap", recordDir(), { journal: JSON.parse(readFileSync(path.join(kd, "journal.json"), "utf8")) });
  await assert.rejects(runOn(k, q, base, { keyDir: kd }), /list now differs/);
  assert.equal(k.get(RETURN).lamports - before, 50_000_000n - 5_000n);
  assert.equal(k.get(funder.id).lamports, 0n);
  assert.equal(sent(k, "transfer").length, 1);
  // the sweep refused: the exact way to get the SOL back
  const k2 = fakeCluster({ onSend: () => ({ refuse: "Transaction simulation failed: node refuses" }) });
  const { dir: kd2, funder: f2 } = keptFolder(keyBase(), p, { list: p.list.slice(1) });
  fund(k2, f2.id, 50_000_000n);
  const q2 = await planOn(k2, "pumpswap", recordDir(), { journal: JSON.parse(readFileSync(path.join(kd2, "journal.json"), "utf8")) });
  await assert.rejects(runOn(k2, q2, base, { keyDir: kd2 }), /list now differs/);
  assert.equal(k2.get(f2.id).lamports, 50_000_000n, "nothing moved");
  assert.ok(k2.logs.some((l) => l.includes(`solana transfer --url ${CLUSTERS.mainnet.rpcs[0]} --keypair ${path.join(kd2, "funder.json")} --fee-payer ${path.join(kd2, "funder.json")} ${RETURN} ALL --allow-unfunded-recipient`)), k2.logs.join("\n"));
});

test("run: a create refused as not recent is made again at a new slot only once it can no longer land", async () => {
  const refuse = "Transaction simulation failed: Error processing Instruction 1: invalid instruction data";
  // the node refuses it and nothing lands: once its blockhash expires with no status, a new slot; one table recorded
  let n = 0;
  const k = fakeCluster({ onSend: ({ kinds }) => (kinds.includes("create") && n++ === 0 ? { refuse } : "land") });
  const dir = recordDir();
  const base = keyBase();
  await runOn(k, await planOn(k, "pumpswap", dir), base);
  const [a, b] = sent(k, "create").map((s) => s.tx.ixs.find((x) => x.prog === ALT).acc[0]);
  assert.ok(a && b && a !== b, "two creates, two slots");
  assert.equal(recOf(dir).tables.pumpswap[0].table, b);
  assert.ok(k.logs.some((l) => /can no longer land: reading again/.test(l)));
  // one node refuses it while another took it, and it lands a second later: the run stops on that table, no second create
  let m = 0;
  const k2 = fakeCluster({ onSend: ({ kinds }) => (kinds.includes("create") && m++ === 0 ? { refuse, late: 1_000 } : "land") });
  const base2 = keyBase();
  await assert.rejects(runOn(k2, await planOn(k2, "pumpswap", recordDir()), base2), /landed: the run stops/);
  assert.equal(sent(k2, "create").length, 1, "no second create");
  const [kd] = readdirSync(base2);
  const j = JSON.parse(readFileSync(path.join(base2, kd, "journal.json"), "utf8"));
  assert.equal(j.table, sent(k2, "create")[0].tx.ixs.find((x) => x.prog === ALT).acc[0]);
  assert.ok(existsSync(path.join(base2, kd, "funder.json")), "the key is kept");
});

test("a resume onto a table both RPCs read that is not the funder's prefix of the list stops, nothing sent", async () => {
  for (const [name, data] of [
    ["another authority", (f, list) => tableData(b58encode(new Uint8Array(32).fill(6)), list.slice(0, 28))],
    ["not a prefix", (f, list) => tableData(f, [list[1], list[0], ...list.slice(2, 28)])],
    ["frozen with another list", (f, list) => tableData(null, list.slice(0, 28))],
  ]) {
    const k = fakeCluster();
    const base = keyBase();
    const dir = recordDir();
    const p = await planOn(k, "pumpswap", dir);
    const T = b58encode(new Uint8Array(32).fill(4));
    const { dir: kd, funder } = keptFolder(base, p, { table: T, txs: [{ step: "lookup table: create and extend with 28 addresses", signature: sigOf(1), state: "landed", table: T, last_valid: 1 }] });
    k.set(T, { owner: ALT, data: data(funder.id, p.list), lamports: 1n }, 0);
    const q = await planOn(k, "pumpswap", dir, { journal: JSON.parse(readFileSync(path.join(kd, "journal.json"), "utf8")) });
    await assert.rejects(runOn(k, q, base, { keyDir: kd }), /not the funder's or not a prefix/, name);
    assert.equal(k.sends.length, 0, name);
    assert.equal(recOf(dir).tables.pumpswap, undefined, name);
  }
});

// ------------------------------------------------------------------------------------------------ every stop path
// The key folder of a run whose funder was printed to pay, or that sent anything, goes only on the success path: the
// record row written and read back, the sweep landed, the funder at 0 on both RPCs at finalized. One run per folder.

const [RPC0, RPC1] = CLUSTERS.mainnet.rpcs;
const methodOf = (init) => JSON.parse(init.body).method;
const tableOf = (s) => s.tx.ixs.find((x) => x.prog === ALT).acc[0];
const folderOf = (base) => {
  const names = readdirSync(base);
  assert.equal(names.length, 1, `one key folder under ${base}: ${names.join(", ")}`);
  return path.join(base, names[0]);
};
const journalAt = (kd) => JSON.parse(readFileSync(path.join(kd, "journal.json"), "utf8"));
const resumeOn = async (k, dir, kd, base, extra = {}) => runOn(k, await planOn(k, "pumpswap", dir, { journal: journalAt(kd) }), base, { keyDir: kd, ...extra });
const addressesOf = (v) => {
  const got = [];
  for (let i = 56; i < v.data.length; i += 32) got.push(b58encode(v.data.subarray(i, i + 32)));
  return got;
};
/** A say that keeps the run's words to itself (the fake pays a funder only when k.logs asks) and notes the funding ask. */
const asker = () => {
  const o = { said: [], ask: null };
  o.say = (s) => {
    o.said.push(s);
    const m = /send (\d+) lamports .*to the funder (\w+)/.exec(s);
    if (m) o.ask = { need: BigInt(m[1]), funder: m[2] };
  };
  return o;
};
const tick = () => new Promise((r) => setImmediate(r));

test("the funding wait reads again through a node's JSON-RPC error or HTTP 503 past rpc()'s tries: the key stays, and the run finishes once the money lands", async () => {
  for (const [name, bad, n] of [
    ["a JSON-RPC error (-32005 node is unhealthy)", () => refusal("Node is unhealthy", -32005), 3],
    ["HTTP 503 past rpc()'s five tries", () => new Response("upstream", { status: 503 }), 12],
  ]) {
    const k = fakeCluster();
    const base = keyBase();
    const dir = recordDir();
    const o = asker();
    let faults = n, keyDuringFaults = null;
    // RPC 1 fails every balance read after the ask until the owner's transfer lands (on the last fault)
    const fetchFn = async (url, init) => {
      if (o.ask && faults > 0 && url === RPC1 && methodOf(init) === "getBalance") {
        keyDuringFaults ??= existsSync(path.join(folderOf(base), "funder.json"));
        if (--faults === 0) fund(k, o.ask.funder, o.ask.need);
        return bad();
      }
      return k.fetchFn(url, init);
    };
    const p = await plan("mainnet", "pumpswap", { fetchFn, dir, wait: k.wait });
    await vt.run(p, { returnTo: RETURN, base, say: o.say, wait: k.wait, now: k.now });
    assert.equal(faults, 0, `${name}: every fault was answered`);
    assert.equal(keyDuringFaults, true, `${name}: the key file is there while the reads fail`);
    assert.ok(o.said.some((l) => /a balance read failed .*reading again/.test(l)), name);
    assert.equal(recOf(dir).tables.pumpswap.length, 1, `${name}: the run made and recorded its table`);
    assert.deepEqual(readdirSync(base), [], `${name}: the key folder goes once the run is done`);
  }
});

test("a run stopped in the funding wait keeps its key folder; once the owner's SOL lands, the printed resume line finishes the run", async () => {
  const k = fakeCluster();
  const base = keyBase();
  const dir = recordDir();
  const o = asker();
  // the run ends during the wait (the owner stops it, or anything else throws there)
  const wait = async (ms) => {
    if (o.ask) throw new Error("the owner stopped the run");
    return k.wait(ms);
  };
  await assert.rejects(vt.run(await planOn(k, "pumpswap", dir), { returnTo: RETURN, base, say: o.say, wait, now: k.now }), /the owner stopped the run/);
  assert.equal(readdirSync(base).length, 1, "the key folder is kept once its funder was printed to pay");
  const kd = folderOf(base);
  assert.ok(existsSync(path.join(kd, "funder.json")), "the funder's key file is kept");
  // the owner's transfer lands after the stop; the printed resume line goes on
  fund(k, o.ask.funder, o.ask.need);
  const [, keyDir, returnTo] = o.said.map((l) => /--resume (\S+) --return (\S+)/.exec(l)).find(Boolean);
  assert.deepEqual([keyDir, returnTo], [kd, RETURN]);
  await vt.run(await planOn(k, "pumpswap", dir, { journal: journalAt(kd) }), { returnTo, keyDir, base, say: o.say, wait: k.wait, now: k.now });
  assert.equal(recOf(dir).tables.pumpswap.length, 1);
  assert.equal(sent(k, "create").length, 1);
  assert.equal(k.get(o.ask.funder, "finalized").lamports, 0n, "swept");
  assert.deepEqual(readdirSync(base), []);
});

test("a freeze one RPC reads only after the run stopped: the journal is kept, a fresh paste is refused, and the resume records the frozen table, creating nothing", async () => {
  let table = null, lag = true;
  const k = fakeCluster({
    // RPC 1 still reads the funder as authority (a node behind) until the run has stopped
    view: (i, a, c, v) => (lag && i === 1 && a === table && v && v.data[21] === 0 ? { ...v, data: Buffer.concat([v.data.subarray(0, 21), Buffer.from([1]), v.data.subarray(22)]) } : v),
    onSend: ({ kinds, tx }) => ((table ??= kinds.includes("create") ? tx.ixs.find((x) => x.prog === ALT).acc[0] : null), "land"),
  });
  const dir = recordDir();
  const base = keyBase();
  const p = await planOn(k, "pumpswap", dir);
  const say = (s) => (k.say(s), /^stopped:/.test(s) && (lag = false));
  await assert.rejects(runOn(k, p, base, { say }), /authority/);
  assert.equal(k.get(table, "finalized").data[21], 0, "the freeze landed");
  assert.equal(recOf(dir).tables.pumpswap, undefined);
  assert.equal(readdirSync(base).length, 1, "the journal naming the frozen table is kept");
  const kd = folderOf(base);
  assert.equal(journalAt(kd).table, table);
  // the same paste again: refused, the folder named with its resume line
  await assert.rejects(runOn(k, await planOn(k, "pumpswap", dir), base), (e) => e.message.includes(kd) && e.message.includes(`--resume ${kd} --return ${RETURN}`));
  // the resume: the frozen table recorded, no second create, no second freeze
  await resumeOn(k, dir, kd, base);
  assert.equal(sent(k, "create").length, 1, "one create in all");
  assert.equal(sent(k, "freeze").length, 1, "one freeze in all");
  const g = recOf(dir).tables.pumpswap;
  assert.deepEqual([g.length, g[0].table], [1, table]);
  assert.deepEqual(g[0].addresses, p.list);
  assert.deepEqual(readdirSync(base), []);
});

test("a record write that fails after the freeze: the journal is kept, and the resume records the frozen table, creating nothing", async () => {
  const k = fakeCluster();
  const dir = recordDir();
  const base = keyBase();
  const p = await planOn(k, "pumpswap", dir);
  chmodSync(path.join(dir, "mainnet.json"), 0o444);
  await assert.rejects(runOn(k, p, base), /EACCES|permission denied/);
  assert.equal(sent(k, "freeze").length, 1);
  assert.equal(readdirSync(base).length, 1, "the journal naming the frozen table is kept");
  const kd = folderOf(base);
  const table = journalAt(kd).table;
  assert.equal(k.get(table, "finalized").data[21], 0);
  chmodSync(path.join(dir, "mainnet.json"), 0o644);
  await resumeOn(k, dir, kd, base);
  assert.deepEqual([sent(k, "create").length, sent(k, "freeze").length], [1, 1]);
  assert.deepEqual(recOf(dir).tables.pumpswap.map((g) => g.table), [table]);
  assert.deepEqual(readdirSync(base), []);
});

test("a sweep that fails after the record row is written keeps the folder and says how to get the SOL back; the resume sweeps and never writes the row twice", async () => {
  let refuse = true;
  const k = fakeCluster({ onSend: ({ kinds }) => (refuse && kinds.includes("transfer") ? { refuse: "Transaction simulation failed: node refuses" } : "land") });
  const dir = recordDir();
  const base = keyBase();
  await assert.rejects(runOn(k, await planOn(k, "pumpswap", dir), base), /node refuses/);
  assert.equal(recOf(dir).tables.pumpswap.length, 1);
  const kd = folderOf(base);
  assert.ok(k.logs.some((l) => l.includes(`--keypair ${path.join(kd, "funder.json")}`)), "the solana transfer line");
  refuse = false;
  await resumeOn(k, dir, kd, base);
  assert.equal(recOf(dir).tables.pumpswap.length, 1, "the row once");
  assert.equal(sent(k, "create").length, 1);
  assert.equal(k.get(k.sends[0].tx.keys[0], "finalized")?.lamports ?? 0n, 0n, "the funder swept to 0");
  assert.deepEqual(readdirSync(base), []);
});

test("the success path keeps the key folder when an RPC stops reading the frozen table the same before the folder would go", async () => {
  let table = null, gone = false;
  const k = fakeCluster({
    view: (i, a, c, v) => (gone && i === 1 && a === table ? null : v),
    onSend: ({ kinds, tx }) => ((table ??= kinds.includes("create") ? tx.ixs.find((x) => x.prog === ALT).acc[0] : null), "land"),
  });
  const dir = recordDir();
  const base = keyBase();
  await runOn(k, await planOn(k, "pumpswap", dir), base, { say: (s) => (k.say(s), /tables\.pumpswap generation/.test(s) && (gone = true)) });
  assert.equal(recOf(dir).tables.pumpswap.length, 1);
  assert.equal(readdirSync(base).length, 1, "kept: one RPC no longer reads the table");
  assert.ok(k.logs.some((l) => /do not read lookup table .* the same/.test(l) && /the key stays/.test(l)));
});

test("a resume reads the journal's table at confirmed and at finalized on both RPCs and goes on only when all four agree: 0 s and 5 s after a refused extend it stops, nothing sent; at 20 s it finishes", async () => {
  for (const after of [0, 5_000, 20_000]) {
    let n = 0;
    // finality 13 s behind confirmed; each send takes 2 s to confirm; the node refuses the eighth extend at preflight
    const k = fakeCluster({ fin: 13_000, onSend: ({ kinds }) => (k.advance(2_000), kinds.includes("extend") && ++n === 8 ? { refuse: "Transaction simulation failed: Error processing Instruction 1: invalid account data for instruction" } : "land") });
    const dir = recordDir();
    const base = keyBase();
    const p = await planOn(k, "pumpswap", dir);
    await assert.rejects(runOn(k, p, base), /invalid account data/);
    const kd = folderOf(base);
    const T = journalAt(kd).table;
    k.advance(after);
    if (after < 20_000) {
      const before = k.sends.length;
      await assert.rejects(resumeOn(k, dir, kd, base), /resume again in a minute/, `${after / 1000} s`);
      assert.equal(k.sends.length, before, `${after / 1000} s: nothing sent`);
      const got = addressesOf(k.get(T));
      assert.deepEqual(got, p.list.slice(0, got.length), `${after / 1000} s: still the list's prefix`);
      k.advance(20_000);
    }
    await resumeOn(k, dir, kd, base);
    const v = k.get(T, "finalized");
    const got = addressesOf(v);
    assert.equal(new Set(got).size, 256, `${after / 1000} s`);
    assert.deepEqual(got, p.list);
    assert.equal(v.data[21], 0, "frozen");
    assert.equal(recOf(dir).tables.pumpswap.length, 1);
  }
});

test("one run per key folder: a resume beside a live run stops at once naming its pid, and so does a fresh paste; the live run finishes alone", async () => {
  const k = fakeCluster();
  const dir = recordDir();
  const base = keyBase();
  const fetchFn = async (url, init) => (await tick(), k.fetchFn(url, init));
  let release;
  const gate = new Promise((r) => (release = r));
  const saidA = [];
  // run A: its funding ask reaches the fake's payer only once B and C were tried
  const runA = vt.run(await plan("mainnet", "pumpswap", { fetchFn, dir, wait: k.wait }), { returnTo: RETURN, base, say: (s) => (saidA.push(s), /send \d+ lamports/.test(s) ? void gate.then(() => k.say(s)) : undefined), wait: k.wait, now: k.now });
  while (!saidA.some((l) => /send \d+ lamports/.test(l))) await tick();
  try {
    const kd = folderOf(base);
    const before = k.sends.length;
    const saidB = [];
    const pid = new RegExp(`another run \\(pid ${process.pid}\\) holds`);
    await assert.rejects(vt.run(await plan("mainnet", "pumpswap", { fetchFn, dir, wait: k.wait, journal: journalAt(kd) }), { returnTo: RETURN, base, keyDir: kd, say: (s) => (saidB.push(s), k.say(s)), wait: k.wait, now: k.now }), (e) => pid.test(e.message) && e.message.includes("holds this folder"));
    assert.deepEqual(saidB, [], "the resume beside it printed nothing");
    await assert.rejects(vt.run(await plan("mainnet", "pumpswap", { fetchFn, dir, wait: k.wait }), { returnTo: RETURN, base, say: () => {}, wait: k.wait, now: k.now }), (e) => pid.test(e.message) && e.message.includes(kd));
    assert.equal(k.sends.length, before, "nothing sent beside the live run");
    assert.equal(readdirSync(base).length, 1);
  } finally {
    release(); // the owner funds once, and run A goes on
  }
  await runA;
  const creates = [...new Set(sent(k, "create").map(tableOf))];
  assert.equal(creates.length, 1);
  assert.deepEqual(addressesOf(k.get(creates[0], "finalized")), recOf(dir).tables.pumpswap[0].addresses);
  assert.equal(k.get(creates[0], "finalized").data[21], 0);
  assert.deepEqual(readdirSync(base), []);
});

test("a lock left by a run that is gone is taken over, and said so", async () => {
  const k = fakeCluster();
  const base = keyBase();
  const dir = recordDir();
  const p = await planOn(k, "pumpswap", dir);
  const { dir: kd, funder } = keptFolder(base, p);
  fund(k, funder.id, 50_000_000n);
  const gone = spawnSync(process.execPath, ["-e", ""]).pid;
  writeFileSync(path.join(kd, "run.lock"), `${gone}\n`);
  await resumeOn(k, dir, kd, base);
  assert.ok(k.logs.some((l) => l.includes(`pid ${gone}`) && /taken over/.test(l)), k.logs.join("\n"));
  assert.equal(recOf(dir).tables.pumpswap.length, 1);
  assert.deepEqual(readdirSync(base), []);
});

test("the lock is released on SIGINT and on SIGTERM, and when a run stops", async () => {
  for (const [sig, code] of [["SIGINT", 130], ["SIGTERM", 143]]) {
    const dir = mkdtempSync(path.join(tmpdir(), "venue-table-lock-"));
    const src = `const m = await import(${JSON.stringify(pathToFileURL(path.join(HERE, "venue-table.mjs")).href)}); m.lockFolder(${JSON.stringify(dir)}, { say: () => {} }); console.log("locked"); setInterval(() => {}, 1000);`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", src], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stderr.on("data", (d) => (err += d));
    const exited = new Promise((r) => child.on("exit", (c) => r(c)));
    await new Promise((res, rej) => {
      child.stdout.on("data", (d) => ((out += d), out.includes("locked") && res()));
      exited.then((c) => rej(new Error(`exited ${c} before it locked: ${err}`)));
    });
    assert.equal(readFileSync(path.join(dir, "run.lock"), "utf8").trim(), String(child.pid), `${sig}: the lock holds the pid`);
    child.kill(sig);
    assert.equal(await exited, code, sig);
    assert.equal(existsSync(path.join(dir, "run.lock")), false, `${sig}: the lock is released`);
  }
  // in this process: a run that stops leaves the folder unlocked for its resume
  const k = fakeCluster();
  const base = keyBase();
  const p = await planOn(k, "pumpswap", recordDir());
  const { dir: kd } = keptFolder(base, p, { list: p.list.slice(1) });
  await assert.rejects(runOn(k, await planOn(k, "pumpswap", recordDir(), { journal: journalAt(kd) }), base, { keyDir: kd }), /list now differs/);
  assert.equal(existsSync(path.join(kd, "run.lock")), false);
});

test("--return is refused before anything is made or printed: the pool program, the pool account, the system program, wSOL's mint", async () => {
  const k = fakeCluster();
  k.set(MAINNET.program_id, { owner: "BPFLoaderUpgradeab1e11111111111111111111111", data: Buffer.alloc(36), lamports: 1_141_440n }, 0);
  k.set(SYSTEM, { owner: "NativeLoader1111111111111111111111111111111", data: Buffer.from("system_program"), lamports: 1n }, 0);
  const WSOL = "So11111111111111111111111111111111111111112";
  k.set(WSOL, { owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", data: Buffer.alloc(82), lamports: 1_000_000_000n }, 0);
  const p = await planOn(k, "pumpswap", recordDir());
  for (const [what, a] of [["the pool program", MAINNET.program_id], ["the pool account", MAINNET.pool], ["the system program", SYSTEM], ["wSOL's mint", WSOL]]) {
    const base = keyBase();
    const said = [];
    await assert.rejects(vt.run(p, { returnTo: a, base, say: (s) => (said.push(s), k.say(s)), wait: k.wait, now: k.now }), (e) => e.message.startsWith(`--return ${a} `), what);
    assert.deepEqual(readdirSync(base), [], `${what}: no key folder`);
    assert.deepEqual(said, [], `${what}: nothing printed`);
    assert.equal(k.sends.length, 0, what);
  }
});

test("a stop that leaves the funder 5,000 lamports or less says what to do, and its folder does not stop a later fresh paste", async () => {
  const k = fakeCluster();
  const base = keyBase();
  const dir = recordDir();
  const p = await planOn(k, "pumpswap", dir);
  const { dir: kd, funder } = keptFolder(base, p, { list: p.list.slice(1) });
  fund(k, funder.id, 3_000n);
  await assert.rejects(runOn(k, await planOn(k, "pumpswap", dir, { journal: journalAt(kd) }), base, { keyDir: kd }), /list now differs/);
  const resume = `node contracts/pool-solana/scripts/venue-table.mjs --resume ${kd} --return ${RETURN}`;
  assert.ok(k.logs.includes(`the funder ${funder.id} holds 3000 lamports, too little to send back: nothing is left to do, unless SOL sent to it is still on its way; once that lands, go on with: ${resume}. This folder does not stop a fresh paste.`), k.logs.join("\n"));
  assert.ok(existsSync(path.join(kd, "funder.json")), "its key stays");
  // a fresh paste goes on beside it, and says so
  await runOn(k, await planOn(k, "pumpswap", dir), base);
  assert.equal(recOf(dir).tables.pumpswap.length, 1);
  assert.ok(existsSync(path.join(kd, "funder.json")), "the stopped run's key is still kept");
  assert.ok(k.logs.some((l) => l.includes(kd) && /does not stop this paste/.test(l)));
});

test("a stopped run's folder whose journal names a table that may still be made stops a fresh paste, though its funder holds nothing; once that create can no longer land, it does not", async () => {
  let refuse = true;
  const k = fakeCluster({ onSend: ({ kinds }) => (refuse && kinds.includes("create") ? { refuse: "Transaction simulation failed: Error processing Instruction 1: custom program error: 0x0" } : "land") });
  const base = keyBase();
  const dir = recordDir();
  await assert.rejects(runOn(k, await planOn(k, "pumpswap", dir), base), /custom program error/);
  const kd = folderOf(base);
  const j = journalAt(kd);
  assert.ok(j.table);
  assert.equal(k.get(j.funder)?.lamports ?? 0n, 0n, "swept back");
  refuse = false;
  await assert.rejects(runOn(k, await planOn(k, "pumpswap", dir), base), (e) => e.message.includes(kd) && /may still land/.test(e.message));
  assert.equal(sent(k, "create").length, 1);
  k.advance(200_000); // past the create's last valid block height at finalized, with no status
  await runOn(k, await planOn(k, "pumpswap", dir), base);
  assert.equal(recOf(dir).tables.pumpswap.length, 1);
  assert.ok(existsSync(path.join(kd, "funder.json")), "the stopped run's key is still kept");
});

// ------------------------------------------------------------------------------------------------ the mainnet source gate

const GIT_ENV = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_"))), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const gitT = (cwd, ...a) => {
  const r = spawnSync("git", ["-C", cwd, ...a], { encoding: "utf8", env: GIT_ENV });
  assert.equal(r.status, 0, `git ${a.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
const put = (root, file, text) => {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), text);
};
const REC = "contracts/pool-solana/deployments/mainnet.json";
/** A bare "public repo": main is old (generation 1) -> mid (generation 2 recorded) -> head (a README edit); card is off main. */
function gateRepo() {
  const root = mkdtempSync(path.join(tmpdir(), "venue-table-gate-"));
  const bare = path.join(root, "remote.git");
  const src = path.join(root, "src");
  gitT(root, "init", "-q", "--bare", bare);
  gitT(root, "init", "-q", "-b", "main", src);
  const rec = (tables) => JSON.stringify({ ...MAINNET, tables }, null, 2) + "\n";
  put(src, REC, rec({ "pump-curve": MAINNET.tables["pump-curve"] }));
  put(src, "contracts/pool-solana/scripts/venue-table.mjs", "// v1\n");
  put(src, "packages/kit/src/trade/solana/pool-buy.ts", "export {};\n");
  put(src, "README.md", "one\n");
  gitT(src, "add", "--", "contracts", "packages", "README.md");
  gitT(src, "commit", "-q", "-m", "old");
  const old = gitT(src, "rev-parse", "HEAD");
  put(src, REC, rec({ "pump-curve": MAINNET.tables["pump-curve"], pumpswap: [{ ...SWAP_G1, addresses: [] }] }));
  gitT(src, "commit", "-q", "-am", "mid");
  const mid = gitT(src, "rev-parse", "HEAD");
  put(src, "README.md", "two\n");
  gitT(src, "commit", "-q", "-am", "head");
  const head = gitT(src, "rev-parse", "HEAD");
  gitT(src, "push", "-q", bare, "main");
  gitT(src, "checkout", "-q", "-b", "card");
  put(src, "contracts/pool-solana/scripts/venue-table.mjs", "// card\n");
  gitT(src, "commit", "-q", "-am", "card");
  const card = gitT(src, "rev-parse", "HEAD");
  return { root, bare, old, mid, head, card, rec };
}
let clones = 0;
const cloneAt = (o, commit) => {
  const dir = path.join(o.root, `clone-${clones++}`);
  gitT(o.root, "clone", "-q", o.bare, dir);
  gitT(dir, "-c", "advice.detachedHead=false", "checkout", "-q", "--detach", commit);
  return dir;
};
/** source-gate.mjs's git shape: git(...args) answers stdout as text. */
const gitFn = (root) => (...a) => {
  const r = spawnSync("git", ["-C", root, ...a], { encoding: "utf8", env: GIT_ENV });
  if (r.status !== 0) throw Object.assign(new Error(r.stderr), { stderr: r.stderr });
  return r.stdout;
};

test("source-gate.mjs exports its own mainProblems: a commit on main passes, one off main is refused", () => {
  const o = gateRepo();
  const c = cloneAt(o, o.mid);
  assert.equal(typeof sourceGate.mainProblems, "function");
  assert.deepEqual(sourceGate.mainProblems(gitFn(c), o.mid, o.bare), []);
  assert.deepEqual(sourceGate.mainProblems(gitFn(c), o.head, o.bare), []);
  gitT(path.join(o.root, "src"), "push", "-q", o.bare, "card");
  gitT(c, "fetch", "-q", o.bare, "card");
  assert.match(sourceGate.mainProblems(gitFn(c), o.card, o.bare).join(), /not an ancestor of main/);
});

test("the mainnet source gate: a HEAD behind main whose mainnet.json differs is refused, a dirty mainnet.json is refused, HEAD equal to main passes", () => {
  const o = gateRepo();
  const gate = (root, journal = null) => vt.sourceProblems({ root, remote: o.bare, journal });
  // behind main, with the record main has moved on from: refused (the stale paste would plan generation 1 again)
  assert.match(gate(cloneAt(o, o.old)).join("\n"), /mainnet\.json at HEAD \w+ is not main's/);
  // behind main with the same three files: passes; equal to main: passes
  assert.deepEqual(gate(cloneAt(o, o.mid)), []);
  const c = cloneAt(o, o.head);
  assert.deepEqual(gate(c), []);
  // a dirty mainnet.json, venue-table.mjs or pool-buy.ts: refused
  for (const f of [REC, "contracts/pool-solana/scripts/venue-table.mjs", "packages/kit/src/trade/solana/pool-buy.ts"]) {
    const d = cloneAt(o, o.head);
    put(d, f, readFileSync(path.join(d, f), "utf8") + "\n");
    assert.match(gate(d).join("\n"), new RegExp(`${f.replace(/[./]/g, "\\$&")} has changes not committed`), f);
  }
  // a commit off main: refused
  gitT(path.join(o.root, "src"), "push", "-q", o.bare, "card");
  assert.match(gate(cloneAt(o, o.card)).join("\n"), /not an ancestor of main/);
  // main not read: refused
  assert.match(vt.sourceProblems({ root: c, remote: path.join(o.root, "nothing.git") }).join("\n"), /main was not read/);
  // a resume after a stop that wrote its own row: the row for the journal's table is the one change allowed
  const T = b58encode(new Uint8Array(32).fill(4));
  const r = cloneAt(o, o.head);
  const w = JSON.parse(readFileSync(path.join(r, REC), "utf8"));
  w.tables.pumpswap.push({ table: T, pages: SWAP_G1.pages, made_at: SWAP_G1.made_at, addresses: [], txs: [] });
  writeFileSync(path.join(r, REC), JSON.stringify(w, null, 2) + "\n");
  assert.deepEqual(gate(r, { venue: "pumpswap", table: T }), []);
  assert.match(gate(r, { venue: "pumpswap", table: b58encode(new Uint8Array(32).fill(5)) }).join(), /has changes not committed/);
  assert.match(gate(r).join(), /has changes not committed/);
});

test("the CLI holds a mainnet run and a mainnet resume to the source gate before any read; a dry run is not gated", async () => {
  const k = fakeCluster();
  const reads = [];
  const fetchFn = (u, i) => (reads.push(methodOf(i)), k.fetchFn(u, i));
  const io = (extra) => ({ fetchFn, dir: recordDir(), base: keyBase(), say: k.say, wait: k.wait, now: k.now, ...extra });
  await assert.rejects(vt.cli(["--cluster", "mainnet", "--venue", "pumpswap", "--return", RETURN], io({ gate: () => ["HEAD 1234 is behind main"] })), /HEAD 1234 is behind main/);
  const p = await planOn(k, "pumpswap", recordDir());
  const { dir: kd } = keptFolder(keyBase(), p, { table: b58encode(new Uint8Array(32).fill(4)) });
  let asked = null;
  await assert.rejects(vt.cli(["--resume", kd], io({ gate: (o) => ((asked = o), ["stale"]) })), /stale/);
  assert.equal(asked.journal.table, b58encode(new Uint8Array(32).fill(4)), "the gate is given the resume's journal");
  assert.deepEqual(reads, [], "nothing read before the gate");
  // a dry run: never gated
  const out = [];
  await vt.cli(["--cluster", "mainnet", "--venue", "pumpswap", "--dry-run"], io({ gate: () => assert.fail("a dry run is gated"), say: (s) => out.push(s) }));
  assert.ok(out.some((l) => /^the run: /.test(l)));
  // the gate passes: the run
  const ok = io({ gate: () => [] });
  await vt.cli(["--cluster", "mainnet", "--venue", "pumpswap", "--return", RETURN], ok);
  assert.equal(recOf(ok.dir).tables.pumpswap.length, 1);
});

// ------------------------------------------------------------------------------------------------ what the mutants showed

test("readBack: reads of the table that keep failing are never taken as the table: no freeze, the run stops", async () => {
  let table = null;
  const k = fakeCluster({ onSend: ({ kinds, tx }) => ((table ??= kinds.includes("create") ? tx.ixs.find((x) => x.prog === ALT).acc[0] : null), "land") });
  const fetchFn = async (url, init) => {
    const b = JSON.parse(init.body);
    if (table && url === RPC1 && b.method === "getAccountInfo" && b.params[0] === table) return refusal("Internal error", -32603);
    return k.fetchFn(url, init);
  };
  const base = keyBase();
  const dir = recordDir();
  await assert.rejects(runOn(k, await plan("mainnet", "pumpswap", { fetchFn, dir, wait: k.wait }), base), /not read: /);
  assert.equal(sent(k, "freeze").length, 0);
  assert.equal(recOf(dir).tables.pumpswap, undefined);
  assert.equal(readdirSync(base).length, 1);
});

test("createState: a journaled create is open (a resume stops, nothing made) while one RPC is not past its last valid height, at that height itself, with no height recorded, or with a status of any kind", async () => {
  const T = b58encode(new Uint8Array(32).fill(4));
  for (const [name, lastValid, height, status] of [
    ["one RPC past, the other not", 6_000, (i) => (i === 0 ? 6_001 : 5_999), null],
    ["both at the last valid height itself", 6_000, () => 6_000, null],
    ["no last valid height recorded", null, () => 9_999_999, null],
    ["a processed status, both past", 6_000, () => 6_001, { slot: 1, confirmations: 0, err: null, confirmationStatus: "processed" }],
  ]) {
    const k = fakeCluster();
    const fetchFn = async (url, init) => {
      const m = methodOf(init);
      const i = CLUSTERS.mainnet.rpcs.indexOf(url);
      if (m === "getBlockHeight") return answer(height(i));
      if (m === "getSignatureStatuses" && status && i === 1) return answer({ context: { slot: 1 }, value: [status] });
      return k.fetchFn(url, init);
    };
    const base = keyBase();
    const dir = recordDir();
    const p = await plan("mainnet", "pumpswap", { fetchFn, dir, wait: k.wait });
    const { dir: kd, funder } = keptFolder(base, p, { table: T, txs: [{ step: "lookup table: create and extend with 28 addresses", signature: sigOf(1), state: "sent", table: T, last_valid: lastValid }] });
    fund(k, funder.id, 50_000_000n);
    const q = await plan("mainnet", "pumpswap", { fetchFn, dir, wait: k.wait, journal: journalAt(kd) });
    await assert.rejects(runOn(k, q, base, { keyDir: kd }), /may still land/, name);
    assert.equal(sent(k, "create").length, 0, name);
    assert.equal(journalAt(kd).table, T, name);
  }
});

test("a resume keeps the journal's page range and sizes when the trees have grown since", async () => {
  const k0 = fakeCluster();
  const dir = recordDir();
  const base = keyBase();
  const p = await planOn(k0, "pumpswap", dir);
  const { dir: kd, funder } = keptFolder(base, p);
  const k = fakeCluster({ sizes: [{ state: 9_000, label: 3_000 }, { state: 9_000, label: 3_000 }] });
  fund(k, funder.id, 50_000_000n);
  const q = await planOn(k, "pumpswap", dir, { journal: journalAt(kd) });
  assert.notDeepEqual(kit.solanaPoolNextTableRange(CFG, tvOf("pumpswap"), { state: 9_000, label: 3_000 }), p.range, "the trees' own range moved on");
  assert.deepEqual([q.range, q.sizes, q.list], [p.range, p.sizes, p.list]);
  await runOn(k, q, base, { keyDir: kd });
  const g = recOf(dir).tables.pumpswap;
  assert.deepEqual([g.length, g[0].pages, g[0].made_at], [1, p.range, p.sizes]);
});

test("the funding wait holds until both RPCs read the need: the smaller read decides", async () => {
  let askedAt = null, funder = null;
  const k = fakeCluster({ view: (i, a, c, v) => (i === 1 && a === funder && k.now() < askedAt + 60_000 ? null : v) });
  const dir = recordDir();
  await runOn(k, await planOn(k, "pumpswap", dir), keyBase(), {
    say: (s) => {
      k.say(s);
      const m = /to the funder (\w+)/.exec(s);
      if (m) (funder = m[1]), (askedAt = k.now());
    },
  });
  assert.ok(sent(k, "create")[0].at >= askedAt + 60_000, "no send before RPC 1 reads the funder funded");
  assert.equal(recOf(dir).tables.pumpswap.length, 1);
});

test("a resume whose journal names another funder than its key file stops, nothing sent", async () => {
  const k = fakeCluster();
  const base = keyBase();
  const dir = recordDir();
  const p = await planOn(k, "pumpswap", dir);
  const { dir: kd } = keptFolder(base, p);
  const other = newKey();
  writeFileSync(path.join(kd, "funder.json"), JSON.stringify([...other.secret, ...other.pub]), { mode: 0o600 });
  fund(k, other.id, 50_000_000n);
  await assert.rejects(resumeOn(k, dir, kd, base), /the journal's funder \w+ is not the key file's/);
  assert.equal(sent(k, "create").length + sent(k, "extend").length + sent(k, "freeze").length, 0);
  assert.equal(recOf(dir).tables.pumpswap, undefined);
});

test("a run on a stopped folder clears the stop's mark while it runs: killed in its funding wait, it never reads as stopped with nothing", async () => {
  const k = fakeCluster();
  const base = keyBase();
  const dir = recordDir();
  const p = await planOn(k, "pumpswap", dir);
  const { dir: kd } = keptFolder(base, p);
  const j = journalAt(kd);
  writeFileSync(path.join(kd, "journal.json"), JSON.stringify({ ...j, stopped_left: "0" }));
  const o = asker();
  let mark;
  // the process is killed in the funding wait (SIGINT: no stop path runs), so the journal is read as the wait left it
  const wait = async (ms) => {
    if (o.ask) {
      mark = journalAt(kd).stopped_left;
      throw new Error("killed");
    }
    return k.wait(ms);
  };
  await assert.rejects(vt.run(await planOn(k, "pumpswap", dir, { journal: journalAt(kd) }), { returnTo: RETURN, base, keyDir: kd, say: o.say, wait, now: k.now }), /killed/);
  assert.equal(mark, undefined, "no stop mark while the run waits for its funding");
});
