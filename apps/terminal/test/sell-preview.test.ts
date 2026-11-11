// The sell box's live preview (card app-sell-shows-what-you-receive): the app asks the signing page's pool.sell.dry for
// the share the tap would sell, the same params the tap's pool.sell sends, and draws its out and network in USD at the
// page's own pool price (state.pools[].price), its fee as is. Red before the card: the live source's sellPreview was
// null (src/screens/positions/source.tsx), so You receive, Network and Fee drew a dash on every sell.
//   node --test test/sell-preview.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { SignpageOutcome, SignpageState } from "@blindfill/kit";
import { askSellPreview } from "../src/screens/positions/model.ts";
import type { PoolPrice } from "../src/screens/trade/model.ts";

const MINT = "Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr";
const POOLS: SignpageState["pools"] = [{ chain: "solana", asset: "SOL", balance: "0.01" }];
/** $150.00 a SOL: 15,000,000,000 x 10^-8, 9 decimals. */
const SOL_150: PoolPrice = { price: 15_000_000_000n, expo: -8, decimals: 9 };
const req = { chain: "solana" as const, token: MINT, amount: "617283.945617", share_bps: 5_000, slippage_bps: 1000 };

function page(answer: SignpageOutcome<"pool.sell.dry">) {
  const asked: { kind: string; params: unknown }[] = [];
  const request = ((kind: string, params: unknown) => {
    asked.push({ kind, params });
    return { id: "dry-1", outcome: Promise.resolve(answer) };
  }) as Parameters<typeof askSellPreview>[0];
  return { request, asked };
}

test("the live preview asks pool.sell.dry with the tap's own params and draws the page's out and network at the page's price", async () => {
  const p = page({ ok: true, result: { out: "0.73", min_out: "0.657", network: "0.000005", fee_bps: 0 } });
  const a = await askSellPreview(p.request, POOLS, () => SOL_150, req);
  assert.deepEqual(p.asked, [{ kind: "pool.sell.dry", params: { chain: "solana", token: MINT, share_bps: 5_000, slippage_bps: 1000 } }]);
  assert.deepEqual(a, { ok: true, preview: { out_usd: "109.50", network_usd: "0.00", fee_bps: 0 } });
});

test("no preview to draw: no client, no pool on the chain, no fresh price, the page's refusal, a throw, an answer the price cannot read", async () => {
  const ok = page({ ok: true, result: { out: "0.73", min_out: "0.657", network: "0.000005", fee_bps: 0 } });
  assert.equal((await askSellPreview(null, POOLS, () => SOL_150, req)).ok, false);
  assert.equal((await askSellPreview(ok.request, [], () => SOL_150, req)).ok, false);
  assert.equal((await askSellPreview(ok.request, POOLS, () => SOL_150, { ...req, chain: "near" })).ok, false);
  assert.equal(ok.asked.length, 0, "nothing asked with no pool");
  assert.deepEqual(await askSellPreview(ok.request, POOLS, () => null, req), { ok: false, code: "no_price" });
  for (const code of ["not_allowed", "busy", "down", "quote_check_failed", "client_timeout", "signpage_down"])
    assert.deepEqual(await askSellPreview(page({ ok: false, error: { code } }).request, POOLS, () => SOL_150, req), { ok: false, code });
  const throws = (() => {
    throw new Error("no frame");
  }) as unknown as Parameters<typeof askSellPreview>[0];
  assert.equal((await askSellPreview(throws, POOLS, () => SOL_150, req)).ok, false);
  assert.equal((await askSellPreview(page({ ok: true, result: { out: "0.1234567891", min_out: "0", network: "0", fee_bps: 0 } }).request, POOLS, () => SOL_150, req)).ok, false, "finer than SOL's 9");
});

test("the live source in src gives the preview (no fixture needed); with none to be had the box is main's: an unread value is a dash, no new word", () => {
  const src = readFileSync(new URL("../src/screens/positions/source.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(src, /createContext<SellKit>\(\{ sellPreview: null \}\)/, "the default is no longer a null preview");
  assert.match(src, /askSellPreview\(/);
  const box = readFileSync(new URL("../src/screens/positions/SellBox.tsx", import.meta.url), "utf8");
  // the word, or its id: the box's own gate on the trade box's Unavailable phase (model.ts unavailable) is not one
  assert.doesNotMatch(box, /Unavailable|"unavailable"/, "an unread value shows a dash (owner 10 Nov)");
  assert.match(box, /data-testid="sell-receive">\{outC === null \? "—" : `≈ \$\{usd\(outC\)\}`\}<\/span>/);
  const words = readFileSync(new URL("../src/screens/positions/words.ts", import.meta.url), "utf8");
  assert.doesNotMatch(words, /unavailable/, "no new word on the sell box");
});
