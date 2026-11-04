// node --test apps/terminal/test/hop-gate.test.ts (card app-hop-sync-lock): every control that opens SIGN_HOST's
// screens goes through one hop() (src/shell/hop-gate.ts), and a double tap sends one open on any device speed: a second
// tap in the same tick is refused before React draws the control disabled, and so is one that lands after the shell's
// ok but before its layer takes this frame (main CI run 41862040096, FR-P2: two taps 40 ms apart sent two signin.open).
import assert from "node:assert/strict";
import { test } from "node:test";
import { SIGNPAGE_TIMEOUT_MS } from "@blindfill/kit";
import { hopGate } from "../src/shell/hop-gate.ts";
import type { HopFailure } from "../src/shell/hop-gate.ts";
import type { HopView } from "../src/shell/return-hop.ts";

const view = (control: string): HopView => ({ route: "discover", sheet: "signin", control, fields: {} });

function rig(answer: (kind: string) => unknown = () => ({ ok: true, result: { pending: true } })) {
  const sent: string[] = [];
  const locks: (string | null)[] = [];
  const fails: (HopFailure | null)[] = [];
  const timers: { ms: number; fn: () => void; live: boolean }[] = [];
  const g = hopGate({
    request: async (kind) => {
      sent.push(kind);
      return answer(kind) as never;
    },
    lock: (c) => void locks.push(c),
    fail: (f) => void fails.push(f),
    after: (ms, fn) => {
      const t = { ms, fn, live: true };
      timers.push(t);
      return () => void (t.live = false);
    },
  });
  const fire = () => {
    for (const t of timers.splice(0)) if (t.live) t.fn();
  };
  return { g, sent, locks, fails, timers, fire };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test("two taps in one tick send one hop; the second gets null", async () => {
  const r = rig();
  const a = r.g.hop("signin.open", { way: "passkey" }, view("signin-passkey"));
  const b = r.g.hop("signin.open", { way: "passkey" }, view("signin-passkey"));
  assert.equal(await b, null);
  assert.equal((await a)?.ok, true);
  assert.deepEqual(r.sent, ["signin.open"]);
});

test("FR-P2: a tap after the shell's ok, before its layer takes the frame, sends nothing", async () => {
  const r = rig();
  assert.equal((await r.g.hop("signin.open", { way: "passkey" }, view("signin-passkey")))?.ok, true);
  await tick();
  // 40 ms later the frame is still here (the shell reads its store before it opens the layer): the second tap
  assert.equal(await r.g.hop("signin.open", { way: "passkey" }, view("signin-passkey")), null);
  assert.deepEqual(r.sent, ["signin.open"]);
  assert.deepEqual(r.locks, ["signin-passkey"], "the control stays locked past the ok");
});

test("every open kind and control shares the one lock while an open is set up", async () => {
  const r = rig();
  await r.g.hop("backup.open", {}, view("acct-backup"));
  for (const [k, p, c] of [
    ["withdraw.open", {}, "deposit-withdraw"],
    ["signout", {}, "acct-signout"],
    ["export.open", { chain: "solana", address: "a" }, "export"],
    ["pool.withdraw", { chain: "solana" }, "pool-withdraw-solana"],
    ["signin.open", { way: "words" }, "signin-words"],
  ] as const) assert.equal(await r.g.hop(k, p as never, view(c)), null, k);
  assert.deepEqual(r.sent, ["backup.open"]);
});

test("no screen within the kind's window: the control unlocks with the silent line, and its Retry opens again", async () => {
  const r = rig();
  await r.g.hop("signin.open", { way: "passkey" }, view("signin-passkey"));
  assert.equal(r.timers.length, 1);
  assert.equal(r.timers[0]!.ms, SIGNPAGE_TIMEOUT_MS["signin.open"]);
  r.fire();
  assert.deepEqual(r.locks, ["signin-passkey", null]);
  const f = r.fails.at(-1)!;
  assert.deepEqual([f.control, f.why], ["signin-passkey", "silent"]);
  f.retry();
  await tick();
  assert.deepEqual(r.sent, ["signin.open", "signin.open"]);
});

test("a refusal or a failure unlocks at once with its line, no hold", async () => {
  for (const [code, why] of [["not_allowed", "refused"], ["client_timeout", "silent"], ["store_error", "error"]] as const) {
    const r = rig(() => ({ ok: false, error: { code } }));
    assert.equal((await r.g.hop("backup.open", {}, view("acct-backup")))?.ok, false);
    assert.deepEqual(r.locks, ["acct-backup", null], code);
    assert.equal(r.timers.length, 0, code);
    assert.equal(r.fails.at(-1)?.why, why, code);
    // the next tap goes
    await r.g.hop("backup.open", {}, view("acct-backup"));
    assert.equal(r.sent.length, 2, code);
  }
});

test("no client: down, shown as silent, nothing sent, unlocked", async () => {
  const fails: (HopFailure | null)[] = [];
  const locks: (string | null)[] = [];
  const g = hopGate({ request: null, lock: (c) => void locks.push(c), fail: (f) => void fails.push(f), after: () => () => {} });
  assert.equal((await g.hop("signin.open", { way: "passkey" }, view("signin-passkey")))?.ok, false);
  assert.deepEqual(locks, ["signin-passkey", null]);
  assert.equal(fails.at(-1)?.why, "silent");
});
