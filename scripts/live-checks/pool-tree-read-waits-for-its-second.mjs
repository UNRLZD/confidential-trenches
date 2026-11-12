#!/usr/bin/env node
// Live check of card pool-tree-read-waits-for-its-second on SIGN_HOST (https://confidential.unrealized.trade) and on
// Solana mainnet's own cadence. Reads only: nothing is signed or sent.
// The fault (11 Nov): mainnet's confirmed slot read equal to its finalized slot, so a newest tree read at now + 1 (a
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
// packages/wallet/test/pool-queue.test.ts at the released commit. The mainnet reads go through provider-answer.mjs's
// rpcAnswer: a provider that gives no answer (a failed fetch, a throttle) is INCONCLUSIVE (exit 3), never FAIL; FAIL is a
// mark missing from the bundle, or a provider that answered and did not reach the cut within the cap. The bundle part
// (readBundle, judgeBundle) runs on a pull request's own build (scripts/ci/bundle-checks.mjs); the chain part is past it.
// After: sign
//   node scripts/live-checks/pool-tree-read-waits-for-its-second.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2, INCONCLUSIVE exit 3.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { EXIT, rpcAnswer, verdictOf } from "./provider-answer.mjs";

const KEY = "pool-tree-read-waits-for-its-second";
export const SIGN = "https://confidential.unrealized.trade";
export const PROVIDERS = Object.freeze(["https://api.mainnet-beta.solana.com", "https://solana-rpc.publicnode.com"]);
/** The sync's cap (solana.ts SOL_REACH_WAITS, SOL_LAG_WAIT_MS). */
export const REACH_WAITS = 10;
export const WAIT = { ms: 400 };
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;

const I = "[\\w$.]+"; // a minified name or member
export const MARKS = Object.freeze({
  "the tree sync reads again until its block reaches the cut": new RegExp(`has not reached \\$\\{${I}\\} after \\$\\{${I}\\} waits\``),
  "a block time not available yet (-32004) is read again": /\/RPC error -32004\\b\//,
  "a withdraw that ended on a throw logs its cause": new RegExp(`console\\.warn\\(\`withdraw \\$\\{${I}\\}: \\$\\{${I}\\}\`\\)`),
});

/** What the check keeps of the bundle: the index, the served bundle's sha384, the marks it carries. */
export function facts(index, js) {
  return { index, sha384: sha384(js), carries: Object.fromEntries(Object.entries(MARKS).map(([k, re]) => [k, re.test(js)])) };
}

export async function readBundle(fetchFn = fetch) {
  const get = async (path) => {
    const r = await fetchFn(`${SIGN}${path}`, { redirect: "error" });
    if (r.status !== 200) throw new Error(`${path}: HTTP ${r.status}`);
    return r.text();
  };
  return facts(await get("/"), await get("/app.js"));
}

/** The bundle's BAD lines (the pin and each mark). */
export function judgeBundle(b) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(b?.index ?? "")?.[1];
  if (!pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (pin !== b.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  for (const k of Object.keys(MARKS)) if (b?.carries?.[k] !== true) bad(`the served bundle does not carry: ${k}`);
  return { ok: lines.length === 0, lines };
}

/** The chain's lines: BAD for a provider that answered and did not reach the cut, "--" for one that gave no answer. */
export function judgeChain(c) {
  const lines = [];
  if (!Array.isArray(c) || c.length !== 2) return { lines: ["BAD no mainnet read on two providers"], quiet: false };
  let quiet = false;
  for (const p of c) {
    if (typeof p?.noAnswer === "string") {
      quiet = true;
      lines.push(`--  ${p.provider}: no answer (${p.noAnswer}): INCONCLUSIVE`);
    } else if (!Number.isSafeInteger(p?.waits) || typeof p?.reached !== "boolean") lines.push(`BAD ${p?.provider}: not a read`);
    else if (!p.reached || p.waits > REACH_WAITS) lines.push(`BAD ${p.provider}: its confirmed block did not reach now + 1 s within ${REACH_WAITS} waits`);
    else lines.push(`ok ${p.provider}: finalized ${p.finalized.slot} at ${p.finalized.t} s, now + 1 s reached at confirmed slot ${p.slot} after ${p.waits} waits (${p.ms} ms)`);
  }
  return { lines, quiet };
}

/** The verdict on an answer { bundle, chain }: FAIL on any BAD line, else INCONCLUSIVE when a provider gave no answer. */
export function judge(a) {
  const ch = judgeChain(a?.chain);
  const lines = [...judgeBundle(a?.bundle).lines, ...ch.lines];
  const verdict = verdictOf(lines.some((l) => l.startsWith("BAD")), ch.quiet);
  return { ok: verdict === "PASS", verdict, lines };
}

class NoAnswer extends Error {}
/** One read's result through rpcAnswer; a no-answer stops this provider's reads (NoAnswer). */
async function result(url, method, params, fetchFn) {
  const a = await rpcAnswer(url, method, params, { fetchFn });
  if (a.noAnswer !== undefined) throw new NoAnswer(a.noAnswer);
  return a;
}
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
/** A read that is not an answer about the chain's cadence (an error answer, a result not a whole number): this
 *  provider's reads stop, a no-answer (INCONCLUSIVE, which live.yml runs again), never ERROR. */
const notRead = (url, what, a) => new NoAnswer(`${new URL(url).host}: ${what} answered ${JSON.stringify(a.error ?? a.result).slice(0, 120)}`);
/** A slot's block time, -32004 (not available yet) read again a slot apart, as the sync does. */
async function blockTime(url, slot, fetchFn) {
  for (let i = 0; ; i++) {
    const a = await result(url, "getBlockTime", [slot], fetchFn);
    if (a.error === undefined && Number.isSafeInteger(a.result)) return a.result;
    if (a.error?.code !== -32004 || i >= REACH_WAITS) throw notRead(url, `getBlockTime(${slot})`, a);
    await sleep(WAIT.ms);
  }
}
async function slotOf(url, commitment, fetchFn) {
  const a = await result(url, "getSlot", [{ commitment }], fetchFn);
  if (a.error !== undefined || !Number.isSafeInteger(a.result)) throw notRead(url, `getSlot ${commitment}`, a);
  return a.result;
}

/** Both providers' finalized block time; then on each, the confirmed block polled the sync's way until its time
 *  reaches the lower finalized time + 1 s. A provider with no answer is { provider, noAnswer }. */
export async function readChain(fetchFn = fetch) {
  const quiet = (provider) => (e) => {
    if (e instanceof NoAnswer) return { provider, noAnswer: e.message };
    throw e;
  };
  const fin = await Promise.all(PROVIDERS.map(async (u) => {
    const slot = await slotOf(u, "finalized", fetchFn);
    return { slot, t: await blockTime(u, slot, fetchFn) };
  }).map((p, k) => p.catch(quiet(PROVIDERS[k]))));
  const gone = fin.filter((f) => f.noAnswer !== undefined);
  if (gone.length > 0) return PROVIDERS.map((provider, k) => (fin[k].noAnswer !== undefined ? fin[k] : { provider, noAnswer: "the other provider gave no finalized time" }));
  const now = Math.min(...fin.map((f) => f.t));
  const t0 = Date.now();
  return Promise.all(PROVIDERS.map(async (provider, k) => {
    for (let waits = 0; ; waits++) {
      const slot = await slotOf(provider, "confirmed", fetchFn);
      const t = await blockTime(provider, slot, fetchFn);
      if (t >= now + 1) return { provider, finalized: fin[k], slot, t, waits, reached: true, ms: Date.now() - t0 };
      if (waits >= REACH_WAITS) return { provider, finalized: fin[k], slot, t, waits, reached: false, ms: Date.now() - t0 };
      await sleep(WAIT.ms);
    }
  }).map((p, k) => p.catch(quiet(PROVIDERS[k]))));
}

export async function read(fetchFn = fetch) {
  return { bundle: await readBundle(fetchFn), chain: await readChain(fetchFn) };
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
    console.log(`${v.verdict} ${KEY}`);
    process.exit(EXIT[v.verdict]);
  } catch (e) {
    console.error(`ERROR ${KEY}: ${e?.message ?? e}`);
    process.exit(EXIT.ERROR);
  }
}
