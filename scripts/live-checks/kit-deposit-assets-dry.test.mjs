// node --test scripts/live-checks/kit-deposit-assets-dry.test.mjs: the live check replays its recorded answers
// (kit-deposit-assets-dry.answers.json).
//   bad: SIGN_HOST as served on 6 Nov 2026 13:49Z, before this card (release-62's page): deposit.assets and deposit.dry
//     both answered not_allowed, no dry quote sent: FAIL, the three BAD lines asserted below.
//   goodSynthetic: SYNTHETIC (its _note says so), a coherent answer built by hand from the bad run's browser facts and
//     1Click's real rows. It proves judge() accepts a coherent good answer; every planted variant below derives from it.
//   good: the card's own build (the wallet lead's branch card/kit-deposit-assets-dry), recorded with
//     node scripts/live-checks/kit-deposit-assets-dry.mjs --local <build dir> --record <file> and put in the answers
//     file as "good" (the file's header says how a build dir is made). The test runs on it when it is there and is
//     skipped, with that reason, when it is not.
// Planted on the synthetic good answer, each FAILs: a fourth asset, an asset missing from /v0/tokens, decimals that
// differ, a min below 1, a min at or above 1.1, a max_usd that is not 1000, a fee_usd 0.000001 off, an amount_out_usd 60
// bps off the direct quote, a quote request naming another recipient, a live (dry false) request, no dry request, a pin
// that does not match.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ASSETS, BASE_USDC, NEAR_USDC, PLACEHOLDER, SOL_USDC, dec, judge } from "./kit-deposit-assets-dry.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "kit-deposit-assets-dry.answers.json"), "utf8"));
const H = "https://ct-api.unrealized.trade/v1/proxy/oneclick";

/** A fresh copy of the synthetic good answer, changed by `f`. */
const plant = (f) => {
  const a = structuredClone(ANSWERS.goodSynthetic);
  f(a);
  return a;
};
const assetsOf = (a) => a.log.find((m) => m.data?.id === a.ids.assets).data.result.assets;
const dryOf = (a) => a.log.find((m) => m.data?.id === a.ids.dry).data.result;
const dryReq = (a) => a.helper.find((r) => r.phase === "dry");
const lines = (a) => judge(a).lines;

test("recorded bad answer: SIGN_HOST before this card answers both kinds not_allowed: FAIL, each named", () => {
  const v = judge(ANSWERS.bad);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, [
    'BAD deposit.assets answered refused "not_allowed", want ok',
    'BAD deposit.dry answered refused "not_allowed", want ok',
    "BAD no dry quote request was sent for deposit.dry",
  ]);
  assert.equal(ANSWERS.bad.ready, true);
  assert.deepEqual(ANSWERS.bad.helper, []);
});

test("synthetic good answer: PASS, no line", () => {
  assert.match(ANSWERS.goodSynthetic._note, /SYNTHETIC/);
  const v = judge(ANSWERS.goodSynthetic);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.deepEqual(v.lines, []);
  assert.deepEqual(Object.keys(ASSETS).sort(), [NEAR_USDC, SOL_USDC, BASE_USDC].sort());
});

test("recorded good answer: the card's build (recorded with --local): PASS", { skip: ANSWERS.good ? false : "no ANSWERS.good yet: the lead records it from the card's build with --local <build dir> --record" }, () => {
  const v = judge(ANSWERS.good);
  // 1Click answered the direct dry quote 201, as it answers every quote
  assert.equal(ANSWERS.good.oneclick.quote.status, 201);
  assert.equal(judge({ ...ANSWERS.good, oneclick: { ...ANSWERS.good.oneclick, quote: { ...ANSWERS.good.oneclick.quote, status: 500 } } }).ok, false, "no direct quote to compare with");
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.deepEqual(v.lines, []);
});

test("planted: a fourth asset in deposit.assets", () => {
  const other = "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near";
  const a = plant((a) => assetsOf(a).push({ origin_asset: other, chain: "near", symbol: "USDC", decimals: 6, min: "1.02", max_usd: "1000" }));
  assert.deepEqual(lines(a), [`BAD deposit.assets lists "${other}", not one of the kit's three USDC assets`]);
});

test("planted: one of the three missing from deposit.assets, and one listed twice", () => {
  assert.deepEqual(lines(plant((a) => assetsOf(a).pop())), [`BAD deposit.assets does not list ${BASE_USDC}`]);
  assert.deepEqual(lines(plant((a) => assetsOf(a).push(structuredClone(assetsOf(a)[0])))), ["BAD deposit.assets lists an asset twice"]);
});

test("planted: an asset missing from 1Click's /v0/tokens", () => {
  const a = plant((a) => (a.oneclick.tokens = a.oneclick.tokens.filter((t) => t.assetId !== SOL_USDC)));
  assert.deepEqual(lines(a), [`BAD deposit.assets ${SOL_USDC}: not in 1Click's /v0/tokens`]);
});

test("planted: decimals that differ from 1Click's, a symbol that is not USDC, a chain 1Click does not hold", () => {
  assert.deepEqual(lines(plant((a) => (assetsOf(a)[1].decimals = 9))), [`BAD deposit.assets ${SOL_USDC}: decimals 9, 1Click's 6`]);
  assert.deepEqual(lines(plant((a) => (a.oneclick.tokens.find((t) => t.assetId === BASE_USDC).decimals = 18))), [`BAD deposit.assets ${BASE_USDC}: decimals 6, 1Click's 18`]);
  assert.deepEqual(lines(plant((a) => (assetsOf(a)[0].symbol = "USDT"))), [`BAD deposit.assets ${NEAR_USDC}: symbol "USDT", want "USDC"`]);
  assert.deepEqual(lines(plant((a) => (a.oneclick.tokens.find((t) => t.assetId === SOL_USDC).blockchain = "eth"))), [`BAD deposit.assets ${SOL_USDC}: 1Click's blockchain "eth", not "sol" for chain "solana"`]);
  assert.deepEqual(lines(plant((a) => (assetsOf(a)[1].chain = "near"))), [
    `BAD deposit.assets ${SOL_USDC}: chain "near", want "solana"`,
    `BAD deposit.assets ${SOL_USDC}: 1Click's blockchain "sol", not "near" for chain "near"`,
  ]);
});

test("planted: min below 1, min at or above 1.1, min not a decimal, min not under max_usd", () => {
  assert.deepEqual(lines(plant((a) => (assetsOf(a)[0].min = "0.999999"))), [`BAD deposit.assets ${NEAR_USDC}: min 0.999999 is below 1 USDC, the vault's MIN_DEPOSIT`]);
  assert.deepEqual(lines(plant((a) => (assetsOf(a)[0].min = "0"))), [`BAD deposit.assets ${NEAR_USDC}: min 0 is below 1 USDC, the vault's MIN_DEPOSIT`]);
  for (const min of ["1.1", "1.100001", "2", "1000"])
    assert.ok(lines(plant((a) => (assetsOf(a)[0].min = min))).includes(`BAD deposit.assets ${NEAR_USDC}: min ${min} is not under 1.1 (1 USDC plus a few tenths of a percent)`), `min ${min}`);
  assert.deepEqual(lines(plant((a) => (assetsOf(a)[0].min = "1.099999"))), [], "1.099999 is the last min under 1.1");
  assert.deepEqual(lines(plant((a) => (assetsOf(a)[0].min = "1"))), [], "exactly 1 is allowed");
  for (const min of ["", "1,02", "-1", "1e0", " 1.02", "1.", ".5", 1.02, null])
    assert.ok(lines(plant((a) => (assetsOf(a)[0].min = min))).includes(`BAD deposit.assets ${NEAR_USDC}: min ${JSON.stringify(min)} is not a decimal`), `min ${JSON.stringify(min)}`);
});

test("planted: max_usd that is not exactly \"1000\"", () => {
  for (const max of ["1001", "999", "1000.0", 1000, "1e3", null])
    assert.deepEqual(lines(plant((a) => (assetsOf(a)[2].max_usd = max))).filter((l) => l.includes("max_usd")).slice(0, 1), [`BAD deposit.assets ${BASE_USDC}: max_usd ${JSON.stringify(max)}, want "1000"`], `max_usd ${JSON.stringify(max)}`);
  assert.equal(judge(plant((a) => (assetsOf(a)[2].max_usd = "1001"))).ok, false);
});

test("planted: fee_usd 0.000001 off the amount asked minus amount_out_usd (either way)", () => {
  assert.deepEqual(lines(plant((a) => (dryOf(a).fee_usd = "0.027096"))), ["BAD deposit.dry: fee_usd 0.027096 is not 25 - amount_out_usd 24.972905"]);
  assert.deepEqual(lines(plant((a) => (dryOf(a).fee_usd = "0.027094"))), ["BAD deposit.dry: fee_usd 0.027094 is not 25 - amount_out_usd 24.972905"]);
  assert.deepEqual(lines(plant((a) => (dryOf(a).fee_usd = 0.027095))), ["BAD deposit.dry: fee_usd 0.027095 is not a decimal"]);
});

test("planted: amount_out_usd 60 bps off the direct quote (50 passes, 51 fails, both ways)", () => {
  // the direct quote's amountOut is 24.992883; the fee is kept at 25 - amount_out_usd so only the distance is wrong
  const at = (out) => plant((a) => {
    const r = dryOf(a);
    r.amount_out_usd = out;
    r.fee_usd = ((25n * 10n ** 6n - BigInt(out.replace(".", ""))).toString().padStart(7, "0")).replace(/(\d{6})$/, ".$1");
    r.min_amount_out_usd = "24.000000";
  });
  const msg = (out) => `BAD deposit.dry: amount_out_usd ${out} is more than 50 bps from the keyless 1Click quote's amountOut 24992883 (6 decimals)`;
  assert.deepEqual(lines(at("24.842926")), [msg("24.842926")], "60 bps under");
  assert.deepEqual(lines(at("24.867919")), [], "49.99 bps under is the last that passes");
  assert.deepEqual(lines(at("24.867918")), [msg("24.867918")], "just past 50 bps under");
  assert.deepEqual(lines(at("24.992883")), [], "equal");
  assert.deepEqual(lines(at("25.000000")), [], "25 asked and given");
  assert.ok(lines(at("25.200000")).includes("BAD deposit.dry: amount_out_usd 25.200000 is above the 25 asked"));
});

test("planted: min_amount_out_usd above amount_out_usd, amount_out_usd above the amount asked", () => {
  assert.deepEqual(lines(plant((a) => (dryOf(a).min_amount_out_usd = "24.972906"))), ["BAD deposit.dry: min_amount_out_usd 24.972906 is above amount_out_usd 24.972905"]);
  assert.deepEqual(lines(plant((a) => (dryOf(a).min_amount_out_usd = "24.972905"))), [], "equal is allowed");
});

test("planted: time_estimate_s not a whole number, or more than a factor of 2 from the direct quote's", () => {
  assert.deepEqual(lines(plant((a) => (dryOf(a).time_estimate_s = 20.5))), ["BAD deposit.dry: time_estimate_s 20.5 is not a whole number of seconds"]);
  assert.deepEqual(lines(plant((a) => (dryOf(a).time_estimate_s = "20"))), ['BAD deposit.dry: time_estimate_s "20" is not a whole number of seconds']);
  for (const t of [41, 300, 9])
    assert.deepEqual(lines(plant((a) => (dryOf(a).time_estimate_s = t))), [`BAD deposit.dry: time_estimate_s ${t} is not within a factor of 2 of the keyless 1Click quote's timeEstimate 20`], `t ${t}`);
  for (const t of [10, 40, 20, 25]) assert.deepEqual(lines(plant((a) => (dryOf(a).time_estimate_s = t))), [], `t ${t}`);
});

test("planted: no keyless 1Click quote to compare with", () => {
  assert.deepEqual(lines(plant((a) => (a.oneclick.quote = null))), ["BAD deposit.dry: no keyless 1Click dry quote to compare with"]);
  assert.deepEqual(lines(plant((a) => (a.oneclick.quote = { status: 400, body: { message: "x" } }))), ["BAD deposit.dry: no keyless 1Click dry quote to compare with (HTTP 400)"]);
});

test("planted: a quote request naming another recipient or refundTo", () => {
  const other = "ab".repeat(32);
  const named = (key) => plant((a) => {
    a.helper.at(-1).body[key] = other;
  });
  assert.deepEqual(lines(named("recipient")), [`BAD the page sent POST ${H}/v0/quote naming recipient "${other}", not the placeholder`]);
  assert.deepEqual(lines(named("refundTo")), [`BAD the page sent POST ${H}/v0/quote naming refundTo "${other}", not the placeholder`]);
  // an assets-phase quote too: no request carries any other recipient
  assert.equal(judge(plant((a) => (a.helper[1].body.recipient = "5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd"))).ok, false);
  assert.equal(judge(plant((a) => delete a.helper[2].body.refundTo)).ok, false, "no refundTo at all");
  assert.equal(PLACEHOLDER, "4b742e2fa54135408f95d6be00483527709b33281f3d1836ae3e83371caae5c0");
});

test("planted: a live (dry false) quote request, or no dry field", () => {
  assert.deepEqual(lines(plant((a) => (a.helper[1].body.dry = false))), [`BAD the page sent POST ${H}/v0/quote with dry false, a quote that is not dry`]);
  assert.deepEqual(lines(plant((a) => delete a.helper[1].body.dry)), [`BAD the page sent POST ${H}/v0/quote with dry undefined, a quote that is not dry`]);
  // the deposit.dry one live: also no dry quote left for deposit.dry
  assert.deepEqual(lines(plant((a) => (dryReq(a).body.dry = false))), [
    `BAD the page sent POST ${H}/v0/quote with dry false, a quote that is not dry`,
    "BAD no dry quote request was sent for deposit.dry",
  ]);
});

test("planted: no dry request for deposit.dry; one for another asset or amount", () => {
  assert.deepEqual(lines(plant((a) => (a.helper = a.helper.filter((r) => r.phase !== "dry")))), ["BAD no dry quote request was sent for deposit.dry"]);
  assert.deepEqual(lines(plant((a) => (a.helper = []))), ["BAD no dry quote request was sent for deposit.dry"]);
  assert.deepEqual(lines(plant((a) => (dryReq(a).body.amount = "1000000"))), ["BAD none of the dry quote requests for deposit.dry is for 25 USDC from Solana"]);
  assert.deepEqual(lines(plant((a) => (dryReq(a).body.originAsset = BASE_USDC))), ["BAD none of the dry quote requests for deposit.dry is for 25 USDC from Solana"]);
});

test("planted: any other request to the helper's 1Click proxy", () => {
  const add = (r) => plant((a) => a.helper.push({ phase: "dry", body: null, ...r }));
  assert.deepEqual(lines(add({ method: "GET", url: `${H}/v0/status?depositAddress=x` })), [`BAD the page sent GET ${H}/v0/status?depositAddress=x, neither POST /v0/tokens nor POST /v0/quote`]);
  assert.deepEqual(lines(add({ method: "GET", url: `${H}/v0/tokens` })), [`BAD the page sent GET ${H}/v0/tokens, neither POST /v0/tokens nor POST /v0/quote`]);
  assert.deepEqual(lines(add({ method: "GET", url: `${H}/v0/quote` })), [`BAD the page sent GET ${H}/v0/quote, neither POST /v0/tokens nor POST /v0/quote`]);
  assert.deepEqual(lines(add({ method: "POST", url: `${H}/v0/quote`, body: null })), [`BAD the page sent POST ${H}/v0/quote with no readable body`]);
  assert.deepEqual(lines(add({ method: "POST", url: `${H}/v0/quote?x=1`, body: { dry: true, recipient: PLACEHOLDER, refundTo: PLACEHOLDER } })), [`BAD the page sent POST ${H}/v0/quote?x=1, neither POST /v0/tokens nor POST /v0/quote`]);
});

test("planted: the served /app.js is not the one index.html pins; index.html pins none", () => {
  assert.deepEqual(lines(plant((a) => (a.appJs.sha384 = "sha384-AAAA"))), ["BAD SIGN_HOST's served /app.js is not the one index.html pins"]);
  assert.deepEqual(lines(plant((a) => (a.appJs = null))), ["BAD SIGN_HOST's served /app.js is not the one index.html pins"]);
  assert.deepEqual(lines(plant((a) => (a.index = "<html></html>"))), ["BAD SIGN_HOST's index.html pins no /app.js"]);
  assert.deepEqual(lines(plant((a) => (a.index = null))), ["BAD SIGN_HOST's index.html pins no /app.js"]);
});

test("planted: the shell's ready never arrives, an answer missing or doubled, an answer from the wrong source, a refusal outside the card's codes", () => {
  assert.ok(lines(plant((a) => (a.ready = false))).includes("BAD the shell's ready did not arrive in the APP_HOST frame"));
  assert.deepEqual(lines(plant((a) => (a.log = a.log.filter((m) => m.data?.id !== a.ids.dry)))), ["BAD deposit.dry: 0 answer(s) to its id, want 1"]);
  assert.deepEqual(lines(plant((a) => a.log.push(structuredClone(a.log.at(-1))))), ["BAD deposit.dry: 2 answer(s) to its id, want 1"]);
  assert.deepEqual(lines(plant((a) => (a.log[1].fromParent = false))), ["BAD deposit.assets: 0 answer(s) to its id, want 1"]);
  assert.deepEqual(lines(plant((a) => (a.log[1].origin = "https://evil.test"))), ["BAD deposit.assets: 0 answer(s) to its id, want 1"]);
  const refused = (code) => plant((a) => (a.log[2].data = { v: 1, id: a.ids.dry, ok: false, error: { code } }));
  for (const code of ["below_min", "above_max", "not_available", "busy", "down", "quote_check_failed", "not_allowed"])
    assert.deepEqual(lines(refused(code)), [`BAD deposit.dry answered refused "${code}", want ok`], code);
  assert.deepEqual(lines(refused("teapot")), ['BAD deposit.dry answered refused "teapot", want ok', 'BAD deposit.dry refused with "teapot", not one of the card\'s codes']);
  assert.deepEqual(lines({}), [
    "BAD SIGN_HOST's index.html pins no /app.js",
    "BAD the shell's ready did not arrive in the APP_HOST frame",
    "BAD deposit.assets: 0 answer(s) to its id, want 1",
    "BAD deposit.dry: 0 answer(s) to its id, want 1",
    "BAD no dry quote request was sent for deposit.dry",
  ]);
});

test("dec() reads plain decimals exactly and nothing else", () => {
  assert.equal(dec("25"), 25n * 10n ** 18n);
  assert.equal(dec("1.019177"), 1_019_177n * 10n ** 12n);
  assert.equal(dec("0.000001"), 10n ** 12n);
  for (const s of ["", "01", "1.", ".1", "-1", "+1", "1e3", "1 ", "0x1", "1.0000000000000000001", 1, null, undefined]) assert.equal(dec(s), null, JSON.stringify(s));
});

test("the file's CLI replays an answer: the synthetic good one ends PASS (exit 0), the bad one FAIL (exit 1), each with its BAD lines", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ct-dad-test-"));
  const run = (answer) => {
    const f = path.join(dir, "answer.json");
    writeFileSync(f, JSON.stringify(answer));
    const r = spawnSync(process.execPath, [path.join(HERE, "kit-deposit-assets-dry.mjs"), "--answer", f], { encoding: "utf8" });
    return { code: r.status, out: r.stdout.trim().split("\n") };
  };
  const good = run(ANSWERS.goodSynthetic);
  assert.equal(good.code, 0);
  assert.deepEqual(good.out, ["PASS kit-deposit-assets-dry"]);
  const bad = run(ANSWERS.bad);
  assert.equal(bad.code, 1);
  assert.equal(bad.out.at(-1), "FAIL kit-deposit-assets-dry");
  assert.equal(bad.out.filter((l) => l.startsWith("BAD ")).length, 3);
});
