#!/usr/bin/env node
// Live check of card wallet-refund-move: a deposit 1Click refunded to U inside intents.near is moved on into the vault by
// the device with no tap (packages/wallet/src/deposit/refund.ts and follow.ts, packages/signpage/src/deposit-follow.ts,
// signed under packages/signpage/src/rules/refund.ts). What it holds on what is deployed, with no money moved:
//   - SIGN_HOST's served /app.js is the one its index.html pins (sha384), and it carries the refund move: the relayer's
//     /v1/intents address on HELPER_HOST;
//   - the helper's 1Click proxy answers a refund move's quote (depositType INTENTS, the vault's USDC to a fresh U on the
//     token, refunds to U inside intents.near) that SIGN_HOST's own rule passes (checkRefundMoveQuote, 1Click's pinned
//     keys, the deposit path's floors with MIN_DEPOSIT, read through the kit's entry): a live quote moves nothing until something is sent to it;
//   - intents.near on two RPCs (FastNear and dRPC) at one block: its current_salt agrees (the nonce the device builds
//     carries it) and is_nonce_used answers false for a fresh nonce of a fresh id (the read the move's end rests on);
//   - the helper carries an id's intents: POST /v1/intents with an empty body answers one of the route's own refusals
//     (kit helper/v1.ts HELPER_INTENTS_CODES, bad_shape for this body), never 404.
// A page without the move leaves every refunded deposit under U until withdraw.open; a helper with no /v1/intents
// carries no move; a quote the rule refuses is a refund that never moves.
// The recorded answers (scripts/live-checks/wallet-refund-move.answers.json): good, this card's committed SIGN_HOST
// build, the helper's live quote and intents.near's live reads of 7 Nov, and /v1/intents's answer as the kit's contract
// gives it (bad_shape, HTTP 400: the route is not deployed yet, so that one fact is the contract's, not a recording);
// bad, SIGN_HOST as served on 7 Nov before the card, the same live reads, and /v1/intents as the helper answered it on
// 7 Nov (HTTP 404 not_found).
//   node scripts/live-checks/wallet-refund-move.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { HELPER_INTENTS_CODES, checkOneClickQuote } from "../../packages/kit/src/index.ts";

const KEY = "wallet-refund-move";
export const SIGN = "https://sign.confidential.unrealized.trade";
export const HELPER = "https://api.confidential.unrealized.trade";
export const APP = "https://confidential.unrealized.trade";
export const INTENTS_URL = `${HELPER}/v1/intents`;
export const QUOTE_URL = `${HELPER}/v1/proxy/oneclick/v0/quote`;
export const RPCS = ["https://free.rpc.fastnear.com", "https://near.drpc.org"];
/** The refund the quote asks for: 2 USDC refunded on Solana USDC, the asset deposit.quote quotes most. */
export const ORIGIN = "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near";
export const VAULT_USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;

/** The device's own request for a refund move of `amount` under `u` (wallet refund.ts refundMoveRequest), at `now`. */
export function refundRequest(u, now, amount = "2000000") {
  return { dry: false, swapType: "EXACT_INPUT", slippageTolerance: 100, originAsset: ORIGIN, depositType: "INTENTS", destinationAsset: VAULT_USDC, amount, refundTo: u, refundType: "INTENTS", recipient: u, recipientType: "DESTINATION_CHAIN", deadline: new Date(now + 30 * 60_000).toISOString() };
}

/** The deposit path SIGN_HOST quotes a refund move on (signpage rules/deposit-dry.ts DEPOSIT_QUOTE_PATH). */
export const QUOTE_PATH = "partner";

/** SIGN_HOST's refund move rule on a recorded quote (signpage rules/refund.ts checkRefundMoveQuote), read through the
 *  kit's entry: the request's own refund-kind fields, then the kit's 1Click check into the vault (pinned keys, the echo,
 *  the deposit path's floors), then a live deposit address and deadline. "pass", or the refusal's message. */
export function ruleVerdict(request, answer) {
  try {
    const u = request.recipient;
    const want = { originAsset: ORIGIN, depositType: "INTENTS", destinationAsset: VAULT_USDC, recipientType: "DESTINATION_CHAIN", refundTo: u, refundType: "INTENTS" };
    for (const [k, v] of Object.entries(want)) if (request[k] !== v) throw new Error(`refund-kind request not allowed: ${k}`);
    const now = Date.parse(answer?.timestamp ?? "") + 1_000;
    const checked = checkOneClickQuote(request, answer, { path: QUOTE_PATH, pricing: "usdc", decimalsIn: 6, decimalsOut: 6, now, intoVault: true });
    if (typeof checked.depositAddress !== "string" || typeof checked.deadline !== "string") throw new Error("refund-kind request not allowed: live");
    return "pass";
  } catch (e) {
    return String(e?.message ?? e);
  }
}

/** What the check keeps of the quote: its HTTP status, the rule's verdict at read time and the signed fields judged (the
 *  answer's signature is not kept: an ed25519 signature has a NEAR secret key's shape, which gitleaks refuses here). */
export function quoteFacts(status, request, answer) {
  const qr = answer?.quoteRequest ?? {};
  return { status, verdict: status === 200 || status === 201 ? ruleVerdict(request, answer) : null, depositType: qr.depositType ?? null, toU: qr.recipient === request.recipient && qr.refundTo === request.recipient, depositAddress: answer?.quote?.depositAddress ?? null };
}

/** The verdict on an answer { index, sha384, intents_url, quote: quoteFacts, near: [{ height, salt, used }, ...], relay: { status, code } }. */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  if (a?.intents_url !== true) bad(`SIGN_HOST's bundle carries no refund move (${INTENTS_URL})`);
  const q = a?.quote ?? {};
  if (q.status !== 201 && q.status !== 200) bad(`the helper's 1Click proxy answers the refund move's quote ${q.status}`);
  else if (q.verdict !== "pass") bad(`SIGN_HOST's rule refuses the live refund move quote: ${q.verdict}`);
  else if (q.depositType !== "INTENTS" || q.toU !== true) bad("the live quote is not a refund move's (depositType INTENTS, to U and refunded to U)");
  const n = Array.isArray(a?.near) ? a.near : [];
  if (n.length !== 2 || n.some((s) => typeof s?.salt !== "string" || !/^[0-9a-f]{8}$/.test(s.salt))) bad("intents.near's current_salt is not read on both RPCs");
  else if (n[0].salt !== n[1].salt || n[0].height !== n[1].height) bad("intents.near's two RPCs disagree at one block");
  if (n.length === 2 && n.some((s) => s?.used !== false)) bad("is_nonce_used does not answer false for a fresh nonce on both RPCs");
  const r = a?.relay ?? {};
  if (r.status === 404 || !HELPER_INTENTS_CODES.includes(r.code)) bad(`the helper carries no id's intent: POST /v1/intents answers ${r.status} ${JSON.stringify(r.code)}`);
  return { ok: !lines.some((l) => l.startsWith("BAD")), lines };
}

const call = async (fetchFn, url, method, args, block) => {
  const params = { request_type: "call_function", account_id: "intents.near", method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64"), ...block };
  const r = await fetchFn(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "ct", method: "query", params }) });
  const j = await r.json();
  if (!j?.result?.result) throw new Error(`${url} ${method}: ${JSON.stringify(j?.error ?? j).slice(0, 200)}`);
  return { height: j.result.block_height, value: JSON.parse(Buffer.from(j.result.result).toString()) };
};

export async function read(fetchFn = fetch, now = Date.now()) {
  const get = async (path) => {
    const r = await fetchFn(`${SIGN}${path}`, { redirect: "error" });
    if (r.status !== 200) throw new Error(`${path}: HTTP ${r.status}`);
    return r.text();
  };
  const index = await get("/");
  const js = await get("/app.js");
  // a fresh U: an id no one holds a key to, so the quote's address is never paid
  const u = randomBytes(32).toString("hex");
  const request = refundRequest(u, now);
  const qr = await fetchFn(QUOTE_URL, { method: "POST", redirect: "error", headers: { "content-type": "application/json", origin: APP }, body: JSON.stringify(request) });
  const answer = await qr.json().catch(() => null);
  // intents.near at one block: each RPC's final height, the lower one read on both
  const finals = await Promise.all(RPCS.map((url) => call(fetchFn, url, "current_salt", {}, { finality: "final" })));
  const at = Math.min(...finals.map((f) => f.height));
  const nonce = Buffer.concat([Buffer.from("5628f6c600", "hex"), Buffer.from(finals[0].value, "hex"), Buffer.alloc(8), randomBytes(15)]);
  nonce.writeBigInt64LE(BigInt(now + 120_000) * 1_000_000n, 9);
  const near = await Promise.all(
    RPCS.map(async (url) => {
      const s = await call(fetchFn, url, "current_salt", {}, { block_id: at });
      const used = await call(fetchFn, url, "is_nonce_used", { account_id: u, nonce: nonce.toString("base64") }, { block_id: at });
      return { height: s.height, salt: s.value, used: used.value };
    }),
  );
  const rr = await fetchFn(INTENTS_URL, { method: "POST", redirect: "error", headers: { "content-type": "application/json", origin: SIGN }, body: "{}" });
  const relayBody = await rr.json().catch(() => null);
  return { index, sha384: sha384(js), intents_url: js.includes(INTENTS_URL), quote: quoteFacts(qr.status, request, answer), near, relay: { status: rr.status, code: relayBody?.error ?? relayBody?.code ?? null } };
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
