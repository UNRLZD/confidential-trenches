// The safety grid under the trade box (card app-trade-box-mount), after R5's riskGrid (research repo design/proto at
// design-lock-r5: token.js U.riskGrid, app.js P.riskCells, P.pctS): the twelve cells of one token read, their words, their
// verdict colours and the dash where the read holds nothing. test/token-source/helper-token-2026-11-03.json is the
// recorded GET /v1/market/token answer (its row and its `risk` part).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { MarketRow } from "../src/screens/discover/fields.ts";
import * as source from "../src/screens/token/source.ts";
import { pct, safetyCells, toneAt } from "../src/screens/trade/safety.ts";
import type { RiskRead } from "../src/screens/trade/safety.ts";
import { DRAFTS, WORDS } from "../src/screens/trade/words.ts";
import tokenRead from "./token-source/helper-token-2026-11-03.json" with { type: "json" };

const row = Object.fromEntries(tokenRead.fields.map((f, i) => [f, tokenRead.row[i]])) as unknown as MarketRow;
const risk = tokenRead.rest.risk as unknown as RiskRead;
const NOW = Date.parse("2026-11-03T12:00:00Z");
const f = (v: unknown) => ({ v, src: "test", as_of_ms: NOW });
const cells = (r: Partial<MarketRow> = {}, k: RiskRead | null = risk) => safetyCells({ ...row, ...r }, k, NOW);
const cell = (id: string, r: Partial<MarketRow> = {}, k: RiskRead | null = risk) => cells(r, k).find((c) => c.id === id)!;

test("the recorded read: the twelve cells in R5's order, each with the value and verdict the read holds", () => {
  const c = cells();
  assert.deepEqual(c.map((x) => x.id), ["top10", "dev", "snipers", "holders", "liq", "age", "insiders", "tax", "mintAuth", "freezeAuth", "lp", "honeypot"]);
  assert.deepEqual(c.map((x, i) => [x.text, x.icon, x.word ?? null, toneAt(i, x)]), [
    ["23%", "check", null, "good"], // top 10 holders 22.98% of the supply: under the 30% line, a green check
    ["—", "dev", null, "unknown"], // the read holds no dev share
    ["—", "sniper", null, "unknown"],
    ["71.3K", null, null, "plain"],
    ["$561.9K", null, null, "plain"],
    ["54d", null, null, "plain"], // created 1788976680, read at the clock above
    ["—", null, null, "unknown"],
    ["0%", null, null, "plain"], // no transfer fee on a buy or a sell
    ["", "x", null, "bad"], // the mint authority is still there
    ["", "x", null, "bad"],
    ["—", null, null, "unknown"], // no LP class read for a token off its curve
    ["—", null, null, "unknown"],
  ]);
});

test("every label is a word of the owner's lists; only Honeypot is a draft, and no cell is a sentence", () => {
  for (const c of cells()) {
    assert.ok(WORDS[c.id].text.length > 0);
    if (c.word) assert.ok(WORDS[c.word].text.length > 0);
  }
  assert.deepEqual(DRAFTS.filter((id) => ["top10", "dev", "snipers", "holders", "liq", "age", "insiders", "tax", "mintAuth", "freezeAuth", "lp", "lpCurve", "honeypot"].includes(id)), ["honeypot"]);
  assert.deepEqual(["top10", "dev", "snipers", "holders", "liq", "age", "insiders", "tax", "mintAuth", "freezeAuth", "lp", "lpCurve", "honeypot"].map((id) => WORDS[id as keyof typeof WORDS].text), ["Top 10 %", "Dev %", "Snipers %", "Holders", "Liq", "Age", "Insiders", "Tax", "Mint auth", "Freeze auth", "LP", "Curve", "Honeypot"]);
});

test("shares as R5's pctS draws them: one place under 10%, whole above, a trace, all of it", () => {
  assert.equal(pct(2298), "23%");
  assert.equal(pct(510), "5.1%");
  assert.equal(pct(1000), "10%");
  assert.equal(pct(0), "0.0%");
  assert.equal(pct(4), "<0.1%");
  assert.equal(pct(10_000), "100%");
  assert.equal(pct(9_996), "100%");
});

test("verdicts: amber at the line, coral at one and a half times it (VN-10), for top 10, dev, snipers and insiders", () => {
  const at = (id: "top10" | "dev" | "snipers", bps: number) => cell(id, { [`${id}_bps`]: bps } as Partial<MarketRow>);
  assert.equal(at("top10", 2999).tone, "plain");
  assert.equal(at("top10", 3000).tone, "warn");
  assert.equal(at("top10", 4499).tone, "warn");
  assert.equal(at("top10", 4500).tone, "bad");
  assert.equal(at("dev", 999).tone, "plain");
  assert.equal(at("dev", 1000).tone, "warn");
  assert.equal(at("dev", 1500).tone, "bad");
  assert.equal(at("snipers", 1500).tone, "bad");
  assert.equal(cell("insiders", {}, { insiders_bps: f(1000) }).tone, "warn");
  assert.equal(cell("insiders", {}, { insiders_bps: f(1500) }).text, "15%");
  // the top 10 icon turns to a cross at the line; only the first three cells draw a plain verdict green
  assert.equal(at("top10", 2999).icon, "check");
  assert.equal(at("top10", 3000).icon, "x");
  const c = cells({ top10_bps: 3000, dev_bps: 100, snipers_bps: 0 });
  assert.deepEqual(c.slice(0, 3).map((x, i) => toneAt(i, x)), ["warn", "good", "good"]);
  assert.equal(toneAt(6, cell("insiders", {}, { insiders_bps: f(100) })), "plain");
});

test("the authorities and honeypot: present is a coral cross, gone a check, unread the dash", () => {
  assert.deepEqual([cell("mintAuth", { mint_auth: false }).icon, cell("mintAuth", { mint_auth: false }).tone], ["check", "plain"]);
  assert.deepEqual([cell("freezeAuth", { freeze_auth: true }).icon, cell("freezeAuth", { freeze_auth: true }).tone], ["x", "bad"]);
  for (const v of [null, undefined, "yes", 0]) {
    const c = cell("mintAuth", { mint_auth: v as never });
    assert.deepEqual([c.text, c.icon, c.tone], ["—", null, "unknown"], String(v));
  }
  assert.deepEqual([cell("honeypot", {}, { honeypot: f(true) }).icon, cell("honeypot", {}, { honeypot: f(true) }).tone], ["x", "bad"]);
  assert.deepEqual([cell("honeypot", {}, { honeypot: f(false) }).icon, cell("honeypot", {}, { honeypot: f(false) }).tone], ["check", "plain"]);
  assert.equal(cell("honeypot", {}, { honeypot: f("no") }).text, "—");
});

test("tax: the higher of the buy and the sell fee, amber above zero; a half read is the dash", () => {
  const tax = (v: unknown) => cell("tax", {}, { tax: f(v) });
  assert.deepEqual([tax({ buy_bps: 0, sell_bps: 0 }).text, tax({ buy_bps: 0, sell_bps: 0 }).tone], ["0%", "plain"]);
  assert.deepEqual([tax({ buy_bps: 100, sell_bps: 500 }).text, tax({ buy_bps: 100, sell_bps: 500 }).tone], ["5.0%", "warn"]);
  for (const v of [null, {}, { buy_bps: 0 }, { buy_bps: -1, sell_bps: 0 }, { buy_bps: 0.5, sell_bps: 0 }, "5%"]) assert.equal(tax(v).text, "—", JSON.stringify(v));
});

test("LP: Curve only for a token on its launchpad's curve, with the read saying so; anything else the dash", () => {
  const lp = (r: Partial<MarketRow>, k: RiskRead | null) => cell("lp", r, k);
  const on = { launchpad: "pump.fun", curve_bps: 6400 };
  assert.deepEqual([lp(on, { lp: f({ class: "curve", bps: null }) }).word, lp(on, { lp: f({ class: "curve" }) }).tone], ["lpCurve", "plain"]);
  // a read that says curve for a token the row shows graduated or on no launchpad is not drawn as Curve
  assert.equal(lp({ launchpad: "pump.fun", curve_bps: 10_000 }, { lp: f({ class: "curve" }) }).text, "—");
  assert.equal(lp({ launchpad: null, curve_bps: 6400 }, { lp: f({ class: "curve" }) }).text, "—");
  for (const k of [{ lp: f(null) }, { lp: f({ class: "burned" }) }, { lp: null }, {}, null] as (RiskRead | null)[]) assert.equal(lp(on, k).text, "—");
});

test("a read with no risk part, or garbage in the row, draws the dash and never throws", () => {
  const none = cells({}, null);
  assert.deepEqual(none.filter((c) => c.id === "insiders" || c.id === "tax" || c.id === "lp" || c.id === "honeypot").map((c) => c.text), ["—", "—", "—", "—"]);
  const bad = cells({ top10_bps: -5, dev_bps: 12_000, snipers_bps: 1.5, holders: -1, liq_usd: "x", created_s: null, mint_auth: null }, {});
  assert.deepEqual(bad.slice(0, 6).map((c) => c.text), ["—", "—", "—", "—", "—", "—"]);
  assert.deepEqual(bad.slice(0, 6).map((c, i) => toneAt(i, c)), ["unknown", "unknown", "unknown", "unknown", "unknown", "unknown"]);
});

test("the token read's risk part reaches the page: loadToken keeps it beside the row, and a read without it is still ready", async () => {
  const answer = { ...tokenRead.rest, row };
  const ask = (body: unknown): typeof fetch => (async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
  const d = await source.loadToken("solana", row.token, ask(answer));
  assert.equal(d.status, "ready");
  assert.deepEqual(d.status === "ready" && d.risk, risk);
  const { risk: _drop, ...bare } = answer;
  const e = await source.loadToken("solana", row.token, ask(bare));
  assert.equal(e.status, "ready");
  assert.equal(e.status === "ready" && "risk" in e, false);
});
