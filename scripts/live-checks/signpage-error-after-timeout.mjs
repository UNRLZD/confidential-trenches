#!/usr/bin/env node
// Live check of card signpage-error-after-timeout on SIGN_HOST (https://confidential.unrealized.trade). What it
// holds, and only that: the served /app.js is the one index.html pins (its sha384), and its api (src/api.ts startApi),
// as minified, posts a trade kind's end as a progress stage after the kind's answer:
//   - a kind answered by running hands `give` whether its kind is in the trade set (`let e=kc.has(l.type)`; from card
//     kit-frame-version the request's kind is read once, `let _=d.type`, and handed to `give` first, `let e=rl.has(_)`),
//     and the set holds buy, pool.buy, pool.sell and pool.deposit;
//   - `give`, for such a kind, posts "refused" for a refusal (never for id_reused) or the result's own stage, when that
//     stage ends a trade (filled, part_filled, not_landed, refused) and was not posted already.
// The kit's client drops an answer that comes past its 10 s window; the app then ends the trade's button and strip on a
// progress stage alone (apps/terminal/src/screens/trade/model.ts progress, route.ts fromStage), so without this a trade
// refused late leaves its button stuck. Each kind's own path is held by its test in packages/signpage/test (trade,
// pool-buy, pool-sell, pool-deposit, pool-kinds, api: a refusal through the api reaches the app as progress refused).
// The recorded answers are facts() over packages/signpage/scripts/build-app.mjs bundle(pkg) of each tree (mainnet, as
// SIGN_HOST serves; this file reaches no package code: the import check holds it).
//   node scripts/live-checks/signpage-error-after-timeout.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "signpage-error-after-timeout";
export const SIGN = "https://confidential.unrealized.trade";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;

export const TRADE_KINDS = ["buy", "pool.buy", "pool.sell", "pool.deposit"];
export const END_STAGES = ["filled", "part_filled", "not_landed", "refused"];

/** Every `X=new Set([`a`,`b`])` of string literals in the bundle, by its name. */
const SETS = /([\w$]+)=new Set\(\[((?:`[^`$\\]*`,?)*)\]\)/g;
/** The api's Running branch: the trade set's verdict on the request's kind handed to `give` with the answer. Before card
 *  kit-frame-version (`set`: the trade set's name in group 3) and after it, where the kind is read once and handed to
 *  `give` too (group 7). */
const RUNNING = new RegExp(
  [
    /if\([\w$]+&&`running`in ([\w$]+)\)\{[^]{0,120}?let ([\w$]+)=([\w$]+)\.has\([\w$]+\.type\);\1\.after\.catch\(\(\)=>\{\}\)\.then\(\(\)=>[\w$]+\([\w$]+,[\w$]+,\1\.answer\(\),[\w$]+,\2\)\);return\}/.source,
    /let ([\w$]+)=[\w$]+\.type,([\w$]+)=[\w$]+\([^]{0,80}?\);if\(\5&&`running`in \5\)\{[^]{0,120}?let ([\w$]+)=([\w$]+)\.has\(\4\);\5\.after\.catch\(\(\)=>\{\}\)\.then\(\(\)=>[\w$]+\(\4,[\w$]+,[\w$]+,\5\.answer\(\),[\w$]+,\6\)\);return\}/.source,
  ].join("|"),
);
/** `give`'s end: refused for a refusal but id_reused, else the result's stage; posted when it ends a trade, once. */
const RULE = /if\(([\w$]+)\)\{let ([\w$]+)=([\w$]+)\?\3\.result\.stage:[\w$]+===`id_reused`\?null:`refused`;typeof \2==`string`&&([\w$]+)\.has\(\2\)&&![\w$]+\.includes\(\2\)&&[\w$]+\(\2\)\}/;

/** What the check keeps of the reads: the index, the served bundle's sha384, and the facts read from the bundle. */
export function facts(index, js) {
  const sets = new Map([...js.matchAll(SETS)].map((m) => [m[1], m[2] ? m[2].split(",").map((s) => s.slice(1, -1)) : []]));
  const running = RUNNING.exec(js);
  const rule = RULE.exec(js);
  return {
    index,
    sha384: sha384(js),
    running: running?.[0] ?? null,
    kinds: running ? (sets.get(running[3] ?? running[7]) ?? null) : null,
    rule: rule?.[0] ?? null,
    ends: rule ? (sets.get(rule[4]) ?? null) : null,
  };
}

/** The verdict on an answer { index, sha384, running, kinds, rule, ends }. */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  if (typeof a?.running !== "string" || typeof a?.rule !== "string") {
    bad("the bundle does not post a trade kind's end as progress after its answer: a trade refused past the client's 10 s leaves the app's button stuck");
  } else {
    const missing = TRADE_KINDS.filter((k) => !a.kinds?.includes(k));
    if (missing.length) bad(`the bundle's trade kinds whose end goes out as progress miss ${missing.join(", ")}`);
    const short = END_STAGES.filter((s) => !a.ends?.includes(s));
    if (short.length) bad(`the bundle's end stages miss ${short.join(", ")}`);
  }
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
