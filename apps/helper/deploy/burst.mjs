#!/usr/bin/env node
// A burst of page opens against a helper (card helper-answers-through-a-burst): `--sessions` pages open the terminal's
// first screen at once, each making the helper reads that screen makes in its first `--seconds` (apps/terminal/src: the
// four chains' lists, screens/discover/data.ts; the token, screens/token/source.ts; its tape, trades.ts; its push
// socket; its chart, candles.ts, 500 bars then 2 every second; its logo), each page its own client. `--coins` spreads the
// pages over that many of the Solana lists' coins (page i opens coin i mod n), as the test browsers' shards open many
// token pages, each a cold chart and tape the first time; 1 (the default) opens the first coin only. A probe reads GET
// /v1/health every 100 ms all along. It prints one JSON line: the answers by status (and how many lacked the CORS
// header the page needs), the failures by cause, the answer times' p50/p95/p99/max, the longest stretch in which no
// answer came back (`stallMs`) and the probe's slowest read.
//   node apps/helper/deploy/burst.mjs --base http://127.0.0.1:18080 [--sessions 300] [--seconds 10]
//     [--client-header X-Forwarded-For] [--origin https://ct-app.unrealized.trade] [--timeout-ms 30000] [--coins 1]
// --client-header: the header each page's own address goes in (X-Forwarded-For with the helper reached directly; the
// proof's test Caddyfile maps X-Burst-Client to it). Never against the live host with a large --sessions: the live check
// (scripts/live-checks/helper-answers-through-a-burst.mjs) is the bounded one.
import "../../../scripts/net-window.mjs";
import { parseArgs } from "node:util";
import WebSocket from "ws";

const { values: a } = parseArgs({
  options: {
    base: { type: "string" },
    sessions: { type: "string", default: "300" },
    seconds: { type: "string", default: "10" },
    "client-header": { type: "string", default: "" },
    origin: { type: "string", default: "https://ct-app.unrealized.trade" },
    "timeout-ms": { type: "string", default: "30000" },
    coins: { type: "string", default: "1" },
  },
});
async function main() {
  if (a.base === undefined) throw new Error("--base is required");
  const BASE = a.base.replace(/\/$/, "");
  const SESSIONS = Number(a.sessions);
  const SECONDS = Number(a.seconds);
  const TIMEOUT_MS = Number(a["timeout-ms"]);
  const CHAINS = ["solana", "base", "robinhood", "near"];

  const times = [];
  const status = {};
  const errors = {};
  const doneAt = [];
  const t0 = performance.now();
  const pct = (xs, p) => (xs.length === 0 ? null : xs[Math.min(xs.length - 1, Math.ceil((p / 100) * xs.length) - 1)]);
  const causeOf = (e) => String(e?.cause?.code ?? e?.code ?? e?.name ?? "error");
  const count = (o, k) => (o[k] = (o[k] ?? 0) + 1);
  const clientHeaders = (client) => (a["client-header"] ? { [a["client-header"]]: client } : {});

  async function get(path, client) {
    const began = performance.now();
    try {
      const r = await fetch(`${BASE}${path}`, { headers: { Origin: a.origin, "Accept-Encoding": "gzip, br, zstd", ...clientHeaders(client) }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      const body = await r.arrayBuffer();
      times.push(performance.now() - began);
      doneAt.push(performance.now());
      count(status, r.status);
      if (r.headers.get("access-control-allow-origin") !== a.origin) count(status, `${r.status} no CORS`);
      return { status: r.status, body };
    } catch (e) {
      times.push(performance.now() - began);
      doneAt.push(performance.now());
      count(errors, causeOf(e));
      return null;
    }
  }

  // the coins the pages open: the first --coins of the Solana lists, from one read made before the burst
  const warm = await get("/v1/market/lists?chain=solana", "10.255.255.254");
  let coins = [];
  try {
    const s = JSON.parse(new TextDecoder().decode(warm?.body ?? new ArrayBuffer(0)));
    coins = [...new Set(Object.values(s.lists ?? {}).flat().map((r) => r?.token).filter((t) => typeof t === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(t)))].slice(0, Math.max(1, Number(a.coins)));
  } catch {
    coins = [];
  }
  if (coins.length === 0) throw new Error("the helper's Solana lists named no token: is it ready?");
  times.length = 0;
  doneAt.length = 0;
  for (const k of Object.keys(status)) delete status[k];

  let probeMax = 0;
  let probing = true;
  const probe = (async () => {
    while (probing) {
      const began = performance.now();
      await get("/v1/health", "10.255.255.253");
      probeMax = Math.max(probeMax, performance.now() - began);
      await new Promise((ok) => setTimeout(ok, 100));
    }
  })();

  const push = { opened: 0, failed: 0 };
  function socket(client, token) {
    return new Promise((ok) => {
      const ws = new WebSocket(`${BASE.replace(/^http/, "ws")}/v1/market/push?chain=solana&token=${token}`, { headers: { Origin: a.origin, ...clientHeaders(client) } });
      const timer = setTimeout(() => (push.failed++, ws.terminate(), ok()), TIMEOUT_MS);
      ws.on("open", () => (push.opened++, clearTimeout(timer), setTimeout(() => (ws.close(), ok()), SECONDS * 1000)));
      ws.on("error", () => (push.failed++, clearTimeout(timer), ok()));
    });
  }

  async function page(i) {
    const client = `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`;
    const token = coins[i % coins.length];
    const q = `chain=solana&token=${token}`;
    const reads = [...CHAINS.map((c) => get(`/v1/market/lists?chain=${c}`, client)), get(`/v1/market/token?${q}`, client), get(`/v1/market/trades?${q}&limit=50`, client), get(`/v1/logo/solana/${token}`, client), socket(client, token)];
    // the chart: 500 bars, then the last 2 every second (candles.ts LIVE_MS), each after the one before answers
    reads.push(
      (async () => {
        await get(`/v1/market/candles?${q}&tf=15m&limit=500`, client);
        const end = performance.now() + SECONDS * 1000;
        while (performance.now() < end) {
          const began = performance.now();
          await get(`/v1/market/candles?${q}&tf=15m&limit=2`, client);
          await new Promise((ok) => setTimeout(ok, Math.max(0, 1000 - (performance.now() - began))));
        }
      })(),
    );
    await Promise.all(reads);
  }

  const burstAt = performance.now();
  await Promise.all(Array.from({ length: SESSIONS }, (_, i) => page(i + 1)));
  probing = false;
  await probe;
  const endAt = performance.now();

  // the longest stretch with no answer back, from the burst's start to its last answer
  const marks = [burstAt, ...doneAt.filter((t) => t >= burstAt).sort((x, y) => x - y)];
  let stall = 0;
  for (let k = 1; k < marks.length; k++) stall = Math.max(stall, marks[k] - marks[k - 1]);
  const sorted = [...times].sort((x, y) => x - y);
  const r = (x) => (x === null ? null : Math.round(x));
  console.log(
    JSON.stringify({
      base: BASE,
      sessions: SESSIONS,
      coins: coins.length,
      requests: times.length,
      status,
      errors,
      push,
      ms: { p50: r(pct(sorted, 50)), p95: r(pct(sorted, 95)), p99: r(pct(sorted, 99)), max: r(sorted.at(-1) ?? null) },
      stallMs: r(stall),
      probeMaxMs: r(probeMax),
      wallMs: r(endAt - burstAt),
      warmupMs: r(burstAt - t0),
    }),
  );
}

if (import.meta.main) await main();
