#!/usr/bin/env node
// Live check of card pump-curve-upgrade-still-buys on SIGN_HOST (https://confidential.unrealized.trade). pump's upgrade
// of 2026-11-13 20:12:28Z (programdata slot 469055660) grew its Global account from 1,088 to 1,096 bytes (one u64
// appended), and the kit's venue read (packages/kit/src/trade/solana/pool-buy.ts pumpGlobalFeeRecipient) refused any
// Global but 1,088 bytes, so every pump.fun curve buy and sell the signing page built stopped before it was signed.
// What it proves, and only that: the served /app.js is the one index.html pins (its sha384); the bundle's check on
// pump Global's size, found by its refusal's text, accepts the sizes it lists; and pump's Global, read now on two
// public mainnet RPCs, is one size on both and one the served bundle accepts. So it also fails the day pump grows Global
// again. It does not prove a buy lands: that is the pool's LiteSVM buy and sell on mainnet's code
// (contracts/pool-solana/svm-tests, fixtures/venues/pump.json) and the kit's test at the released commit.
// An RPC that answers nothing usable is its no-answer (provider-answer.mjs), never a wrong answer: with fewer than two
// sizes read the check is INCONCLUSIVE. On a pull request's build (scripts/ci/bundle-checks.mjs) `bundle` judges the
// build alone: its pin, and a size check that takes GLOBAL_SIZE_AT_CARD, the size mainnet held when this card landed.
// After: sign
// Bundle: read sign
//   node scripts/live-checks/pump-curve-upgrade-still-buys.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2, INCONCLUSIVE exit 3.
import "../net-window.mjs";
import { EXIT, rpcAnswer, verdictOf } from "./provider-answer.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "pump-curve-upgrade-still-buys";
export const SIGN = "https://confidential.unrealized.trade";
export const RPCS = ["https://api.mainnet-beta.solana.com", "https://solana-rpc.publicnode.com"];
const PUMP = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
/** pump's Global, the PDA of ["global"] under pump's program (the kit's PUMP_GLOBAL). */
export const PUMP_GLOBAL = "4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf";
/** Global's size on both RPCs after pump's upgrade of 2026-11-13 20:12:28Z (slot 469057462). */
export const GLOBAL_SIZE_AT_CARD = 1096;
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;
const esc = (s) => s.replace(/[$]/g, "\\$");

/** The Global sizes the bundle's check accepts, from its one refusal "pump Global is N bytes, not ...": a list
 *  (`!L.includes(e.data.length)`, L defined as an array of numbers) or a single size (`e.data.length!==N`); null when
 *  the refusal is missing, repeated or of another shape. */
export function acceptedSizes(js) {
  const all = js.match(/throw Error\(`pump Global is /g) ?? [];
  if (all.length !== 1) return null;
  const list = /!([\w$]+)\.includes\(([\w$]+)\.data\.length\)\)throw Error\(`pump Global is \$\{\2\.data\.length\} bytes, not \$\{\1\.join\(` or `\)\}`\)/.exec(js);
  if (list) {
    const defs = [...js.matchAll(new RegExp(`(?<![\\w$.])${esc(list[1])}=\\[(\\d+(?:,\\d+)*)\\][,;]`, "g"))];
    return defs.length === 1 ? defs[0][1].split(",").map(Number) : null;
  }
  const one = /([\w$]+)\.data\.length!==(\d+)\)throw Error\(`pump Global is \$\{\1\.data\.length\} bytes, not /.exec(js);
  return one ? [Number(one[2])] : null;
}

/** What the check keeps of the reads: the index, the served bundle's sha384, the sizes it accepts, and Global's size
 *  on each RPC (null when it gave no account of pump's). */
export function facts(index, js, globalSizes) {
  return { index, sha384: sha384(js), accepts: acceptedSizes(js), globalSizes };
}

/** The build's own lines: SIGN_HOST's pin, and the sizes the bundle's check accepts (or null with a BAD line). */
function bundleLines(a, lines) {
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) lines.push("BAD SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sha384) lines.push("BAD SIGN_HOST's served /app.js is not the one index.html pins");
  const accepts = Array.isArray(a?.accepts) && a.accepts.length > 0 && a.accepts.every((n) => Number.isSafeInteger(n) && n > 0) ? a.accepts : null;
  if (!accepts) lines.push("BAD the served bundle has no check of pump Global's size");
  return accepts;
}

/** The verdict on an answer { index, sha384, accepts, globalSizes, noAnswers }: FAIL on a bad build or a mainnet size
 *  the build refuses; INCONCLUSIVE when an RPC gave no size (its no-answer named); else PASS. */
export function judge(a) {
  const lines = [];
  const accepts = bundleLines(a, lines);
  const raw = Array.isArray(a?.globalSizes) && a.globalSizes.length === RPCS.length ? a.globalSizes : [null, null];
  const sizes = raw.filter((n) => Number.isSafeInteger(n) && n > 0);
  const wrong = raw.filter((n) => n !== null && !(Number.isSafeInteger(n) && n > 0)).length;
  for (const why of Array.isArray(a?.noAnswers) ? a.noAnswers : []) lines.push(`--  ${why}`);
  const quiet = sizes.length + wrong < RPCS.length;
  if (wrong) lines.push(`BAD ${wrong} RPC(s) answered with no pump Global`);
  else if (quiet) lines.push(`--  pump Global read on ${sizes.length} of ${RPCS.length} RPCs: INCONCLUSIVE`);
  else if (sizes.some((n) => n !== sizes[0])) lines.push(`BAD the RPCs read pump Global at different sizes: ${sizes.join(", ")}`);
  else if (accepts && !accepts.includes(sizes[0])) lines.push(`BAD pump Global is ${sizes[0]} bytes on mainnet and the served bundle accepts only ${accepts.join(" or ")}`);
  const bad = lines.some((l) => l.startsWith("BAD"));
  const verdict = verdictOf(bad, quiet);
  return { ok: verdict === "PASS", verdict, lines };
}

/** The build alone (scripts/ci/bundle-checks.mjs): its pin, and a size check that takes GLOBAL_SIZE_AT_CARD. */
export function judgeBundle(a) {
  const lines = [];
  const accepts = bundleLines(a, lines);
  if (accepts && !accepts.includes(GLOBAL_SIZE_AT_CARD)) lines.push(`BAD the bundle accepts only ${accepts.join(" or ")}, not the ${GLOBAL_SIZE_AT_CARD}-byte Global`);
  return { ok: lines.length === 0, lines };
}

/** Global's size on one RPC, or its no-answer: the account's base64 data length, when it is pump's and not executable;
 *  any other answer is a wrong one (size 0, judged). */
async function globalSize(url, fetchFn) {
  const a = await rpcAnswer(url, "getAccountInfo", [PUMP_GLOBAL, { encoding: "base64", commitment: "confirmed" }], { fetchFn, redirect: "error" });
  if (a.noAnswer !== undefined) return { noAnswer: a.noAnswer };
  const v = a.result?.value;
  if (a.error !== undefined || !v || v.owner !== PUMP || v.executable !== false || !Array.isArray(v.data) || v.data[1] !== "base64" || typeof v.data[0] !== "string" || v.data[0].length > 64 * 1024) return { size: 0 };
  return { size: Buffer.from(v.data[0], "base64").length };
}

const getter = (fetchFn) => async (path) => {
  const r = await fetchFn(`${SIGN}${path}`, { redirect: "error" });
  if (r.status !== 200) throw new Error(`${path}: HTTP ${r.status}`);
  return r.text();
};

export async function bundle(fetchFn = fetch) {
  const get = getter(fetchFn);
  const [index, js] = [await get("/"), await get("/app.js")];
  return judgeBundle(facts(index, js, []));
}

export async function read(fetchFn = fetch) {
  const get = getter(fetchFn);
  const [index, js] = [await get("/"), await get("/app.js")];
  const reads = [];
  for (const url of RPCS) reads.push(await globalSize(url, fetchFn));
  const noAnswers = reads.filter((r) => r.noAnswer !== undefined).map((r) => r.noAnswer);
  return { ...facts(index, js, reads.map((r) => r.size ?? null)), ...(noAnswers.length ? { noAnswers } : {}) };
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
    console.log(`${v.verdict} ${KEY}`);
    process.exit(EXIT[v.verdict]);
  } catch (e) {
    console.error(`ERROR ${KEY}: ${e?.message ?? e}`);
    process.exit(2);
  }
}
