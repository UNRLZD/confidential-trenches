// node --test apps/terminal/test/deposit-assets.test.ts: the deposit sheet's held asset list (card app-faults-seen-on-122,
// walk of release 122 row 7): the last read is drawn at once on the next open and refreshed; a refusal never wipes a
// held list; an older answer never lands over a newer one; Retry drops only a refusal.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createAssetsStore } from "../src/screens/deposit/assets.ts";
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

test("the first read draws nothing until it answers; the next open draws the held list at once and reads again", async () => {
  const s = createAssetsStore();
  const a = asker();
  assert.deepEqual(s.view(), { list: null, refused: null });
  s.ask(a.ask);
  a.pending[0]!({ ok: true, list: [A("1.01")] });
  await tick();
  assert.deepEqual(s.view().list, [A("1.01")]);
  // a sheet opening again: the list is there before its read answers
  s.ask(a.ask);
  assert.equal(a.pending.length, 2);
  assert.deepEqual(s.view().list, [A("1.01")]);
  a.pending[1]!({ ok: true, list: [A("1.02")] });
  await tick();
  assert.deepEqual(s.view().list, [A("1.02")], "the refresh follows the live minimum");
});

test("one read out at a time; a refusal or a throw keeps a held list; with none held it is the sheet's answer", async () => {
  const s = createAssetsStore();
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
  s.ask(a.ask);
  a.pending[2]!({ ok: false, code: "down" });
  await tick();
  assert.deepEqual(s.view(), { list: [A("1.01")], refused: null });
  s.ask(() => Promise.reject(new Error("gone")));
  await tick();
  assert.deepEqual(s.view(), { list: [A("1.01")], refused: null });
});

test("subscribers hear each change", async () => {
  const s = createAssetsStore();
  const a = asker();
  let n = 0;
  const off = s.subscribe(() => n++);
  s.ask(a.ask);
  a.pending[0]!({ ok: true, list: [A("1")] });
  await tick();
  assert.equal(n, 1);
  off();
  s.ask(a.ask);
  a.pending[1]!({ ok: true, list: [A("2")] });
  await tick();
  assert.equal(n, 1);
});
