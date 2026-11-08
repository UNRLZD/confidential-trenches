#!/usr/bin/env node
// Live check of card signpage-withdraw-own-spend on SIGN_HOST (https://confidential.unrealized.trade), which
// serves the mainnet build: a withdraw's owed sends (their attempt and context) live in the wallet store's meta under
// owed/<op id>, which the frame's reader neither reads nor lists, so the ops records the frame decrypts hold none
// (round-3 review LOW 2), and the database stays at version 1, so a rollback of SIGN_HOST never locks a wallet (fold 3).
// It reads SIGN_HOST's index.html and the /app.js it serves, and judges:
//   - the served /app.js is the one index.html pins (its sha384);
//   - the bundle's wallet store list is the paper's seven stores, no more, and it opens its database at version 1;
//   - the bundle's store takes owed/<op id> as a meta key (its rule /^owed\/[^/]{1,200}$/), and its reader leaves
//     owed/ keys out of what it lists for meta: the reader's keys() filter, found after the reader's own refusal text,
//     evaluated on meta/owed/1 (left out) and meta/status (listed), so the minifier's shape of it (!a&&!b, !(a||b) or
//     any other) is not what is judged (card signpage-check-shapes-on-build);
//   - the page reads its seed again on another tab's meta write, but never on an owed send's (the store's change event
//     names the key written, and the seed-move test skips owed/ keys: fold 4).
// The withdraw run's own-spend reads (src/pool-withdraw.ts spendOwner) are in the testnet build only, which no host
// serves; the pool-withdraw and pool-testnet tests and the round-3 probes cover them.
// After: sign
//   node scripts/live-checks/signpage-withdraw-own-spend.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "signpage-withdraw-own-spend";
export const SIGN = "https://confidential.unrealized.trade";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;
// the minified store list, quoted with backticks or double quotes: the paper's seven, then any more
const STORES = /\[([`"])notes\1,\1wallets\1,\1quotes\1,\1orders\1,\1ops\1,\1counters\1,\1meta\1((?:,\1[a-z]+\1)*)\]/;
const OPENS_V1 = /\.open\([A-Za-z_$][\w$]*,1\)/;
const OWED_KEY = "/^owed\\/[^/]{1,200}$/";
// the seed-move test's: the event's `.key.startsWith("owed/")`
const SEED_MOVED = /\.key\.startsWith\(([`"])owed\/\1\)/;
// The reader (packages/wallet/src/store/index.ts, the frame's reader): its get() refuses with this text, and the keys()
// next to it filters what it lists, `(x) => !(store === "meta" && (... || x.startsWith(WALLET_OWED_PREFIX) || ...))`.
const READER_AT = "the reader opens meta/status";
const KEYS = /async keys\(([A-Za-z_$][\w$]*)\)\{[^{}]*?\.filter\(\(?([A-Za-z_$][\w$]*)\)?=>/;
const TOKEN = /\s*(?:(===|!==|==|!=|&&|\|\||[!().?:])|([A-Za-z_$][\w$]*)|`([^`$\\]*)`|"([^"\\]*)"|'([^'\\]*)'|(\d+))/y;

/** The reader's keys() filter in `js`: { store, key, body } (the arrow's parameter names and its expression), or null. */
export function readerFilter(js) {
  const at = js.indexOf(READER_AT);
  if (at < 0) return null;
  const tail = js.slice(at, at + 4000);
  const m = KEYS.exec(tail);
  if (!m) return null;
  let depth = 1;
  let i = m.index + m[0].length;
  const start = i;
  for (let q = null; i < tail.length; i++) {
    const c = tail[i];
    if (q) {
      if (c === "\\") i++;
      else if (c === q) q = null;
    } else if (c === "`" || c === '"' || c === "'") q = c;
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) break;
  }
  return depth === 0 ? { store: m[1], key: m[2], body: tail.slice(start, i) } : null;
}

/**
 * The value of a filter body for one store and key: a small evaluator of the forms a minifier writes for it (!, &&, ||,
 * ?:, ===, !==, ==, !=, parentheses, string and number literals, and <name>.startsWith(<string>)); any other name is
 * an opaque constant, equal only to itself. Nothing in the bundle is run. Throws on anything else.
 */
export function evalFilter({ store, key, body }, storeValue, keyValue) {
  const toks = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < body.trimEnd().length) {
    const t = TOKEN.exec(body);
    if (!t) throw new Error(`the reader's filter has a form this check does not read at ${TOKEN.lastIndex}`);
    toks.push(t[1] ? { p: t[1] } : t[2] ? { id: t[2] } : t[6] ? { v: Number(t[6]) } : { v: t[3] ?? t[4] ?? t[5] });
  }
  let n = 0;
  const peek = (p) => toks[n]?.p === p;
  const take = (p) => {
    if (!peek(p)) throw new Error(`the reader's filter: ${p} expected`);
    n++;
  };
  const opaque = new Map();
  const ternary = () => {
    const c = or();
    if (!peek("?")) return c;
    n++;
    const a = ternary();
    take(":");
    const b = ternary();
    return c ? a : b;
  };
  const or = () => {
    let v = and();
    while (peek("||")) {
      n++;
      const r = and();
      v = v || r;
    }
    return v;
  };
  const and = () => {
    let v = eq();
    while (peek("&&")) {
      n++;
      const r = eq();
      v = v && r;
    }
    return v;
  };
  const eq = () => {
    const a = unary();
    const op = toks[n]?.p;
    if (!["===", "!==", "==", "!="].includes(op)) return a;
    n++;
    const same = a === unary();
    return op.startsWith("=") ? same : !same;
  };
  const unary = () => (peek("!") ? (n++, !unary()) : primary());
  const primary = () => {
    const t = toks[n++];
    if (t?.p === "(") {
      const v = ternary();
      take(")");
      return v;
    }
    if (t && "v" in t) return t.v;
    if (!t?.id) throw new Error("the reader's filter: a value expected");
    const v = t.id === key ? keyValue : t.id === store ? storeValue : opaque.get(t.id) ?? (opaque.set(t.id, { name: t.id }), opaque.get(t.id));
    if (!peek(".")) return v;
    n++;
    const f = toks[n++];
    if (f?.id !== "startsWith" || typeof v !== "string") throw new Error("the reader's filter: only <key>.startsWith(<string>) is read");
    take("(");
    const arg = ternary();
    take(")");
    if (typeof arg !== "string") throw new Error("the reader's filter: startsWith takes a string");
    return v.startsWith(arg);
  };
  const v = ternary();
  if (n !== toks.length) throw new Error("the reader's filter: text after its expression");
  return v;
}

/** True when the bundle's reader leaves meta/owed/<op id> out of what it lists and still lists meta/status. */
export function readerHidesOwed(js) {
  const f = readerFilter(js);
  if (!f) return false;
  try {
    return !evalFilter(f, "meta", "owed/1") && !!evalFilter(f, "meta", "status");
  } catch {
    return false;
  }
}

/** What the check keeps of the reads: the index, the served bundle's sha384 and the facts read from it. */
export function facts(index, js) {
  const m = STORES.exec(js);
  return { index, sha384: sha384(js), stores: m ? m[0] : null, opensV1: OPENS_V1.test(js), owedKey: js.includes(OWED_KEY), readerHidesOwed: readerHidesOwed(js), seedMovedSkipsOwed: SEED_MOVED.test(js) };
}

/** The verdict on an answer { index, sha384, stores, opensV1, owedKey, readerHidesOwed, seedMovedSkipsOwed }. */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  const more = typeof a?.stores === "string" ? (STORES.exec(a.stores)?.[2] ?? "") : null;
  if (more === null) bad("the bundle's wallet store list is not found");
  else if (more !== "") bad("the wallet store names a store past the paper's seven: its database would need a version past 1");
  if (a?.opensV1 !== true) bad("the wallet store does not open its database at version 1: a rollback of SIGN_HOST would lock every wallet");
  if (a?.owedKey !== true) bad("the wallet store takes no owed/<op id> meta key: an owed send's context would sit in the ops the frame reads");
  if (a?.readerHidesOwed !== true) bad("the frame's reader lists owed/ keys of meta");
  if (a?.seedMovedSkipsOwed !== true) bad("the page reads its seed again on every owed send's write in another tab");
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
