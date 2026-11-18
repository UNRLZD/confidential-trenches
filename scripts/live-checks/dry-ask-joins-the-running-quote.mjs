#!/usr/bin/env node
// Live check of card dry-ask-joins-the-running-quote: a buy box that asks for the same quote again after the kit's 10 s
// timeout gets the running quote's answer, never a second quote on the same paced reads. It reads what SIGN_HOST serves:
//   - the served /app.js is the one index.html pins (its sha384);
//   - the join (packages/signpage/src/dry-join.ts joinRunning): a map of running dries by key; a request whose key is
//     running gets that run's own after and answer; only a run (running true) is kept, under its key;
//   - the key (dryKey): every field of the request, keys sorted at every depth, as JSON;
//   - fresh after the end: the run leaves the map when its wait settles, either way, before any answer is posted;
//   - src/main.ts wraps pool.buy.dry (which routes NEAR, Base, Robinhood and Solana) and pool.sell.dry with it.
// The facts are read from the minified bundle with patterns written out here, not read from the repo.
// After: sign
// Bundle: read sign
//   node scripts/live-checks/dry-ask-joins-the-running-quote.mjs [--site <dir>] [--record <file>] [--answer <file>]
// --site reads a build folder (its index.html and public/app.js) in place of SIGN_HOST: the answer this tree's build
// gives, which the deployed page must match. PASS exit 0, FAIL exit 1, error exit 2. --record writes the answer read;
// --answer replays one (the test's).
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const SIGN = "https://confidential.unrealized.trade";

const Q = "[`\"']";
const N = "[\\w$]+";
/** The join function in `js`: its name, its key function's name and its body; null when none. */
function joinOf(js) {
  const m = new RegExp(
    `function (${N})\\((${N})\\)\\{let (${N})=new Map;return\\(?(${N})=>\\{let (${N})=(${N})\\(\\4\\),(${N})=\\3\\.get\\(\\5\\);if\\(\\7\\)return\\{running:!0,after:\\7\\.after,answer:\\7\\.answer\\};let (${N})=\\2\\(\\4\\);if\\(!${N}\\(\\8\\)\\)return \\8;\\3\\.set\\(\\5,\\8\\);([\\s\\S]{0,200}?)\\}\\)?\\}`,
  ).exec(js);
  return m ? { fn: m[1], key: m[6], map: m[3], keyVar: m[5], run: m[8], rest: m[9] } : null;
}
const esc = (s) => s.replace(/\$/g, "\\$");
/** Each fact the served /app.js must hold. */
export const FACTS = {
  join_answers_from_the_running_quote: (js) => joinOf(js) !== null,
  key_is_every_field_sorted: (js) => {
    const j = joinOf(js);
    return j !== null && new RegExp(`function ${esc(j.key)}\\((${N})\\)\\{let (${N})=(${N})=>Array\\.isArray\\(\\3\\)\\?\\3\\.map\\(\\2\\):typeof \\3==${Q}object${Q}&&\\3\\?Object\\.fromEntries\\(Object\\.keys\\(\\3\\)\\.sort\\(\\)\\.map\\((${N})=>\\[\\4,\\2\\(\\3\\[\\4\\]\\)\\]\\)\\):\\3;return JSON\\.stringify\\(\\2\\(\\1\\)\\)\\}`).test(js);
  },
  fresh_once_it_ends: (js) => {
    const j = joinOf(js);
    return j !== null && new RegExp(`^let (${N})=\\(\\)=>void\\(${esc(j.map)}\\.get\\(${esc(j.keyVar)}\\)===${esc(j.run)}&&${esc(j.map)}\\.delete\\(${esc(j.keyVar)}\\)\\);return ${esc(j.run)}\\.after\\.then\\(\\1,\\1\\),${esc(j.run)}$`).test(j.rest);
  },
  buy_dry_joins: (js) => {
    const j = joinOf(js);
    return j !== null && new RegExp(`${Q}pool\\.buy\\.dry${Q}:${esc(j.fn)}\\(`).test(js);
  },
  sell_dry_joins: (js) => {
    const j = joinOf(js);
    return j !== null && new RegExp(`${Q}pool\\.sell\\.dry${Q}:${esc(j.fn)}\\(`).test(js);
  },
};
export const FACT_NAMES = Object.keys(FACTS);

const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;

/** The verdict on an answer { index, app: { sha384, facts: { <name>: boolean } } }. */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a.index ?? "")?.[1];
  if (!pin) bad("index.html pins no /app.js");
  else if (pin !== a.app?.sha384) bad("the served /app.js is not the one index.html pins");
  for (const f of FACT_NAMES) if (a.app?.facts?.[f] !== true) bad(`the served /app.js does not hold ${f}`);
  if (!lines.length) lines.push("OK the pinned /app.js joins a buy or sell dry to the running one of the same params, and starts fresh once it ends");
  return { ok: !lines.some((l) => l.startsWith("BAD")), lines };
}

const answerOf = (index, js) => ({ index, app: { sha384: sha384(js), facts: Object.fromEntries(FACT_NAMES.map((f) => [f, FACTS[f](js)])) } });

/** Reads SIGN_HOST, or a build folder. */
export async function read(site) {
  if (site) return answerOf(readFileSync(path.join(site, "index.html"), "utf8"), readFileSync(path.join(site, "public", "app.js"), "utf8"));
  const index = await (await fetch(`${SIGN}/`)).text();
  const js = await (await fetch(`${SIGN}/app.js`)).text();
  return answerOf(index, js);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (k) => {
    const i = process.argv.indexOf(k);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  try {
    const answer = arg("--answer") ? JSON.parse(readFileSync(arg("--answer"), "utf8")) : await read(arg("--site"));
    if (arg("--record")) writeFileSync(arg("--record"), `${JSON.stringify(answer)}\n`);
    const v = judge(answer);
    for (const l of v.lines) console.log(l);
    console.log(v.ok ? "PASS dry-ask-joins-the-running-quote" : "FAIL dry-ask-joins-the-running-quote");
    process.exit(v.ok ? 0 : 1);
  } catch (e) {
    console.error(`ERROR dry-ask-joins-the-running-quote: ${e?.message ?? e}`);
    process.exit(2);
  }
}

/** How scripts/ci/bundle-checks.mjs runs this check on a build (its `// Bundle: read` line): `dirs` names the build
 *  folders. */
export async function bundle(f, { dirs }) {
  return judge(await read(dirs.sign));
}
