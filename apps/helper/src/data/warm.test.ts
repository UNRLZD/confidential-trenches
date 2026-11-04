// node --test apps/helper/src/data/warm.test.ts (card helper-restart-fresh): the warm file carries the old helper's
// GeckoTerminal calls with their lists lane, and the next helper seeds them once however often it reads the file (at its
// start and again at the handover, warm.ts seedGecko), so a token page read straight after a swap finds its calls.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { geckoBudget } from "./gecko.ts";
import * as W from "./warm.ts";

test("the old helper's calls go through the file with their lists lane, and the next helper's urgent lists stay within the floor they spent: a cold page finds its two calls", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "warm-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let now = 1_800_000_000_000;
  const old = geckoBudget(() => now);
  assert.equal(old.take("lists", true), true);
  now += 5_000;
  assert.equal(old.take("lists", true), true);
  now += 5_000;
  assert.equal(old.take("pages"), true);
  W.writeWarm(dir, { at: now, gecko: old.calls(), geckoLists: old.calls("lists"), evm: {} } as W.Warm);
  const next = geckoBudget(() => now);
  assert.equal(typeof (W as Record<string, unknown>).seedGecko, "function", "warm.ts seedGecko");
  const seed = (W as unknown as { seedGecko: (b: unknown, w: unknown) => void }).seedGecko;
  seed(next, W.readWarm(dir, now));
  seed(next, W.readWarm(dir, now)); // read again at the handover
  assert.deepEqual(next.calls(), old.calls(), "the old helper's three calls, once");
  assert.equal(next.take("lists", true), false, "the lists' floor is spent by the old helper's lists");
  assert.equal(next.take("pages"), true);
  assert.equal(next.take("pages"), true, "a cold page's top pool and its bars");
});

test("the file's lists calls are hostile input: only finite times, at most 64, and a file without them (the helper before this card) seeds every call with no lane", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "warm-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const now = 1_800_000_000_000;
  W.writeWarm(dir, { at: now, gecko: [now - 2_000, now - 1_000], geckoLists: ["x", null, Infinity, now - 2_000], evm: {} } as unknown as W.Warm);
  const w = W.readWarm(dir, now) as W.Warm & { geckoLists?: number[] };
  assert.deepEqual(w.geckoLists, [now - 2_000]);
  W.writeWarm(dir, { at: now, gecko: [now - 2_000, now - 1_000], evm: {} });
  const b = geckoBudget(() => now);
  (W as unknown as { seedGecko: (b: unknown, w: unknown) => void }).seedGecko(b, W.readWarm(dir, now));
  assert.deepEqual([b.calls(), b.calls("lists")], [[now - 2_000, now - 1_000], []]);
});
