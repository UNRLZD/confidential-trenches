#!/usr/bin/env node
// Live check of card kit-deposit-calls on SIGN_HOST (https://confidential.unrealized.trade). What it holds, and
// only that: the served /app.js is the one index.html pins (its sha384), and its code, as minified, carries every stage
// a deposit can reach and the facts beside it (packages/kit/src/signpage/messages.ts DEPOSIT_STAGES, DEPOSIT_HOLDS,
// DepositFacts), which the kit's schema (src/signpage/schema.ts) checks on the deposit op and on deposit.confirm:
//   - the deposit stages, exactly: quote_checked, waiting, in_transit, into_vault, done, refunded, held, halted, and
//     the four this card added, failed, short, expired and refund_move;
//   - the hold reasons, exactly: halted, not_caught_up, vault_blocked;
//   - the frame copies a deposit record's five facts into state.ops (packages/signpage/src/state.ts opOf), exactly:
//     refunded, hold, held_id, since_ms, amount_usd.
// A page without them sends a short, failed, expired or refunding deposit as an op the kit's client drops, or drops the
// facts, so the app's sheet cannot show it. Each fact's stages are held by the kit's and the signing page's tests
// (packages/kit/test/signpage-client.test.mjs, packages/signpage/test/state.test.ts, the kit-deposit-calls tests).
// The recorded answers are facts() over packages/signpage/scripts/build-app.mjs bundle(pkg) of each tree (mainnet, as
// SIGN_HOST serves; this file reaches no package code: the import check holds it).
// After: sign
//   node scripts/live-checks/kit-deposit-calls.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "kit-deposit-calls";
export const SIGN = "https://confidential.unrealized.trade";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;

export const STAGES = ["quote_checked", "waiting", "in_transit", "into_vault", "done", "refunded", "held", "halted", "failed", "short", "expired", "refund_move"];
export const HOLDS = ["halted", "not_caught_up", "vault_blocked"];
export const FACT_KEYS = ["refunded", "hold", "held_id", "since_ms", "amount_usd"];

/** Every array literal of plain backtick strings in the bundle, as string lists. */
const ARRAYS = /\[((?:`[^`$\\]*`,)*`[^`$\\]*`)\]/g;

/** What the check keeps of the reads: the index, the served bundle's sha384, and the bundle's lists the card names. */
export function facts(index, js) {
  const lists = [...js.matchAll(ARRAYS)].map((m) => m[1].split(",").map((s) => s.slice(1, -1)));
  const pick = (first) => lists.filter((l) => l[0] === first && l.length >= 3);
  return {
    index,
    sha384: sha384(js),
    stages: pick("quote_checked"),
    holds: pick("halted").filter((l) => l[1] === "not_caught_up"),
    keys: pick("refunded").filter((l) => l[1] === "hold"),
  };
}

const same = (a, b) => Array.isArray(a) && a.length === b.length && a.every((x, i) => x === b[i]);

/** The verdict on an answer { index, sha384, stages, holds, keys }. */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  if (!(a?.stages ?? []).some((l) => same(l, STAGES))) {
    const near = (a?.stages ?? [])[0] ?? [];
    const missing = STAGES.filter((s) => !near.includes(s));
    bad(`the bundle's deposit stages miss ${missing.join(", ") || "none, but are not exactly the kit's"}: the app's sheet cannot show such a deposit`);
  }
  if (!(a?.holds ?? []).some((l) => same(l, HOLDS))) bad("the bundle names no hold reasons halted, not_caught_up, vault_blocked");
  if (!(a?.keys ?? []).some((l) => same(l, FACT_KEYS))) bad("the frame does not carry a deposit's facts refunded, hold, held_id, since_ms, amount_usd into state.ops");
  return { ok: !lines.some((l) => l.startsWith("BAD")), lines };
}

export async function read(fetchFn = fetch) {
  const get = async (path) => {
    const r = await fetchFn(`${SIGN}${path}`, { redirect: "error" });
    if (r.status !== 200) throw new Error(`${path}: HTTP ${r.status}`);
    return r.text();
  };
  return facts(await get("/"), await get("/app.js"));
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
