#!/usr/bin/env node
// Live check of card kit-oneclick-pins-frozen on SIGN_HOST (https://confidential.unrealized.trade). What it holds,
// and only that: the served /app.js is the one index.html pins (its sha384), and, as minified:
//   - every 1Click signing key it names (an "ed25519:" string of a 32-byte key) is one of PINNED_KEYS, the bytes this
//     file names itself, and each of PINNED_KEYS is there: a build that ships a test harness's key, or any key the
//     release does not pin, fails;
//   - each pin the device's 1Click check reads (packages/kit/src/checks/oneclick.ts and oneclick-keys.ts: the key set,
//     the USDC assets, the stablecoin and the pair fee tables) is in the bundle with exactly its pinned values, and every
//     copy of it is an Object.freeze(...) literal, so no code on the page can add a key or an asset or change a fee.
// That the frozen pins refuse every write is packages/kit/test/oneclick-pins-frozen.test.ts's, with a planted unfrozen
// copy of each. SIGN_HOST's deploy gate runs this judge on every build it uploads or lists (packages/signpage/scripts/
// deploy.mjs checkDir), so a build that fails it is never uploaded. This file reaches no package code (the import check
// holds it): its test holds PINNED_KEYS and PINS to the kit's own exports.
// After: sign
//   node scripts/live-checks/kit-oneclick-pins-frozen.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "kit-oneclick-pins-frozen";
export const SIGN = "https://confidential.unrealized.trade";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;

/** The 1Click signing keys SIGN_HOST's build may name: 1Click's one published key (SDK 0.1.26 dist/index.mjs:1593). */
export const PINNED_KEYS = Object.freeze(["ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc"]);

/** Each pin of the 1Click check with its pinned values, as an array of strings or an object of numbers. */
export const PINS = Object.freeze({
  ONECLICK_SIGNING_KEYS: PINNED_KEYS,
  ONECLICK_USDC_ASSETS: Object.freeze([
    "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
    "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near",
    "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
  ]),
  ONECLICK_FEE_BPS: Object.freeze({ keyless: 1, partner: 1 }),
  ONECLICK_PAIR_FEE_BPS: Object.freeze({ keyless: 20, partner: 20 }),
});

/** A 1Click signing key as a string: "ed25519:" and the base58 of 32 bytes (43 or 44 characters). */
const KEY_STRING = /ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}(?![1-9A-HJ-NP-Za-km-z])/g;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const str = (s) => `[\`'"]${esc(s)}[\`'"]`;
/** A pin's literal as minified (any quote, any spacing), optionally inside Object.freeze(...): group 1 is the freeze. */
function literal(values) {
  const body = Array.isArray(values)
    ? `\\[\\s*${values.map(str).join("\\s*,\\s*")}\\s*,?\\s*\\]`
    : `\\{\\s*${Object.entries(values).map(([k, v]) => `${esc(k)}\\s*:\\s*${v}`).join("\\s*,\\s*")}\\s*,?\\s*\\}`;
  return new RegExp(`(Object\\.freeze\\(\\s*)?${body}`, "g");
}

/** What the check keeps of the reads: the index, the served bundle's sha384, every key string, and per pin how many
 *  copies of its literal the bundle holds and how many of them are frozen. */
export function facts(index, js) {
  const keys = [...new Set(js.match(KEY_STRING) ?? [])];
  const pins = {};
  for (const [name, values] of Object.entries(PINS)) {
    const m = [...js.matchAll(literal(values))];
    // a frozen copy closes its Object.freeze( right after the literal
    const frozen = m.filter((x) => x[1] !== undefined && /^\s*\)/.test(js.slice(x.index + x[0].length))).length;
    pins[name] = { copies: m.length, frozen };
  }
  return { index, sha384: sha384(js), keys, pins };
}

/** The verdict on an answer { index, sha384, keys, pins }. */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  const keys = Array.isArray(a?.keys) ? a.keys : [];
  for (const k of keys) if (!PINNED_KEYS.includes(k)) bad(`the bundle names the 1Click key ${k}, which the release does not pin: a test harness's key, or one no 1Click release names`);
  for (const k of PINNED_KEYS) if (!keys.includes(k)) bad(`the bundle does not name the pinned 1Click key ${k}`);
  for (const name of Object.keys(PINS)) {
    const p = a?.pins?.[name];
    if (!p || !Number.isInteger(p.copies) || p.copies < 1) bad(`the bundle holds no ${name} with exactly its pinned values`);
    else if (p.frozen !== p.copies) bad(`${p.copies - (Number.isInteger(p.frozen) ? p.frozen : 0)} of ${p.copies} copies of ${name} in the bundle are not frozen: code on the page could change it`);
  }
  return { ok: lines.length === 0, lines };
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
