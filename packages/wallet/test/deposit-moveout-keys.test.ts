// The held deposit's way out (src/deposit/moveout.ts) opens U's key only inside the seed lock it is given, and zeroes
// the seed and U's key once the signature is made, and when the seed's U is not the op's (review of d791adda, M3: the
// mutants "U's key not zeroed" and "no seed lock" survived the suite). A load hook wraps derive/keys.ts depositId before
// moveout.ts loads, so the test holds the very key the move signed with, and whether the seed lock was held then.
//   node --test test/deposit-moveout-keys.test.ts   (from packages/wallet)
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { after, test } from "node:test";

const derived: { secretKey: Uint8Array; locked: boolean }[] = [];
const g = globalThis as { __ctDerived?: typeof derived; __ctLocked?: boolean };
g.__ctDerived = derived;
g.__ctLocked = false;
registerHooks({
  load(url, context, next) {
    const r = next(url, context);
    if (!url.endsWith("/wallet/src/derive/keys.ts")) return r;
    const src = String(r.source);
    const anchor = "export const depositId = (";
    if (src.split(anchor).length !== 2) throw new Error("depositId moved");
    return { ...r, source: `${src.replace(anchor, "const depositId__real = (")}
export const depositId = (...a) => { const k = depositId__real(...a); globalThis.__ctDerived.push({ secretKey: k.secretKey, locked: globalThis.__ctLocked === true }); return k; };
` };
  },
});

const { VAULT_TOKEN_CODE_HASH } = await import("@blindfill/kit");
const { sha256 } = await import("@noble/hashes/sha2.js");
const { base58 } = await import("@scure/base");
const { IDBFactory } = await import("fake-indexeddb");
const { NEAR_NETWORKS } = await import("../src/deposit/account.ts");
const { moveOutHeld, MoveOutRefused } = await import("../src/deposit/moveout.ts");
const d = await import("../src/derive/index.ts");
const { depositId } = await import("../src/derive/keys.ts");
const { openWalletStore } = await import("../src/store/index.ts");

const NET = NEAR_NETWORKS.testnet;
const SEED = d.wordsToSeed64(d.entropyToWords(new Uint8Array(16)));
const U = depositId(SEED, 1n, 0).id;
derived.length = 0;
const TO = "alice.testnet";
const opened: { close(): void }[] = [];
after(() => opened.forEach((s) => s.close()));

// both RPCs: U with 0.1 N, 2.5 USDC, one own key at nonce 7, TO registered; every send lands, leaving U 1 base unit
function rpcs() {
  const own = `ed25519:${base58.encode(Uint8Array.from(U.match(/../g)!, (x) => parseInt(x, 16)))}`;
  const view = (v: unknown, h: number) => ({ result: { block_height: h, result: [...Buffer.from(JSON.stringify(v))] } });
  const landed = new Set<string>();
  const one = (name: string) => ({
    name,
    block: async (p: Record<string, unknown>) => {
      const h = (p.block_id as number | undefined) ?? 1000;
      return { result: { header: { height: h, hash: base58.encode(sha256(new TextEncoder().encode(`b${h}`))), timestamp_nanosec: "1" } } };
    },
    query: async (p: Record<string, unknown>) => {
      const h = p.block_id as number;
      if (p.request_type === "view_access_key_list") return { result: { block_height: h, keys: [{ public_key: own, access_key: { nonce: 7, permission: "FullAccess" } }] } };
      if (p.request_type === "view_account") return { result: { block_height: h, amount: (10n ** 23n).toString(), locked: "0", storage_usage: 182, code_hash: p.account_id === NET.usdc ? VAULT_TOKEN_CODE_HASH : "11111111111111111111111111111111" } };
      if (p.method_name === "ft_balance_of") return view(landed.size > 0 ? "1" : "2500000", h); // a landed move leaves 1
      if (p.method_name === "storage_balance_of") return view({ total: "1", available: "0" }, h);
      throw new Error(String(p.method_name));
    },
    // a hash nobody sent: UNKNOWN_TRANSACTION only to wait_until NONE; to FINAL the release RPCs time out or answer 408
    tx: async ({ tx_hash, sender_account_id, wait_until }: { tx_hash: string; sender_account_id: string; wait_until: string }) => {
      if (landed.has(tx_hash)) return { result: { final_execution_status: "FINAL", status: { SuccessValue: "" }, transaction: { hash: tx_hash, signer_id: sender_account_id }, receipts_outcome: [{ id: "r", outcome: { status: { SuccessValue: "" } } }] } };
      if (wait_until === "NONE") return { error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_TRANSACTION" } } };
      throw new Error("HTTP 408");
    },
    call: async (method: string, params: unknown) => {
      if (method === "gas_price") return { result: { gas_price: "100000000" } };
      const b = Buffer.from((params as { signed_tx_base64: string }).signed_tx_base64, "base64");
      landed.add(base58.encode(sha256(b.subarray(0, b.length - 65))));
      return { result: {} };
    },
  });
  const shared = one(NET.fastnear[0]);
  return [shared, { ...shared, name: NET.drpc }] as const;
}
async function heldStore() {
  const ops = await openWalletStore({ indexedDB: new IDBFactory() });
  opened.push(ops);
  await ops.put("ops", "op1", { kind: "deposit", stage: "held", txs: [], created_ms: 1, held_id: U, follow: { network: "testnet", s: "1", i: 0, u: U, address: "a", deadline_ms: 1, origin: "nep141:x", min_out: "1", sent: true, status: "PROCESSING", why: "sender_struck" } }); // its send in flight when held: its USDC in U
  return ops;
}
const seedLock = async <T,>(fn: () => Promise<T>): Promise<T> => {
  g.__ctLocked = true;
  try {
    return await fn();
  } finally {
    g.__ctLocked = false;
  }
};

test("U's key is derived inside the seed lock, and it and the seed are zero once the move is signed", async () => {
  derived.length = 0;
  const seeds: Uint8Array[] = [];
  const out = await moveOutHeld("op1", TO, { ops: await heldStore(), rpcs: rpcs(), seed64: async () => (seeds.push(SEED.slice()), seeds.at(-1)!), seedLock, sleep: async () => {}, pollMs: 0 });
  assert.equal(out.kind, "moved");
  assert.equal(derived.length, 1);
  assert.equal(derived[0]!.locked, true, "the derive ran inside the seed lock");
  assert.ok(derived[0]!.secretKey.every((x) => x === 0), "U's key was left in memory");
  assert.ok(seeds.length === 1 && seeds[0]!.every((x) => x === 0), "the seed was left in memory");
});

test("a seed whose U is not the op's: refused, and that key and the seed are zero too", async () => {
  derived.length = 0;
  const seeds: Uint8Array[] = [];
  const other = d.wordsToSeed64(d.entropyToWords(new Uint8Array(16).fill(1)));
  await assert.rejects(moveOutHeld("op1", TO, { ops: await heldStore(), rpcs: rpcs(), seed64: async () => (seeds.push(other.slice()), seeds.at(-1)!), seedLock, sleep: async () => {}, pollMs: 0 }), MoveOutRefused);
  assert.equal(derived.length, 1);
  assert.ok(derived[0]!.secretKey.every((x) => x === 0), "the refused key was left in memory");
  assert.ok(seeds[0]!.every((x) => x === 0), "the seed was left in memory");
});
