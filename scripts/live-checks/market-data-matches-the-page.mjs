#!/usr/bin/env node
// Live check of card market-data-matches-the-page: the deployed helper's market data agrees with the token page.
//   - push: GET /v1/market/push?chain=near&token=<NEAR_COIN> upgrades to a WebSocket (101), as Solana's does, so a NEAR
//     page gets live trades (apps/helper/src/server.ts pushReaders; before, 404);
//   - pools: GET /v1/market/pools?chain=base&token=<BASE_COIN> answers 200 with Base's chain id (complete false while
//     the Base index is off, server.ts POOL_INDEX_ON), never 404, so a Base token page logs no failed load;
//   - holders: no Solana holder of the first HOLDER_COINS coins of the New list is an account off the ed25519 curve (a
//     bonding curve, pool or vault: a program's account, apps/helper/src/data/solana/token.ts listedHolders) unless it is
//     a burn, and no holder of NEAR_COIN is one of Ref's pool contracts (NEAR_POOLS, apps/helper/src/data/near/engine.ts);
//   - market cap: no row of the Base or Robinhood lists with a price has mc_usd 0 (the FDV stands in, else null,
//     apps/helper/src/data/evm/lists.ts and named.ts).
// After: helper
// Record: what the run read (the helper's public answers); a live run that fails keeps it beside its log
//   node scripts/live-checks/market-data-matches-the-page.mjs [--base <url>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2. --record writes what the run read, so the check's test can replay it.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";
import { request } from "node:https";
import { onCurve } from "../../apps/helper/src/data/solana/origin.ts";
import { b58decode } from "../../apps/helper/src/data/solana/lists.ts";

const KEY = "market-data-matches-the-page";
export const BASE = "https://ct-api.unrealized.trade";
export const APP = "https://ct-app.unrealized.trade";
// BLACKDRAGON (a NEAR coin with a Ref pool among its holders' accounts) and FLOWER (a Base coin), read 16 Nov
export const NEAR_COIN = "blackdragon.tkn.near";
export const BASE_COIN = "0x3e12b9d6a4d12cd9b4a6d613872d0eb32f68b380";
export const NEAR_POOLS = ["v2.ref-finance.near", "dclv2.ref-labs.near"];
export const HOLDER_COINS = 3;
const INCINERATOR = "1nc1nerator11111111111111111111111111111111";
const LISTS = ["new", "trending", "trending_5m", "trending_1h", "graduating"];

const obj = (v) => (typeof v === "object" && v !== null && !Array.isArray(v) ? v : {});
const arr = (v) => (Array.isArray(v) ? v : []);

/** The status a WebSocket upgrade of `url` answers (101 when it upgrades), or null when nothing answered in 10 s. */
export function upgradeStatus(url) {
  return new Promise((done) => {
    const key = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64");
    const req = request(url, { headers: { origin: APP, connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": key }, timeout: 10_000 });
    req.on("upgrade", (res, socket) => (socket.destroy(), done(res.statusCode ?? null)));
    req.on("response", (res) => (res.resume(), done(res.statusCode ?? null)));
    req.on("timeout", () => (req.destroy(), done(null)));
    req.on("error", () => done(null));
    req.end();
  });
}

/** The run: the NEAR push's upgrade status, Base's pools answer, the holders read, the EVM lists' priced rows' caps. */
export async function read(base = BASE, fetchFn = fetch, upgrade = upgradeStatus) {
  const b = base.replace(/\/$/, "");
  const get = async (p) => {
    const r = await fetchFn(`${b}${p}`, { headers: { origin: APP } });
    const text = await r.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {}
    return { status: r.status, body };
  };
  const push = await upgrade(`${b}/v1/market/push?chain=near&token=${NEAR_COIN}`);
  const p = await get(`/v1/market/pools?chain=base&token=${BASE_COIN}`);
  const pools = { status: p.status, chainId: obj(p.body).chainId ?? null, complete: obj(p.body).complete ?? null };
  const sl = await get("/v1/market/lists?chain=solana");
  const coins = arr(obj(obj(sl.body).lists).new).map((r) => obj(r).token).filter((t) => typeof t === "string").slice(0, HOLDER_COINS);
  const solana = [];
  for (const c of coins) {
    const h = await get(`/v1/market/holders?chain=solana&token=${c}`);
    solana.push({ coin: c, status: h.status, holders: arr(obj(h.body).holders).map((x) => ({ addr: obj(x).addr, bps: obj(x).bps, ...(obj(x).kind ? { kind: x.kind } : {}) })) });
  }
  const nh = await get(`/v1/market/holders?chain=near&token=${NEAR_COIN}`);
  const near = { status: nh.status, addrs: arr(obj(nh.body).holders).map((x) => obj(x).addr) };
  const caps = {};
  for (const chain of ["base", "robinhood"]) {
    const l = await get(`/v1/market/lists?chain=${chain}`);
    const rows = LISTS.flatMap((k) => arr(obj(obj(l.body).lists)[k])).map(obj);
    caps[chain] = { status: l.status, priced: rows.filter((r) => Number(r.price_usd) > 0).map((r) => ({ address: r.token, mc_usd: r.mc_usd ?? null })) };
  }
  return { base: b, at: new Date().toISOString(), push, pools, solana, near, caps };
}

/** A Solana holder row that is a wallet: a burn, the incinerator, or an owner on the ed25519 curve. */
const wallet = (h) => h.kind === "burn" || h.addr === INCINERATOR || (typeof h.addr === "string" && onCurve(b58decode(h.addr) ?? new Uint8Array()));

/** PASS or FAIL with one line per rule (a failed rule starts BAD). */
export function judge(r) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok" : "BAD"} ${text}`);
  say(r.push === 101, `the NEAR push upgrades to a WebSocket: ${r.push}`);
  const pl = obj(r.pools);
  say(pl.status === 200 && pl.chainId === 8453, `Base pools answer 200 with chain 8453: ${pl.status} ${pl.chainId} complete ${pl.complete}`);
  const sol = arr(r.solana);
  const off = sol.flatMap((c) => arr(c.holders).filter((h) => !wallet(h)).map((h) => `${c.coin.slice(0, 8)} ${h.addr} ${h.bps}`));
  say(sol.length > 0 && sol.every((c) => c.status === 200 && arr(c.holders).length > 0), `Solana holders read for ${sol.length} New coins: ${sol.map((c) => `${c.status}/${arr(c.holders).length}`).join(", ")}`);
  say(off.length === 0, `no Solana holder is a program's account: ${off.length ? off.slice(0, 3).join("; ") : "none"}`);
  const n = obj(r.near);
  const pooled = arr(n.addrs).filter((a) => NEAR_POOLS.includes(a));
  say(n.status === 200 && arr(n.addrs).length > 0, `NEAR holders read: ${n.status}, ${arr(n.addrs).length} rows`);
  say(pooled.length === 0, `no NEAR holder is a Ref pool: ${pooled.join(", ") || "none"}`);
  for (const [chain, c] of Object.entries(obj(r.caps))) {
    const zero = arr(c.priced).filter((x) => x.mc_usd !== null && !(Number(x.mc_usd) > 0));
    say(c.status === 200 && arr(c.priced).length > 0, `${chain} lists: ${c.status}, ${arr(c.priced).length} priced rows`);
    say(zero.length === 0, `no priced ${chain} row has MC 0: ${zero.length ? zero.slice(0, 3).map((x) => `${x.address} ${x.mc_usd}`).join("; ") : "none"}`);
  }
  return { ok: lines.every((l) => !l.startsWith("BAD")), lines };
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const r = await read(opt("--base", BASE));
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(r, null, 1)}\n`);
    const { ok, lines } = judge(r);
    for (const l of lines) console.log(l);
    console.log(`live-check ${KEY}: ${ok ? "PASS" : "FAIL"} (${r.base})`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
    process.exit(2);
  }
}
