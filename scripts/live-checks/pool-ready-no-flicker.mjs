#!/usr/bin/env node
// Live check of card pool-ready-no-flicker: a note that stays ready never reads as ready "0" while the proof queue
// remakes its proof at an epoch boundary. The fix is the proof queue's readyWith (packages/wallet/src/pool/queue.ts),
// through which the signing page's state reads the ready list with the notes (packages/signpage/src/main.ts). It reads:
//   1. SIGN_HOST's /app.js has the sha384 of this checkout's signing page bundle (packages/signpage/public/app.js), so
//      the deployed page carries the fix; and that bundle carries the readyWith state path itself, read in its text: two
//      readyWith definitions (the queue's and the testnet pool's) and two calls (the testnet pool's into the queue and
//      the page's state read), so a build whose state read is back on the old ready list fails even if both sides match;
// It reads SIGN_HOST and this checkout only (card live-checks-read-mainnet-only: a listed check reads no test network).
// The fix's run on the testnet build (pool-ready-no-flicker.devnet.json, packages/signpage/scripts/pool-ready-devnet.mjs:
// after the first read with ready above 0, every state read gave that same ready over at least READ_EPOCHS epochs with a
// remake at each boundary) is a record no deploy changes: the check's test judges it, and the money gate reads its
// deposit back (pool-ready-no-flicker.md's Tx lines).
// After: sign
// Bundle: out its verdict is the served bundle against this checkout's, which a build of the checkout cannot differ on
//   node scripts/live-checks/pool-ready-no-flicker.mjs [--harness] [--record <file>]
//     --harness: this checkout's bundle stands for SIGN_HOST's /app.js
//     PASS exit 0, FAIL exit 1, error exit 2
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { signBuilt } from "../signpage-built.mjs";

const KEY = "pool-ready-no-flicker";
export const SIGN_HOST = "https://confidential.unrealized.trade";
export const READ_EPOCHS = 4; // the epoch of the first ready read and three whole ones after it
/** This tree's bundle, built from its sources at the read (card signpage-generated-merge-free). */
const treeBundlePath = () => path.join(signBuilt(), "public/app.js");
const sha384 = (b) => `sha384-${createHash("sha384").update(b).digest("base64")}`;
// the readyWith state path in a minified bundle: property names survive minifying, so a definition reads "readyWith:"
// and a call ".readyWith("
export const readyPath = (text) => ({ defs: text.split("readyWith:").length - 1, calls: text.split(".readyWith(").length - 1 });

// ------------------------------------------------------------------------------------------------ the verdict
export function judge(rec) {
  const lines = [];
  const say = (ok, s) => lines.push(`${ok ? "ok " : "BAD"} ${s}`);
  const b = rec.signBundle ?? {};
  say(b.status === 200 && typeof rec.treeBundle === "string" && b.sha384 === rec.treeBundle,
    `SIGN_HOST's /app.js is this checkout's signing page bundle: ${b.status !== 200 ? `HTTP ${b.status ?? "none"}` : b.sha384 === rec.treeBundle ? b.sha384 : `served ${b.sha384}, the checkout's ${rec.treeBundle}`}`);
  const p = b.readyWith ?? {};
  say(p.defs >= 2 && p.calls >= 2, `the served bundle carries the readyWith state path: ${p.defs ?? 0} definitions and ${p.calls ?? 0} calls, want at least 2 of each`);
  return { ok: lines.every((l) => l.startsWith("ok ")), lines };
}

// ------------------------------------------------------------------------------------------------ the read
export async function collect({ harness = false } = {}) {
  const tree = readFileSync(treeBundlePath());
  const treeBundle = sha384(tree);
  let signBundle;
  if (harness) signBundle = { status: 200, sha384: treeBundle, readyWith: readyPath(tree.toString("utf8")) };
  else {
    const res = await fetch(`${SIGN_HOST}/app.js`, { signal: AbortSignal.timeout(15_000) });
    const body = new Uint8Array(await res.arrayBuffer());
    signBundle = { status: res.status, sha384: sha384(body), readyWith: readyPath(new TextDecoder().decode(body)) };
  }
  return { check: KEY, at: new Date().toISOString(), source: harness ? "harness: this checkout's bundle as SIGN_HOST's" : `live ${SIGN_HOST}`, treeBundle, signBundle };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  try {
    const rec = await collect({ harness: a.includes("--harness") });
    const file = a.includes("--record") ? a[a.indexOf("--record") + 1] : null;
    if (file) writeFileSync(file, `${JSON.stringify(rec, null, 1)}\n`);
    const { ok, lines } = judge(rec);
    for (const l of lines) console.log(l);
    console.log(`CARD ${KEY} / live: ${ok ? "PASS" : "FAIL"} (${rec.source})`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`CARD ${KEY} / live: ERROR ${e?.stack ?? e}`);
    process.exit(2);
  }
}
