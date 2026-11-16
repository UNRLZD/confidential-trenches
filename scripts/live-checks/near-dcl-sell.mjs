#!/usr/bin/env node
// Live check of card near-dcl-sell on SIGN_HOST (https://confidential.unrealized.trade). What it holds, and only that:
// the served /app.js is the one index.html pins (its sha384), it is the /app.js of a written release list from this
// card's release on (packages/signpage/releases/release-<N>.json, N >= FIRST_RELEASE), so its bytes are a build of
// source whose tests ran; and in it, as minified, the device's Rhea DCL sell:
//   - quote: the kit's dclQuote, DCL's own quote view on two providers (its refusal text "no Running DCL pool among"),
//     which the pair read (readNearSwapPair) runs beside Rhea classic to take the venue that pays more;
//   - swap: the DCL Swap W signs, into DCL's exchange (dclv2.ref-labs.near) with its minimum ("min_output_amount");
//   - check: the kit's dclSwapCheck that W's signer runs on a DCL quote before W's key signs (its refusal text "msg: the
//     Swap's keys (no referrer, no echo)").
// The sale's calls, their exact bytes, the venue pick, W's calls read back and the candidates made on the device are held
// by the card's tests (packages/kit/test/near-dcl-pair.test.ts, packages/wallet/test/near-swap-delegate-dcl.test.ts,
// packages/signpage/test/near-sell.test.ts, near-pools.test.ts, near-w-calls-dcl.test.ts). Not held here: that the page's
// sell asks DCL on its pair read: the page binds the pair in packages/signpage/src/near-buy.ts (nearReads), which passes
// the sell's DCL candidates on only from the card that wires the DCL buy there. The money run itself is the owner's.
// The recorded answers are facts() over a tree's index.html and app.js as build-app.mjs writes them, or SIGN_HOST's own
// page. This file reaches no package code (the import check holds it). The PR's own build runs judge(read, { ledger:
// false }) in scripts/ci/bundle-checks.mjs, since it is cut as a release only after its merge.
// After: sign
// Bundle: read sign
//   node scripts/live-checks/near-dcl-sell.mjs [--record <file>] [--answer <file>] [--built <dir>]
//   --built <dir>: index.html and app.js read from a build folder (build-app.mjs --out <dir>) instead of SIGN_HOST
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KEY = "near-dcl-sell";
export const SIGN = "https://confidential.unrealized.trade";
/** This card's release: the first list cut after release-163 (main's newest when this card was built, without it). */
export const FIRST_RELEASE = 164;
const RELEASES = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."), "packages/signpage/releases");
/** The SIGN_HOST /app.js of every written release list from FIRST_RELEASE on: its sha384 to its release. */
export function releasedAppJs(dir = RELEASES, from = FIRST_RELEASE) {
  const out = new Map();
  for (const f of readdirSync(dir)) {
    const n = /^release-(\d+)\.json$/.exec(f)?.[1];
    if (n === undefined || Number(n) < from) continue;
    const app = JSON.parse(readFileSync(path.join(dir, f), "utf8")).hosts?.SIGN_HOST?.files?.find((x) => x.path === "/app.js");
    if (typeof app?.sha384 === "string") out.set(app.sha384, `release-${n}`);
  }
  return out;
}
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;
const has = (js, ...marks) => marks.every((m) => js.includes(m));

/** What the check keeps of the reads: the index, the served bundle's sha384, and whether the bundle holds each mark. */
export function facts(index, js) {
  return {
    index,
    sha384: sha384(js),
    quote: has(js, "no Running DCL pool among"),
    swap: has(js, "dclv2.ref-labs.near", "min_output_amount"),
    check: has(js, "msg: the Swap's keys (no referrer, no echo)"),
  };
}

export const MARKS = {
  quote: "the page quotes no Rhea DCL pool: a NEAR sell is priced on Rhea classic alone",
  swap: "the page builds no Rhea DCL Swap",
  check: "the page's signer holds no DCL Swap to its quote before W signs",
};

/** The verdict on an answer, against the release lists' /app.js files (none with `ledger: false`). */
export function judge(a, { ledger = true, released = ledger ? releasedAppJs() : null } = {}) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  if (released && !released.has(a?.sha384)) bad("SIGN_HOST's served /app.js is the /app.js of no release list of this card's on: bytes no tested source built");
  for (const [k, m] of Object.entries(MARKS)) if (a?.[k] !== true) bad(m);
  return { ok: lines.length === 0, lines };
}

export async function read(fetchFn = fetch) {
  const get = async (p) => {
    const r = await fetchFn(`${SIGN}${p}`, { redirect: "error" });
    if (r.status !== 200) throw new Error(`${p}: HTTP ${r.status}`);
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
    const built = arg("--built");
    const answer = arg("--answer")
      ? JSON.parse(readFileSync(arg("--answer"), "utf8"))
      : built
        ? facts(readFileSync(path.join(built, "index.html"), "utf8"), readFileSync(path.join(built, "app.js"), "utf8"))
        : await read();
    if (arg("--record")) writeFileSync(arg("--record"), `${JSON.stringify(answer)}\n`);
    const v = judge(answer, built ? { ledger: false } : {});
    for (const l of v.lines) console.log(l);
    console.log(v.ok ? `PASS ${KEY}` : `FAIL ${KEY}`);
    process.exit(v.ok ? 0 : 1);
  } catch (e) {
    console.error(`ERROR ${KEY}: ${e?.message ?? e}`);
    process.exit(2);
  }
}

/** How scripts/ci/bundle-checks.mjs runs this check on a build (its `// Bundle: read` line): `f` answers from the build
 *  folders as the host would. */
export async function bundle(f) {
  return judge(await read(f), { ledger: false });
}
