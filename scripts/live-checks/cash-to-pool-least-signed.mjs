#!/usr/bin/env node
// Live check of card cash-to-pool-least-signed on SIGN_HOST (https://confidential.unrealized.trade). A move of Cash into
// a pool is planned with no part under 1Click's least for the route (packages/signpage/src/cash-to-pool.ts
// readOneClickLeast). Before the card the least was the helper's word: the N of a 400's "try at least N", which no one
// signs, or the amount of any 200 or 201, checked against nothing. With the card N says only where to ask next, and the
// least is an amount whose dry quote 1Click signed and the kit's check passes (the pinned keys, the echo, the floors at
// the device's price). What it holds:
//   - the served /app.js is the one index.html pins (its sha384), and in it the read's mark, the words its refusal of an
//     answer it cannot check names (MARK), as the minifier keeps them;
//   - on mainnet 1Click now, through the helper's proxy, the page's own read (readOneClickLeast, run here on this
//     checkout's code, 1Click's signatures checked under the kit's pinned keys) ends, into SOL, Base's ETH and
//     Robinhood's ETH, at a least, and that least is the amount of the last answer 1Click quoted. It names each least
//     beside 1Click's own N, unchanged or raised and why. The price the floors are held at is 1Click's own /v0/tokens
//     price of the pool's coin (the page uses its own pool price reads, which this check does not make). A read refused
//     for an answer that fails the check FAILs: the device would plan no move. One that ran out of tries on 1Click's
//     blips ("Failed to get quote", "No liquidity available", a 429, a 5xx, no answer) is INCONCLUSIVE, and the run reads
//     again.
// The record keeps each ask's answer with its signature left out: an "ed25519:" string of 64 bytes is what the secret
// scan refuses (.gitleaks.toml near-ed25519-secret-key), as kit-deposit-assets-dry records 1Click's answers. So the
// signatures are judged in the live run, and a replay judges what that run found.
// That a lowered N or an unsigned quote never sets the least is packages/signpage/test/cash-to-pool-least-signed.test.ts's.
// After: sign
// Bundle: read sign
//   node scripts/live-checks/cash-to-pool-least-signed.mjs [--local <build dir>] [--record <file>] [--answer <file>]
//     --local reads index.html and app.js from a build dir (build-app.mjs --out) instead of SIGN_HOST; 1Click is live.
// PASS exit 0, FAIL exit 1, error exit 2, INCONCLUSIVE exit 3. Reads only: dry quotes name no account of anyone's, no
// deposit address is made and nothing is sent.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readOneClickLeast } from "../../packages/signpage/src/cash-to-pool.ts";

const KEY = "cash-to-pool-least-signed";
export const SIGN = "https://confidential.unrealized.trade";
export const TOKENS = "https://1click.chaindefuser.com/v0/tokens";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;
/** The read's refusal with no price to check an answer at, as cash-to-pool.ts writes it and the minifier keeps it. */
export const MARK = " fails the device's check: no price of the pool's coin to check it at";
export const CHAINS = Object.freeze({ solana: "nep141:sol.omft.near", base: "nep141:base.omft.near", robinhood: "nep141:hood.omft.near" });
export const NO_MARK = "BAD the served page does not set 1Click's least from a checked answer";
export const EXIT = Object.freeze({ PASS: 0, FAIL: 1, INCONCLUSIVE: 3 });
/** The read's ends that are 1Click's blips, every try spent or the budget out: no verdict on the page. */
const BLIPS = /no least in \d+ tries|no least within \d+ ms/;
const N = /"message"\s*:\s*"Amount is too low for bridge, try at least (\d{1,30})"/;
const AMOUNT = /^(0|[1-9][0-9]{0,29})$/;

/** 1Click's decimal USD price as the page's { price, expo }; null when it is not one. */
export function priceOf(usd) {
  const m = /^(\d{1,20})(?:\.(\d{1,18}))?$/.exec(String(usd));
  if (m === null) return null;
  const f = m[2] ?? "";
  const price = BigInt(m[1] + f).toString();
  return price === "0" ? null : { price, expo: f.length === 0 ? 0 : -f.length };
}

/** An answer's text as recorded: its signature left out (the secret scan's shape), the rest as 1Click sent it. */
export function unsigned(text) {
  try {
    const j = JSON.parse(text);
    if (j === null || typeof j !== "object" || !("signature" in j)) return text;
    const { signature, ...rest } = j;
    return JSON.stringify({ ...rest, signature: typeof signature === "string" && signature.startsWith("ed25519:") ? "ed25519:(left out)" : "(none)" });
  } catch {
    return text;
  }
}

/** The build's half of the verdict: the pin and the mark, which a pull request's own build is held to. */
function buildLines(a, bad) {
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  if (a?.mark !== true) bad(NO_MARK);
}

/** The verdict on an answer { index, sha384, mark, chains: { <chain>: { usd, asks, least } | { usd, asks, error } } }:
 *  PASS, FAIL or INCONCLUSIVE, with one line per fact. */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(m.startsWith("BAD ") ? m : `BAD ${m}`);
  let quiet = false;
  buildLines(a, bad);
  for (const chain of Object.keys(CHAINS)) {
    const c = a?.chains?.[chain];
    const asks = Array.isArray(c?.asks) ? c.asks.filter((x) => typeof x?.amount === "string" && AMOUNT.test(x.amount)) : [];
    if (asks.length === 0 || asks.length !== c.asks.length) {
      bad(`${chain}: no read of 1Click recorded`);
      continue;
    }
    if (typeof c.least === "string" && AMOUNT.test(c.least) && c.least !== "0") {
      // the least is the amount 1Click last quoted, the answer the page's check passed
      const last = asks.at(-1);
      if (last.amount !== c.least || !(last.status === 200 || last.status === 201)) {
        bad(`${chain}: the page's least ${c.least} is not the amount of the last answer 1Click quoted (${last.amount}, HTTP ${last.status})`);
        continue;
      }
      const named = asks.map((x) => N.exec(String(x.text))?.[1]).find((x) => x !== undefined);
      const least = BigInt(c.least);
      // why a least above 1Click's N: 1Click refused an amount at or above it (a 400 again), or its signed quote there
      // failed the kit's floor (a quote the read asked past)
      const past = asks.filter((x) => named !== undefined && BigInt(x.amount) >= BigInt(named) && BigInt(x.amount) < least);
      const why = past.map((x) => (x.status === 400 ? `${x.amount}: 1Click refused it` : `${x.amount}: its signed quote fails the kit's floor`)).join(", ");
      const was = named === undefined ? "1Click named no N, it quoted on the ladder" : BigInt(named) === least ? `unchanged from 1Click's N ${named}` : `raised from 1Click's N ${named} (${why})`;
      lines.push(`ok ${chain}: the page's least ${c.least} USDC base units, from a signed quote the kit's check passed; ${was}`);
    } else if (typeof c.error === "string" && BLIPS.test(c.error)) {
      quiet = true;
      lines.push(`INCONCLUSIVE ${chain}: 1Click gave only blips (${c.error.slice(0, 160)}): read again`);
    } else bad(`${chain}: the page reads no least: ${String(c.error ?? "no verdict recorded").slice(0, 200)}`);
  }
  const failed = lines.some((l) => l.startsWith("BAD"));
  const verdict = failed ? "FAIL" : quiet ? "INCONCLUSIVE" : "PASS";
  return { ok: verdict === "PASS", verdict, lines };
}

/** The bundle checks' run on a build (scripts/ci/bundle-checks.mjs): its pin and mark; 1Click is past the build. */
export async function bundle(fetchFn) {
  const get = async (p) => {
    const r = await fetchFn(`${SIGN}${p}`, { redirect: "error" });
    if (r.status !== 200) throw new Error(`${p}: HTTP ${r.status}`);
    return r.text();
  };
  const index = await get("/");
  const js = await get("/app.js");
  const lines = [];
  buildLines({ index, sha384: sha384(js), mark: js.includes(MARK) }, (m) => lines.push(m.startsWith("BAD ") ? m : `BAD ${m}`));
  return { ok: lines.length === 0, lines };
}

/** The live read: the page's index and script (or a build dir's), 1Click's prices, and the page's own read into each
 *  pool over the helper's 1Click proxy, its verdict and every ask it made with its answer (signature left out). */
export async function read({ fetchFn = fetch, local } = {}) {
  const get = async (p) => {
    if (local) return readFileSync(path.join(local, p === "/" ? "index.html" : p.slice(1)), "utf8");
    const r = await fetchFn(`${SIGN}${p}`, { redirect: "error" });
    if (r.status !== 200) throw new Error(`${p}: HTTP ${r.status}`);
    return r.text();
  };
  const index = await get("/");
  const js = await get("/app.js");
  const tokens = await (await fetchFn(TOKENS, { signal: AbortSignal.timeout(15_000) })).json();
  const chains = {};
  for (const [chain, asset] of Object.entries(CHAINS)) {
    const usd = Array.isArray(tokens) ? tokens.find((t) => t?.assetId === asset)?.price : undefined;
    const asks = [];
    const recording = async (u, init) => {
      const amount = JSON.parse(String(init.body)).amount;
      try {
        const r = await fetchFn(u, init);
        const text = await r.text();
        asks.push({ amount, status: r.status, text: unsigned(text).slice(0, 4096) });
        return new Response(text, { status: r.status });
      } catch (e) {
        asks.push({ amount, status: 0, text: `no answer: ${e?.name ?? "failed"}` });
        throw e;
      }
    };
    const price = priceOf(usd);
    // no price to hold the floors at is this check's gap, never the page's verdict
    if (price === null) throw new Error(`1Click's /v0/tokens gives no USD price of ${asset}`);
    const verdict = await readOneClickLeast(chain, recording, Date.now(), { price: () => price }).then(
      (least) => ({ least: least.toString() }),
      (e) => ({ error: String(e?.message ?? e) }),
    );
    chains[chain] = { usd: String(usd), asks, ...verdict };
  }
  return { index, sha384: sha384(js), mark: js.includes(MARK), chains };
}

if (realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url))) {
  const arg = (k) => {
    const i = process.argv.indexOf(k);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  try {
    const answer = arg("--answer") ? JSON.parse(readFileSync(arg("--answer"), "utf8")) : await read({ local: arg("--local") });
    if (arg("--record")) writeFileSync(arg("--record"), `${JSON.stringify(answer)}\n`);
    const v = judge(answer);
    for (const l of v.lines) console.log(l);
    console.log(`${v.verdict} ${KEY}`);
    process.exit(EXIT[v.verdict]);
  } catch (e) {
    console.error(`ERROR ${KEY}: ${e?.message ?? e}`);
    process.exit(2);
  }
}
