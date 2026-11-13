// node --test apps/terminal/test/deposit-assets.test.ts: the deposit sheet's held asset list (card app-faults-seen-on-122,
// walk of release 122 row 7): the last read is drawn at once on the next open and refreshed; a refusal never wipes a
// held list; an older answer never lands over a newer one; Retry drops only a refusal. A list is fresh for a minute
// (ASSETS_FRESH_MS): the clock below moves past it where an open must read again.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ASSETS_FRESH_MS, createAssetsStore } from "../src/screens/deposit/assets.ts";
import type { AssetsAsk } from "../src/screens/deposit/assets.ts";
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
// tab's session store with its time: at most one ask a minute, and the page is right without the store.
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
  first.warm(a.ask);
  a.pending[0]!({ ok: true, list: [A("1.01")] });
  await tick();
  t += 20_000;
  const second = createAssetsStore({ now, storage });
  assert.deepEqual(second.view().list, [A("1.01")], "the next load draws the held list at once");
  second.warm(a.ask);
  second.ask(a.ask);
  assert.equal(a.pending.length, 1, "neither the warm read nor the open asks again inside the minute");
  t += 41_000;
  const third = createAssetsStore({ now, storage });
  third.warm(a.ask);
  assert.equal(a.pending.length, 1, "a held list older than a minute: the warm read leaves it to the sheet");
  third.ask(a.ask);
  assert.equal(a.pending.length, 2, "the sheet opening on it asks again, so its minimum follows the live fees");
  assert.deepEqual(third.view().list, [A("1.01")], "and draws the held list while it asks");
});

test("warm then open asks once; the open inside the minute draws the warm read's list", async () => {
  let t = 5_000_000;
  const s = createAssetsStore({ now: () => t, storage: store() });
  const a = asker();
  s.warm(a.ask);
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
  s0.warm(a.ask);
  a.pending[0]!({ ok: false, code: "busy" });
  await tick();
  for (let i = 1; i < 10; i++) {
    t += 5_000;
    createAssetsStore({ now: () => t, storage }).warm(a.ask);
  }
  assert.equal(a.pending.length, 1, "no warm read inside the minute after an ask, whatever it answered");
  const open = createAssetsStore({ now: () => t, storage });
  open.ask(a.ask);
  assert.equal(a.pending.length, 2, "a sheet opened with no list held asks: the person asked for it");
});

test("a blocked or unreadable session store: the page is right without it", async () => {
  const a = asker();
  const s = createAssetsStore({ now: () => 1, storage: store(true) });
  s.warm(a.ask);
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
