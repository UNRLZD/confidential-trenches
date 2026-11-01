// The sign-in screens' states (card app-signin-screens; A1.4, app.md:1442): the header S1.1-S1.4 and its Backup dot,
// the ways in S2.1 offers, and the restore screens S19, each from the signing page's snapshot alone; and the one WORDS
// table, where every word not yet on the owner's lists is marked draft.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SignpageClientSnapshot, SignpageState } from "@blindfill/kit";
import { balanceCents, headerModel, restoreModel, showRestore, signinWays, toCents, usd } from "../src/screens/signin/model.ts";
import { DRAFTS, WORDS } from "../src/screens/signin/words.ts";

const base: SignpageState = {
  release: "signpage-v1",
  api: 1,
  signed_in: true,
  way: "passkey",
  code_saved: true,
  vault_balance: "0",
  wallets: [],
  positions: [],
  orders: [],
  held: [],
  ops: [],
};
const st = (s: Partial<SignpageState>): SignpageState => ({ ...base, ...s });
const snap = (state: SignpageState | null, status: SignpageClientSnapshot["status"] = "ready"): SignpageClientSnapshot => ({ status, release: "signpage-v1", state, stale: false });

test("money strings: decimal to cents, rounded down; garbage is 0; thousands grouped", () => {
  assert.equal(toCents("73.18"), 7318n);
  assert.equal(toCents("73.189999"), 7318n);
  assert.equal(toCents("5"), 500n);
  assert.equal(toCents("0.1"), 10n);
  assert.equal(toCents("-1"), 0n);
  assert.equal(toCents("1e3"), 0n);
  assert.equal(usd(0n), "$0.00");
  assert.equal(usd(7318n), "$73.18");
  assert.equal(usd(123456789n), "$1,234,567.89");
});

test("S1.2 before the first state; S1.1 when signed out or the page is down with nothing known", () => {
  assert.equal(headerModel(snap(null, "connecting")).kind, "loading");
  assert.equal(headerModel(snap(null, "down")).kind, "out");
  assert.equal(headerModel(snap(st({ signed_in: false }))).kind, "out");
  assert.equal(headerModel(snap(st({ signed_in: false }))).backupDot, false);
});

test("S1.3 empty with the Backup dot until the 12 words are saved; S1.4 with a balance", () => {
  const empty = headerModel(snap(st({ code_saved: false })));
  assert.deepEqual([empty.kind, empty.cents, empty.backupDot], ["empty", 0n, true]);
  const bal = headerModel(snap(st({ vault_balance: "73.18" })));
  assert.deepEqual([bal.kind, usd(bal.cents), bal.backupDot], ["balance", "$73.18", false]);
});

test("a stale state keeps its header (the page went down after READY)", () => {
  const m = headerModel({ ...snap(st({ vault_balance: "10" }), "down"), stale: true });
  assert.equal(m.kind, "balance");
});

test("CH-001: the balance is the notes plus READY wallets plus positions; other wallet states do not count", () => {
  const s = st({
    vault_balance: "50.00",
    wallets: [
      { chain: "solana", address: "a", role: "fresh", size: "20.12", state: "READY" },
      { chain: "base", address: "b", role: "fresh", size: "10.12", state: "ARMING" },
      { chain: "near", address: "c", role: "fresh", size: "5", state: "EMPTY" },
    ],
    positions: [{ chain: "solana", token: "t", amount: "1000", cost: "3.06", wallets: ["a"] }],
  });
  assert.equal(balanceCents(s), 7318n);
});

test("S2.1: passkey first, wallet second, the 12 words last; none while signed in (W:921)", () => {
  assert.deepEqual(signinWays(null), ["passkey", "wallet", "words"]);
  assert.deepEqual(signinWays(st({ signed_in: false })), ["passkey", "wallet", "words"]);
  assert.deepEqual(signinWays(st({})), []);
});

test("S2.1 after a failed way (APU-05): no PRF drops the passkey; no passkey keeps it (create still works)", () => {
  assert.deepEqual(signinWays(st({ signed_in: false, signin_failed: { way: "passkey", reason: "no_prf" } })), ["wallet", "words"]);
  assert.deepEqual(signinWays(st({ signed_in: false, signin_failed: { way: "passkey", reason: "no_passkey" } })), ["passkey", "wallet", "words"]);
  assert.deepEqual(signinWays(st({ signed_in: false, signin_failed: { way: "wallet", reason: "no_prf" } })), ["passkey", "wallet", "words"]);
});

const op = (id: string, stage: "started" | "reading" | "done" | "stalled") => ({ id, kind: "restore" as const, stage, txs: [] });

test("S19 from the latest restore operation: scanning, done, nothing found, offline", () => {
  assert.equal(restoreModel(st({})), null);
  assert.equal(restoreModel(st({ signed_in: false, ops: [op("r1", "reading")] })), null);
  assert.equal(restoreModel(st({ ops: [op("r1", "started")] }))!.kind, "scanning");
  const growing = restoreModel(st({ vault_balance: "12.5", ops: [op("r1", "reading")] }))!;
  assert.deepEqual([growing.kind, usd(growing.cents)], ["scanning", "$12.50"]);
  assert.equal(restoreModel(st({ vault_balance: "73.18", ops: [op("r1", "done")] }))!.kind, "done");
  assert.equal(restoreModel(st({ ops: [op("r1", "done")] }))!.kind, "nothing");
  assert.equal(restoreModel(st({ held: [{ id: "u", asset: "usdc", amount: "1" }], ops: [op("r1", "done")] }))!.kind, "done");
  assert.equal(restoreModel(st({ ops: [op("r1", "stalled")] }))!.kind, "offline");
  // the latest one wins: a Sync after a stall
  assert.equal(restoreModel(st({ ops: [op("r1", "stalled"), op("r2", "reading")] }))!.id, "r2");
});

test("S19 shows while running or stalled; a finished one only if this page saw it run; never after close", () => {
  const run = restoreModel(st({ ops: [op("r1", "reading")] }));
  const done = restoreModel(st({ vault_balance: "1", ops: [op("r1", "done")] }));
  const none = new Set<string>();
  assert.equal(showRestore(null, none, none), false);
  assert.equal(showRestore(run, none, none), true);
  assert.equal(showRestore(done, none, none), false, "a reload after the end does not bring the sheet back");
  assert.equal(showRestore(done, new Set(["r1"]), none), true);
  assert.equal(showRestore(done, new Set(["r1"]), new Set(["r1"])), false);
  assert.equal(showRestore(restoreModel(st({ ops: [op("r1", "stalled")] })), none, none), true);
});

test("WORDS: every picked word carries its source; every other word is a draft", () => {
  for (const [k, w] of Object.entries(WORDS)) {
    assert.ok(w.text.length > 0 && w.source.length > 0, k);
  }
  assert.deepEqual(DRAFTS.sort(), ["backup", "close", "nothingFound", "offline", "recoveryCode", "restoring", "sync"]);
  // owner-words-pass and the signed CN rows: final
  for (const k of ["usePasskey", "wallet", "signOut", "privacy", "retry"] as const) assert.equal(WORDS[k].draft, false, k);
});
