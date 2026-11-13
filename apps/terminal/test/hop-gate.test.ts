// node --test apps/terminal/test/hop-gate.test.ts (card app-hop-sync-lock): every control that opens SIGN_HOST's
// screens goes through one hop() (src/shell/hop-gate.ts), and a double tap sends one open on any device speed: a second
// tap in the same tick is refused before React draws the control disabled, and so is one that lands after the shell's
// ok but before its layer takes this frame (main CI run 41862040096, FR-P2: two taps 40 ms apart sent two signin.open).
// Card app-lock-holds-until-the-layer-closes: with a page that says when its layer closes (an ok with `closes`, kit 1.13),
// the lock holds past this frame's blur, until that open's closed notice (merge-queue run 43344446268: a tap after the
// blur, before SIGN_HOST's next rendering, sent a second signin.open), and never past its bound.
import assert from "node:assert/strict";
import { test } from "node:test";
import { SIGNPAGE_TIMEOUT_MS } from "@blindfill/kit";
import { hopGate } from "../src/shell/hop-gate.ts";
import type { HopFailure } from "../src/shell/hop-gate.ts";
import type { HopView } from "../src/shell/return-hop.ts";

const view = (control: string): HopView => ({ route: "discover", sheet: "signin", control, fields: {} });

const CLOSES = () => ({ ok: true, result: { pending: true, closes: true } });

function rig(answer: (kind: string) => unknown = () => ({ ok: true, result: { pending: true } })) {
  const sent: string[] = [];
  const locks: (string | null)[] = [];
  const fails: (HopFailure | null)[] = [];
  const timers: { ms: number; fn: () => void; live: boolean }[] = [];
  const takers: { fn: () => void; live: boolean }[] = [];
  // the kit client's onClosed: a listener only for an id whose ok carried `closes`, as the kit keeps them
  const closing = new Map<string, boolean>();
  const notices: { id: string; fn: () => void; live: boolean }[] = [];
  const backs: { fn: () => void; live: boolean }[] = [];
  const g = hopGate({
    request: (kind) => {
      sent.push(kind);
      const id = `op-${sent.length}`;
      const o = answer(kind) as { ok: boolean; result?: { closes?: boolean } };
      if (o.ok && o.result?.closes === true) closing.set(id, true);
      const outcome = Promise.resolve(o);
      // a thenable too, so the same rig drives a gate that awaits the request itself (main's before this card: the red run)
      return { id, outcome, then: (a: (v: unknown) => unknown, b?: (e: unknown) => unknown) => outcome.then(a, b) } as never;
    },
    lock: (c) => void locks.push(c),
    fail: (f) => void fails.push(f),
    after: (ms, fn) => {
      const t = { ms, fn, live: true };
      timers.push(t);
      return () => void (t.live = false);
    },
    taken: (fn) => {
      const t = { fn, live: true };
      takers.push(t);
      return () => void (t.live = false);
    },
    closed: (id, fn) => {
      if (!closing.has(id)) return null;
      const t = { id, fn, live: true };
      notices.push(t);
      return () => void (t.live = false);
    },
    returned: (fn) => {
      const t = { fn, live: true };
      backs.push(t);
      return () => void (t.live = false);
    },
  });
  const fire = () => {
    for (const t of timers.splice(0)) if (t.live) t.fn();
  };
  const take = () => {
    for (const t of takers.splice(0)) if (t.live) t.fn();
  };
  // SIGN_HOST's closed notice for `id`, once
  const notify = (id: string) => {
    for (const t of notices.filter((n) => n.id === id)) {
      if (!t.live) continue;
      t.live = false;
      t.fn();
    }
  };
  // this frame's window takes the focus again
  const back = () => {
    for (const t of backs.splice(0)) if (t.live) t.fn();
  };
  const live = () => timers.filter((t) => t.live).length + backs.filter((t) => t.live).length + notices.filter((t) => t.live).length;
  return { g, sent, locks, fails, timers, fire, take, notify, back, live };
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
  const g = hopGate({ request: null, lock: (c) => void locks.push(c), fail: (f) => void fails.push(f), after: () => () => {}, taken: () => () => {}, closed: () => null, returned: () => () => {} });
  assert.equal((await g.hop("signin.open", { way: "passkey" }, view("signin-passkey")))?.ok, false);
  assert.deepEqual(locks, ["signin-passkey", null]);
  assert.equal(fails.at(-1)?.why, "silent");
});

test("the sheet takes this frame's focus: the control unlocks with no line, the window's timer cancelled, and the next open goes (card signing-views-open-over-the-app)", async () => {
  const r = rig();
  assert.equal((await r.g.hop("signin.open", { way: "passkey" }, view("signin-passkey")))?.ok, true);
  assert.deepEqual(r.locks, ["signin-passkey"]);
  r.take();
  assert.deepEqual(r.locks, ["signin-passkey", null], "unlocked once the sheet took the focus");
  r.fire();
  assert.deepEqual(r.fails, [null], "no silent line: the window's timer was cancelled");
  // the sheet closed, the frame kept: the next tap opens again
  assert.equal((await r.g.hop("backup.open", {}, view("acct-backup")))?.ok, true);
  assert.deepEqual(r.sent, ["signin.open", "backup.open"]);
});

test("no focus taken within the kind's window: the silent line, and a late blur changes nothing", async () => {
  const r = rig();
  await r.g.hop("withdraw.open", {}, view("acct-withdraw"));
  r.fire();
  assert.equal(r.fails.at(-1)?.why, "silent");
  const n = r.locks.length;
  r.take();
  assert.equal(r.locks.length, n, "the blur listener was removed with the timer");
});

// ------------------------------------------------------------------------- a page that says when its layer closes

test("a second tap inside the window sends one open: the blur does not lift the lock, the closed notice does", async () => {
  const r = rig(CLOSES);
  assert.equal((await r.g.hop("signin.open", { way: "passkey" }, view("signin-passkey")))?.ok, true);
  // SIGN_HOST's sheet takes the focus, and the frame still takes a tap until SIGN_HOST's next rendering
  r.take();
  await tick();
  assert.equal(await r.g.hop("signin.open", { way: "passkey" }, view("signin-passkey")), null, "the second tap");
  assert.deepEqual(r.sent, ["signin.open"]);
  assert.deepEqual(r.locks, ["signin-passkey"], "still locked after the blur");
  r.notify("op-1");
  assert.deepEqual(r.locks, ["signin-passkey", null], "unlocked at the notice");
  assert.deepEqual(r.fails, [null], "no line");
  assert.equal(r.live(), 0, "nothing left listening, no timer");
  assert.equal((await r.g.hop("backup.open", {}, view("acct-backup")))?.ok, true, "the next open goes");
});

test("the notice for another open's id does not lift this lock", async () => {
  const r = rig(CLOSES);
  await r.g.hop("signin.open", { way: "passkey" }, view("signin-passkey"));
  r.take();
  r.notify("op-0");
  r.notify("another");
  assert.deepEqual(r.locks, ["signin-passkey"]);
  assert.equal(await r.g.hop("signin.open", { way: "passkey" }, view("signin-passkey")), null);
  r.notify("op-1");
  assert.deepEqual(r.locks, ["signin-passkey", null]);
});

test("an ok with no closes (a page before kit 1.13) keeps the blur rule: no notice is listened for", async () => {
  const r = rig();
  await r.g.hop("signin.open", { way: "passkey" }, view("signin-passkey"));
  r.take();
  assert.deepEqual(r.locks, ["signin-passkey", null], "unlocked at the blur");
  assert.equal(r.live(), 0);
  // a refusal has no closes either: unlocked at once with its line (above), nothing listened for
  const n = rig(() => ({ ok: false, error: { code: "not_allowed" } }));
  await n.g.hop("signin.open", { way: "passkey" }, view("signin-passkey"));
  assert.deepEqual(n.locks, ["signin-passkey", null]);
  assert.equal(n.fails.at(-1)?.why, "refused");
  assert.equal(n.live(), 0);
});

test("the lock lifts on the notice even if the blur never fired (no layer shown: signed in already)", async () => {
  const r = rig(CLOSES);
  await r.g.hop("signin.open", { way: "passkey" }, view("signin-passkey"));
  r.notify("op-1");
  assert.deepEqual(r.locks, ["signin-passkey", null]);
  assert.deepEqual(r.fails, [null]);
  r.fire();
  r.take();
  assert.deepEqual(r.locks, ["signin-passkey", null], "the window and the blur were let go with it");
  assert.deepEqual(r.fails, [null]);
});

test("a lock never outlives its bound: no screen within the kind's window, the silent line and its Retry", async () => {
  const r = rig(CLOSES);
  await r.g.hop("withdraw.open", {}, view("acct-withdraw"));
  assert.equal(r.timers.length, 1);
  assert.equal(r.timers[0]!.ms, SIGNPAGE_TIMEOUT_MS["withdraw.open"]);
  r.fire();
  assert.deepEqual(r.locks, ["acct-withdraw", null]);
  assert.equal(r.fails.at(-1)?.why, "silent");
  assert.equal(r.live(), 0, "a late notice or blur changes nothing");
  r.notify("op-1");
  r.take();
  assert.deepEqual(r.locks, ["acct-withdraw", null]);
});

test("a lock never outlives its bound: a screen came and its notice never does, it lifts at this frame's next focus past the window", async () => {
  const r = rig(CLOSES);
  await r.g.hop("signin.open", { way: "passkey" }, view("signin-passkey"));
  r.take();
  // the layer is up: the frame is inert under it, the lock holds with no line however long it stays
  assert.deepEqual(r.timers.filter((t) => t.live).map((t) => t.ms), [SIGNPAGE_TIMEOUT_MS["signin.open"]], "the window, from the blur");
  r.back();
  assert.deepEqual(r.locks, ["signin-passkey"], "a focus inside the window (a tap before SIGN_HOST's next rendering) lifts nothing");
  r.fire();
  assert.deepEqual(r.locks, ["signin-passkey"], "the window passing alone lifts nothing: the layer may be up");
  assert.deepEqual(r.fails, [null]);
  // the page closed its layer and gave this frame the focus back, with no notice (a page that crashed)
  r.back();
  assert.deepEqual(r.locks, ["signin-passkey", null], "unlocked at the frame's focus");
  assert.deepEqual(r.fails, [null], "no line");
  assert.equal(r.live(), 0);
  r.notify("op-1");
  assert.deepEqual(r.locks, ["signin-passkey", null], "a late notice changes nothing");
});

test("stop lets every listener go: the notice, the window and the focus", async () => {
  const r = rig(CLOSES);
  await r.g.hop("signin.open", { way: "passkey" }, view("signin-passkey"));
  r.take();
  r.fire();
  r.g.stop();
  assert.equal(r.live(), 0);
});
