#!/usr/bin/env node
// Live check of card withdraw-fee-busy-waits: the device's one-shot fee asks of HELPER_HOST meet either an answer or a
// busy answer they can wait out, never a stop. The device (packages/wallet/src/busy.ts) waits a 429 rate_limited or a
// 503 upstream for its Retry-After and asks again, bounded; it can read that header cross-origin only when the helper
// exposes it. This check reads the two fee routes the signing page asks, with Origin SIGN_HOST, as the device does:
//   - GET /v1/withdraw/fee?token=<mainnet USDC> (the withdrawal's fee, wallet withdraw/relay.ts askWithdrawFee);
//   - GET /v1/pool/fee?cluster=devnet&pool=<the devnet pool of pool-sol-deploy.devnet.json> (signpage poolRelayFee).
// It passes only when every answer:
//   - is 200 with the route's answer (the withdraw fee's 7 fields; the pool fee naming the asked pool), or 429
//     { error: { code: "rate_limited" } } or 503 { error: { code: "upstream" } } with a Retry-After of whole seconds,
//     1 to 75 (the helper's RETRY_AFTER_MAX_S): any other status, or a busy answer naming no wait, FAILs;
//   - echoes SIGN_HOST in Access-Control-Allow-Origin and lists Retry-After in Access-Control-Expose-Headers, so the
//     device reads the wait.
// The helper answers 200 while it is not busy, and a busy answer cannot be made on demand without loading the helper,
// so the busy shape is judged when the run meets one; the recorded answers hold both (the test).
// A route that answers nothing (no connection, a timeout) is a no-answer: INCONCLUSIVE (provider-answer.mjs EXIT 3).
// The sign part (--part sign, after a sign deploy; review of 407ba3bc, P3): the device's waits live in the signing
// page's bundle, so SIGN_HOST's index.html must pin this commit's /app.js (the sha384 in this checkout's
// packages/signpage/index.html, built by build-app with the wallet's busy.ts; live.yml checks out the deployed commit),
// and the served /app.js must be that file (its sha384). A sign host still serving an earlier build FAILs. As
// evm-sell-no-release-in-flight's, it proves the served bytes are this commit's build, not that the wait runs: that is
// the wallet's and the signing page's tests at the commit.
// After: helper
// After: sign --part sign
//   node scripts/live-checks/withdraw-fee-busy-waits.mjs [--base <url>] [--record <file>]
//   node scripts/live-checks/withdraw-fee-busy-waits.mjs --part sign [--sign <url>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2, INCONCLUSIVE exit 3.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EXIT, verdictOf } from "./provider-answer.mjs";

const KEY = "withdraw-fee-busy-waits";
export const BASE = "https://ct-api.unrealized.trade";
export const SIGN = "https://confidential.unrealized.trade";
/** Mainnet USDC, the vault's token (relayer-withdraw-fee.mjs TOKENS.mainnet; the test holds them equal). */
export const MAINNET_USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"; // gitleaks:allow (a public account id)
/** The devnet pool the helper carries: its deploy record, never typed here. */
export const DEVNET_POOL = JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "pool-sol-deploy.devnet.json"), "utf8")).pool;
export const RETRY_AFTER_MAX_S = 75;
export const TIMEOUT_MS = 15_000;
const FEE_FIELDS = ["relayer_account", "fee_recipient", "relay_fee", "gp", "px", "g_w", "valid_until_block"];
const BUSY = { 429: "rate_limited", 503: "upstream" };
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PIN = /src="\/app\.js" integrity="(sha384-[A-Za-z0-9+/=]+)"/;
/** The /app.js sha384 this checkout's signing page pins: the commit's own build. */
export const COMMIT_PIN = PIN.exec(readFileSync(path.join(ROOT, "packages/signpage/index.html"), "utf8"))?.[1];

export const asks = (pool = DEVNET_POOL) => [
  { route: "withdraw-fee", path: `/v1/withdraw/fee?token=${MAINNET_USDC}` },
  { route: "pool-fee", path: `/v1/pool/fee?cluster=devnet&pool=${encodeURIComponent(pool)}` },
];

/** Reads each ask once with Origin SIGN_HOST: { route, asked, status, headers, body } or { route, asked, noAnswer }. */
export async function read(base = BASE, fetchFn = fetch, pool = DEVNET_POOL) {
  const reads = [];
  for (const a of asks(pool)) {
    const url = `${base.replace(/\/$/, "")}${a.path}`;
    try {
      const r = await fetchFn(url, { redirect: "manual", headers: { origin: SIGN, "cache-control": "no-cache" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      const headers = {};
      for (const k of ["retry-after", "access-control-allow-origin", "access-control-expose-headers", "x-helper-commit"]) {
        const v = r.headers.get(k);
        if (v !== null) headers[k] = v;
      }
      reads.push({ route: a.route, asked: a.path, status: r.status, headers, body: await r.text() });
    } catch (e) {
      reads.push({ route: a.route, asked: a.path, noAnswer: `${new URL(url).host}: no answer (${e?.cause?.code ?? e?.name ?? e?.message ?? e})` });
    }
  }
  return { base, reads };
}

const json = (t) => {
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
};
const show = (v) => (v === undefined ? "none" : JSON.stringify(v));

/** The check on one recorded run: { ok, quiet, verdict, lines }. */
export function judge(run, pool = DEVNET_POOL) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  let quiet = false;
  for (const a of asks(pool)) {
    const r = run.reads?.find((x) => x.route === a.route);
    const tag = `[${a.route}]`;
    if (!r) {
      say(false, `${tag} no read`);
      continue;
    }
    if (r.noAnswer !== undefined) {
      quiet = true;
      lines.push(`no-answer ${tag} ${r.noAnswer}`);
      continue;
    }
    const b = json(r.body);
    const isObj = typeof b === "object" && b !== null && !Array.isArray(b);
    if (r.status === 200) {
      if (a.route === "withdraw-fee") {
        const keys = isObj ? Object.keys(b) : [];
        say(keys.length === FEE_FIELDS.length && FEE_FIELDS.every((k) => keys.includes(k)), `${tag} 200 with the fee answer's fields: ${show(keys)}`);
      } else say(isObj && b.pool === pool && b.chain === "solana" && typeof b.fee === "string", `${tag} 200 with the pool's fee: pool ${show(b?.pool)}, fee ${show(b?.fee)}`);
    } else if (Object.hasOwn(BUSY, r.status)) {
      const code = isObj && Object.keys(b).length === 1 ? b.error?.code : undefined;
      say(code === BUSY[r.status], `${tag} ${r.status} is the helper's busy answer: code ${show(code)}, want ${BUSY[r.status]}`);
      const s = r.headers?.["retry-after"];
      const ok = typeof s === "string" && /^[1-9][0-9]*$/.test(s) && Number(s) <= RETRY_AFTER_MAX_S;
      say(ok, `${tag} ${r.status} names its wait: Retry-After ${show(s)}, whole seconds 1 to ${RETRY_AFTER_MAX_S}`);
    } else say(false, `${tag} answers ${r.status} ${String(r.body).slice(0, 80)}: neither the fee nor a busy answer the device waits out`);
    say(r.headers?.["access-control-allow-origin"] === SIGN, `${tag} Access-Control-Allow-Origin ${show(r.headers?.["access-control-allow-origin"])}`);
    const exposed = String(r.headers?.["access-control-expose-headers"] ?? "").split(",").map((h) => h.trim().toLowerCase());
    say(exposed.includes("retry-after"), `${tag} Access-Control-Expose-Headers lists Retry-After: ${show(r.headers?.["access-control-expose-headers"])}`);
  }
  const bad = lines.some((l) => l.startsWith("BAD"));
  return { ok: !bad && !quiet, quiet, verdict: verdictOf(bad, quiet), lines };
}

// ---- the sign part ----

/** SIGN_HOST's index and the sha384 of its served /app.js, with the pin this commit wants. */
export async function readSign(sign = SIGN, fetchFn = fetch, want = COMMIT_PIN) {
  const get = async (p) => {
    const r = await fetchFn(`${sign.replace(/\/$/, "")}${p}`, { redirect: "error", headers: { "cache-control": "no-cache" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (r.status !== 200) throw new Error(`${p}: HTTP ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  };
  const index = (await get("/")).toString("utf8");
  const js = await get("/app.js");
  return { part: "sign", sign, want, pin: PIN.exec(index)?.[1] ?? null, sha384: `sha384-${createHash("sha384").update(js).digest("base64")}` };
}

/** The sign part's verdict: the served index pins this commit's /app.js, and the served /app.js is that file. */
export function judgeSign(a) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  say(typeof a?.want === "string" && a.want.startsWith("sha384-"), `this commit's index.html pins /app.js ${show(a?.want)}`);
  say(a?.pin === a?.want, `SIGN_HOST's index.html pins ${show(a?.pin)}, this commit's ${show(a?.want)}`);
  say(a?.sha384 === a?.pin, `SIGN_HOST's served /app.js is ${show(a?.sha384)}, the pinned ${show(a?.pin)}`);
  const ok = lines.every((l) => l.startsWith("ok "));
  return { ok, quiet: false, verdict: ok ? "PASS" : "FAIL", lines };
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const sign = opt("--part", "helper") === "sign";
    const run = sign ? await readSign(opt("--sign", SIGN)) : await read(opt("--base", BASE));
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(run, null, 1)}\n`);
    const { verdict, lines } = sign ? judgeSign(run) : judge(run);
    for (const l of lines) console.log(l);
    console.log(`live-check ${KEY}${sign ? " (sign)" : ""}: ${verdict} (${sign ? run.sign : run.base})`);
    process.exit(EXIT[verdict]);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
    process.exit(EXIT.ERROR);
  }
}
