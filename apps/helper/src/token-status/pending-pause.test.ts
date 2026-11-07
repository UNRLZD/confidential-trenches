// node --test apps/helper/src/token-status/pending-pause.test.ts: a pending Pause multisig request on USDC counts as a
// halt (check 10, M:1388-1404; V:303, the M1 row V:1091; card helper-usdc-pending-pause). The two fake providers answer
// USDC's request views with the answers both mainnet providers gave on 2026-11-07 (test/token-status/near.ts STORED,
// NO_REQUEST, NEXT_ID): get_next_multisig_request_id at H, and approve_multisig_request run as a view for each id from
// the pin up to it. Every hold is the relayers' own call: tokenHeld(statusAt("higher")) for a deposit (bind/send.ts) and
// tokenHeld(statusAt("lower")) for a withdrawal (withdraw/send.ts).
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { A, B, nearPair, PAUSED, type Views } from "../../test/token-status/near.ts";
import { createTokenWatch, storeOf, tokenHeld, USDC } from "./status.ts";

const ENV = { NEAR_RPC_URL: A, NEAR_RPC_URL_B: B, WITHDRAW_VAULT_MAINNET: "vault.test.near" };
const PIN = 218; // mainnet USDC's next request id on both providers, 2026-11-07

async function holds(a: Views, b: Views = a) {
  const p = nearPair({ final: 500, ...a }, { final: 500, ...b });
  const w = createTokenWatch("mainnet", ENV, { fetch: p.fetch });
  const deposit = await w.statusAt("higher");
  const withdrawal = await w.statusAt("lower");
  return { deposit, withdrawal, held: [tokenHeld(deposit), tokenHeld(withdrawal)], seen: p.seen };
}

test("today on mainnet: N is the pin on both providers, no new request: caught up, not halted, nothing held", async () => {
  const r = await holds({});
  assert.deepEqual([r.deposit.caught_up, r.deposit.halted], [true, false]);
  assert.deepEqual(r.held, [false, false]);
});

test("a pending Pause: a new request stored at H on both providers holds every carry (its kind is not read, so not caught up)", async () => {
  const r = await holds({ next: () => String(PIN + 1), request: (id) => id === PIN });
  assert.equal(r.deposit.caught_up, false);
  assert.deepEqual(r.held, [true, true]);
  // the request ids are read at H by block_id, one view each on each provider
  const asked = r.seen.filter((c) => c.params.method_name === "approve_multisig_request").map((c) => [c.url, c.params.block_id, Buffer.from(String(c.params.args_base64), "base64").toString()]);
  assert.deepEqual(asked.sort(), [[A, 500, `{"request_id":${PIN}}`], [A, 500, `{"request_id":${PIN}}`], [B, 500, `{"request_id":${PIN}}`], [B, 500, `{"request_id":${PIN}}`]].sort());
});

test("a stored new request on one provider only, or an answer that is neither of the two: held", async () => {
  for (const [what, a, b] of [
    ["stored on A only", { next: () => String(PIN + 1), request: (id: number) => id === PIN }, { next: () => String(PIN + 1) }],
    ["stored on B only", { next: () => String(PIN + 1) }, { next: () => String(PIN + 1), request: (id: number) => id === PIN }],
    ["another panic", { next: () => String(PIN + 1), request: () => ({ error: PAUSED }) }, { next: () => String(PIN + 1) }],
    ["a value", { next: () => String(PIN + 1), request: () => "null" }, { next: () => String(PIN + 1) }],
  ] as const) {
    const r = await holds(a as Views, b as Views);
    assert.deepEqual(r.held, [true, true], what);
  }
});

test("an executed Pause: the request is gone and ft_balance_of is the paused panic: caught up, halted, held", async () => {
  const r = await holds({ next: () => String(PIN + 1), balance: () => ({ error: PAUSED }) });
  assert.deepEqual([r.deposit.caught_up, r.deposit.halted], [true, true]);
  assert.deepEqual(r.held, [true, true]);
});

test("a removed or executed non-Pause request (no request at its id on both): caught up, not halted, nothing held", async () => {
  const r = await holds({ next: () => String(PIN + 3) });
  assert.deepEqual([r.deposit.caught_up, r.deposit.halted], [true, false]);
  assert.deepEqual(r.held, [false, false]);
  assert.equal(r.seen.filter((c) => c.params.method_name === "approve_multisig_request").length, 2 * 3, "ids 218-220 on both providers, once: the second hold at that H takes the kept answer");
});

test("N unread, disagreeing, below the pin or over 16 new ids: held, and no request id read past the bound", async () => {
  for (const [what, a, b] of [
    ["N fails on B", {}, { next: () => ({ error: PAUSED }) }],
    ["N differs", { next: () => String(PIN + 1) }, {}],
    ["N below the pin", { next: () => String(PIN - 1) }, { next: () => String(PIN - 1) }],
    ["N not a number", { next: () => '"218"' }, { next: () => '"218"' }],
    ["N over 16 new ids", { next: () => String(PIN + 17) }, { next: () => String(PIN + 17) }],
  ] as const) {
    const r = await holds(a as Views, b as Views);
    assert.deepEqual(r.held, [true, true], what);
    assert.equal(r.seen.filter((c) => c.params.method_name === "approve_multisig_request").length, 0, what);
  }
});

test("the testnet token's watch reads its own pin (4) on its own pair", async () => {
  const TA = "https://ta.example";
  const TB = "https://tb.example";
  const p = nearPair({ final: 500 }, { final: 500 }, [TA, TB]);
  const w = createTokenWatch("testnet", { NEAR_TESTNET_RPC_URL: TA, NEAR_TESTNET_RPC_URL_B: TB, WITHDRAW_VAULT_TESTNET: "vault.test.testnet" }, { fetch: p.fetch });
  assert.equal(tokenHeld(await w.statusAt("higher")), false);
  const q = nearPair({ final: 500, next: () => "5", request: (id) => id === 4 }, { final: 500, next: () => "5", request: (id) => id === 4 }, [TA, TB]);
  const v = createTokenWatch("testnet", { NEAR_TESTNET_RPC_URL: TA, NEAR_TESTNET_RPC_URL_B: TB, WITHDRAW_VAULT_TESTNET: "vault.test.testnet" }, { fetch: q.fetch });
  assert.equal(tokenHeld(await v.statusAt("higher")), true);
  assert.equal(USDC.length, 64);
});

// ---- the expiry: a stored new id frees MULTISIG_VALIDITY_NS after its first sight, timed by H's block on both ----

const V_MS = 432_000_000; // 432000 s: the token's ~am\x01 config (02 00008bd6e6880100)
const T0 = Date.UTC(2026, 10, 7, 1, 0, 0);
type Store = { text: string | null; load(): string | null; save(t: string): void };
const memStore = (): Store => ({ text: null, load() { return this.text; }, save(t) { this.text = t; } });

/** A watch over two providers whose final is `at.final` with that block's time `at.ms` (both alike unless `b` says). */
function timed(at: { final: number; ms: number }, store: Store | null, a: Views = {}, b: Views = {}) {
  const base = { final: () => at.final, ms: () => at.ms, next: () => String(PIN + 1), request: (id: number) => id === PIN };
  const p = nearPair({ ...base, ...a }, { ...base, ...b });
  const w = createTokenWatch("mainnet", ENV, { fetch: p.fetch, now: () => at.ms, store });
  return { w, seen: p.seen, held: async () => tokenHeld(await w.statusAt("higher")) };
}

test("a stored new id holds at first sight + validity - 1 s and frees at first sight + validity, timed by H's block, never the server clock", async () => {
  const at = { final: 500, ms: T0 };
  const store = memStore();
  const { held } = timed(at, store);
  assert.equal(await held(), true, "first sight");
  assert.deepEqual(JSON.parse(store.text!), { floor: PIN, seen: { [PIN]: String(BigInt(T0) * 1_000_000n) } }, "first sight kept in the store");
  Object.assign(at, { final: 501, ms: T0 + V_MS - 1_000 });
  assert.equal(await held(), true, "validity - 1 s");
  Object.assign(at, { final: 502, ms: T0 + V_MS });
  assert.equal(await held(), false, "validity: expired, it can never execute");
  assert.deepEqual(JSON.parse(store.text!), { floor: PIN + 1, seen: {} }, "the floor moves past the expired id");
});

test("a restart without the record holds again from its new first sight; with it, frees and reads no done id again", async () => {
  const at = { final: 500, ms: T0 };
  const store = memStore();
  assert.equal(await timed(at, store).held(), true);
  Object.assign(at, { final: 600, ms: T0 + V_MS });
  assert.equal(await timed(at, memStore()).held(), true, "no record: first sight is now");
  assert.equal(await timed(at, null).held(), true, "no store at all: the same");
  const kept = timed(at, store);
  assert.equal(await kept.held(), false, "the record's first sight: expired");
  const again = timed({ final: 601, ms: T0 + V_MS + 600 }, store);
  assert.equal(await again.held(), false);
  assert.equal(again.seen.filter((c) => c.params.method_name === "approve_multisig_request").length, 0, "the floor is past it: no request id read");
});

test("H's timestamp unread or disagreeing on a provider holds, and records no first sight", async () => {
  for (const [what, b] of [
    ["B's block 600 ms off", { ms: () => T0 + 600 }],
    ["B has no block by height", { shift: 1 }],
  ] as const) {
    const store = memStore();
    const t = timed({ final: 500, ms: T0 }, store, {}, b as Views);
    assert.equal(await t.held(), true, what);
    assert.equal(store.text, null, what);
  }
});

test("the record read back: a floor below the pin, a bad file or bad first sights start from the pin; a failing store keeps memory", async () => {
  const at = { final: 500, ms: T0 + V_MS };
  for (const text of [JSON.stringify({ floor: PIN - 1, seen: {} }), "{", JSON.stringify({ floor: PIN, seen: { [PIN]: 5 } }), JSON.stringify({ floor: PIN, seen: { x: "1" } })]) {
    const s = memStore();
    s.text = text;
    assert.equal(await timed(at, s).held(), true, text);
  }
  const broken = { text: null, load: () => { throw new Error("eio"); }, save: () => { throw new Error("eio"); } };
  const mem = { final: 500, ms: T0 };
  const w = timed(mem, broken as unknown as Store);
  assert.equal(await w.held(), true, "first sight, the store failing");
  Object.assign(mem, { final: 501, ms: T0 + V_MS });
  assert.equal(await w.held(), false, "the first sight kept in memory frees it at validity");
});

test("the durable record: HELPER_STORE_DIR/token-watch/requests-mainnet.json, opened once per process, read back after a restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "token-watch-"));
  const env = { HELPER_STORE_DIR: dir };
  assert.equal(storeOf({}, "mainnet"), null, "no store dir: none");
  const at = { final: 500, ms: T0 };
  assert.equal(await timed(at, storeOf(env, "mainnet") as Store).held(), true);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "token-watch", "requests-mainnet.json"), "utf8")), { floor: PIN, seen: { [PIN]: String(BigInt(T0) * 1_000_000n) } });
  Object.assign(at, { final: 600, ms: T0 + V_MS });
  assert.equal(await timed(at, storeOf(env, "mainnet") as Store).held(), false, "a new watch reads the record back");
  assert.equal(storeOf(env, "testnet")!.load(), null, "testnet's file is its own");
});
