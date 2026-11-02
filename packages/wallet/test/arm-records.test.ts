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
import { ArmRefused, armKey, armRecordOf, armRecords, moveArmRecord, solanaArmedSigner, type ArmRecord } from "../src/arming/records.ts";
import { entropyToWords, freshWallet, wordsToSeed64 } from "../src/derive/index.ts";

const L = 0x223ba5af661ac5b8dfb52a527bf1c7aaf7853d423364c2b7d347febe93436b32n; // a8.json l
const seed = () => wordsToSeed64(entropyToWords(new Uint8Array(16)));
const W0 = freshWallet(seed(), "sol", L, 0);
const W1 = freshWallet(seed(), "sol", L, 1);
W0.secretKey.fill(0);
W1.secretKey.fill(0);
const CONTEXT = "ab".repeat(32);
const MSG = new TextEncoder().encode("a checked Solana message");

const record = (j: number, address: string, over: Partial<ArmRecord> = {}): ArmRecord => ({
  v: 1, chain: "sol", l: L, j, address, role: "fresh", size_cents: 1_000n, state: "READY", own: { context: CONTEXT }, spend: 50_000_000n, ...over,
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
  const signer = solanaArmedSigner(s as never, o.open);
  await assert.rejects(signer.sign(W0.address, MSG), (e: unknown) => e instanceof ArmRefused && e.code === "not_armed");
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
    const signer = solanaArmedSigner(store({ [armKey("sol", L, 0)]: rec }) as never, o.open);
    await assert.rejects(signer.sign(W0.address, MSG), ArmRefused, name);
    assert.equal(o.opened(), 0, name);
  }
});

test("a record for an address the seed does not derive at (l, j) is refused: nothing is signed", async () => {
  // a record whose address is someone else's wallet, under this seed's (l, 0)
  const other = freshWallet(wordsToSeed64(entropyToWords(new Uint8Array(16).fill(7))), "sol", L, 0);
  other.secretKey.fill(0);
  const signer = solanaArmedSigner(store({ [armKey("sol", L, 0)]: record(0, other.address) }) as never, opener().open);
  await assert.rejects(signer.sign(other.address, MSG), (e: unknown) => e instanceof ArmRefused && e.code === "not_this_seed");
});

test("a wallet not READY or IN_POSITION is refused before the seed is opened", async () => {
  for (const state of ["PLANNED", "ARMING", "RETURNING", "EMPTY"] as const) {
    const o = opener();
    const signer = solanaArmedSigner(store({ [armKey("sol", L, 0)]: record(0, W0.address, { state }) }) as never, o.open);
    await assert.rejects(signer.sign(W0.address, MSG), (e: unknown) => e instanceof ArmRefused && e.code === "state", state);
    assert.equal(o.opened(), 0, state);
  }
});

test("an own-armed wallet signs with W_{sol,l,j}'s key; the seed is opened once per signer and zeroed at close", async () => {
  const s = store({ [armKey("sol", L, 0)]: record(0, W0.address), [armKey("sol", L, 1)]: record(1, W1.address, { state: "IN_POSITION", token: "So11111111111111111111111111111111111111112" }) });
  let held: Uint8Array | null = null;
  const signer = solanaArmedSigner(s as never, async () => (held = seed()));
  const a = await signer.sign(W0.address, MSG);
  const b = await signer.sign(W1.address, MSG);
  assert.ok(ed25519.verify(a, MSG, W0.publicKey));
  assert.ok(ed25519.verify(b, MSG, W1.publicKey));
  signer.close();
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(held !== null && (held as Uint8Array).every((x) => x === 0), "the seed is zeroed at close");
  await assert.rejects(signer.sign(W0.address, MSG), /closed/);
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
  assert.deepEqual(s.m.get(k), { ...record(0, W0.address), state: "IN_POSITION", token: "Mint1111111111111111111111111111111111111111" });
  const empty = store({ [k]: { ...record(0, W0.address), own: undefined } });
  assert.equal(await moveArmRecord(empty as never, k, "READY", "IN_POSITION"), false, "a record with no own withdrawal is left alone");
  assert.equal(await moveArmRecord(store() as never, k, "READY", "IN_POSITION"), false, "no record is made");
  assert.deepEqual(empty.writes, []);
});

test("no source of the wallet or the signing page writes a `wallets` record but moveArmRecord", () => {
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
  const writers = files.filter((f) => /\.put\(\s*["']wallets["']/.test(readFileSync(f, "utf8")));
  assert.deepEqual(writers.map((f) => f.slice(f.lastIndexOf("/packages/") + 10)), ["wallet/src/arming/records.ts"]);
  const src = readFileSync(new URL("../src/arming/records.ts", import.meta.url), "utf8");
  assert.equal(src.match(/\.put\(/g)?.length, 1, "records.ts writes only in moveArmRecord");
});
