#!/usr/bin/env node
// Live check of card robinhood-tap-asks-no-missing-v3-tier: SIGN_HOST's buy tap asks no v3 fee tier a coin has no pool
// at. Release 175's walk read robinhood.drpc.org and robinhood-rpc.publicnode.com answer code 3 to the swap-fit read (the
// pool's buySwap) of the v3 tier the tap asked for 0x0b7c6c13 on Robinhood, which has no v3 pool at any tier. The tap
// now reads the v3 factory's getPool for every tier in one Multicall3 call on two providers and skips each tier both
// find empty (kit trade/evm/buy-tap.ts evmPoolV3Tiers); the kit test NOTIER (packages/kit/test/evm-buy-tap.test.ts)
// holds the order. This check reads:
//   - the served /app.js is the one index.html pins (its sha384), and it holds the tier read's pins: each mainnet's v3
//     factory (MARKERS), which the page before this card has none of (getPool's and aggregate3's selectors it had
//     already: the sell quote's factory read and the kit's Multicall3 reads);
//   - on mainnet, each pinned factory is the one the chain's pinned v3 quoter reads its pools from: QuoterV2.factory()
//     on two of the chain's providers (a pin that drifted would find every tier empty and ask no v3 route at all).
// The markers and pins are written out here, not read from the repo. Reads only.
// After: sign
// Bundle: out it reads each chain's v3 quoter on mainnet RPCs, past the build
//   node scripts/live-checks/robinhood-tap-asks-no-missing-v3-tier.mjs [--site <dir>] [--record <file>] [--answer <file>]
// --site reads a build folder (its index.html and app.js, or public/app.js) in place of SIGN_HOST: the answer this tree's build
// gives, which the deployed page must match. PASS exit 0, FAIL exit 1, error exit 2. --record writes the answer read;
// --answer replays one (the test's).
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const CARD = "robinhood-tap-asks-no-missing-v3-tier";
export const SIGN = "https://confidential.unrealized.trade";
/** Each mainnet's v3 quoter, the v3 factory the page pins for it, and two of its providers (kit buy-unpinned.ts). */
export const CHAINS = Object.freeze({
  base: {
    quoter: "0x3d4e44eb1374240ce5f1b871ab261cd16335b76a",
    factory: "0x33128a8fc17869897dce68ed026d694621f6fdfd",
    rpcs: ["https://base-rpc.publicnode.com", "https://mainnet.base.org"],
  },
  robinhood: {
    quoter: "0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7",
    factory: "0x1f7d7550b1b028f7571e69a784071f0205fd2efa",
    rpcs: ["https://robinhood-rpc.publicnode.com", "https://rpc.mainnet.chain.robinhood.com"],
  },
});
/** The tier read in the bundle: each pinned factory. */
export const MARKERS = Object.freeze(Object.values(CHAINS).map((c) => c.factory.slice(2)));

const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;

/** The verdict on an answer { index, app: { sha384, markers }, factories: { <chain>: [<factory() on each provider>] } }. */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) bad("index.html pins no /app.js");
  else if (pin !== a.app?.sha384) bad("the served /app.js is not the one index.html pins");
  for (const m of MARKERS) if (!(a?.app?.markers ?? []).includes(m)) bad(`the served /app.js holds no v3 tier read (${m})`);
  for (const [chain, c] of Object.entries(CHAINS)) {
    const got = a?.factories?.[chain];
    if (!Array.isArray(got) || got.length < 2) bad(`${chain}: the v3 quoter's factory was not read on two providers`);
    else if (got.some((f) => typeof f !== "string" || f.toLowerCase() !== c.factory)) bad(`${chain}: the v3 quoter reads its pools from ${[...new Set(got)].join(" / ")}, not the pinned ${c.factory}`);
  }
  if (!lines.length) lines.push("OK the pinned /app.js reads each v3 tier's pool before it asks the tier, from the factory each chain's quoter reads");
  return { ok: !lines.some((l) => l.startsWith("BAD")), lines };
}

/** QuoterV2.factory() (0xc45a0155) on `rpc`, as an address, or the error's words. */
async function factoryOf(rpc, quoter) {
  const r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: quoter, data: "0xc45a0155" }, "latest"] }) });
  const j = await r.json();
  return typeof j?.result === "string" && /^0x[0-9a-fA-F]{64}$/.test(j.result) ? "0x" + j.result.slice(26).toLowerCase() : `error ${JSON.stringify(j?.error ?? r.status).slice(0, 80)}`;
}

async function factories() {
  const out = {};
  for (const [chain, c] of Object.entries(CHAINS)) out[chain] = await Promise.all(c.rpcs.map((u) => factoryOf(u, c.quoter)));
  return out;
}

const answerOf = async (index, js) => ({ index, app: { sha384: sha384(js), markers: MARKERS.filter((m) => js.includes(m)) }, factories: await factories() });

/** Reads SIGN_HOST, or a build folder, and the chains' quoters. */
export async function read(site) {
  // a package folder keeps app.js in public/; build-app.mjs --out writes it beside index.html, as served
  if (site) return answerOf(readFileSync(path.join(site, "index.html"), "utf8"), readFileSync(existsSync(path.join(site, "public", "app.js")) ? path.join(site, "public", "app.js") : path.join(site, "app.js"), "utf8"));
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
    console.log(v.ok ? `PASS ${CARD}` : `FAIL ${CARD}`);
    process.exit(v.ok ? 0 : 1);
  } catch (e) {
    console.error(`ERROR ${CARD}: ${e?.message ?? e}`);
    process.exit(2);
  }
}

