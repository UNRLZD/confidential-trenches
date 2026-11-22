#!/usr/bin/env node
// Live check of card a-restored-deposit-wallets-leftover-shows: a deposit wallet (U_X) that only a restore carried, with
// no op on the device, still shows its leftover in the pool balance. The deployed signing page writes such a U_X an op
// of its own, ended as a follow's end is (packages/signpage/src/pool-deposit-follow.ts writeLeft: its left and the cost
// the restore's carry read), so state.deposit_wallets lists it. Nothing live can show that without a funded restore, so
// this reads what SIGN_HOST serves:
//   - the served /app.js is the one index.html pins (its sha384);
//   - that /app.js holds the restored op's id ("pool-restored/", POOL_RESTORED_OP), which only that write names.
// The marker is written out here, not read from the repo. The behaviour itself is proven by
// packages/signpage/test/deposit-pool-delta.test.ts ("a restore's carry of a U_X with no op writes one").
// After: sign
// Bundle: read sign
//   node scripts/live-checks/a-restored-deposit-wallets-leftover-shows.mjs [--site <dir>] [--record <file>] [--answer <file>]
// --site reads a build folder (its index.html and public/app.js) in place of SIGN_HOST: the answer this tree's build
// gives, which the deployed page must match. PASS exit 0, FAIL exit 1, error exit 2. --record writes the answer read;
// --answer replays one (the test's).
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const KEY = "a-restored-deposit-wallets-leftover-shows";
export const SIGN = "https://confidential.unrealized.trade";
export const MARKERS = ["pool-restored/"];

const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;

/** The verdict on an answer { index, app: { sha384, markers } }. */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a.index ?? "")?.[1];
  if (!pin) bad("index.html pins no /app.js");
  else if (pin !== a.app?.sha384) bad("the served /app.js is not the one index.html pins");
  for (const m of MARKERS) if (!(a.app?.markers ?? []).includes(m)) bad(`the served /app.js writes no op for a restored U_X (${JSON.stringify(m)})`);
  if (!lines.length) lines.push("OK the pinned /app.js writes a restored U_X's op, so its leftover is listed");
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
    console.log(v.ok ? `PASS ${KEY}` : `FAIL ${KEY}`);
    process.exit(v.ok ? 0 : 1);
  } catch (e) {
    console.error(`ERROR ${KEY}: ${e?.message ?? e}`);
    process.exit(2);
  }
}

/** How scripts/ci/bundle-checks.mjs runs this check on a build (its `// Bundle: read` line): `dirs` names the build
 *  folders. */
export async function bundle(f, { dirs }) {
  return judge(await read(dirs.sign));
}
