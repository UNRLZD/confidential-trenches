// The arm records and the Solana signer that signs only from a wallet this device armed by its own withdrawal (card
// signpage-solana-trade; wallet.md §2.3 `wallets`, §2.5 step 6, §2.8 "Buy from fresh wallets").
//   node --test test/arm-records.test.ts   (from packages/wallet)
// The seed is the §A.8 test seed (16 zero bytes), whose keys are published. The store is a Map with the store's get,
// keys and put: the sealing under K_wrap is store.test.ts's.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ed25519 } from "@noble/curves/ed25519.js";
import { base58 } from "@scure/base";
import { ArmRefused, armKey, armRecordOf, armRecords, claimArm, moveArmRecord, settleArm, solanaArmedSigner, solanaMessageBlockhash, type ArmRecord } from "../src/arming/records.ts";
import { entropyToWords, freshWallet, wordsToSeed64 } from "../src/derive/index.ts";

const L = 0x223ba5af661ac5b8dfb52a527bf1c7aaf7853d423364c2b7d347febe93436b32n; // a8.json l
const seed = () => wordsToSeed64(entropyToWords(new Uint8Array(16)));
const W0 = freshWallet(seed(), "sol", L, 0);
const W1 = freshWallet(seed(), "sol", L, 1);
W0.secretKey.fill(0);
W1.secretKey.fill(0);
const CONTEXT = "ab".repeat(32);
// a legacy message's shape: header, no static keys, the blockhash, then the rest
const BLOCKHASH = base58.encode(new Uint8Array(32).fill(9));
const message = (text: string) => Uint8Array.from([1, 0, 0, 0, ...base58.decode(BLOCKHASH), ...new TextEncoder().encode(text)]);
const MSG = message("a checked Solana message");
const TX = { lastValidBlockHeight: 300_000_000 };

const OP = "6f9619ff-8b86-4011-b42d-00c04fc964ff";
const MINT = "Mint1111111111111111111111111111111111111111";
// a record as the arming writes it, marked by the trade OP (the signer signs only for its own trade's marks)
const record = (j: number, address: string, over: Partial<ArmRecord> = {}): ArmRecord => ({
  v: 1, chain: "sol", l: L, j, address, role: "fresh", size_cents: 1_000n, state: "READY", own: { context: CONTEXT }, spend: 50_000_000n,
  inflight: { op: OP, side: "buy", token: MINT, txs: [] }, ...over,
});

function store(entries: Record<string, unknown> = {}) {
  const m = new Map<string, unknown>(Object.entries(entries));
  const writes: string[] = [];
  return {
    m,
    writes,
    async keys(s: string) {
      assert.equal(s, "wallets");
      return [...m.keys()];
    },
    async get(s: string, k: string) {
      assert.equal(s, "wallets");
      return m.get(k);
    },
    async put(s: string, k: string, v: unknown) {
      assert.equal(s, "wallets");
      writes.push(k);
      m.set(k, v);
    },
    // the store's compare-and-set: a turn of the event loop between the read and the write, and a lost race read again
    async update(s: string, k: string, change: (v: unknown) => unknown) {
      assert.equal(s, "wallets");
      for (;;) {
        const before = m.get(k);
        const next = change(structuredClone(before));
        await new Promise((r) => setTimeout(r, 1));
        if (m.get(k) !== before) continue;
        if (next === undefined) return undefined;
        writes.push(k);
        m.set(k, next);
        return next;
      }
    },
  };
}

/** A seed opener that counts its opens. */
function opener() {
  let opened = 0;
  return { open: async () => (opened++, seed()), opened: () => opened };
}

test("a wallet with no arm record is refused before the seed is opened, so nothing is signed", async () => {
  const s = store();
  const o = opener();
  const signer = solanaArmedSigner(s as never, o.open, OP);
  await assert.rejects(signer.sign(W0.address, MSG, TX), (e: unknown) => e instanceof ArmRefused && e.code === "not_armed");
  assert.equal(o.opened(), 0, "the seed was never opened");
});

test("a wallet whose record lacks the device's own withdrawal, or names another key, is refused before the seed is opened", async () => {
  const bad: Record<string, unknown> = {
    "no own": { ...record(0, W0.address), own: undefined },
    "own not a context": { ...record(0, W0.address), own: { context: "yes" } },
    "own as a flag": { ...record(0, W0.address), own: true },
    "key for another j": record(1, W0.address),
    "hop role": record(0, W0.address, { role: "hop" }),
  };
  for (const [name, rec] of Object.entries(bad)) {
    const o = opener();
    const signer = solanaArmedSigner(store({ [armKey("sol", L, 0)]: rec }) as never, o.open, OP);
    await assert.rejects(signer.sign(W0.address, MSG, TX), ArmRefused, name);
    assert.equal(o.opened(), 0, name);
  }
});

test("a record for an address the seed does not derive at (l, j) is refused: nothing is signed", async () => {
  // a record whose address is someone else's wallet, under this seed's (l, 0)
  const other = freshWallet(wordsToSeed64(entropyToWords(new Uint8Array(16).fill(7))), "sol", L, 0);
  other.secretKey.fill(0);
  const signer = solanaArmedSigner(store({ [armKey("sol", L, 0)]: record(0, other.address) }) as never, opener().open, OP);
  await assert.rejects(signer.sign(other.address, MSG, TX), (e: unknown) => e instanceof ArmRefused && e.code === "not_this_seed");
});

test("a wallet not READY or IN_POSITION is refused before the seed is opened", async () => {
  for (const state of ["PLANNED", "ARMING", "RETURNING", "EMPTY"] as const) {
    const o = opener();
    const signer = solanaArmedSigner(store({ [armKey("sol", L, 0)]: record(0, W0.address, { state }) }) as never, o.open, OP);
    await assert.rejects(signer.sign(W0.address, MSG, TX), (e: unknown) => e instanceof ArmRefused && e.code === "state", state);
    assert.equal(o.opened(), 0, state);
  }
});

test("an own-armed wallet signs with W_{sol,l,j}'s key; the seed is opened once per signer and zeroed at close", async () => {
  const s = store({ [armKey("sol", L, 0)]: record(0, W0.address), [armKey("sol", L, 1)]: record(1, W1.address, { state: "IN_POSITION", token: "So11111111111111111111111111111111111111112" }) });
  let held: Uint8Array | null = null;
  const signer = solanaArmedSigner(s as never, async () => (held = seed()), OP);
  const a = await signer.sign(W0.address, MSG, TX);
  const b = await signer.sign(W1.address, MSG, TX);
  assert.ok(ed25519.verify(a, MSG, W0.publicKey));
  assert.ok(ed25519.verify(b, MSG, W1.publicKey));
  signer.close();
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(held !== null && (held as Uint8Array).every((x) => x === 0), "the seed is zeroed at close");
  await assert.rejects(signer.sign(W0.address, MSG, TX), /closed/);
});

test("armRecordOf: the key and the record must agree; armRecords lists one chain's well-formed records", async () => {
  assert.ok(armRecordOf(armKey("sol", L, 0), record(0, W0.address)));
  assert.equal(armRecordOf(`sol:${L}:00`, record(0, W0.address)), null);
  assert.equal(armRecordOf(armKey("evm", L, 0), record(0, W0.address)), null);
  assert.equal(armRecordOf(armKey("sol", L, 0), { ...record(0, W0.address), spend: 0n }), null);
  const s = store({ [armKey("sol", L, 0)]: record(0, W0.address), [armKey("sol", L, 1)]: { junk: 1 }, [armKey("evm", L, 0)]: { ...record(0, "0x"), chain: "evm" } });
  assert.deepEqual((await armRecords(s as never, "sol")).map((r) => r.key), [armKey("sol", L, 0)]);
});

test("moveArmRecord moves a record's state and token only; it never makes a record or sets own", async () => {
  const k = armKey("sol", L, 0);
  const s = store({ [k]: record(0, W0.address) });
  assert.equal(await moveArmRecord(s as never, k, "IN_POSITION", "EMPTY"), false, "not in `from`");
  assert.equal(await moveArmRecord(s as never, k, "READY", "IN_POSITION", "Mint1111111111111111111111111111111111111111"), true);
  assert.deepEqual(s.m.get(k), { ...record(0, W0.address), state: "IN_POSITION", token: MINT });
  const empty = store({ [k]: { ...record(0, W0.address), own: undefined } });
  assert.equal(await moveArmRecord(empty as never, k, "READY", "IN_POSITION"), false, "a record with no own withdrawal is left alone");
  assert.equal(await moveArmRecord(store() as never, k, "READY", "IN_POSITION"), false, "no record is made");
  assert.deepEqual(empty.writes, []);
});

test("no source of the wallet or the signing page writes a `wallets` record but records.ts's one write", () => {
  const roots = [new URL("../src", import.meta.url).pathname, new URL("../../signpage/src", import.meta.url).pathname];
  const files: string[] = [];
  const walk = (d: string): void => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".ts")) files.push(p);
    }
  };
  roots.forEach(walk);
  const writers = files.filter((f) => /\.(put|update)\(\s*["']wallets["']/.test(readFileSync(f, "utf8")));
  assert.deepEqual(writers.map((f) => f.slice(f.lastIndexOf("/packages/") + 10)), ["wallet/src/arming/records.ts"]);
  const src = readFileSync(new URL("../src/arming/records.ts", import.meta.url), "utf8");
  assert.equal(src.match(/\.put\(/g), null, "records.ts never puts a record whole");
  assert.equal(src.match(/\.update\(/g)?.length, 1, "records.ts writes only in rewriteArm, as one compare-and-set");
});

test("two records for one address are refused: the signer never picks one of them", async () => {
  const o = opener();
  const s = store({ [armKey("sol", L, 0)]: record(0, W0.address), [armKey("sol", L, 1)]: record(1, W0.address) });
  await assert.rejects(solanaArmedSigner(s as never, o.open, OP).sign(W0.address, MSG, TX), (e: unknown) => e instanceof ArmRefused && e.code === "not_armed" && /more than one/.test(e.message));
  assert.equal(o.opened(), 0);
});

test("an empty message, or a signature asked for after close (while the seed opens), gives no signature", async () => {
  const s = store({ [armKey("sol", L, 0)]: record(0, W0.address) });
  await assert.rejects(solanaArmedSigner(s as never, opener().open, OP).sign(W0.address, new Uint8Array(0), TX), /no message/);
  let open!: (b: Uint8Array) => void;
  const signer = solanaArmedSigner(s as never, () => new Promise<Uint8Array>((r) => (open = r)), OP);
  const asked = signer.sign(W0.address, MSG, TX);
  await new Promise((r) => setTimeout(r, 0));
  signer.close();
  const held = seed();
  open(held);
  await assert.rejects(asked, /closed/);
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(held.every((x) => x === 0), "the seed opened after close is zeroed");
  assert.deepEqual(s.writes, [], "no mark: nothing was signed");
});

test("the not_this_seed refusal names no derivation path", async () => {
  const other = freshWallet(wordsToSeed64(entropyToWords(new Uint8Array(16).fill(7))), "sol", L, 0);
  other.secretKey.fill(0);
  const signer = solanaArmedSigner(store({ [armKey("sol", L, 0)]: record(0, other.address) }) as never, opener().open, OP);
  await assert.rejects(signer.sign(other.address, MSG, TX), (e: unknown) => e instanceof Error && !e.message.includes(String(L)) && !/W_\{/.test(e.message));
});

test("the signer signs only for this trade's mark, and gives the signature back only once the mark holds it", async () => {
  const k = armKey("sol", L, 0);
  for (const inflight of [undefined, { op: "0f9619ff-8b86-4011-b42d-00c04fc964ff", side: "buy" as const, token: MINT, txs: [] }]) {
    const o = opener();
    const s = store({ [k]: record(0, W0.address, { inflight }) });
    await assert.rejects(solanaArmedSigner(s as never, o.open, OP).sign(W0.address, MSG, TX), (e: unknown) => e instanceof ArmRefused && e.code === "not_claimed");
    assert.equal(o.opened(), 0, "not this trade's mark: the seed never opened");
  }
  const s = store({ [k]: record(0, W0.address) });
  let wrote!: () => void;
  const slow = { ...s, update: async (st: string, key: string, f: (v: unknown) => unknown) => { await new Promise<void>((r) => (wrote = r)); return s.update(st, key, f); } };
  let back = false;
  const asked = solanaArmedSigner(slow as never, opener().open, OP).sign(W0.address, MSG, TX).then((sig) => ((back = true), sig));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(back, false, "no signature before the mark is written");
  wrote();
  const sig = await asked;
  assert.deepEqual((s.m.get(k) as ArmRecord).inflight!.txs, [{ sig: base58.encode(sig), lvbh: 300_000_000, blockhash: BLOCKHASH }]);
  for (const bad of [undefined, { lastValidBlockHeight: -1 }, { lastValidBlockHeight: 1.5 }]) {
    const o = opener();
    await assert.rejects(solanaArmedSigner(store({ [k]: record(0, W0.address) }) as never, o.open, OP).sign(W0.address, MSG, bad as never), /lastValidBlockHeight/, "no height: no signature");
    assert.equal(o.opened(), 0);
  }
  const failing = { ...store({ [k]: record(0, W0.address) }), update: async () => { throw new Error("QuotaExceededError"); } };
  await assert.rejects(solanaArmedSigner(failing as never, opener().open, OP).sign(W0.address, MSG, TX), /QuotaExceeded/, "a failed mark write gives no signature");
});

test("claimArm marks only an unmarked READY or IN_POSITION record; settleArm takes only its own op's mark off", async () => {
  const k = armKey("sol", L, 0);
  const { inflight: _, ...bare } = record(0, W0.address);
  const s = store({ [k]: bare });
  assert.equal(await claimArm(s as never, k, { op: OP, side: "buy", token: MINT }), true);
  assert.equal(await claimArm(s as never, k, { op: "0f9619ff-8b86-4011-b42d-00c04fc964ff", side: "buy", token: MINT }), false, "already marked");
  assert.deepEqual((s.m.get(k) as ArmRecord).inflight, { op: OP, side: "buy", token: MINT, txs: [] });
  assert.equal(await settleArm(s as never, k, "0f9619ff-8b86-4011-b42d-00c04fc964ff"), false, "another op's mark stays");
  assert.equal(await settleArm(s as never, k, OP, { from: "READY", to: "IN_POSITION", token: MINT }), true);
  assert.deepEqual(s.m.get(k), { ...bare, state: "IN_POSITION", token: MINT });
  const r = store({ [k]: { ...bare, state: "RETURNING" } });
  assert.equal(await claimArm(r as never, k, { op: OP, side: "sell", token: MINT }), false, "not a signing state");
  assert.equal(await claimArm(r as never, k, { op: "not an op id!", side: "sell", token: MINT }), false);
  assert.equal(armRecordOf(k, { ...bare, inflight: { op: OP, side: "buy", token: MINT, txs: [{ sig: "not base58 0OIl", lvbh: 1, blockhash: BLOCKHASH }] } }), null, "a malformed mark is no record");
  assert.equal(armRecordOf(k, { ...bare, inflight: { op: OP, side: "buy", token: MINT, txs: [{ sig: base58.encode(new Uint8Array(64).fill(1)), lvbh: -1, blockhash: BLOCKHASH }] } }), null, "a mark with no height is no record");
  assert.equal(armRecordOf(k, { ...bare, inflight: { op: OP, side: "buy", token: MINT, txs: [{ sig: base58.encode(new Uint8Array(64).fill(1)), lvbh: 1 }] } }), null, "a mark with no blockhash is no record");
});

test("two signatures for one wallet at once (a teardown's frames) both stay in the mark: the write is a compare-and-set", async () => {
  const k = armKey("sol", L, 0);
  const s = store({ [k]: record(0, W0.address) });
  const signer = solanaArmedSigner(s as never, opener().open, OP);
  const [a, b] = await Promise.all([signer.sign(W0.address, MSG, TX), signer.sign(W0.address, message("frame 2"), TX)]);
  assert.deepEqual((s.m.get(k) as ArmRecord).inflight!.txs.map((t) => t.sig).sort(), [base58.encode(a), base58.encode(b)].sort());
});

test("the mark keeps the blockhash the message signs; a message with no blockhash is never signed", async () => {
  assert.equal(solanaMessageBlockhash(MSG), BLOCKHASH);
  const v0 = Uint8Array.from([0x80, 1, 0, 0, 1, ...new Uint8Array(32).fill(4), ...base58.decode(BLOCKHASH), 0]);
  assert.equal(solanaMessageBlockhash(v0), BLOCKHASH, "a v0 message with one static key");
  assert.equal(solanaMessageBlockhash(Uint8Array.from([1, 0, 0, 2, 1, 2, 3])), null, "cut short");
  const o = opener();
  await assert.rejects(solanaArmedSigner(store({ [armKey("sol", L, 0)]: record(0, W0.address) }) as never, o.open, OP).sign(W0.address, Uint8Array.from([1, 0, 0, 5]), TX), /blockhash/);
  assert.equal(o.opened(), 0);
});

test("settleArm moves the state only from `from`: a record in another state keeps it, its mark still goes", async () => {
  const k = armKey("sol", L, 0);
  const s = store({ [k]: record(0, W0.address, { state: "IN_POSITION", token: MINT }) });
  assert.equal(await settleArm(s as never, k, OP, { from: "READY", to: "IN_POSITION", token: "Other1111111111111111111111111111111111111" }), true);
  const r = s.m.get(k) as ArmRecord;
  assert.deepEqual([r.state, r.token, r.inflight], ["IN_POSITION", MINT, undefined]);
});
