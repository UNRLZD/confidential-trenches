// An outside app on SIGN_HOST (src/outside.ts), card signpage-answers-outside-apps.
//   node --test test/outside.test.ts      (from packages/signpage)
// Which app /connect frames (https, or http on localhost and 127.0.0.1; never SIGN_HOST's own origin, credentials or
// another scheme), the kinds it may ask, and each buy and sell held for the user's Confirm. The shell's half (no answer
// before Allow, the app's origin only) is test/shell.test.ts's; the headers' is scripts/deploy.test.mjs's.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CONFIRMED_KINDS, confirmLines, OUTSIDE_KINDS, outsideKinds, outsideOrigin, outsideWithdraw } from "../src/outside.ts";
import type { ApiHost, KindContext } from "../src/api.ts";

const SIGN = "https://confidential.unrealized.trade";

test("an origin shown and allowed: https, or http on localhost and 127.0.0.1 at any port", () => {
  for (const o of ["https://app.example", "https://app.example:8443", "http://localhost:5173", "http://localhost", "http://127.0.0.1:4791", "https://ct-app.unrealized.trade"]) assert.equal(outsideOrigin(o, SIGN), true, o);
});

test("refused: SIGN_HOST itself, an opaque origin, plain http off the device, another scheme, anything but a bare origin", () => {
  for (const o of [SIGN, "null", "", "http://app.example", "http://localhost.evil.example", "http://127.0.0.2", "http://[::1]:5173", "data:text/html,x", "blob:https://app.example/1", "javascript:alert(1)", "file://", "ws://localhost:1", "https://app.example/", "https://app.example/path", "https://user@app.example", "app.example"]) assert.equal(outsideOrigin(o, SIGN), false, o);
});

test("the kinds an outside app may ask: state's own, sign-in, the deposit kinds, withdraw.open, and the pool buy and sell with their previews; nothing else", () => {
  assert.deepEqual([...OUTSIDE_KINDS].sort(), ["deposit.assets", "deposit.confirm", "deposit.dry", "deposit.quote", "pool.buy", "pool.buy.dry", "pool.sell", "pool.sell.dry", "signin.open", "withdraw.open"]);
  assert.deepEqual([...CONFIRMED_KINDS].sort(), ["pool.buy", "pool.sell"]);
  const all = Object.fromEntries(["signin.open", "signout", "backup.open", "export.open", "withdraw.open", "pool.withdraw", "pool.deposit", "pool.move", "pool.address", "deposit.assets", "deposit.dry", "deposit.quote", "deposit.confirm", "buy", "hop", "arm", "orders.set", "orders.cancel", "return", "restore", "nav", "reload", "pool.buy", "pool.sell", "pool.buy.dry", "pool.sell.dry"].map((k) => [k, () => ({ result: {} })]));
  const out = outsideKinds(all as NonNullable<ApiHost["kinds"]>, async () => true);
  assert.deepEqual(Object.keys(out).sort(), [...OUTSIDE_KINDS].sort());
  // a read kind is passed as it is: no Confirm; the deposit kinds sign nothing (the quote hands back an address funded
  // from outside), so they are passed as they are too
  for (const k of ["pool.buy.dry", "signin.open", "deposit.assets", "deposit.dry", "deposit.quote", "deposit.confirm"]) assert.equal(out[k as keyof typeof out], all[k], k);
});

// withdraw.open from an outside app only as the app's given (to with amount or max), which the page draws as
// its own Confirm (src/withdraw/form.ts given: the app's origin above it, To whole, the amount, a max resolved); the
// typed form (no to) and a held deposit's way out (from_id) stay refused
test("withdraw.open: run only with to plus amount or max and no from_id; anything else refused (null: not_allowed) and never run", () => {
  const ran: unknown[] = [];
  const answer = { result: { pending: true, closes: true } };
  const kinds = { "withdraw.open": (p: Record<string, unknown>) => (ran.push(p), answer) } as unknown as NonNullable<ApiHost["kinds"]>;
  const w = outsideKinds(kinds, async () => true)["withdraw.open"]!;
  const TO = "alice.near";
  for (const p of [{ return_key: "w", to: TO, amount: "12.5" }, { return_key: "w", to: TO, max: true }]) assert.equal(w(p, ctx()), answer, JSON.stringify(p));
  assert.equal(ran.length, 2);
  for (const p of [{ return_key: "w" }, { return_key: "w", amount: "1" }, { return_key: "w", max: true }, { return_key: "w", to: TO }, { return_key: "w", to: "", amount: "1" }, { return_key: "w", to: TO, max: false }, { return_key: "w", from_id: "h1" }, { return_key: "w", from_id: "h1", to: TO, amount: "1" }]) assert.equal(w(p, ctx()), null, JSON.stringify(p));
  assert.equal(ran.length, 2, "a refused withdraw.open never reaches the page's own kind");
  assert.equal(outsideWithdraw({ to: TO, amount: "1" }), true);
  assert.equal(outsideWithdraw({ to: TO }), false);
});

const ctx = (id = crypto.randomUUID()): KindContext => ({ id, sha: "0".repeat(64), progress: () => {} });
const BUY = { chain: "solana", token: "So11111111111111111111111111111111111111112", amount: "0.1", slippage_bps: 300 };

test("a buy waits for the Confirm: Cancel refuses it not_allowed and never runs it; Confirm runs it and gives its own answer", async () => {
  let runs = 0;
  const own = { result: { stage: "filled", txs: [] } };
  const kinds = { "pool.buy": () => (runs++, { running: true as const, after: Promise.resolve(), answer: () => own }) } as unknown as NonNullable<ApiHost["kinds"]>;
  const asked: unknown[] = [];
  let say = false;
  const out = outsideKinds(kinds, async (kind, params, id) => (asked.push([kind, params, id]), say));
  const c1 = ctx();
  const no = out["pool.buy"]!(BUY, c1) as { running: true; after: Promise<unknown>; answer(): unknown };
  assert.equal(no.running, true);
  await no.after;
  assert.deepEqual(no.answer(), { error: "not_allowed" });
  assert.equal(runs, 0, "never run without a Confirm");
  assert.deepEqual(asked, [["pool.buy", BUY, c1.id]]);
  say = true;
  const yes = out["pool.buy"]!(BUY, ctx()) as { after: Promise<unknown>; answer(): unknown };
  await yes.after;
  assert.equal(runs, 1);
  assert.equal(yes.answer(), own);
  // a confirm that throws is a Cancel
  const thrown = outsideKinds(kinds, async () => Promise.reject(new Error("x")))["pool.sell"];
  assert.equal(thrown, undefined, "no sell handler given, none made");
  const t = outsideKinds({ ...kinds, "pool.sell": kinds["pool.buy"] } as NonNullable<ApiHost["kinds"]>, () => Promise.reject(new Error("x")))["pool.sell"]!({ ...BUY }, ctx()) as { after: Promise<unknown>; answer(): unknown };
  await t.after;
  assert.deepEqual(t.answer(), { error: "not_allowed" });
  assert.equal(runs, 1);
});

test("the Confirm's lines: chain, token, amount in the pool's coin or share, slippage", () => {
  assert.deepEqual(confirmLines(BUY, () => "SOL"), [["Chain", "solana"], ["Token", BUY.token], ["Amount", "0.1 SOL"], ["Slippage", "3%"]]);
  assert.deepEqual(confirmLines({ chain: "base", token: "0xabc", share_bps: 5000, slippage_bps: 50 }, () => "ETH"), [["Chain", "base"], ["Token", "0xabc"], ["Share", "50%"], ["Slippage", "0.5%"]]);
});
