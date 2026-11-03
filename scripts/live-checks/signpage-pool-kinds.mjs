#!/usr/bin/env node
// Live check of card signpage-pool-kinds: SIGN_HOST answers the four pool kinds through the pool rule
// (packages/signpage/src/rules/pool.ts). It reads what SIGN_HOST serves:
//   - the served /app.js is the one index.html pins (its sha384);
//   - that /app.js holds the pool rule: its refusal ("pool request not allowed: ", the rule's PoolRuleRefused) and the
//     device's own read of a token's decimals (ERC-20 decimals(), selector 0x313ce567), which no other kind has.
// The markers are written out here, not read from the repo.
//   node scripts/live-checks/signpage-pool-kinds.mjs [--site <dir>] [--record <file>] [--answer <file>]
// --site reads a build folder (its index.html and public/app.js) in place of SIGN_HOST: the answer this tree's build
// gives, which the deployed page must match. PASS exit 0, FAIL exit 1, error exit 2. --record writes the answer read;
// --answer replays one (the test's).
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const SIGN = "https://sign.confidential.unrealized.trade";
export const MARKERS = ["pool request not allowed: ", "PoolRuleRefused", "0x313ce567"];

const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;

/** The verdict on an answer { index, app: { sha384, markers } }. */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a.index ?? "")?.[1];
  if (!pin) bad("index.html pins no /app.js");
  else if (pin !== a.app?.sha384) bad("the served /app.js is not the one index.html pins");
  for (const m of MARKERS) if (!(a.app?.markers ?? []).includes(m)) bad(`the served /app.js holds no pool rule (${JSON.stringify(m)})`);
  if (!lines.length) lines.push("OK the pinned /app.js holds the pool rule and the device's decimals read");
  return { ok: !lines.some((l) => l.startsWith("BAD")), lines };
}

const answerOf = (index, js) => ({ index, app: { sha384: sha384(js), markers: MARKERS.filter((m) => js.includes(m)) } });

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
    console.log(v.ok ? "PASS signpage-pool-kinds" : "FAIL signpage-pool-kinds");
    process.exit(v.ok ? 0 : 1);
  } catch (e) {
    console.error(`ERROR signpage-pool-kinds: ${e?.message ?? e}`);
    process.exit(2);
  }
}
