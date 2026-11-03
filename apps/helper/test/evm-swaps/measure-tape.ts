// The swap-to-tape speed harness (card index-evm-swaps-2). It runs the Base swaps reader in this process on the public providers,
// opens one token, then polls its trade tape every 100 ms and times how long a swap takes to show: seen_ms - t_ms, the time
// from the swap's block to the answer that first lists its transaction.
//
//   node apps/helper/test/evm-swaps/measure-tape.ts --chain base --token <addr> --tick 1000 --n 20 [--rpcs url,url] [--max-s 600]
//
// Reads the live chain; not part of any test run. It opens one book, so one tick reads the head on two providers and the
// pool's logs on two providers (the helper's RPC rules in swaps.ts). Keep one run at a time: the providers' free limits are
// per address.
//
// How to read the numbers. A block's timestamp is whole seconds (t_ms is that second times 1000) and a Base block is made
// within its second, so the latency is measured from the START of the block's second: the swap itself is up to about 1 s
// later than that, and the figure is an upper bound on what a trader waits by up to 1 s. The clocks are this machine's and the
// chain's; clock_skew_ms_est is this machine's clock minus a provider's HTTP Date header (whole seconds, so +-1000), shown so
// a skewed machine is seen. A tx counts when it first appears after the first answer; polls are 100 ms apart, and an answer
// that has to look up a new trader (eth_getTransactionByHash) takes that long to return, as it does for the app.
import "../../../../scripts/net-window.mjs";
import { createSwaps, SWAP_RPCS, TICK_MS } from "../../src/data/evm/swaps.ts";

const POLL_MS = 100;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function fail(msg: string): never {
  console.error(`measure-tape: ${msg}`);
  process.exit(2);
}

const chain = arg("chain") ?? "base";
if (chain !== "base" && chain !== "robinhood") fail("--chain base or robinhood");
const token = (arg("token") ?? "").toLowerCase();
if (!/^0x[0-9a-f]{40}$/.test(token)) fail("--token must be a 0x address");
const tickMs = Number(arg("tick") ?? TICK_MS);
if (!Number.isInteger(tickMs) || tickMs < 100 || tickMs > 60_000) fail("--tick must be 100 to 60000 (ms)");
const nWant = Number(arg("n") ?? 20);
if (!Number.isInteger(nWant) || nWant < 1 || nWant > 500) fail("--n must be 1 to 500");
const maxS = Number(arg("max-s") ?? 600);
if (!Number.isInteger(maxS) || maxS < 1 || maxS > 3600) fail("--max-s must be 1 to 3600");
const rpcs = arg("rpcs") === undefined ? [...SWAP_RPCS[chain]] : arg("rpcs")!.split(",").filter((u) => u !== "");
for (const u of rpcs) if (!/^https:\/\/[^\s]+$/.test(u)) fail(`--rpcs entry is not an https URL: ${u}`);
if (rpcs.length < 2) fail("--rpcs needs at least two providers");

// What the reader asks of each provider, counted at the fetch it is given: no change to src.
type Count = { requests: number; bytes: number; byMethod: Record<string, number>; statuses: Record<string, number>; rpcErrors: number; holdsSeen: number; lastLimitText: string | null };
// Two phases: "open" is the token's first answer (pool discovery and the cold read), "steady" is everything after it, the
// load an open book puts on a provider.
const phases = { open: new Map<string, Count>(), steady: new Map<string, Count>() };
let phase: keyof typeof phases = "open";
const count = (url: string): Count => {
  let c = phases[phase].get(url);
  if (c === undefined) phases[phase].set(url, (c = { requests: 0, bytes: 0, byMethod: {}, statuses: {}, rpcErrors: 0, holdsSeen: 0, lastLimitText: null }));
  return c;
};
let skewMs: number | null = null;
const LIMIT = /rate.?limit|too many requests|limit (reached|exceeded)|request limit/i;
const countingFetch = async (url: string, init: RequestInit): Promise<Response> => {
  const c = count(url);
  let methods: string[] = [];
  try {
    const body = JSON.parse(String(init.body)) as unknown;
    methods = (Array.isArray(body) ? body : [body]).map((x) => String((x as { method?: unknown }).method));
  } catch {
    // a body we cannot read is counted as one unknown request
    methods = ["?"];
  }
  c.requests += 1;
  for (const m of methods) c.byMethod[m] = (c.byMethod[m] ?? 0) + 1;
  const r = await fetch(url, init);
  c.statuses[String(r.status)] = (c.statuses[String(r.status)] ?? 0) + 1;
  if (r.status === 429) {
    c.holdsSeen += 1;
    c.lastLimitText = `HTTP 429 retry-after=${r.headers.get("retry-after") ?? "none"}`;
  } else if (r.status === 200) {
    const date = r.headers.get("date");
    if (skewMs === null && date !== null && Number.isFinite(Date.parse(date))) skewMs = Date.now() - Date.parse(date);
    // an error inside a 200 answer: read a copy, the reader reads the original
    const text = await r.clone().text();
    c.bytes += text.length; // the answers are ASCII (hex), so characters are bytes
    if (text.length < 1_000_000 && text.includes('"error"')) {
      c.rpcErrors += 1;
      const m = LIMIT.exec(text);
      if (m !== null) {
        c.holdsSeen += 1;
        c.lastLimitText = text.slice(Math.max(0, m.index - 80), m.index + 120);
      }
    }
  }
  return r;
};

const swaps = createSwaps(chain, { listed: async () => true, rpcs, tickMs, fetch: countingFetch });
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type Trade = { t_ms: number; tx: string };
async function tape(): Promise<{ status: number; trades: Trade[] }> {
  const a = await swaps.trades(token, 50);
  if (a.status !== 200) return { status: a.status, trades: [] };
  const body = JSON.parse(a.body) as { trades?: unknown };
  const list = Array.isArray(body.trades) ? body.trades : [];
  return { status: 200, trades: list.filter((x): x is Trade => typeof x === "object" && x !== null && typeof (x as Trade).tx === "string" && Number.isSafeInteger((x as Trade).t_ms)) };
}

const startedAt = Date.now();
const first = await tape();
if (first.status !== 200) {
  swaps.stop();
  fail(`opening the token answered ${first.status} (a token with no supported pool answers 404; 503 is the providers failing)`);
}
const openedAt = Date.now();
phase = "steady";
const known = new Set(first.trades.map((t) => t.tx));
const samples: { tx: string; t_ms: number; seen_ms: number; latency_ms: number }[] = [];
let polls = 1;
let backlogSkipped = 0;
let timedOut = false;
let lastErr = 0;
while (samples.length < nWant) {
  if (Date.now() - openedAt > maxS * 1000) {
    timedOut = true;
    break;
  }
  await sleep(POLL_MS);
  const a = await tape();
  polls += 1;
  const seen = Date.now();
  if (a.status !== 200) {
    lastErr = a.status;
    continue;
  }
  for (const t of a.trades) {
    if (known.has(t.tx)) continue;
    known.add(t.tx);
    // a swap in a block older than the open's end was waiting for the first tick, not made while we watched: not a sample
    if (t.t_ms <= openedAt) {
      backlogSkipped += 1;
      continue;
    }
    if (samples.length < nWant) samples.push({ tx: t.tx, t_ms: t.t_ms, seen_ms: seen, latency_ms: seen - t.t_ms });
  }
}
const endedAt = Date.now();
swaps.stop();

const sorted = samples.map((s) => s.latency_ms).sort((a, b) => a - b);
const rank = (p: number): number | null => (sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!);
const seconds = (endedAt - openedAt) / 1000;
const table = (m: Map<string, Count>, secs: number) =>
  Object.fromEntries([...m].map(([u, c]) => [new URL(u).host, { ...c, requests_per_s: Number((c.requests / secs).toFixed(2)), bytes_per_s: Math.round(c.bytes / secs) }]));
const providers = { open: table(phases.open, (openedAt - startedAt) / 1000), steady: table(phases.steady, seconds) };
const steadyAll = [...phases.steady.values()];
const allCounts = [...phases.open.values(), ...steadyAll];
const out = {
  chain,
  token,
  tick_ms: tickMs,
  rpcs: rpcs.map((u) => new URL(u).host),
  started_at: new Date(startedAt).toISOString(),
  n_wanted: nWant,
  n_got: samples.length,
  backlog_skipped: backlogSkipped,
  timed_out: timedOut,
  watched_s: Number(seconds.toFixed(1)),
  polls,
  last_non_200: lastErr === 0 ? null : lastErr,
  // the head read runs once per provider per tick, so the busiest provider's count of it after the open is the tick count
  ticks_after_open: Math.max(0, ...steadyAll.map((c) => c.byMethod["eth_getBlockByNumber"] ?? 0)),
  latency_ms: { p50: rank(50), p95: rank(95), max: sorted.length === 0 ? null : sorted[sorted.length - 1]! },
  latency_note: "seen_ms - t_ms; t_ms is the block time in whole seconds, so this runs from the start of the block's second (up to ~1000 ms before the swap itself)",
  clock_skew_ms_est: skewMs,
  provider_holds_seen: allCounts.reduce((s, c) => s + c.holdsSeen, 0),
  providers,
  samples,
};
console.log(JSON.stringify(out, null, 2));
process.exit(timedOut && samples.length === 0 ? 1 : 0);
