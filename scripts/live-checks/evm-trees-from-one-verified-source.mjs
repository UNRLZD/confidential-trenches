#!/usr/bin/env node
// Live check of card evm-trees-from-one-verified-source: on SIGN_HOST (https://confidential.unrealized.trade) a Base or
// Robinhood proof's trees come from the first log source whose leaves rebuild the pool's root, read on two operators at
// the anchor (the Privacy Pools client's baseline), where before they waited for a second operator's same bytes. In the
// owner's browser only one log source answered in reach (publicnode and Pocket blocked, the helper's keyed Base route
// 503 past 100 blocks), so the fee hold waited on the cold two-operator sync for minutes and failed, and no proof was
// made (mainnet probe packages/signpage/scripts/evm-pass-reads-mainnet.mjs --owners-case, 15 Nov 01:27-01:32Z). What the
// sync does is held by packages/wallet/test/pool-evm.test.ts (card evm-trees-from-one-verified-source); this check holds
// that SIGN_HOST serves that code. It passes only when SIGN_HOST's served /app.js is the one its index.html pins (its
// sha384), and in it, each exactly once (packages/wallet/src/pool/evm.ts evmTreeSync):
//   - root: the proof's round ends at the first source whose leaves rebuild the pool's root
//     ("a source's leaves rebuild the pool's root");
//   - refused: a proof's round with no such source is refused ("no source's logs make the pool's trees");
//   - depth: a one-source round's depth comes from the pool's root times, refused when they leave two depths
//     ("two depths, and no two operators' logs to tell them").
// After: sign
// Bundle: read sign
//   node scripts/live-checks/evm-trees-from-one-verified-source.mjs [--local] [--record <file>]
//   PASS exit 0, FAIL 1, error 2. --local judges this tree's SIGN_HOST build (signBuilt) in SIGN_HOST's place; --record
//   writes what the run read, which evm-trees-from-one-verified-source.test.mjs replays. Reads only.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { signBuilt } from "../signpage-built.mjs";

export const KEY = "evm-trees-from-one-verified-source";
export const SIGN = "https://confidential.unrealized.trade";
export const TEXTS = Object.freeze({
  root: "a source's leaves rebuild the pool's root",
  refused: "no source's logs make the pool's trees",
  depth: "two depths, and no two operators' logs to tell them",
});

const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;
const count = (js, t) => js.split(t).length - 1;

/** What the check keeps of SIGN_HOST's build: its pin and sha384, and how many times each text is in it. */
export function pageFacts(index, js) {
  return {
    pin: /src="\/app\.js" integrity="([^"]+)"/.exec(index)?.[1] ?? null,
    sha384: sha384(js),
    ...Object.fromEntries(Object.entries(TEXTS).map(([k, t]) => [k, count(js, t)])),
  };
}

/** SIGN_HOST's index and /app.js through `fetchFn`: { from, page }. */
export async function readBundle(fetchFn = fetch) {
  const get = async (p) => {
    const r = await fetchFn(`${SIGN}${p}`, { redirect: "error" });
    if (r.status !== 200) throw new Error(`SIGN_HOST ${p}: HTTP ${r.status}`);
    return r.text();
  };
  return { from: SIGN, page: pageFacts(await get("/"), await get("/app.js")) };
}

/** The verdict on { page }: { ok, verdict, lines }. */
export function judge(run) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const p = run?.page;
  say(typeof p?.pin === "string" && p.pin === p.sha384, `[SIGN_HOST] the served /app.js is the one index.html pins: ${p?.pin ?? "no pin"}`);
  say(p?.root === 1, `[SIGN_HOST] a proof's round ends at the first source whose leaves rebuild the pool's root (root: ${p?.root ?? 0}, want 1)`);
  say(p?.refused === 1, `[SIGN_HOST] a proof's round with no such source is refused (refused: ${p?.refused ?? 0}, want 1)`);
  say(p?.depth === 1, `[SIGN_HOST] a one-source round's depth comes from the pool's root times (depth: ${p?.depth ?? 0}, want 1)`);
  const verdict = lines.some((l) => l.startsWith("BAD")) ? "FAIL" : "PASS";
  return { ok: verdict === "PASS", verdict, lines };
}

/** SIGN_HOST's index and /app.js, or this tree's build with `local`. */
export async function read(fetchFn = fetch, { local = false } = {}) {
  const page = local ? pageFacts(readFileSync(path.join(signBuilt(), "index.html"), "utf8"), readFileSync(path.join(signBuilt(), "public/app.js"), "utf8")) : (await readBundle(fetchFn)).page;
  return { readAt: new Date().toISOString(), from: local ? "local build" : SIGN, page };
}

if (realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url))) {
  const a = process.argv.slice(2);
  try {
    const run = await read(fetch, { local: a.includes("--local") });
    if (a.includes("--record")) writeFileSync(a[a.indexOf("--record") + 1], `${JSON.stringify(run, null, 1)}\n`);
    const { verdict, lines } = judge(run);
    for (const l of lines) console.log(l);
    console.log(`live-check ${KEY}: ${verdict}`);
    process.exit(verdict === "PASS" ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
    process.exit(2);
  }
}
