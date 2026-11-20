#!/usr/bin/env node
// Live check of card refunded-needs-the-refund: SIGN_HOST shows a deposit refunded only when what waits under its
// one-time id inside intents.near is the refund itself, at or over the quote's own lowest refund (the checked quote's
// amountIn less its signed refundFee), never on a speck beside the helper's REFUNDED. The rule runs on the device with a
// live quote and a refund under a seed's id, which this run never has; the package tests hold it on both follows
// (packages/wallet/test/deposit-follow.test.ts and packages/signpage/test/pool-refund-carry.test.ts, named
// "refunded-needs-the-refund", and the plants in packages/wallet/scripts/refund-move-mutants.mjs). This check reads
// that the deployed page carries that rule:
//   - the served /app.js is the one index.html pins (its sha384);
//   - that /app.js holds the rule: the pool carry's speck answer (the build writes strings as template literals), the
//     op's refund_min, and the refusal of a quote
//     whose lowest refund is no positive amount, which the page before this card has none of.
// The markers are written out here, not read from the repo.
// After: sign
// Bundle: read sign
//   node scripts/live-checks/refunded-needs-the-refund.mjs [--site <dir>] [--record <file>] [--answer <file>]
// --site reads a build folder (its index.html and public/app.js) in place of SIGN_HOST: the answer this tree's build
// gives, which the deployed page must match. PASS exit 0, FAIL exit 1, error exit 2. --record writes the answer read;
// --answer replays one (the test's).
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const SIGN = "https://confidential.unrealized.trade";
export const MARKERS = ["`speck`", "refund_min", "the quote's lowest refund is not a positive amount"];

const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;

/** The verdict on an answer { index, app: { sha384, markers } }. */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a.index ?? "")?.[1];
  if (!pin) bad("index.html pins no /app.js");
  else if (pin !== a.app?.sha384) bad("the served /app.js is not the one index.html pins");
  for (const m of MARKERS) if (!(a.app?.markers ?? []).includes(m)) bad(`the served /app.js holds no refund floor (${JSON.stringify(m)})`);
  if (!lines.length) lines.push("OK the pinned /app.js holds the refund floor: a speck is never shown refunded");
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
    console.log(v.ok ? "PASS refunded-needs-the-refund" : "FAIL refunded-needs-the-refund");
    process.exit(v.ok ? 0 : 1);
  } catch (e) {
    console.error(`ERROR refunded-needs-the-refund: ${e?.message ?? e}`);
    process.exit(2);
  }
}

/** How scripts/ci/bundle-checks.mjs runs this check on a build (its `// Bundle: read` line): `f` answers from the build
 *  folders as the host would; `dirs` names them. */
export async function bundle(f, { dirs }) {
  return judge(await read(dirs.sign));
}
