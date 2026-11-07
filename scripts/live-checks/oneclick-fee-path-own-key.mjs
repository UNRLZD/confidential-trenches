#!/usr/bin/env node
// Live check of card oneclick-fee-path-own-key on SIGN_HOST (https://sign.confidential.unrealized.trade). What it holds,
// and only that: the served /app.js is the one index.html pins (its sha384), and in it, as minified, the device's 1Click
// fee by path (packages/kit/src/checks/oneclick.ts oneClickFeeBps) reads its two fee tables only as own keys and refuses
// any other path by name:
//   - the bundle holds each fee table, ONECLICK_FEE_BPS {keyless: 1, partner: 1} and ONECLICK_PAIR_FEE_BPS {keyless: 20,
//     partner: 20}, assigned to a name;
//   - every read of either table by a key that is not a literal, `T[k]`, sits in a function that first checks
//     Object.hasOwn(T, k) for that table and that key and holds the refusal "no such 1Click path". A read through the
//     prototype chain, as SIGN_HOST served before this card (release-68), lets a polluted Object.prototype.nopath = 1
//     name a fee for a path that does not exist, and a real dry quote on it passed the device's check.
// That the check refuses such a quote is packages/kit/test/oneclick.test.ts's ("a path outside keyless and partner names
// no fee, even when a polluted Object.prototype has one"); this check reads that the build SIGN_HOST serves carries it.
// This file reaches no package code (the import check holds it): its test holds TABLES to the kit's own exports.
//   node scripts/live-checks/oneclick-fee-path-own-key.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "oneclick-fee-path-own-key";
export const SIGN = "https://sign.confidential.unrealized.trade";
export const REFUSAL = "no such 1Click path";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;

/** The two fee tables the device's 1Click check reads by path, with their pinned values. */
export const TABLES = Object.freeze({
  ONECLICK_FEE_BPS: Object.freeze({ keyless: 1, partner: 1 }),
  ONECLICK_PAIR_FEE_BPS: Object.freeze({ keyless: 20, partner: 20 }),
});

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const ID = "[A-Za-z_$][\\w$]*";
/** `name=` then the table's literal as minified (any spacing, any quotes on a key), optionally inside Object.freeze(. */
const assigned = (values) =>
  new RegExp(`(?<![\\w$.])(${ID})\\s*=\\s*(?:Object\\.freeze\\(\\s*)?\\{\\s*${Object.entries(values).map(([k, v]) => `[\`'"]?${esc(k)}[\`'"]?\\s*:\\s*${v}`).join("\\s*,\\s*")}\\s*,?\\s*\\}`, "g");

/** What the check keeps of the reads: the index, the served bundle's sha384, per table the names it is assigned to, and
 *  every read of one of those names by a non-literal key, with whether its function checks Object.hasOwn for that table
 *  and key first and holds the refusal. */
export function facts(index, js) {
  const tables = {};
  const reads = [];
  for (const [table, values] of Object.entries(TABLES)) {
    const names = [...new Set([...js.matchAll(assigned(values))].map((m) => m[1]))];
    tables[table] = names;
    for (const name of names) {
      for (const m of js.matchAll(new RegExp(`(?<![\\w$.])${esc(name)}\\[(${ID})\\]`, "g"))) {
        const key = m[1];
        const start = js.lastIndexOf("function", m.index);
        const body = js.slice(start < 0 ? 0 : start, m.index);
        const owns = new RegExp(`Object\\.hasOwn\\(\\s*${esc(name)}\\s*,\\s*${esc(key)}\\s*\\)`).test(body);
        reads.push({ table, name, key, owns, refuses: body.includes(REFUSAL) });
      }
    }
  }
  return { index, sha384: sha384(js), tables, reads };
}

/** The verdict on an answer { index, sha384, tables, reads }. */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  const reads = Array.isArray(a?.reads) ? a.reads : [];
  for (const table of Object.keys(TABLES)) {
    const names = a?.tables?.[table];
    if (!Array.isArray(names) || names.length === 0) bad(`the bundle holds no ${table} with exactly its pinned values`);
    else if (!reads.some((r) => r?.table === table)) bad(`the bundle never reads ${table} by path`);
  }
  for (const r of reads) {
    if (!r?.owns) bad(`${r?.table} is read as ${r?.name}[${r?.key}] with no Object.hasOwn(${r?.name}, ${r?.key}) first: a polluted Object.prototype can name a fee for a path that does not exist`);
    else if (!r.refuses) bad(`${r.table}'s read ${r.name}[${r.key}] is in a function without the refusal "${REFUSAL}"`);
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
