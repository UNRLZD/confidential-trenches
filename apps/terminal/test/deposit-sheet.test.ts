// The deposit sheet's state map (card app-deposit-sheet; APU-04, app.md:1326; FR-P7 to FR-P11 and branch D,
// app.md:1123-1139): the kit's deposit stages to S4 ids, table driven; the checks AE-09 makes of each branch on the
// screen's side (each branch its own state, done never before the kit's done, a refused quote never an address); the one
// WORDS table; and (card app-deposit-mount) the kit's deposit.assets rows and deposit op facts as the sheet reads them,
// the pickers, the address heading and the address QR.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { DepositAsset, Operation, SignpageResults } from "@blindfill/kit";
import { addressHeading, ADDRESS_STATES, assetOf, chainsOf, countdown, DESTS, destFundable, elapsed, getAddressOn, HELD_STATES, lessThan, parseAmount, pickAsset, recentRows, sheetState, statusOf, statusState, symbolsOf, usd } from "../src/screens/deposit/model.ts";
import { qrOf } from "../src/screens/deposit/qr.ts";
import type { Asset, DepositStatus, SheetInput } from "../src/screens/deposit/model.ts";
import { DRAFTS, WORDS } from "../src/screens/deposit/words.ts";

const NOW = Date.parse("2026-11-01T18:00:00Z");
const DEADLINE = "2026-11-04T18:00:00Z";
const near: Asset = { id: "nep141:wrap.near", chain: "near", symbol: "NEAR", min: "2.1", max_usd: "1000" };
const checked: SignpageResults["deposit.quote"] = { deposit_address: "a1b2c3d4e5f6", origin_asset: near.id, amount_in: "15", min_amount_out: "72.45", deadline: DEADLINE, time_estimate_s: 37 };
const dry = { amount_out_usd: "73.18", min_amount_out_usd: "72.45", fee_usd: "0.62", time_estimate_s: 37 };
const base: SheetInput = { dest: "near", signedIn: true, moneyOn: true, codeSaved: true, asset: near, amount: "15", dry: { kind: "ok", value: dry }, checked: { kind: "idle" }, status: null, now: NOW };
const at = (p: Partial<SheetInput>) => sheetState({ ...base, ...p });
const tracked = (status: DepositStatus | null, now = NOW) => at({ checked: { kind: "ok", value: checked }, status, now });

test("amounts: a positive decimal or nothing; exact comparison with no float", () => {
  assert.equal(parseAmount(" 15 "), "15");
  assert.equal(parseAmount("0.5"), "0.5");
  for (const bad of ["", "0", "0.00", "-1", "1e3", "1.", ".5", "1,5", "abc"]) assert.equal(parseAmount(bad), null, bad);
  assert.equal(lessThan("2.09", "2.1"), true);
  assert.equal(lessThan("2.1", "2.10"), false);
  assert.equal(lessThan("0.30000000000000004", "0.3"), false);
  assert.equal(lessThan("999.999999", "1000"), true);
  assert.equal(usd("73.189"), "$73.18");
  assert.equal(usd("1234567"), "$1,234,567.00");
});

test("FR-P7: S4.1 until the assets load; S4.2 while quoting; S4.3 with the quote, Get address on", () => {
  assert.equal(at({ asset: null }), "S4.1");
  assert.equal(at({ asset: null, dry: { kind: "refused", code: "not_available" } }), "S4.6", "no asset to take: S4.6, not a skeleton forever");
  assert.equal(at({ dry: { kind: "pending" } }), "S4.2");
  assert.equal(at({}), "S4.3");
  assert.equal(getAddressOn("S4.3", base), true);
  assert.equal(getAddressOn("S4.3", { ...base, moneyOn: false }), false, "the signing page not READY turns it off");
  assert.equal(getAddressOn("S4.3", { ...base, signedIn: false }), false);
  for (const s of ["S4.1", "S4.2", "S4.4", "S4.5", "S4.6", "S4.7", "S4.8", "S4.19"] as const) assert.equal(getAddressOn(s, base), false, s);
});

test("AE-09 S4.4 to S4.8: below min (typed or answered), above the max, not available, busy, paused", () => {
  assert.equal(at({ amount: "1.5" }), "S4.4", "below the asset's minimum before any call");
  assert.equal(at({ dry: { kind: "refused", code: "below_min" } }), "S4.4");
  assert.equal(at({ dry: { kind: "ok", value: { ...dry, amount_out_usd: "1000.01" } } }), "S4.5");
  assert.equal(at({ dry: { kind: "ok", value: { ...dry, amount_out_usd: "1000" } } }), "S4.3", "the max itself is allowed");
  assert.equal(at({ asset: { ...near, max_usd: null }, dry: { kind: "ok", value: { ...dry, amount_out_usd: "250000" } } }), "S4.3", "no cap set: no max");
  assert.equal(at({ dry: { kind: "refused", code: "above_max" } }), "S4.5");
  assert.equal(at({ dry: { kind: "refused", code: "not_available" } }), "S4.6");
  assert.equal(at({ dry: { kind: "refused", code: "busy" } }), "S4.7");
  assert.equal(at({ dry: { kind: "refused", code: "down" } }), "S4.8");
});

test("AE-09 the quote-check refusal: its own state, never an address", () => {
  const s = at({ checked: { kind: "refused", code: "quote_check_failed" } });
  assert.equal(s, "quote-refused");
  assert.equal(ADDRESS_STATES.has(s), false);
  assert.equal(at({ checked: { kind: "refused", code: "down" } }), "S4.8");
  assert.equal(at({ checked: { kind: "pending" } }), "S4.2");
});

test("AE-02 / FR-N-gate S4.19: the 12 words not saved hold the address; saved goes on to S4.3", () => {
  assert.equal(at({ codeSaved: false }), "S4.19");
  assert.equal(at({ codeSaved: true }), "S4.3");
  assert.equal(at({ codeSaved: false, amount: "1" }), "S4.4", "the amount's own state shows first");
});

// APU-04: the kit's stages, and the ones it does not have yet, to S4 ids
const TABLE: [DepositStatus | null, string][] = [
  [null, "S4.13"],
  [{ stage: "quote_checked" }, "S4.13"],
  [{ stage: "waiting" }, "S4.14"],
  [{ stage: "in_transit" }, "S4.15"],
  [{ stage: "into_vault" }, "S4.15"],
  [{ stage: "failed" }, "S4.15"],
  [{ stage: "short" }, "S4.18"],
  [{ stage: "done", amount_usd: "73.18" }, "S4.16"],
  [{ stage: "refunded", refunded: true }, "S4.17"],
  [{ stage: "refund_move", refunded: true }, "refund-move"],
  [{ stage: "in_transit", refunded: true }, "refund-move"],
  [{ stage: "into_vault", refunded: true }, "refund-move"],
  [{ stage: "done", refunded: true, amount_usd: "73.18" }, "S4.16"],
  [{ stage: "held", held_id: "u1" }, "held"],
  [{ stage: "held", held_id: "u1", moved_out: true }, "moved"],
  [{ stage: "halted", hold: "halted", held_id: "u1" }, "held-halted"],
  [{ stage: "halted", hold: "not_caught_up", held_id: "u1" }, "held-not-caught-up"],
  [{ stage: "halted", hold: "vault_blocked", held_id: "u1" }, "held-vault-blocked"],
  [{ stage: "halted", held_id: "u1" }, "held-halted"],
  [{ stage: "expired" }, "S4.20"],
];

test("APU-04: every deposit stage to its one S4 state", () => {
  for (const [status, want] of TABLE) assert.equal(tracked(status), want, JSON.stringify(status));
});

test("BAR-12: S4.16 only at the kit's done; never at 1Click's SUCCESS (into_vault) or a refund", () => {
  const done = TABLE.filter(([, s]) => s === "S4.16").map(([st]) => st?.stage);
  assert.deepEqual([...new Set(done)], ["done"]);
  assert.notEqual(tracked({ stage: "into_vault" }), "S4.16");
  assert.notEqual(tracked({ stage: "refunded", refunded: true }), "S4.16");
});

test("FR-D1 to FR-D3: refunded, then the refund move, then done or held; held states carry withdraw.open", () => {
  const path = [{ stage: "refunded", refunded: true }, { stage: "refund_move", refunded: true }, { stage: "done", refunded: true }] as DepositStatus[];
  assert.deepEqual(path.map((s) => tracked(s)), ["S4.17", "refund-move", "S4.16"]);
  for (const s of ["held", "held-halted", "held-not-caught-up", "held-vault-blocked"] as const) assert.ok(HELD_STATES.has(s), s);
  assert.equal(ADDRESS_STATES.has("refund-move"), false, "FR-D2: no address is shown for the move");
  assert.equal(ADDRESS_STATES.has("S4.17"), false);
});

test("S4.20 at the signed deadline with nothing sent; a send seen before it keeps going; no timer fails a deposit", () => {
  const after = Date.parse(DEADLINE);
  assert.equal(tracked(null, after - 1000), "S4.13");
  assert.equal(tracked(null, after), "S4.20");
  assert.equal(tracked({ stage: "quote_checked" }, after), "S4.20");
  assert.equal(tracked({ stage: "waiting" }, after + 3_600_000), "S4.14");
  assert.equal(tracked({ stage: "in_transit" }, after + 86_400_000), "S4.15");
});

test("BAR-11: the counter from the kit's first sight of the send; the countdown to the signed deadline", () => {
  assert.equal(elapsed(undefined, NOW), 0);
  assert.equal(elapsed(NOW - 12_400, NOW), 12);
  assert.equal(elapsed(NOW + 5_000, NOW), 0);
  assert.equal(countdown(DEADLINE, NOW), "72:00:00");
  assert.equal(countdown(DEADLINE, NOW + 48_000), "71:59:12");
  assert.equal(countdown(DEADLINE, Date.parse(DEADLINE) + 1), "00:00:00");
});

test("WORDS: every word carries its source; the only drafts are card deposit-to-pool's, on its picks page", () => {
  for (const [k, w] of Object.entries(WORDS)) assert.ok(w.text.length > 0 && w.source.length > 0, k);
  assert.deepEqual([...DRAFTS], ["to"]);
  for (const k of ["asset", "chain", "amount", "expiresIn", "expired", "getAddress", "copy", "retry"] as const) assert.equal(WORDS[k].draft, false, k);
});

// card app-deposit-mount: the live source reads the kit's deposit calls as they are on main (kit-deposit-assets-dry,
// kit-deposit-calls): deposit.assets' rows become the sheet's assets, a deposit op's stage and facts its status, and the
// address heading names the asset once.

test("deposit.assets: each row is an asset the sheet draws, the chain by its name, the cap as sent", () => {
  const row: DepositAsset = { origin_asset: "nep141:wrap.near", chain: "near", symbol: "NEAR", decimals: 24, min: "2.1", max_usd: "1000" };
  assert.deepEqual(assetOf(row), { id: "nep141:wrap.near", chain: "NEAR", symbol: "NEAR", min: "2.1", max_usd: "1000" });
  const usdc: DepositAsset = { origin_asset: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near", chain: "base", symbol: "USDC", decimals: 6, min: "1.2", max_usd: "1000" };
  assert.equal(assetOf(usdc).chain, "Base");
  assert.equal(assetOf({ ...usdc, chain: "solana" }).chain, "Solana");
  assert.equal(assetOf({ ...usdc, chain: "robinhood" }).chain, "Robinhood");
});

test("a deposit op: its stage and every fact the kit sends, nothing else", () => {
  const op: Operation = { id: "q1", kind: "deposit", stage: "halted", txs: [], hold: "vault_blocked", held_id: "u1", since_ms: 5, refunded: true };
  assert.deepEqual(statusOf(op), { stage: "halted", hold: "vault_blocked", held_id: "u1", since_ms: 5, refunded: true });
  assert.deepEqual(statusOf({ id: "q1", kind: "deposit", stage: "done", txs: [], amount_usd: "73.18", since_ms: 1 }), { stage: "done", amount_usd: "73.18", since_ms: 1 });
  assert.deepEqual(statusOf({ id: "q1", kind: "deposit", stage: "waiting", txs: [] }), { stage: "waiting" });
  assert.equal(tracked(statusOf(op)), "held-vault-blocked");
});

test("the address heading names the asset once: NEAR on NEAR is NEAR, USDC on Base is USDC and Base", () => {
  assert.deepEqual(addressHeading({ symbol: "NEAR", chain: "NEAR" }), ["NEAR"]);
  assert.deepEqual(addressHeading({ symbol: "near", chain: "NEAR" }), ["near"]);
  assert.deepEqual(addressHeading({ symbol: "USDC", chain: "Base" }), ["USDC", "Base"]);
});

test("the address QR is R5's: uqr at error correction H with a one-module border, one square per dark module", () => {
  // R5's QR of a real 1Click NEAR deposit address (research design/proto/assets/marks.js:3 at design-lock-r5, made with
  // uqr ecc H as UNRLZD shell/funds/Qr.tsx): 47 modules, its path's sha256 below
  const q = qrOf("046b61f0a0cb71da75ac26bc7a2a8b3c96f98c2c43e5753eb22b0a0183069e79");
  assert.equal(q.n, 47);
  assert.equal(createHash("sha256").update(q.d).digest("hex"), "1d3bf40bc8c4b30f8d0fd08eef8f6348b4ce199c6592a08a3008feca597fb1cf");
});

test("the pickers: each asset once in the list's order, its chains, and the pick falls back to the asset's first chain", () => {
  const list: Asset[] = [
    near,
    { id: "base-usdc", chain: "Base", symbol: "USDC", min: "1.2", max_usd: "1000" },
    { id: "sol-usdc", chain: "Solana", symbol: "USDC", min: "1.2", max_usd: "1000" },
    { id: "sol", chain: "Solana", symbol: "SOL", min: "0.01", max_usd: "1000" },
  ];
  assert.deepEqual(symbolsOf(list), ["NEAR", "USDC", "SOL"]);
  assert.deepEqual(chainsOf(list, "USDC"), ["Base", "Solana"]);
  assert.equal(pickAsset(list, null)?.id, "nep141:wrap.near", "nothing picked: the list's first");
  assert.equal(pickAsset(list, { symbol: "USDC", chain: "Solana" })?.id, "sol-usdc");
  assert.equal(pickAsset(list, { symbol: "USDC", chain: "NEAR" })?.id, "base-usdc", "a chain the asset is not on: its first chain");
  assert.equal(pickAsset(list, { symbol: "ETH", chain: "Base" })?.id, "nep141:wrap.near", "an asset gone from the list: the list's first");
  assert.equal(pickAsset([], null), null);
  assert.equal(pickAsset(null, null), null);
});

test("Recent: the account's deposits from state.ops, newest first, three at most, each by its stage's word; others left out", () => {
  const dep = (id: string, stage: Operation["stage"], facts: object = {}) => ({ id, kind: "deposit", stage, txs: [], ...facts }) as Operation;
  const ops: Operation[] = [
    dep("a", "done", { amount_usd: "73.18" }),
    { id: "w", kind: "withdraw", stage: "sent", txs: [] },
    dep("b", "halted", { hold: "halted", held_id: "u1" }),
    dep("c", "in_transit", { since_ms: 1 }),
    dep("d", "refund_move", { refunded: true, since_ms: 1 }),
  ];
  assert.deepEqual(recentRows(ops), [
    { id: "d", word: "refunded" },
    { id: "c", word: "processing" },
    { id: "b", word: "held" },
  ]);
  assert.deepEqual(recentRows(ops.slice(0, 2)), [{ id: "a", word: "deposited", amount_usd: "73.18" }]);
  assert.deepEqual(recentRows([dep("r", "done", { refunded: true, amount_usd: "5" })]), [{ id: "r", word: "deposited", amount_usd: "5" }], "a refund moved in is deposited");
  assert.deepEqual(recentRows([dep("q", "quote_checked"), dep("e", "expired"), dep("s", "short", { since_ms: 1 }), dep("f", "failed", { since_ms: 1 })]).map((r) => r.word), ["processing", "short", "expired"], "four deposits: the newest three");
  assert.deepEqual(recentRows([dep("q", "quote_checked")]).map((r) => r.word), ["waiting"]);
  // card held-move-forgotten-tx: a held deposit the device moved out reads Moved, never Held
  assert.deepEqual(recentRows([dep("m", "held", { held_id: "u1", since_ms: 1, moved_out: true }), dep("h", "held", { held_id: "u1" })]), [{ id: "h", word: "held" }, { id: "m", word: "moved" }]);
  assert.deepEqual(recentRows([]), []);
  assert.deepEqual(recentRows(undefined), []);
  for (const k of ["recent", "noActivity"] as const) assert.equal(WORDS[k].draft, false, k);
});

// card deposit-to-pool (v2 A3): where the money goes. The sheet's To row names the NEAR vault (the cash home) and the
// three pools (the kit's POOL_CHAINS). The kit's deposit.quote and deposit.dry land only in the NEAR vault, and nothing
// yet follows money sent to a pool's address on into the pool (card pool-deposit-follow), so a pool picked is its own state: no quote,
// no address, Get address off, whatever the amount and the dry quote say.

test("the To row: the NEAR vault first, then the kit's three pools; only the vault takes a deposit from the sheet", () => {
  assert.deepEqual([...DESTS], ["near", "solana", "base", "robinhood"]);
  assert.equal(destFundable("near"), true);
  for (const d of ["solana", "base", "robinhood"] as const) assert.equal(destFundable(d), false, d);
});

test("a pool picked: pool-off before any quote, in every form state; Get address off; never an address", () => {
  for (const dest of ["solana", "base", "robinhood"] as const) {
    for (const p of [{}, { asset: null }, { dry: { kind: "pending" } }, { amount: "1.5" }, { codeSaved: false }, { dry: { kind: "refused", code: "busy" } }] as Partial<SheetInput>[]) {
      const s = at({ ...p, dest });
      assert.equal(s, "pool-off", `${dest} ${JSON.stringify(p)}`);
      assert.equal(getAddressOn(s, base), false);
      assert.equal(ADDRESS_STATES.has(s), false);
    }
  }
  assert.equal(at({ dest: "near" }), "S4.3", "the vault: the quote, Get address on");
});

test("a deposit already asked follows its own stages: the destination cannot turn a vault deposit into a pool's", () => {
  for (const [status, want] of TABLE) assert.equal(sheetState({ ...base, dest: "solana", checked: { kind: "ok", value: checked }, status }), want, JSON.stringify(status));
});

test("held-move-forgotten-tx: a moved-out deposit draws no Held mark and no withdraw.open", () => {
  const st = tracked({ stage: "held", held_id: "u1", since_ms: 1, moved_out: true });
  assert.equal(st, "moved");
  assert.equal(HELD_STATES.has(st), false, "no held state, so no withdraw.open from its id");
  assert.equal(ADDRESS_STATES.has(st), false);
  assert.equal(tracked({ stage: "held", held_id: "u1" }), "held", "still held without the fact");
  const op: Operation = { id: "m1", kind: "deposit", stage: "held", txs: [], held_id: "u1", since_ms: 5, moved_out: true };
  assert.equal(tracked(statusOf(op)), "moved", "the kit's op carries the fact through statusOf");
});
