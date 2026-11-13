// src/main.ts's wiring of the NEAR rebuild (card near-holdings-restore), read as its source: one pass at a time (a second
// ask while one runs gets the same run, a fresh one runs after it, the slot freed when it ends), on each landing only after the buy's and the sell's
// own resumes (the trades' reads go first), then the sell's home pass for a USDC-only W it rebuilt; after a restore's
// NEAR walk, the pass then the home pass. The pass's own behaviour is test/near-holdings-restore.test.ts's.
//   node --test test/near-holdings-main.test.ts      (from packages/signpage)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const src = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8").replace(/\s+/g, " ");

test("one pass at a time: the run is kept while it runs and freed when it ends, whatever its end", () => {
  assert.ok(src.includes("let nearHoldingsRun: Promise<void> | null = null;"));
  assert.match(src, /function nearHoldings\(page: NearBuyPage, fresh = false\): Promise<void> \{ if \(fresh && nearHoldingsRun !== null\) return nearHoldingsRun\.then\(\(\) => nearHoldings\(page, true\)\); return \(nearHoldingsRun \?\?= nearHoldingsPass\(page, \{ fresh \}\) .*?\.finally\(\(\) => \(nearHoldingsRun = null\)\)\); \}/);
  assert.equal(src.split("nearHoldingsPass(").length - 1, 1, "the pass is started in one place only");
});

test("on a landing: the buy's resumes, the sell's resumes, then the rebuild, then the sell's home pass", () => {
  assert.ok(src.includes("return page ? resumeNearBuys(page).then(() => resumeNearSells(page)).then(() => nearHoldings(page)).then(() => resumeNearSells(page)) : undefined;"));
});

test("after a restore's NEAR walk (a restore or a Sync): the rebuild fresh, every W one seat answer read empty read again, then the home pass, never awaited by the restore; a fresh ask during a pass runs after it", () => {
  assert.ok(src.includes("nearWalked: () => { const page = nearBuyPage(); if (page) void nearHoldings(page, true).then(() => resumeNearSells(page)).catch(() => {}); },"));
});
