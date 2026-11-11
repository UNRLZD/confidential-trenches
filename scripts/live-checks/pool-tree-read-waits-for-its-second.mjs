#!/usr/bin/env node
// Live check of card pool-tree-read-waits-for-its-second on SIGN_HOST (https://confidential.unrealized.trade) and on
// Solana mainnet's own cadence. Reads only: nothing is signed or sent.
// The fault (12 Nov): mainnet's confirmed slot read equal to its finalized slot, so a newest tree read at now + 1 (a
// note that landed in now's block-second: a sell's return note, a deposit's first proof) was refused at once, and the
// withdraw ended "stopped" with no cause. What this proves, and only that:
//   - the served /app.js is the one index.html pins (its sha384), and it carries, each found by a mark of the bundle's
//     shape (packages/wallet/src/pool/solana.ts, packages/signpage/src/pool-testnet.ts):
//       the tree sync's reached check read again until it is reached ("has not reached ${x} after ${n} waits");
//       a block time not available yet (-32004) read again;
//       a withdraw that ended on a throw logs its cause ("withdraw ${stage}: ${cause}");
//   - on two public mainnet providers, a confirmed block reaches the lower finalized block time + 1 s within the
//     sync's cap (SOL_REACH_WAITS = 10 waits of 400 ms), polled the way the sync polls.
// It does not prove the wait runs in a withdraw: that is packages/signpage/test/pool-withdraw.test.ts and
// packages/wallet/test/pool-queue.test.ts at the released commit.
// After: sign
//   node scripts/live-checks/pool-tree-read-waits-for-its-second.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "pool-tree-read-waits-for-its-second";
export const SIGN = "https://confidential.unrealized.trade";
export const PROVIDERS = Object.freeze(["https://api.mainnet-beta.solana.com", "https://solana-rpc.publicnode.com"]);
/** The sync's cap (solana.ts SOL_REACH_WAITS, SOL_LAG_WAIT_MS). */
export const REACH_WAITS = 10;
export const WAIT_MS = 400;
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;

const I = "[\\w$.]+"; // a minified name or member
export const MARKS = Object.freeze({
  "the tree sync reads again until its block reaches the cut": new RegExp(`has not reached \\$\\{${I}\\} after \\$\\{${I}\\} waits\``),
  "a block time not available yet (-32004) is read again": /\/RPC error -32004\\b\//,
  "a withdraw that ended on a throw logs its cause": new RegExp(`console\\.warn\\(\`withdraw \\$\\{${I}\\}: \\$\\{${I}\\}\`\\)`),
});

/** What the check keeps of the reads: the index, the served bundle's sha384, the marks it carries, the chain's reads. */
export function facts(index, js, chain) {
  return { index, sha384: sha384(js), carries: Object.fromEntries(Object.entries(MARKS).map(([k, re]) => [k, re.test(js)])), chain };
}

/** The verdict on an answer { index, sha384, carries, chain }. */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  for (const k of Object.keys(MARKS)) if (a?.carries?.[k] !== true) bad(`the served bundle does not carry: ${k}`);
  const c = a?.chain;
  if (!Array.isArray(c) || c.length !== 2) bad("no mainnet read on two providers");
  else
    for (const p of c) {
      if (!Number.isSafeInteger(p?.waits) || typeof p?.reached !== "boolean") bad(`${p?.provider}: not a read`);
      else if (!p.reached || p.waits > REACH_WAITS) bad(`${p.provider}: its confirmed block did not reach now + 1 s within ${REACH_WAITS} waits`);
      else lines.push(`ok ${p.provider}: finalized ${p.finalized.slot} at ${p.finalized.t} s, now + 1 s reached at confirmed slot ${p.slot} after ${p.waits} waits (${p.ms} ms)`);
    }
  return { ok: !lines.some((l) => l.startsWith("BAD")), lines };
}

let id = 0;
async function call(url, method, params, fetchFn) {
  const r = await fetchFn(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
  if (r.status !== 200) throw new Error(`${method}: HTTP ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(`RPC error ${j.error.code}: ${method}`);
  return j.result;
}
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
/** A slot's block time, -32004 read again a slot apart, as the sync does. */
async function blockTime(url, slot, fetchFn) {
  for (let i = 0; ; i++) {
    try {
      return await call(url, "getBlockTime", [slot], fetchFn);
    } catch (e) {
      if (!/-32004\b/.test(e.message) || i >= REACH_WAITS) throw e;
    }
    await sleep(WAIT_MS);
  }
}

/** Both providers' finalized block time; then on each, the confirmed block polled the sync's way until its time
 *  reaches the lower finalized time + 1 s. */
export async function chainReads(fetchFn = fetch) {
  const fin = await Promise.all(PROVIDERS.map(async (u) => {
    const slot = await call(u, "getSlot", [{ commitment: "finalized" }], fetchFn);
    return { slot, t: await blockTime(u, slot, fetchFn) };
  }));
  const now = Math.min(...fin.map((f) => f.t));
  const t0 = Date.now();
  return Promise.all(PROVIDERS.map(async (provider, k) => {
    for (let waits = 0; ; waits++) {
      const slot = await call(provider, "getSlot", [{ commitment: "confirmed" }], fetchFn);
      const t = await blockTime(provider, slot, fetchFn);
      if (t >= now + 1) return { provider, finalized: fin[k], slot, t, waits, reached: true, ms: Date.now() - t0 };
      if (waits >= REACH_WAITS) return { provider, finalized: fin[k], slot, t, waits, reached: false, ms: Date.now() - t0 };
      await sleep(WAIT_MS);
    }
  }));
}

export async function read(fetchFn = fetch) {
  const get = async (path) => {
    const r = await fetchFn(`${SIGN}${path}`, { redirect: "error" });
    if (r.status !== 200) throw new Error(`${path}: HTTP ${r.status}`);
    return r.text();
  };
  return facts(await get("/"), await get("/app.js"), await chainReads(fetchFn));
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
