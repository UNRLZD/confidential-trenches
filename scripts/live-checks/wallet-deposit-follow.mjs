#!/usr/bin/env node
// Live check of card wallet-deposit-follow: after SIGN_HOST shows a checked deposit address, the device carries the
// deposit to its note with no tap (packages/wallet/src/deposit/follow.ts, packages/signpage/src/deposit-follow.ts).
// What it holds on what is deployed, and only that:
//   - SIGN_HOST's served /app.js is the one its index.html pins (sha384), and its code carries the follow: the status
//     read's URL on the helper's proxy (/v1/proxy/oneclick/v0/status) and the follow's lock (ct-wallet/deposit-follow/);
//   - the helper's keyed proxy answers the status of a real deposit address of ours (the G1 arm-swap live run's,
//     a998c658..., a partner-path quote; keyless status answered 404 for such quotes on 22 Oct, wallet.md D9) the way
//     the device's read takes it: POST /v1/proxy/oneclick/v0/status?depositAddress=<it>, with Origin APP_HOST, answers
//     200 from X-Helper-Source oneclick, JSON whose status is one of 1Click's seven and whose quoteResponse names that
//     same deposit address.
// A page without the follow leaves every deposit at its address until a tap; a helper that answers the status another
// way (a 405, a 404, another address) leaves the device reading nothing, so no deposit moves past waiting.
// The recorded answers: facts() over this card's committed SIGN_HOST build (packages/signpage/index.html and
// public/app.js) and the helper's live answer; the bad one SIGN_HOST as served before the card and the helper asked by GET.
// After: sign
//   node scripts/live-checks/wallet-deposit-follow.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "wallet-deposit-follow";
export const SIGN = "https://confidential.unrealized.trade";
export const HELPER = "https://ct-api.unrealized.trade";
export const APP = "https://ct-app.unrealized.trade";
export const STATUS_PATH = "/v1/proxy/oneclick/v0/status";
export const LOCK = "ct-wallet/deposit-follow/";
/** The G1 arm-swap live run's deposit address (research proofs/g1-arm-swap, packages/kit/test/fixtures/oneclick-quotes.json live). */
export const ADDRESS = "a998c6585100ca4bccbc0e0bcceb9abd66e59666e87bd03b1d83bb9544f7ce2f";
export const STATUSES = ["PENDING_DEPOSIT", "KNOWN_DEPOSIT_TX", "PROCESSING", "INCOMPLETE_DEPOSIT", "SUCCESS", "REFUNDED", "FAILED"];
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;

/**
 * What the check keeps of a status answer: its HTTP status, its X-Helper-Source, and of its JSON only the two fields
 * judged (the status and the address the quote names; the quote's signature and amounts are not kept).
 */
export function helperFacts(status, source, body) {
  let j;
  try {
    j = JSON.parse(body);
  } catch {
    j = undefined;
  }
  return { status, source, answer: { status: j?.status, depositAddress: j?.quoteResponse?.quote?.depositAddress } };
}

/** What the check keeps of the reads: the index, the bundle's sha384 and markers, the helper's answer. */
export function facts(index, js, helper) {
  return { index, sha384: sha384(js), status_url: js.includes(STATUS_PATH), lock: js.includes(LOCK), helper };
}

/** The verdict on an answer { index, sha384, status_url, lock, helper: { status, source, answer: { status, depositAddress } } }. */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  if (a?.status_url !== true) bad(`SIGN_HOST's bundle reads no deposit status on the helper's proxy (${STATUS_PATH})`);
  if (a?.lock !== true) bad(`SIGN_HOST's bundle has no deposit follow (${LOCK})`);
  const h = a?.helper ?? {};
  if (h.status !== 200) bad(`the helper's status read answers ${h.status}, not 200`);
  if (h.source !== "oneclick") bad(`the helper's status read is not 1Click's (X-Helper-Source ${JSON.stringify(h.source)})`);
  const j = h.answer ?? {};
  if (!STATUSES.includes(j.status)) bad(`the status answer names none of 1Click's seven statuses (${JSON.stringify(j.status)})`);
  if (j.depositAddress !== ADDRESS) bad("the status answer does not name the address asked");
  return { ok: !lines.some((l) => l.startsWith("BAD")), lines };
}

export async function read(fetchFn = fetch) {
  const get = async (path) => {
    const r = await fetchFn(`${SIGN}${path}`, { redirect: "error" });
    if (r.status !== 200) throw new Error(`${path}: HTTP ${r.status}`);
    return r.text();
  };
  const index = await get("/");
  const js = await get("/app.js");
  const r = await fetchFn(`${HELPER}${STATUS_PATH}?depositAddress=${ADDRESS}`, { method: "POST", redirect: "error", headers: { origin: APP, "cache-control": "no-cache" } });
  return facts(index, js, helperFacts(r.status, r.headers.get("x-helper-source"), await r.text()));
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
