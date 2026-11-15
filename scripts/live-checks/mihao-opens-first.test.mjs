// node --test scripts/live-checks/mihao-opens-first.test.mjs: the live check replays its recorded answers
// (mihao-opens-first.answers.json, read 15 Nov 00:5xZ). good: this card's build (apps/terminal/dist), / on All opening
// mihao, its PumpSwap pool read on two mainnet RPCs: PASS. liveBefore: APP_HOST before this card's deploy (release 146),
// / opening NEARKAT, which has no venue the private buy fills (both providers: an account is missing): FAIL, both named.
// Planted on the good one: another script, no pin, each mark taken away, the venue gone or read for another coin: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { bundle, facts, judge, MIHAO, read } from "./mihao-opens-first.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./mihao-opens-first.answers.json", import.meta.url), "utf8"));
const NEARKAT = "6UtY9iTZMQQ5QZVrbzFnNaJntV7oySm9k97mvwnuZcxr";
const NO_OPEN = `BAD the app names no token for / to open: mihao (${MIHAO}) is not in it`;
const NO_HOME = "BAD / on All does not open mihao: it opens the top Trending token";
const NO_VENUE = (mint, why) => `BAD the token / opens (${mint}) has no venue the private buy fills: ${why}`;

test("recorded good answer: this card's build, / on All opening mihao on its PumpSwap pool: PASS", () => {
  assert.deepEqual(judge(ANSWERS.good), { ok: true, lines: [] });
  assert.deepEqual(ANSWERS.good.venue, { mint: MIHAO, kind: "pumpswap", at: "Ho1aSG6WGH1FfXdEHrK2f4Ggt1Hoxo9s5jcLMDqeyeBz" });
});

test("recorded bad answer liveBefore: APP_HOST before this card, / on All opening NEARKAT with no venue: FAIL, both named", () => {
  assert.deepEqual(judge(ANSWERS.liveBefore), { ok: false, lines: [NO_OPEN, NO_VENUE(NEARKAT, "an account is missing")] });
});

test("planted on the good answer: each fact taken away FAILs", () => {
  const g = ANSWERS.good;
  assert.deepEqual(judge({ ...g, app: { ...g.app, sha384: "sha384-other" } }).lines, ["BAD APP_HOST's served script is not the one index.html pins"]);
  assert.deepEqual(judge({ ...g, app: { ...g.app, index: "<html></html>" } }).lines, ["BAD APP_HOST's index.html pins no script"]);
  assert.deepEqual(judge({ ...g, app: { ...g.app, open: false } }).lines, [NO_OPEN]);
  assert.deepEqual(judge({ ...g, app: { ...g.app, home: false } }).lines, [NO_HOME]);
  // mihao's pool gone (its accounts missing on both providers), or no venue read at all
  assert.deepEqual(judge({ ...g, venue: { mint: MIHAO, error: "an account is missing" } }).lines, [NO_VENUE(MIHAO, "an account is missing")]);
  assert.deepEqual(judge({ ...g, venue: null }).lines, ["BAD no venue read for the token / opens"]);
  assert.deepEqual(judge({ ...g, venue: { ...g.venue, kind: "meteora-dlmm" } }).lines, [NO_VENUE(MIHAO, "meteora-dlmm")]);
  // a venue read for another coin than the one / opens is no proof of it
  assert.deepEqual(judge({ ...g, venue: { ...g.venue, mint: NEARKAT } }).lines, [`BAD the venue read is ${NEARKAT}'s, not the token / opens`]);
  assert.equal(judge(null).ok, false);
});

test("the facts read from the script: the token object, / on All reading that same object, and the mint it reads", () => {
  const js = "var Zu=`/token/:chain/:id`,Qu={chain:`solana`,id:`" + MIHAO + "`},$u=1;async function hN(e=fetch,t=`all`,n=$f){return t===`all`?mN(Qu.chain,Qu.id,e):gN(e,t,n)}";
  const f = (s) => facts({ index: "", js: s }).app;
  assert.deepEqual([f(js).open, f(js).home, f(js).opens], [true, true, MIHAO]);
  // another mint (NEARKAT's) is not this card's opener, and is the mint whose venue is read
  assert.deepEqual([f(js.replace(MIHAO, NEARKAT)).open, f(js.replace(MIHAO, NEARKAT)).opens], [false, NEARKAT]);
  assert.equal(f(js.replace("chain:`solana`", "chain:`base`")).open, false);
  assert.deepEqual([f(js.replace("mN(Qu.chain,Qu.id", "mN(Xu.chain,Xu.id")).home, f(js.replace("mN(Qu.chain,Qu.id", "mN(Xu.chain,Xu.id")).opens], [false, null]);
  // the token named but never read on All (the object left in, the old rule back) is no opener
  const old = js.replace("t===`all`?mN(Qu.chain,Qu.id,e):gN(e,t,n)", "gN(e,t,n)");
  assert.deepEqual([f(old).home, f(old).opens], [false, null]);
  // another Solana token object in the script that / never reads is not the one whose venue is read
  assert.equal(f(`var Pp={chain:\`solana\`,id:\`${NEARKAT}\`};` + js).opens, MIHAO);
});

test("read: the venue is read for the mint / opens; the build's run judges the script alone", async () => {
  const g = ANSWERS.good;
  const js = "Qu={chain:`solana`,id:`" + MIHAO + "`};t===`all`?mN(Qu.chain,Qu.id,e):gN(e,t,n)";
  const { createHash } = await import("node:crypto");
  const index = `<script type="module" crossorigin src="/assets/a.js" integrity="sha384-${createHash("sha384").update(js).digest("base64")}"></script>`;
  const f = async (u) => ({ status: 200, text: async () => (u.endsWith("/a.js") ? js : index) });
  const asked = [];
  const a = await read(f, async (m) => (asked.push(m), g.venue));
  assert.deepEqual(asked, [MIHAO]);
  assert.deepEqual(judge(a), { ok: true, lines: [] });
  // the build's run never reads mainnet: its verdict is the script's
  assert.deepEqual(await bundle(f), { ok: true, lines: [] });
  assert.deepEqual(await bundle(async (u) => ({ status: 200, text: async () => (u.endsWith("/a.js") ? js.replace(MIHAO, NEARKAT) : index) })), { ok: false, lines: ["BAD APP_HOST's served script is not the one index.html pins", NO_OPEN] });
});
