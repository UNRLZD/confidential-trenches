// A `node --import` preload for test/warm-start-coingecko.test.ts (card helper-warm-start-coingecko-bound): the helper
// process runs as deployed, but every request it makes to the outside is answered here from fixtures already in the
// repo, or with a 503, and each one is written as a line to the file NET_REPLAY_LOG names: the URL with no query and no
// header (the key goes in a header, never into a line). Nothing reaches a network: fetch is replaced, node:http and
// node:https outbound refuse every host but 127.0.0.1, and the Solana tape's WebSocket never opens.
import { appendFileSync, readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";

const LOG = process.env.NET_REPLAY_LOG ?? "";
if (LOG === "") throw new Error("net-replay: NET_REPLAY_LOG is unset");
const read = (file) => JSON.parse(readFileSync(file, "utf8"));
const SOL = read(new URL("../src/data/solana/fixtures/token-page.json", import.meta.url));
const SOL_TAPE = read(new URL("../src/data/solana/fixtures/sol-pool-trades-nearkat.json", import.meta.url));

const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
const none = (status) => new Response(null, { status });

/** GeckoTerminal's /pools/<pool>/trades rows for the recorded tape: the fixture keeps each row's legs as legs.from and
 *  legs.to, the answer has them as from_token_address and the rest (solana/token.test.ts geckoTrades does the same). */
const TAPE = {
  data: SOL_TAPE.trades.map(({ id, legs, ...a }) => ({ id, type: "trade", attributes: { ...a, from_token_address: legs.from[0], from_token_amount: legs.from[1], to_token_address: legs.to[0], to_token_amount: legs.to[1] } })),
};
const TAPE_TOKEN = { data: { relationships: { top_pools: { data: [{ id: `solana_${SOL_TAPE.pool}`, type: "pool" }] } } } };

/** The on-chain answer for `path` (the part after /onchain, or after GeckoTerminal's /api/v2, query left off). Every Solana
 *  mint but the recorded tape's has the one top pool and the one set of bars of token-page.json; the tape's mint has its
 *  own pool and rows. A path of no fixture is the 404 the vendor gives a coin it has not indexed. */
function onchain(path) {
  let m;
  if (/^\/networks\/solana\/pools\/[^/]+\/ohlcv\/(minute|hour|day)$/.test(path)) return json(SOL.gt_ohlcv);
  if ((m = /^\/networks\/solana\/pools\/([^/]+)\/trades$/.exec(path))) return m[1] === SOL_TAPE.pool ? json(TAPE) : json({ data: [] });
  if ((m = /^\/networks\/solana\/tokens\/([^/]+)$/.exec(path))) return json(m[1] === SOL_TAPE.mint ? TAPE_TOKEN : SOL.gt_token);
  return none(404);
}

const ORIGIN_CG = "https://pro-api.coingecko.com/api/v3/onchain";
const ORIGIN_GT = "https://api.geckoterminal.com/api/v2";

function answer(u) {
  if (u.startsWith(ORIGIN_CG)) return onchain(u.slice(ORIGIN_CG.length));
  if (u.startsWith(ORIGIN_GT)) return onchain(u.slice(ORIGIN_GT.length));
  return none(503);
}

globalThis.fetch = async (input) => {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const u = new URL(raw);
  const bare = `${u.origin}${u.pathname}`;
  appendFileSync(LOG, `${bare}\n`);
  return answer(bare);
};

const refuse = (what) => (opts, ...rest) => {
  const host = typeof opts === "string" ? new URL(opts).hostname : opts instanceof URL ? opts.hostname : (opts?.hostname ?? opts?.host ?? "");
  if (host !== "127.0.0.1") throw new Error(`net-replay: ${what} to ${String(host)} refused`);
  return realRequest[what](opts, ...rest);
};
const realRequest = { http: http.request, https: https.request };
http.request = refuse("http");
https.request = refuse("https");
syncBuiltinESMExports();

// the Solana tape's stream: a socket that never opens (the helper falls to its reads)
globalThis.WebSocket = class {
  constructor(url) {
    appendFileSync(LOG, `ws ${new URL(url).origin}\n`);
    this.readyState = 3;
    this.listeners = {};
    queueMicrotask(() => this.emit("error", {}), 0);
    queueMicrotask(() => this.emit("close", {}), 0);
  }
  addEventListener(t, f) {
    (this.listeners[t] ??= []).push(f);
  }
  removeEventListener() {}
  close() {}
  send() {}
  emit(t, e) {
    for (const f of this.listeners[t] ?? []) f(e);
    this[`on${t}`]?.(e);
  }
};
