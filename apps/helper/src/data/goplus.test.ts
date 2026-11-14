// GoPlus's contract checks on the EVM token page (card every-cell-shows-a-value), from its real answers of 2026-11-14
// 04:05Z (data/evm/fixtures/goplus-*-2026-11-14.json: SANTACOIN on Robinhood, KTA on Base). Before this card the EVM
// page's mint, freeze, dev, tax and honeypot cells were src "none" (evm/token.ts: "not built"), each a dash.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { RISK_FIELDS } from "./solana/token.ts";
import { toPage } from "./evm/token.ts";
import { contractRisk, createGoPlus, GOPLUS, RISK_MS, RISK_WAIT_MS } from "./goplus.ts";
import type { Fetch } from "./near/views.ts";

const RH = "0x38bb87cf3e7344a82be7cd671c191f015b97eee6";
const BASE = "0xc0634090f2fe6c6d75e61be2b949464abb498973";
const fx = (chain: string) => readFileSync(new URL(`./evm/fixtures/goplus-${chain}-2026-11-14.json`, import.meta.url), "utf8");
const AT = Date.UTC(2026, 10, 14, 4, 5);

test("contractRisk: honeypot, tax, mint, freeze (pause or blacklist), creator share, holders and top 10 from the token's own entry", () => {
  const r = contractRisk(JSON.parse(fx("robinhood")), RH, AT)!;
  assert.deepEqual({ ...r, top10_bps: typeof r.top10_bps }, { honeypot: false, tax: { buy_bps: 0, sell_bps: 0 }, mint_auth: false, freeze_auth: false, dev_bps: 0, holders: 2699, top10_bps: "number", as_of_ms: AT });
  assert.ok(r.top10_bps! > 0 && r.top10_bps! <= 10_000);
  assert.equal(contractRisk(JSON.parse(fx("base")), BASE, AT)!.holders, 138948);
  // another token's entry, an error code, and hostile values
  assert.equal(contractRisk(JSON.parse(fx("robinhood")), BASE, AT), null);
  assert.equal(contractRisk({ code: 2, result: {} }, RH, AT), null);
  const entry = JSON.parse(fx("robinhood")).result[RH];
  const bad = contractRisk({ code: 1, result: { [RH]: { ...entry, is_honeypot: "yes", buy_tax: "1e3", sell_tax: "0.1", is_mintable: 1, transfer_pausable: "1", holder_count: "-4" } } }, RH, AT)!;
  assert.deepEqual([bad.honeypot, bad.tax, bad.mint_auth, bad.freeze_auth, bad.holders], [null, null, null, true, null]);
  const taxed = contractRisk({ code: 1, result: { [RH]: { ...entry, buy_tax: "0.05", sell_tax: "0.1", is_honeypot: "1" } } }, RH, AT)!;
  assert.deepEqual([taxed.tax, taxed.honeypot], [{ buy_bps: 500, sell_bps: 1000 }, true]);
});

test("toPage: with GoPlus's checks the grid's mint, freeze, dev, tax and honeypot cells hold values, src goplus; holders and top 10 stay GeckoTerminal's when it has them", () => {
  const row = { chain: "robinhood", token: RH, symbol: "SANTACOIN", name: "SANTACOIN", liq_usd: "16848.47", created_s: null, as_of_ms: AT, holders: null, top10_bps: null } as never;
  const risk = contractRisk(JSON.parse(fx("robinhood")), RH, AT);
  const page = toPage(row, null, undefined, risk);
  assert.deepEqual(Object.keys(page.risk), [...RISK_FIELDS]);
  const filled = Object.entries(page.risk).filter(([, f]) => f.v !== null).map(([k, f]) => `${k}:${f.src}`);
  assert.deepEqual(filled, ["mint_auth:goplus", "freeze_auth:goplus", "top10_bps:goplus", "dev_bps:goplus", "holders:goplus", "liq_usd:geckoterminal", "tax:goplus", "honeypot:goplus"]);
  const withInfo = toPage(row, { holders: 2701, top10Bps: 4100, decimals: 18, asOfMs: AT } as never, undefined, risk);
  assert.deepEqual([withInfo.risk.holders.v, withInfo.risk.holders.src, withInfo.risk.top10_bps.v], [2701, "geckoterminal", 4100]);
  // without GoPlus (down, or not answered in time) the cells are as before
  assert.deepEqual(Object.entries(toPage(row, null, undefined, null).risk).filter(([, f]) => f.v !== null).map(([k]) => k), ["liq_usd"]);
});

test("createGoPlus: one read per token held RISK_MS, shared by callers; a slow first read is not waited on past RISK_WAIT_MS and serves the next ask", async () => {
  const clock = { t: AT };
  const asked: string[] = [];
  let release: () => void = () => undefined;
  let slow = false;
  const fetch: Fetch = async (url) => {
    asked.push(url);
    if (slow) await new Promise<void>((ok) => (release = ok));
    return new Response(fx("robinhood"), { status: 200 });
  };
  // the page's wait ends only when the test says (a timer that has not run yet)
  const waits: number[] = [];
  let timeUp: () => void = () => undefined;
  const g = createGoPlus({ fetch, now: () => clock.t, wait: (ms) => (waits.push(ms), new Promise<void>((ok) => (timeUp = ok))) });
  const [a, b] = await Promise.all([g.risk("robinhood", RH), g.risk("robinhood", RH)]);
  assert.equal(a!.honeypot, false);
  assert.equal(b, a);
  assert.deepEqual(asked, [`${GOPLUS}/4663?contract_addresses=${RH}`]);
  clock.t += RISK_MS;
  await g.risk("robinhood", RH);
  assert.equal(asked.length, 1, "held for RISK_MS");
  // a cold token whose read is slow: the page is answered without it after RISK_WAIT_MS, the read lands for the next
  slow = true;
  const COLD = BASE.replace("c0", "c1");
  const asking = g.risk("base", COLD);
  await new Promise((ok) => setImmediate(ok));
  timeUp();
  assert.equal(await asking, null);
  assert.deepEqual(waits.at(-1), RISK_WAIT_MS);
  release();
  await new Promise((ok) => setImmediate(ok));
  await g.risk("base", COLD);
  assert.equal(asked.length, 2, "the late read landed and is held: the next ask sends nothing");
  // an unserved chain or a bad address asks nothing
  assert.equal(await g.risk("solana", RH), null);
  assert.equal(await g.risk("base", "0xABC"), null);
  assert.equal(asked.length, 2);
});
