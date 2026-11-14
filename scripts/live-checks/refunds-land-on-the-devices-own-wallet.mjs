#!/usr/bin/env node
// Live check of card refunds-land-on-the-devices-own-wallet on SIGN_HOST (https://confidential.unrealized.trade) and
// through the helper's 1Click proxy, moving no money. What it holds, and only that:
//   - SIGN_HOST's served /app.js is the one index.html pins (its sha384), and in it: the origin refund rule that the
//     request builders and both quote rules hold (packages/wallet/src/deposit/quote.ts checkOriginRefund: ORIGIN_CHAIN
//     only on the origin coin's own chain, at an address the device derives there; `rule`), and the refund address's
//     record the leftover carry reads (packages/signpage/src/leftover-carry.ts refundKeyOf, meta owed/refund-; `record`);
//   - through the helper's proxy (its partner key, never printed), a DRY quote of every leg a device wallet pays in a
//     pool coin (Solana, Base and Robinhood pool coins into each other pool and into NEAR Cash's USDC: 9) asked
//     confidential "advanced" with refundType ORIGIN_CHAIN to an address of the origin's own chain nobody holds answers
//     201 and echoes ORIGIN_CHAIN and that address (`legs`): 1Click takes the refund the Move now asks on every leg. A
//     dry quote makes no deposit address.
// What the page does with them (which host asks ORIGIN_CHAIN, the record before the address goes out, the carry) is held
// by packages/signpage/test/origin-refund-legs.test.ts, origin-refund-rules.test.ts and refund-carry.test.ts.
// Runs: pending refunds-land-on-the-devices-own-wallet, the release that carries it is not deployed yet
//   node scripts/live-checks/refunds-land-on-the-devices-own-wallet.mjs [--build <dir>] [--record <file>] [--answer <file>]
//   --build reads index.html and app.js from a local build (build-app.mjs --out <dir>) in place of SIGN_HOST.
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const KEY = "refunds-land-on-the-devices-own-wallet";
export const SIGN = "https://confidential.unrealized.trade";
export const HELPER_QUOTE = "https://ct-api.unrealized.trade/v1/proxy/oneclick/v0/quote";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;

// Each pool coin on 1Click, its amount (about 6 USD), and an address of its chain nobody holds: the dry quote's
// recipient on that chain and its refund on it (a dry quote pays nothing and refunds nothing).
const COINS = {
  solana: { asset: "nep141:sol.omft.near", amount: "40000000", at: "2KesqqvtnrxmqFzTKDWNt2WyP4bA2pJqJbrJDZppE6aT" },
  base: { asset: "nep141:base.omft.near", amount: "2000000000000000", at: "0x000000000000000000000000000000000000bEEF" },
  robinhood: { asset: "nep141:hood.omft.near", amount: "2000000000000000", at: "0x000000000000000000000000000000000000bEEF" },
};
const CASH = { asset: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", at: "ab".repeat(32) };
export const LEGS = Object.keys(COINS).flatMap((f) => [...Object.keys(COINS).filter((t) => t !== f), "cash"].map((t) => `${f}>${t}`));
export const refundOf = (leg) => COINS[leg.split(">")[0]].at;

/** The marks in SIGN_HOST's bundle, as minified (error texts and string keys survive minification). */
const MARKS = {
  rule: /origin refund: not the origin coin's own chain/,
  record: /owed\/refund-/,
};

/** What the check keeps of SIGN_HOST's reads: the index, the bundle's sha384 and which marks it carries. */
export function facts(index, js) {
  return { index, sha384: sha384(js), marks: Object.keys(MARKS).filter((k) => MARKS[k].test(js)) };
}

/** One dry quote's answer, kept as the check judges it: its HTTP status and the refund it echoes. */
export function legOf(leg, status, body) {
  const qr = body && typeof body === "object" ? body.quoteRequest : undefined;
  return { leg, status, refundType: qr?.refundType ?? null, refundTo: qr?.refundTo ?? null, out: typeof body?.quote?.amountOut === "string" ? body.quote.amountOut : null };
}

/** The verdict on an answer { index, sha384, marks, legs }. */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  const marks = Array.isArray(a?.marks) ? a.marks : [];
  const missing = Object.keys(MARKS).filter((k) => !marks.includes(k));
  if (missing.length) bad(`SIGN_HOST's /app.js lacks the origin refund's ${missing.join(", ")}: a failed swap's refund still rests in intents.near`);
  const legs = Array.isArray(a?.legs) ? a.legs : [];
  for (const l of LEGS) {
    const q = legs.find((x) => x?.leg === l);
    if (!q) bad(`no dry quote read for ${l}`);
    else if (q.status !== 201) bad(`${l}: the helper's dry quote refunding ORIGIN_CHAIN answered HTTP ${q.status}, not 201`);
    else if (q.refundType !== "ORIGIN_CHAIN" || q.refundTo !== refundOf(l) || !/^[1-9][0-9]*$/.test(q.out ?? "")) bad(`${l}: the answer does not refund on the origin chain (refundType ${q.refundType}, refundTo ${q.refundTo}, out ${q.out})`);
  }
  return { ok: lines.length === 0, lines };
}

export async function read(fetchFn = fetch, build) {
  const get = async (path) => {
    if (build) return readFileSync(join(build, path === "/" ? "index.html" : path.slice(1)), "utf8");
    const r = await fetchFn(`${SIGN}${path}`, { redirect: "error" });
    if (r.status !== 200) throw new Error(`${SIGN}${path}: HTTP ${r.status}`);
    return r.text();
  };
  const sign = facts(await get("/"), await get("/app.js"));
  const deadline = new Date(Date.now() + 10 * 60_000).toISOString();
  const legs = await Promise.all(LEGS.map(async (l) => {
    const [f, t] = l.split(">");
    const to = t === "cash" ? CASH : COINS[t];
    const body = {
      dry: true, swapType: "EXACT_INPUT", slippageTolerance: 100, confidentiality: "advanced", originAsset: COINS[f].asset, depositType: "ORIGIN_CHAIN",
      destinationAsset: to.asset, amount: COINS[f].amount, refundTo: COINS[f].at, refundType: "ORIGIN_CHAIN", recipient: to.at,
      recipientType: "DESTINATION_CHAIN", deadline,
    };
    const r = await fetchFn(HELPER_QUOTE, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return legOf(l, r.status, await r.json().catch(() => null));
  }));
  return { ...sign, legs };
}

if (realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url))) {
  const arg = (k) => {
    const i = process.argv.indexOf(k);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  try {
    const answer = arg("--answer") ? JSON.parse(readFileSync(arg("--answer"), "utf8")) : await read(fetch, arg("--build"));
    if (arg("--record")) writeFileSync(arg("--record"), `${JSON.stringify(answer)}\n`);
    const v = judge(answer);
    for (const l of v.lines) console.log(l);
    console.log(v.ok ? `PASS ${KEY}` : `FAIL ${KEY}`);
    process.exit(v.ok ? 0 : 1);
  } catch (e) {
    console.error(`ERROR ${KEY}: ${e?.message ?? e}`);
    process.exit(2);
  }
}
