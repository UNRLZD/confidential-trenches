#!/usr/bin/env node
// Live check of card near-dcl-helper-relay: HELPER_HOST, at the deployed commit, takes a NEAR trade whose hops are Rhea
// DCL pools (dclv2.ref-labs.near, ids `<token_x>|<token_y>|<fee>`) on POST /v1/bind's trade kind (apps/helper/src/bind/
// trade.ts), and still refuses a trade that mixes DCL and Rhea classic hops. It reads GET /v1/health with Origin
// APP_HOST (200, X-Helper-Commit the commit asked for, `bind` carrying mainnet), then POSTs, for a W made fresh for this
// run (64 random hex: no account, no payout) and with no delegate:
//   1. a DCL buy of a coin that trades only on DCL (USDC to wNEAR to the coin, two real DCL pools): the body parses and
//      the creation path reads no vault payout to W: 409 no_payout, no transaction. A helper before this card reads the
//      string pool ids as a bad body: 400 bad_shape;
//   2. the same trade with a Rhea classic hop first and a DCL hop second, and 3. the reverse: 400 bad_shape on both.
// Nothing is signed and nothing is sent: the probes hold no delegate, and a W no payout reached is never created
// (trade.ts createW). DCL is mainnet only (kit NEAR_DCL), so only mainnet is probed. It moves no money.
// After: helper --commit {commit}
//   node scripts/live-checks/near-dcl-helper-relay.mjs --commit <sha> [--base <url>]   PASS exit 0, FAIL exit 1, error exit 2
import "../net-window.mjs";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";

export const KEY = "near-dcl-helper-relay";
export const BASE = "https://ct-api.unrealized.trade";
export const APP = "https://ct-app.unrealized.trade";
const SHA = /^[0-9a-f]{40}$/;
const IMPLICIT = /^[0-9a-f]{64}$/;
const USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"; // gitleaks:allow (a public account id)
const COIN = "hoodl-95275b.launchpad.justhoot.near";
/** Two real DCL pools (get_pool on dclv2.ref-labs.near, state Running): USDC/wNEAR at 0.01 %, the coin/wNEAR at 1 %. */
const DCL_USDC = `${USDC}|wrap.near|100`;
const DCL_COIN = `${COIN}|wrap.near|10000`;
/** A DCL buy of 1 USDC, as the kit's dclQuote answers one (packages/kit/src/near/dcl.ts), in the wire's hop order. */
export const DCL_TRADE = {
  side: "buy",
  token: COIN,
  amount_in: "1000000",
  slippage_bps: 100,
  venue_out: "1",
  hops: [
    { pool: DCL_USDC, token_in: USDC, token_out: "wrap.near" },
    { pool: DCL_COIN, token_in: "wrap.near", token_out: COIN },
  ],
};
/** The same buy with one Rhea classic hop (pool 4512, USDC/wNEAR) in place of a DCL one: one venue per trade. */
export const MIXED = {
  classic_first: [{ pool: 4512, token_in: USDC, token_out: "wrap.near" }, DCL_TRADE.hops[1]],
  dcl_first: [DCL_TRADE.hops[0], { pool: 4512, token_in: "wrap.near", token_out: COIN }],
};

/** The trade body for `wallet`: no delegate, so the helper's creation path runs, and only its reads. */
export const probeBody = (wallet, hops = DCL_TRADE.hops) => JSON.stringify({ trade: { network: "mainnet", wallet, ...DCL_TRADE, hops }, signed_delegates: [] });

const json = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
};

/** One run: health, then, when health lists mainnet as carried, the DCL probe and the two mixed ones, each kept as read. */
export async function read(base = BASE, fetchFn = fetch, commit = "", wallet = randomBytes(32).toString("hex")) {
  const root = base.replace(/\/$/, "");
  const h = await fetchFn(`${root}/v1/health`, { redirect: "manual", headers: { origin: APP }, signal: AbortSignal.timeout(15_000) });
  const healthBody = (await h.text()).slice(0, 4096);
  const health = { status: h.status, commit: h.headers.get("x-helper-commit"), body: healthBody };
  const bind = json(healthBody)?.bind;
  const probes = {};
  if (bind !== null && typeof bind === "object" && "mainnet" in bind) {
    for (const [name, hops] of [["dcl", DCL_TRADE.hops], ["classic_first", MIXED.classic_first], ["dcl_first", MIXED.dcl_first]]) {
      const r = await fetchFn(`${root}/v1/bind`, { method: "POST", redirect: "manual", headers: { origin: APP, "content-type": "application/json" }, body: probeBody(wallet, hops), signal: AbortSignal.timeout(30_000) });
      probes[name] = { status: r.status, body: (await r.text()).slice(0, 1024) };
    }
  }
  return { base, commit, wallet, readAt: new Date().toISOString(), health, probes };
}

const WANT = {
  dcl: [409, "no_payout", "a DCL buy for a W the vault never paid"],
  classic_first: [400, "bad_shape", "a classic hop then a DCL hop"],
  dcl_first: [400, "bad_shape", "a DCL hop then a classic hop"],
};

/** The check on one recorded run. */
export function judge(run) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  say(run.health?.status === 200, `GET /v1/health: ${run.health?.status} (want 200)`);
  say(typeof run.commit === "string" && SHA.test(run.commit) && run.health?.commit === run.commit, `X-Helper-Commit ${run.health?.commit} is the deployed commit ${run.commit || "(no --commit)"}`);
  say(IMPLICIT.test(run.wallet ?? ""), `the probe's W is a 64-hex id made for this run (${run.wallet})`);
  for (const [name, [status, want, what]] of Object.entries(WANT)) {
    const p = run.probes?.[name];
    const b = json(p?.body ?? "");
    const code = b?.error?.code;
    const noTx = b !== undefined && !("tx_hashes" in (b ?? {})) && !("tx_hashes" in (b?.error ?? {}));
    say(p !== undefined && p.status === status && code === want && noTx, `mainnet: ${what}: ${p?.status ?? "not read (health lists no mainnet bind carry)"} ${code ?? p?.body?.slice(0, 80) ?? ""} (want ${status} ${want}, no transaction)`);
  }
  return { ok: lines.every((l) => l.startsWith("ok ")), lines };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const opt = (k) => {
    const i = args.indexOf(k);
    return i === -1 ? undefined : args[i + 1];
  };
  try {
    const commit = opt("--commit");
    if (!SHA.test(commit ?? "")) throw new Error("--commit <the deployed commit's 40-hex sha> is required");
    const run = await read(opt("--base") ?? BASE, fetch, commit);
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(run, null, 1)}\n`);
    const r = judge(run);
    for (const l of r.lines) console.log(l);
    console.log(`live-check ${KEY}: ${r.ok ? "PASS" : "FAIL"} (${run.base})`);
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
}
