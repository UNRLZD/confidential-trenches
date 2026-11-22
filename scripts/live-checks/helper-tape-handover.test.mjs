// node --test scripts/live-checks/helper-tape-handover.test.mjs: the live check replays its runs
// (helper-tape-handover.answers.json, from the helper's code on the recorded Base hour, see its `about`). good: a helper
// restored from the old one's books answers every row at its first read, each answer marked handed over: PASS. bad
// (planted, card helper-tape-handover-judges-handed-books): a book marked handed over whose first answer is 0 rows, 50 a
// read later: FAIL. cold: the same short answer unmarked on a helper whose warm file held no books: PASS, the coin named.
// Planted on the cold run's answers: the file held books and none were restored: FAIL; books restored but no coin read
// answered as handed: FAIL; a helper naming no handover counts: INCONCLUSIVE. Made from them: a mark and the counts are
// read only as the helper writes them; rows newer than a first answer's newest are not judged; a first answer of 50 rows
// misses none below its oldest; a chain with no coin read FAILs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CHAINS, COINS_MAX, handedOf, handoverOf, judge, missed, read, RESTART_MS } from "./helper-tape-handover.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "helper-tape-handover.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const BASE = ["base"];

test("recorded good run: a restored helper 120 s old answers every row of its span at the first read, marked handed over: PASS", () => {
  const r = judge(A.good.run, BASE);
  assert.equal(r.verdict, "PASS", r.lines.join("\n"));
  // the start, the counts, the handed coins read, and each coin's span
  assert.equal(r.lines.filter((l) => l.startsWith("GOOD")).length, 3 + A.good.run.chains.base.tapes.length, r.lines.join("\n"));
  assert.ok(r.lines.includes("GOOD [base] the warm file held 2 books, 2 restored"), r.lines.join("\n"));
  assert.ok(r.lines.includes("GOOD [base] 2 book(s) were handed over and 2 of the 2 coin(s) read answered as handed"), r.lines.join("\n"));
});

test("recorded bad run (planted): a book marked handed over answers ICNT 0 rows at its first read and 50 a read later: FAIL", () => {
  const r = judge(A.bad.run, BASE);
  assert.equal(r.verdict, "FAIL", r.lines.join("\n"));
  assert.equal(bad(r).length, 1, r.lines.join("\n"));
  assert.match(bad(r)[0], /^BAD \[base 0xe0cd4cacddcbf4f36e845407ce53e87717b6601d\] handed over, first answer 0 rows \(filling\), last 50 rows .*: 50 row\(s\) at or below its first answer's span filled in after it on a helper 120 s old/);
  // a handed book's short answer is judged on a warm helper too: the mark, not the helper's age, says the book was handed
  const warm = structuredClone(A.bad.run);
  warm.health.started = String(warm.health.at - RESTART_MS);
  assert.equal(judge(warm, BASE).verdict, "FAIL");
});

test("recorded cold run: the warm file held no books (held 0), and the same short ICNT answer with no handover mark PASSes, the coin named, not judged", () => {
  const r = judge(A.cold.run, BASE);
  assert.equal(r.verdict, "PASS", r.lines.join("\n"));
  assert.deepEqual(bad(r), []);
  assert.ok(r.lines.includes("--  [base] the warm file held no books (the old helper wrote none): its coins open cold, named, not judged"), r.lines.join("\n"));
  const named = r.lines.filter((l) => l.startsWith("--  [base "));
  assert.equal(named.length, 1, r.lines.join("\n"));
  assert.match(named[0], /^--  \[base 0xe0cd4cacddcbf4f36e845407ce53e87717b6601d\] cold, first answer 0 rows \(filling\), last 50 rows .*: 50 row\(s\) filled in after its first answer; its book was not handed over \(it opened cold\), so it is named, not judged$/);
});

const counts = (run, v) => ((run = structuredClone(run)), (run.health.handover = v), run);

test("planted: a young helper whose warm file held 2 Base books and restored none FAILs, its cold coins with it", () => {
  const r = judge(counts(A.cold.run, "base books held 2 restored 0, robinhood books held 0 restored 0, solana tapes held 0 restored 0"), BASE);
  assert.equal(r.verdict, "FAIL", r.lines.join("\n"));
  assert.ok(bad(r).includes("BAD [base] the warm file held 2 books, 0 restored"), r.lines.join("\n"));
  const tapes = judge(counts(A.cold.run, "base books held 0 restored 0, robinhood books held 0 restored 0, solana tapes held 3 restored 2"), BASE);
  assert.ok(bad(tapes).includes("BAD [solana] the warm file held 3 tapes, 2 restored"), "the Solana tapes are held to it too");
});

test("planted: a young helper that restored 2 Base books while no coin read answered as handed FAILs", () => {
  const r = judge(counts(A.cold.run, "base books held 2 restored 2, robinhood books held 0 restored 0, solana tapes held 0 restored 0"), BASE);
  assert.equal(r.verdict, "FAIL", r.lines.join("\n"));
  assert.ok(bad(r).includes("BAD [base] 2 book(s) were handed over and 0 of the 2 coin(s) read answered as handed"), r.lines.join("\n"));
  // the counts bind a young helper only: past RESTART_MS they are named
  const warm = counts(A.cold.run, "base books held 2 restored 0, robinhood books held 0 restored 0, solana tapes held 0 restored 0");
  warm.health.started = String(warm.health.at - RESTART_MS);
  assert.equal(judge(warm, BASE).verdict, "PASS", judge(warm, BASE).lines.join("\n"));
});

test("a young helper that names no handover counts (one before the card) with a cold coin is INCONCLUSIVE; a header that is not counts, or no count for a chain read, FAILs", () => {
  assert.equal(judge(counts(A.cold.run, null), BASE).verdict, "INCONCLUSIVE");
  assert.equal(judge(counts(A.good.run, null), BASE).verdict, "PASS", "every coin answered as handed: nothing unknown");
  assert.equal(judge(counts(A.cold.run, "base books held two"), BASE).verdict, "FAIL");
  assert.equal(judge(counts(A.cold.run, "robinhood books held 0 restored 0"), BASE).verdict, "FAIL");
  assert.equal(judge(counts(A.cold.run, ""), BASE).verdict, "FAIL", "a helper with no market parts names none");
});

test("the handover counts are read only as the helper writes them, bounded", () => {
  const helper = readFileSync(path.join(HERE, "../../apps/helper/src/server.ts"), "utf8");
  assert.match(helper, /export const HANDOVER_HEADER = "X-Helper-Handover";/);
  assert.match(helper, /named\.push\(`\$\{chain\} \$\{chain === "solana" \? "tapes" : "books"\} held \$\{h\.held\} restored \$\{h\.restored\}`\)/);
  assert.deepEqual(handoverOf("base books held 3 restored 3, robinhood books held 2 restored 1, solana tapes held 0 restored 0"), { base: { held: 3, restored: 3 }, robinhood: { held: 2, restored: 1 }, solana: { held: 0, restored: 0 } });
  assert.deepEqual(handoverOf(""), {});
  for (const v of [null, undefined, 7, "base books held 3", "base tapes held 1 restored 1", "solana books held 1 restored 1", "base books held 01 restored 1", "base books held 1 restored 1, base books held 1 restored 1", "near books held 1 restored 1", `base books held 1 restored 1, ${"x".repeat(500)}`]) {
    assert.equal(handoverOf(v), null, String(v).slice(0, 60));
  }
});

test("the mark is read only as the helper writes it: its own Server-Timing part, the helper's own words, bounded", () => {
  const helper = readFileSync(path.join(HERE, "../../apps/helper/src/data/evm/swaps.ts"), "utf8");
  const written = /export const HANDED_TIMING = '([^']+)';/.exec(helper)?.[1];
  assert.equal(written, 'evm-handed;desc="book from the handover"', "the helper's mark, as this check reads it");
  assert.equal(handedOf({ timing: `evm-open;dur=1, ${written}` }), true);
  assert.equal(handedOf({ timing: written }), true);
  for (const timing of [undefined, null, 7, "", "evm-open;dur=1", 'evm-read-to;desc="evm-handed;"', "xevm-handed;desc=1", `evm-open;desc="${"a".repeat(2_000)}", ${written}`]) {
    assert.equal(handedOf({ timing }), false, String(timing).slice(0, 60));
  }
});

test("rows newer than the first answer's newest (the blocks since a rested book) are not judged; rows inside its span are", () => {
  const first = { rows: [["a", 100], ["b", 90]] };
  assert.deepEqual(missed(first, { rows: [["n", 110], ["a", 100], ["b", 90]] }), []);
  assert.deepEqual(missed(first, { rows: [["a", 100], ["x", 95], ["b", 90], ["y", 80]] }), [["x", 95], ["y", 80]], "under 50 rows: below its oldest is judged too");
  const full = { rows: Array.from({ length: 50 }, (_, i) => [`t${i}`, 1_000 - i]) };
  assert.deepEqual(missed(full, { rows: [["new", 2_000], ...full.rows.slice(0, 49)] }), [], "50 rows: older ones pushed out by newer are not missed");
});

test("a chain with no coin read, or a first read that is no 200, FAILs; the live run reads every chain", () => {
  assert.deepEqual(CHAINS, ["base", "robinhood"]);
  assert.equal(judge(A.good.run).verdict, "FAIL", "robinhood unread");
  const run = structuredClone(A.good.run);
  run.chains.base.tapes[0].first = { ...run.chains.base.tapes[0].first, status: 503, rows: null };
  assert.equal(judge(run, BASE).verdict, "FAIL");
});

test("read: past its first 3 coins a chain reads on, up to COINS_MAX, only while its books were restored and no coin read answered as handed", async () => {
  const coin = (i) => `0x${String(i).padStart(40, "0")}`;
  const fake = (handover, markedFrom) => async (url) => {
    const u = new URL(url);
    const head = (h) => ({ get: (k) => h[k.toLowerCase()] ?? null });
    if (u.pathname === "/v1/health") return { status: 200, headers: head({ "x-helper-started": "1", "x-helper-handover": handover }), text: async () => JSON.stringify({ commit: "rig" }) };
    if (u.pathname === "/v1/market/lists") return { status: 200, headers: head({}), text: async () => JSON.stringify({ lists: { hot: Array.from({ length: 10 }, (_, i) => ({ token: coin(i) })) } }) };
    const i = Number(BigInt(u.searchParams.get("token")));
    const timing = i >= markedFrom ? 'evm-read-to;desc="x", evm-handed;desc="book from the handover"' : 'evm-read-to;desc="x"';
    return { status: 200, headers: head({ "server-timing": timing }), text: async () => JSON.stringify({ trades: [{ tx: "0x1", t_ms: 1 }], src: "chain" }) };
  };
  const n = async (handover, markedFrom) => Object.fromEntries(Object.entries((await read("https://h.test", fake(handover, markedFrom))).chains).map(([c, v]) => [c, v.tapes.length]));
  const all = "base books held 2 restored 2, robinhood books held 0 restored 0, solana tapes held 0 restored 0";
  assert.deepEqual(await n(all, 99), { base: COINS_MAX, robinhood: 3 }, "base restored books, none answered as handed: read on");
  assert.deepEqual(await n(all, 4), { base: 5, robinhood: 3 }, "the fifth coin answered as handed: stop");
  assert.deepEqual(await n(all, 0), { base: 3, robinhood: 3 });
  assert.deepEqual(await n(null, 99), { base: 3, robinhood: 3 }, "no counts: the first 3");
});
