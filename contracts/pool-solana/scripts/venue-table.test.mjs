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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compileMessage, newKey, priceIx, PRIORITY_MICRO_LAMPORTS, TX_MAX } from "./deploy.mjs";
import { CLUSTERS, needOf, plan, runLine, tableSteps } from "./venue-table.mjs";
import * as vt from "./venue-table.mjs";
import { b58decode, b58encode, le, pda } from "../../../scripts/live-checks/pool-sol-deploy.mjs";

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
    if (method === "getLatestBlockhash") return answer({ context: ctx, value: { blockhash: b58encode(new Uint8Array(32).fill(7)), lastValidBlockHeight: heightAt(t) + 150 } });
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
