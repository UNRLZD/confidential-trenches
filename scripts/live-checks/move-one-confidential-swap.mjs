#!/usr/bin/env node
// Live check of card move-one-confidential-swap on SIGN_HOST (https://confidential.unrealized.trade) and on 1Click
// itself, moving no money. What it holds, and only that:
//   - SIGN_HOST's served /app.js is the one index.html pins (its sha384), and in it: the kit's confidential collector
//     pin (packages/kit/src/checks/oneclick.ts ONECLICK_CONFIDENTIAL_COLLECTOR, `collector`), the Move's request mode
//     (packages/wallet/src/deposit/quote.ts poolDepositQuoteRequest: confidentiality "advanced", `mode`), and the
//     keyless tell at 1Click's own address (packages/signpage/src/pool-deposit-address.ts oneClickHidden, `tell`);
//   - through the helper's proxy (its partner key, never printed), a DRY "advanced" quote of every Move pair (Solana,
//     Base, Robinhood pool coins and NEAR Cash's USDC, each to each: 12) answers 201 on Confidential Intents rails: the
//     mode echoed and 1Click's confidential collector named (`pairs`); a dry quote makes no deposit address;
//   - 1Click's own keyless status still tells the two apart (`tell`): a confidential deposit address made 2026-11-14
//     03:37Z answers 404 "Deposit address <it> not found", a public one made beside it answers a status. Both addresses
//     were made by non-dry quotes through the helper and nothing was ever sent to either.
// What the Move does with those (one quote into the destination pool, the source pool's run pays it, the pool follow
// carries it in) is held by packages/signpage/test/pool-to-cash.test.ts and pool-deposit-address.test.ts.
// Runs: pending move-one-confidential-swap, the release that carries it is not deployed yet
//   node scripts/live-checks/move-one-confidential-swap.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "move-one-confidential-swap";
export const SIGN = "https://confidential.unrealized.trade";
export const HELPER_QUOTE = "https://ct-api.unrealized.trade/v1/proxy/oneclick/v0/quote";
export const ONECLICK_STATUS = "https://1click.chaindefuser.com/v0/status";
export const CONF_COLLECTOR = "2238fd089f1c92b206c218cd16b8676cb98964e0d50f8ab729c6396a81e07805";
export const HIDDEN = "57LxDLkS96hfigLJW45RFEBYT28kzZ8x8u28Vd14o3xU";
export const PUBLIC = "G12KtPsLhr8pQFFHXCxo771qhhX8s1z9AZKEHc7ofmB8";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;

// Each Move end's coin on 1Click, its amount (about 6 USD) and a recipient of its kind nobody holds (a dry quote pays nothing).
const ENDS = {
  solana: { asset: "nep141:sol.omft.near", amount: "80000000", to: "2KesqqvtnrxmqFzTKDWNt2WyP4bA2pJqJbrJDZppE6aT" },
  base: { asset: "nep141:base.omft.near", amount: "3000000000000000", to: "0x000000000000000000000000000000000000beef" },
  robinhood: { asset: "nep141:hood.omft.near", amount: "3000000000000000", to: "0x000000000000000000000000000000000000beef" },
  near: { asset: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", amount: "6000000", to: "ab".repeat(32) },
};
export const PAIRS = Object.keys(ENDS).flatMap((f) => Object.keys(ENDS).filter((t) => t !== f).map((t) => `${f}>${t}`));
const REFUND = "cd".repeat(32);

/** The marks in SIGN_HOST's bundle, as minified. */
const MARKS = {
  collector: new RegExp(CONF_COLLECTOR),
  mode: /confidentiality:`advanced`/,
  tell: /https:\/\/1click\.chaindefuser\.com\/v0\/status/,
};

/** What the check keeps of SIGN_HOST's reads: the index, the bundle's sha384 and which marks it carries. */
export function facts(index, js) {
  return { index, sha384: sha384(js), marks: Object.keys(MARKS).filter((k) => MARKS[k].test(js)) };
}

/** One dry quote's answer, kept as the check judges it: its HTTP status, the mode it echoes and the collector it names. */
export function pairOf(pair, status, body) {
  const qr = body && typeof body === "object" ? body.quoteRequest : undefined;
  const fees = Array.isArray(qr?.appFees) ? qr.appFees : [];
  return { pair, status, mode: qr?.confidentiality ?? null, collector: fees.length === 1 ? fees[0]?.recipient ?? null : null, out: typeof body?.quote?.amountOut === "string" ? body.quote.amountOut : null };
}

/** The verdict on an answer { index, sha384, marks, pairs, tell: { hidden: {status, message}, public: {status, state} } }. */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  const marks = Array.isArray(a?.marks) ? a.marks : [];
  const missing = Object.keys(MARKS).filter((k) => !marks.includes(k));
  if (missing.length) bad(`SIGN_HOST's /app.js lacks the Move's ${missing.join(", ")}: a Move is not asked or checked as one confidential swap`);
  const pairs = Array.isArray(a?.pairs) ? a.pairs : [];
  for (const p of PAIRS) {
    const q = pairs.find((x) => x?.pair === p);
    if (!q) bad(`no dry quote read for ${p}`);
    else if (q.status !== 201) bad(`${p}: the helper's dry "advanced" quote answered HTTP ${q.status}, not 201`);
    else if (q.mode !== "advanced" || q.collector !== CONF_COLLECTOR || !/^[1-9][0-9]*$/.test(q.out ?? "")) bad(`${p}: the answer is not a confidential quote (mode ${q.mode}, collector ${q.collector}, out ${q.out})`);
  }
  const h = a?.tell?.hidden, u = a?.tell?.public;
  if (!(h?.status === 404 && h?.message === `Deposit address ${HIDDEN} not found`)) bad(`1Click's keyless status no longer answers not found for a confidential address (HTTP ${h?.status}): the Move's tell refuses every Move`);
  if (!(u?.status === 200 && typeof u?.state === "string")) bad(`1Click's keyless status no longer answers a public address's status (HTTP ${u?.status}): the tell cannot see a public swap`);
  return { ok: lines.length === 0, lines };
}

export async function read(fetchFn = fetch) {
  const get = async (path) => {
    const r = await fetchFn(`${SIGN}${path}`, { redirect: "error" });
    if (r.status !== 200) throw new Error(`${SIGN}${path}: HTTP ${r.status}`);
    return r.text();
  };
  const sign = facts(await get("/"), await get("/app.js"));
  const deadline = new Date(Date.now() + 10 * 60_000).toISOString();
  const pairs = await Promise.all(PAIRS.map(async (p) => {
    const [f, t] = p.split(">");
    const body = {
      dry: true, swapType: "EXACT_INPUT", slippageTolerance: 100, confidentiality: "advanced", originAsset: ENDS[f].asset, depositType: "ORIGIN_CHAIN",
      destinationAsset: ENDS[t].asset, amount: ENDS[f].amount, refundTo: REFUND, refundType: "INTENTS", recipient: ENDS[t].to,
      recipientType: t === "near" ? "INTENTS" : "DESTINATION_CHAIN", deadline,
    };
    const r = await fetchFn(HELPER_QUOTE, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return pairOf(p, r.status, await r.json().catch(() => null));
  }));
  const status = async (addr) => {
    const r = await fetchFn(`${ONECLICK_STATUS}?depositAddress=${addr}`);
    const b = await r.json().catch(() => null);
    return { status: r.status, message: typeof b?.message === "string" ? b.message : null, state: typeof b?.status === "string" ? b.status : null };
  };
  return { ...sign, pairs, tell: { hidden: await status(HIDDEN), public: await status(PUBLIC) } };
}

if (realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url))) {
  const arg = (k) => {
    const i = process.argv.indexOf(k);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  try {
    const answer = arg("--answer") ? JSON.parse(readFileSync(arg("--answer"), "utf8")) : await read();
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
