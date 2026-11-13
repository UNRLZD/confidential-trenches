// node --test apps/terminal/test/deposit-assets.test.ts: the deposit sheet's held asset list (card app-faults-seen-on-122,
// walk of release 122 row 7): the last read is drawn at once on the next open and refreshed; a refusal never wipes a
// held list; an older answer never lands over a newer one; Retry drops only a refusal. A list is fresh for a minute
// (ASSETS_FRESH_MS): the clock below moves past it where an open must read again.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ASSETS_FRESH_MS, BUSY_RETRY_MS, createAssetsStore } from "../src/screens/deposit/assets.ts";
import type { AssetsAsk, AssetsTimer } from "../src/screens/deposit/assets.ts";
import type { Asset } from "../src/screens/deposit/model.ts";

const A = (min: string): Asset => ({ id: "nep141:usdc", chain: "near", symbol: "USDC", decimals: 6, min, max_usd: "1000" }) as unknown as Asset;
const tick = () => new Promise((r) => setTimeout(r, 0));
/** An ask the test answers by hand. */
function asker() {
  const pending: ((v: Awaited<ReturnType<AssetsAsk>>) => void)[] = [];
  const ask: AssetsAsk = () => new Promise((r) => pending.push(r));
  return { ask, pending };
}
/** A clock the test moves by hand. */
function clock() {
  const c = { t: 1_000_000, now: () => c.t, pass: () => void (c.t += ASSETS_FRESH_MS) };
  return c;
}

test("the first read draws nothing until it answers; the next open draws the held list at once and reads again", async () => {
  const c = clock();
  const s = createAssetsStore({ now: c.now });
  const a = asker();
  assert.deepEqual(s.view(), { list: null, refused: null });
  s.ask(a.ask);
  a.pending[0]!({ ok: true, list: [A("1.01")] });
  await tick();
  assert.deepEqual(s.view().list, [A("1.01")]);
  // a sheet opening again a minute later: the list is there before its read answers
  c.pass();
  s.ask(a.ask);
  assert.equal(a.pending.length, 2);
  assert.deepEqual(s.view().list, [A("1.01")]);
  a.pending[1]!({ ok: true, list: [A("1.02")] });
  await tick();
  assert.deepEqual(s.view().list, [A("1.02")], "the refresh follows the live minimum");
});

test("one read out at a time; a refusal or a throw keeps a held list; with none held it is the sheet's answer", async () => {
  const c = clock();
  const s = createAssetsStore({ now: c.now });
  const a = asker();
  s.ask(a.ask);
  s.ask(a.ask);
  assert.equal(a.pending.length, 1, "a second ask while one is out asks nothing");
  a.pending[0]!({ ok: false, code: "busy" });
  await tick();
  assert.deepEqual(s.view(), { list: null, refused: "busy" });
  s.retry();
  assert.deepEqual(s.view(), { list: null, refused: null }, "Retry draws the skeleton again");
  s.ask(a.ask);
  a.pending[1]!({ ok: true, list: [A("1.01")] });
  await tick();
  c.pass();
  s.ask(a.ask);
  a.pending[2]!({ ok: false, code: "down" });
  await tick();
  assert.deepEqual(s.view(), { list: [A("1.01")], refused: null });
  s.ask(() => Promise.reject(new Error("gone")));
  await tick();
  assert.deepEqual(s.view(), { list: [A("1.01")], refused: null });
});

test("subscribers hear each change", async () => {
  const c = clock();
  const s = createAssetsStore({ now: c.now });
  const a = asker();
  let n = 0;
  const off = s.subscribe(() => n++);
  s.ask(a.ask);
  a.pending[0]!({ ok: true, list: [A("1")] });
  await tick();
  assert.equal(n, 1);
  off();
  c.pass();
  s.ask(a.ask);
  a.pending[1]!({ ok: true, list: [A("2")] });
  await tick();
  assert.equal(n, 1);
});

// card app-faults-seen-on-124 (h): deposit.assets is four of a device's five 1Click calls a minute (the token list and a
// probe quote per asset, packages/signpage/src/rules/deposit-dry.ts depositAssetsKind; the helper's share,
// apps/helper/src/proxy/proxy.ts DEPOSIT_SHEET_CALLS). The shell's warm read asked it on every page load and the sheet
// asked it again on open, so a second load inside a minute met 429 on /v1/proxy/oneclick/v0/tokens. A list is held in the
// tab's session store with its time: at most one ask a minute, and the page is right without the store. Since fault 9 the
// rule the warm read had is a Deposit control's intent (assets.ts intent); no page load asks.
/** A tab's session store the test can read; `broken` throws on every call, as a blocked store does. */
function store(broken = false) {
  const m = new Map<string, string>();
  return {
    m,
    getItem: (k: string) => {
      if (broken) throw new Error("blocked");
      return m.get(k) ?? null;
    },
    setItem: (k: string, v: string) => {
      if (broken) throw new Error("blocked");
      m.set(k, v);
    },
  };
}

test("two page loads inside a minute ask deposit.assets once: the second draws the held list and asks nothing", async () => {
  let t = 1_000_000;
  const now = () => t;
  const storage = store();
  const a = asker();
  const first = createAssetsStore({ now, storage });
  first.intent(a.ask);
  a.pending[0]!({ ok: true, list: [A("1.01")] });
  await tick();
  t += 20_000;
  const second = createAssetsStore({ now, storage });
  assert.deepEqual(second.view().list, [A("1.01")], "the next load draws the held list at once");
  second.intent(a.ask);
  second.ask(a.ask);
  assert.equal(a.pending.length, 1, "neither an intent nor the open asks again inside the minute");
  t += 41_000;
  const third = createAssetsStore({ now, storage });
  third.intent(a.ask);
  assert.equal(a.pending.length, 1, "a held list older than a minute: an intent leaves it to the sheet");
  third.ask(a.ask);
  assert.equal(a.pending.length, 2, "the sheet opening on it asks again, so its minimum follows the live fees");
  assert.deepEqual(third.view().list, [A("1.01")], "and draws the held list while it asks");
});

test("intent then open asks once; the open inside the minute draws the intent's list", async () => {
  let t = 5_000_000;
  const s = createAssetsStore({ now: () => t, storage: store() });
  const a = asker();
  s.intent(a.ask);
  a.pending[0]!({ ok: true, list: [A("1.01")] });
  await tick();
  t += 59_000;
  s.ask(a.ask);
  assert.equal(a.pending.length, 1);
  assert.deepEqual(s.view().list, [A("1.01")]);
});

test("ten page loads in a minute ask once, even when the first ask was refused", async () => {
  let t = 9_000_000;
  const storage = store();
  const a = asker();
  const s0 = createAssetsStore({ now: () => t, storage });
  s0.intent(a.ask);
  a.pending[0]!({ ok: false, code: "busy" });
  await tick();
  for (let i = 1; i < 10; i++) {
    t += 5_000;
    createAssetsStore({ now: () => t, storage }).intent(a.ask);
  }
  assert.equal(a.pending.length, 1, "no intent asks inside the minute after an ask, whatever it answered");
  const open = createAssetsStore({ now: () => t, storage });
  open.ask(a.ask);
  assert.equal(a.pending.length, 2, "a sheet opened with no list held asks: the person asked for it");
});

test("a blocked or unreadable session store: the page is right without it", async () => {
  const a = asker();
  const s = createAssetsStore({ now: () => 1, storage: store(true) });
  s.intent(a.ask);
  a.pending[0]!({ ok: true, list: [A("1.01")] });
  await tick();
  assert.deepEqual(s.view().list, [A("1.01")]);
  s.ask(a.ask);
  assert.equal(a.pending.length, 1, "the list held in memory still counts");
  const junk = store();
  junk.m.set("ct.deposit.assets", "{not json");
  const b = createAssetsStore({ now: () => 1, storage: junk });
  assert.deepEqual(b.view(), { list: null, refused: null });
  junk.m.set("ct.deposit.assets", JSON.stringify({ at: 0, asked: 0, list: [{ id: 3 }] }));
  assert.deepEqual(createAssetsStore({ now: () => 1, storage: junk }).view(), { list: null, refused: null }, "a list not of assets is dropped");
});

// card app-faults-seen-on-124, fault 9: no page load asks the list; a Deposit control's intent asks it once, the sheet's
// opening is the fallback, and a busy answer (the helper's 429) while the sheet is open is asked once more by itself at
// BUSY_RETRY_MS, then the busy state and its Retry stand; closing the sheet or signing out stops that ask. The timer is a
// stand-in the test fires: no real time passes.
/** A timer the test fires by hand. */
function timers() {
  const set: { fn: () => void; ms: number; cleared: boolean }[] = [];
  const timer: AssetsTimer = {
    set: (fn, ms) => set.push({ fn, ms, cleared: false }) - 1,
    clear: (h) => void (set[h as number]!.cleared = true),
  };
  const live = () => set.filter((x) => !x.cleared && x.fn !== noop);
  const fire = (i: number) => {
    const x = set[i]!;
    assert.equal(x.cleared, false, "a cleared timer never fires");
    const fn = x.fn;
    x.fn = noop;
    fn();
  };
  return { set, timer, live, fire };
}
const noop = () => {};

test("intent on a control starts exactly one ask, however often it comes; the sheet then opens on that ask", async () => {
  const s = createAssetsStore({ now: () => 7_000_000 });
  const a = asker();
  s.intent(a.ask); // pointerenter
  s.intent(a.ask); // focus
  s.intent(a.ask); // pointerdown
  assert.equal(a.pending.length, 1);
  s.ask(a.ask); // the sheet opens while the intent's ask is out
  assert.equal(a.pending.length, 1, "the open joins the ask out");
  a.pending[0]!({ ok: true, list: [A("1.01")] });
  await tick();
  assert.deepEqual(s.view(), { list: [A("1.01")], refused: null });
});

test("open with no list held draws the loading state, then the list", async () => {
  const s = createAssetsStore({ now: () => 7_500_000 });
  const a = asker();
  s.ask(a.ask);
  assert.deepEqual(s.view(), { list: null, refused: null }, "loading: no list, no refusal");
  a.pending[0]!({ ok: true, list: [A("1.01")] });
  await tick();
  assert.deepEqual(s.view(), { list: [A("1.01")], refused: null });
});

test("a busy answer while the sheet is open is asked once more by itself at BUSY_RETRY_MS, then the busy state stands", async () => {
  assert.equal(BUSY_RETRY_MS, 10_000);
  let t = 8_000_000;
  const T = timers();
  const s = createAssetsStore({ now: () => t, timer: T.timer });
  const a = asker();
  s.ask(a.ask);
  a.pending[0]!({ ok: false, code: "busy" });
  await tick();
  assert.deepEqual(s.view(), { list: null, refused: "busy" });
  assert.deepEqual(T.live().map((x) => x.ms), [BUSY_RETRY_MS], "one ask waits, at the bound");
  assert.equal(a.pending.length, 1, "nothing asked before the bound");
  t += BUSY_RETRY_MS;
  T.fire(0);
  assert.equal(a.pending.length, 2, "the one automatic ask");
  a.pending[1]!({ ok: false, code: "busy" });
  await tick();
  assert.equal(T.live().length, 0, "busy again: no second automatic ask");
  assert.deepEqual(s.view(), { list: null, refused: "busy" }, "the busy state and its Retry stand");
  // Retry asks at once, the person's own ask
  s.retry();
  s.ask(a.ask);
  assert.equal(a.pending.length, 3);
});

test("Retry while the automatic ask waits asks at once, in its place: one ask, not two", async () => {
  const T = timers();
  const s = createAssetsStore({ now: () => 8_500_000, timer: T.timer });
  const a = asker();
  s.ask(a.ask);
  a.pending[0]!({ ok: false, code: "busy" });
  await tick();
  assert.equal(T.live().length, 1);
  s.retry();
  s.ask(a.ask);
  assert.equal(a.pending.length, 2, "Retry asks at once");
  assert.equal(T.live().length, 0, "and the waiting ask is cleared");
});

test("the automatic ask stops when the sheet closes or the account signs out, and none is made with the sheet closed", async () => {
  let t = 9_500_000;
  const T = timers();
  const s = createAssetsStore({ now: () => t, timer: T.timer });
  const a = asker();
  s.ask(a.ask);
  a.pending[0]!({ ok: false, code: "busy" });
  await tick();
  assert.equal(T.live().length, 1);
  s.stop(); // the sheet closed, or signed out
  assert.equal(T.live().length, 0, "its wait is cleared");
  assert.equal(T.set[0]!.cleared, true);
  t += BUSY_RETRY_MS;
  assert.equal(a.pending.length, 1, "nothing asked after close");
  // an intent's busy answer with no sheet open waits for nothing
  const s2 = createAssetsStore({ now: () => t, timer: T.timer });
  s2.intent(a.ask);
  a.pending[1]!({ ok: false, code: "busy" });
  await tick();
  assert.equal(T.live().length, 0, "no sheet open: no automatic ask");
  // the sheet opening after that busy answer asks (no list held), and its own busy answer gets the one automatic ask
  s2.ask(a.ask);
  assert.equal(a.pending.length, 3);
  a.pending[2]!({ ok: false, code: "busy" });
  await tick();
  assert.deepEqual(T.live().map((x) => x.ms), [BUSY_RETRY_MS]);
});
