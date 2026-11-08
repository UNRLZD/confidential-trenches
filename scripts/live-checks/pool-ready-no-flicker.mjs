#!/usr/bin/env node
// Live check of card pool-ready-no-flicker: a note that stays ready never reads as ready "0" while the proof queue
// remakes its proof at an epoch boundary. The fix is the proof queue's readyWith (packages/wallet/src/pool/queue.ts),
// through which the signing page's state reads the ready list with the notes (packages/signpage/src/main.ts). It reads:
//   1. SIGN_HOST's /app.js has the sha384 of this checkout's signing page bundle (packages/signpage/public/app.js), so
//      the deployed page carries the fix; and that bundle carries the readyWith state path itself, read in its text: two
//      readyWith definitions (the queue's and the testnet pool's) and two calls (the testnet pool's into the queue and
//      the page's state read), so a build whose state read is back on the old ready list fails even if both sides match;
//   2. the devnet run's record (pool-ready-no-flicker.devnet.json, packages/signpage/scripts/pool-ready-devnet.mjs):
//      after the first read with ready above 0, every state read (one every few seconds, each starting the queue's pass
//      as main.ts does) gave that same ready, over at least READ_EPOCHS epochs with a remake at each boundary. The
//      run's deposit is read back on two devnet RPCs by the money gate (pool-ready-no-flicker.md's Tx lines).
// Not read here, and why: SIGN_HOST's mainnet build pins no pool yet (card pool-sol-deploy-mainnet), so no deployed
// page holds a ready proof to watch; the devnet run is the testnet build of the same code.
//   node scripts/live-checks/pool-ready-no-flicker.mjs [--harness] [--record <file>]
//     --harness: this checkout's bundle stands for SIGN_HOST's /app.js
//     PASS exit 0, FAIL exit 1, error exit 2
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KEY = "pool-ready-no-flicker";
export const SIGN_HOST = "https://confidential.unrealized.trade";
export const READ_EPOCHS = 4; // the epoch of the first ready read and three whole ones after it
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TREE_BUNDLE = path.join(REPO, "packages/signpage/public/app.js");
const RUN = path.join(REPO, "scripts/live-checks/pool-ready-no-flicker.devnet.json");
const sha384 = (b) => `sha384-${createHash("sha384").update(b).digest("base64")}`;
const EPOCH_MS = 60_000;
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
  const run = rec.run ?? {};
  const states = Array.isArray(run.states) ? run.states : [];
  const k = states.findIndex((x) => typeof x?.ready === "string" && /[1-9]/.test(x.ready));
  const first = k < 0 ? null : states[k].ready;
  const after = k < 0 ? [] : states.slice(k);
  const off = after.filter((x) => x.ready !== first);
  say(first !== null && run.cluster === "devnet", `the devnet run's first ready read: ${first ?? "none"}`);
  say(first !== null && off.length === 0, `every read after it gave ${first ?? "it"}: ${off.length ? off.map((x) => `${x.at} ${x.ready}`).join(", ") : `all ${after.length}`}`);
  const epochs = new Set(after.map((x) => Math.floor(Date.parse(x.at) / EPOCH_MS))).size;
  say(epochs >= READ_EPOCHS, `the reads span ${epochs} epochs, want at least ${READ_EPOCHS}`);
  const remakes = new Set(after.flatMap((x) => x.attempts ?? [])).size - 1;
  say(remakes >= READ_EPOCHS - 1, `the proof was made again ${Math.max(remakes, 0)} times while read, want at least ${READ_EPOCHS - 1}`);
  const gap = after.slice(1).reduce((m, x, i) => Math.max(m, Date.parse(x.at) - Date.parse(after[i].at)), 0);
  say(after.length > 1 && gap <= 20_000, `reads every few seconds: the longest gap ${gap} ms, want at most 20000`);
  return { ok: lines.every((l) => l.startsWith("ok ")), lines };
}

// ------------------------------------------------------------------------------------------------ the read
export async function collect({ harness = false } = {}) {
  const tree = readFileSync(TREE_BUNDLE);
  const treeBundle = sha384(tree);
  let signBundle;
  if (harness) signBundle = { status: 200, sha384: treeBundle, readyWith: readyPath(tree.toString("utf8")) };
  else {
    const res = await fetch(`${SIGN_HOST}/app.js`, { signal: AbortSignal.timeout(15_000) });
    const body = new Uint8Array(await res.arrayBuffer());
    signBundle = { status: res.status, sha384: sha384(body), readyWith: readyPath(new TextDecoder().decode(body)) };
  }
  const r = JSON.parse(readFileSync(RUN, "utf8"));
  const run = { cluster: r.cluster, states: r.states.map((x) => ({ at: x.at, ready: x.ready, attempts: x.attempts })) };
  return { check: KEY, at: new Date().toISOString(), source: harness ? "harness: this checkout's bundle as SIGN_HOST's" : `live ${SIGN_HOST}`, treeBundle, signBundle, run };
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
