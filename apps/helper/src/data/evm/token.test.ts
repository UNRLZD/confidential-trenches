// node --test apps/helper/src/data/evm/token.test.ts: GET /v1/market/token and /v1/market/holders with chain=base and
// chain=robinhood on a real server on a free port (card market-data-evm-token), with the deployed helper's recorded
// lists answers and the recorded on-chain token info answers (fixtures/token-info-<chain>.json, GeckoTerminal's v2 at
// 2026-11-09 01:49-01:52Z, the answer CoinGecko's keyed /onchain path serves) behind a fake keyed read: 200 in exactly
// the Solana path's frozen fields, the row the lists' own with its launchpad tag and chain, the info's decimals, holder
// count and top 10 share; an address the lists never served, or no address, 404; the key missing or missing a read
// never invents a value. Red at 26438c0c: both routes answered 404 for any chain but solana (server.ts:478). Card
// evm-token-page-off-the-5-call-window: the info is CoinGecko's keyed read, never GeckoTerminal's keyless window.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { ROW_FIELDS } from "../../../../terminal/src/screens/discover/fields.ts";
import { start } from "../../server.ts";
import { HOLDERS_FIELDS, PAGE_FIELDS, RISK_FIELDS } from "../solana/token.ts";
import { CHASE_PER_TICK, CHASE_TICK_MS, CHASE_TRIES, createEvmToken, HOLDERS_DAY, HOLDERS_GROUP, holdersDay, INFO_FRESH_MS, INFO_SERVE_MS, INFO_WAIT_MS, MISSED_HOLD_MS, toInfo } from "./token.ts";
import { CG_DAY } from "../coingecko.ts";
import { DAY_SYNC_MS, PROBE_DAY_SHARE } from "../../limits/limits.ts";
import type { DayPeers } from "../../limits/day-spend.ts";
import { enableTimers, resetTimers } from "../../../test/mock-timers.ts";

/** `p`'s answer once the promise steps queued now have run, with no timer firing; undefined while it waits on one. */
async function atOnce<T>(p: Promise<T>): Promise<T | undefined> {
  let got: T | undefined;
  void p.then((v) => (got = v));
  for (let i = 0; i < 10 && got === undefined; i++) await new Promise((r) => setImmediate(r));
  return got;
}

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
type Snapshot = { as_of_ms: number; lists: Record<string, Record<string, unknown>[]> };
/** `lists_body`: the deployed helper's lists answer as it sent it; `info`: GeckoTerminal's info answer per token. */
type Fixture = { recorded_at: string; lists_body: string; lists: Snapshot; info: Record<string, unknown>; info_404?: unknown };
const fx = (chain: string): Fixture => {
  const f = JSON.parse(readFileSync(new URL(`./fixtures/token-info-${chain}.json`, import.meta.url), "utf8")) as Fixture;
  return { ...f, lists: JSON.parse(f.lists_body) as Snapshot };
};
const FX = { base: fx("base"), robinhood: fx("robinhood") };
const NOW = Date.parse(FX.base.recorded_at);
/** The recorded token each chain's case reads, and the launchpad the deployed lists tagged it with on chain. */
const CASES = [
  { chain: "base", addr: "0x2df14792e7b9c5cc8e9a1eb37140533b32fb8d99", pad: "doppler", decimals: 18, holders: 154, top: 9550 },
  { chain: "robinhood", addr: "0xe71b15267238c80ec51a16d389cdd00133162ad2", pad: "pons", decimals: 18, holders: 2, top: 10_000 },
] as const;
const UNLISTED = "0x000000000000000000000000000000000000dead";

const rowOf = (chain: keyof typeof FX, token: string) => Object.values(FX[chain].lists.lists).flat().find((r) => r.token === token)!;
const listsOf = (chain: keyof typeof FX) => {
  const tokens = new Set(Object.values(FX[chain].lists.lists).flat().map((r) => r.token as string));
  return { get: async () => ({ status: 200, body: FX[chain].lists_body, asOfMs: FX[chain].lists.as_of_ms }), listed: async (t: string) => tokens.has(t) };
};
let calls = 0;
/** The keyed reads (../coingecko.ts Keyed) of one chain: the recorded info for each asked token, as CoinGecko's 200;
 *  "missed" as the key answers when its minute or day is spent or CoinGecko refused or failed (undefined). `bg`: each
 *  call's background flag. `gate`: awaited before each answer. */
const keyedOf = (chain: keyof typeof FX, mode: "ok" | "missed" = "ok", o: { bg?: boolean[]; gate?: () => Promise<unknown> } = {}) => ({
  read: async (path: string, ok: (json: unknown) => boolean, background = false): Promise<unknown> => {
    const m = new RegExp(`^/networks/${chain}/tokens/(0x[0-9a-f]{40})/info$`).exec(path);
    if (m === null) throw new Error(`unexpected ${path}`);
    calls++;
    o.bg?.push(background);
    await o.gate?.();
    if (mode !== "ok") return undefined;
    const a = FX[chain].info[m[1]!];
    return a !== undefined && ok(a) ? a : undefined;
  },
});
const tokens = (mode: "ok" | "missed" | "unset" = "ok") => ({
  base: createEvmToken("base", { lists: listsOf("base"), keyed: mode === "unset" ? null : keyedOf("base", mode), now: () => NOW }),
  robinhood: createEvmToken("robinhood", { lists: listsOf("robinhood"), keyed: mode === "unset" ? null : keyedOf("robinhood", mode), now: () => NOW }),
});
const at = (evmTokens: ReturnType<typeof tokens>) => start(COMMIT, 0, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, evmTokens);
const servers = [at(tokens()), at(tokens("missed")), at(tokens("unset"))];
const ports: number[] = [];
before(() => Promise.all(servers.map((s, i) => new Promise<void>((ok) => s.on("listening", () => ((ports[i] = (s.address() as AddressInfo).port), ok()))))));
after(() => Promise.all(servers.map((s) => new Promise<void>((ok) => (s.closeAllConnections(), s.close(() => ok()))))));

function call(path: string, to = 0) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((ok, fail) => {
    const r = request({ host: "127.0.0.1", port: ports[to], method: "GET", path }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (d: Buffer) => chunks.push(d)).on("end", () => ok({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    r.on("error", fail).end();
  });
}

for (const c of CASES) {
  test(`GET /v1/market/token?chain=${c.chain}: 200 in the frozen fields, the lists' row with its ${c.pad} tag, the keyed info's decimals, holders and top 10`, async () => {
    const r = await call(`/v1/market/token?chain=${c.chain}&token=${c.addr}`);
    assert.equal(r.status, 200, r.body);
    assert.equal(r.headers["x-helper-source"], "geckoterminal");
    const p = JSON.parse(r.body);
    // dated by the row's own list read (each list's; the snapshot's as_of_ms is the oldest of the three)
    assert.equal(r.headers["x-fetched-at"], new Date(rowOf(c.chain, c.addr).as_of_ms as number).toISOString());
    assert.deepEqual(Object.keys(p), [...PAGE_FIELDS]);
    assert.deepEqual(Object.keys(p.row), [...ROW_FIELDS]);
    assert.deepEqual(Object.keys(p.risk), [...RISK_FIELDS]);
    const listed = rowOf(c.chain, c.addr);
    assert.equal(p.row.chain, c.chain);
    assert.equal(p.row.token, c.addr);
    assert.equal(p.row.launchpad, c.pad);
    for (const f of ["symbol", "name", "price_usd", "mc_usd", "liq_usd", "vol_24h_usd", "created_s", "as_of_ms"]) assert.equal(p.row[f], listed[f], f);
    assert.equal(p.row.holders, c.holders);
    assert.equal(p.row.top10_bps, c.top);
    assert.equal(p.decimals, c.decimals);
    assert.equal(p.pool, null); // no swap read holds its pool here
    assert.deepEqual(p.risk.holders, { v: c.holders, src: "coingecko", as_of_ms: p.risk.holders.as_of_ms });
    assert.equal(p.risk.top10_bps.v, c.top);
    assert.deepEqual(p.risk.liq_usd, { v: listed.liq_usd, src: listed.src, as_of_ms: listed.as_of_ms });
    for (const f of ["mint_auth", "freeze_auth", "lp", "dev_bps", "snipers_bps", "tax", "honeypot", "insiders_bps", "bundlers_bps", "fresh_bps"]) assert.equal(p.risk[f].src, "none", f);
    assert.equal(p.route, "unknown");
    assert.equal(p.filling, false);
  });

  test(`GET /v1/market/holders?chain=${c.chain}: 200 in the frozen fields, no rows, the keyed info's count and top 10`, async () => {
    const r = await call(`/v1/market/holders?chain=${c.chain}&token=${c.addr}`);
    assert.equal(r.status, 200, r.body);
    const h = JSON.parse(r.body);
    assert.deepEqual(Object.keys(h), [...HOLDERS_FIELDS]);
    assert.deepEqual(h.holders, []);
    assert.equal(h.total, c.holders);
    assert.equal(h.top_bps, c.top);
    assert.equal(h.src, "coingecko");
  });
}

test("an address the lists never served, a mixed-case listed address, no token, two tokens, a non-address: 404 or the page", async () => {
  for (const chain of ["base", "robinhood"]) {
    for (const path of ["token", "holders"]) {
      for (const q of [`&token=${UNLISTED}`, "", `&token=${CASES[0].addr}&token=${CASES[0].addr}`, "&token=0x123", "&token=__proto__"]) {
        const r = await call(`/v1/market/${path}?chain=${chain}${q}`);
        assert.equal(r.status, 404, `${chain} ${path} ${q}`);
        assert.deepEqual(JSON.parse(r.body), { error: { code: "not_found" } });
      }
    }
  }
  // the lists' tokens are lowercase; the same address in checksum case is the same token
  const mixed = await call(`/v1/market/token?chain=base&token=0x${CASES[0].addr.slice(2).toUpperCase()}`);
  assert.equal(mixed.status, 200);
  assert.equal(JSON.parse(mixed.body).row.token, CASES[0].addr);
  for (const q of ["?chain=BASE", "?chain=eip155:8453", "?chain=constructor"]) assert.equal((await call(`/v1/market/token${q}&token=${CASES[0].addr}`)).status, 404, q);
});

test("the key missing a read (its minute or day spent, CoinGecko refusing or down) or no key set: the page is the lists' row with those fields null, holders 200 with no count (src none), never a value made up, never a 429 or a 503", async () => {
  for (const to of [1, 2]) {
    const r = await call(`/v1/market/token?chain=base&token=${CASES[0].addr}`, to);
    assert.equal(r.status, 200);
    const p = JSON.parse(r.body);
    assert.equal(p.row.holders, null);
    assert.equal(p.row.top10_bps, null);
    assert.equal(p.decimals, null);
    assert.equal(p.risk.holders.src, "none");
    assert.equal(p.row.launchpad, "doppler");
    const h = await call(`/v1/market/holders?chain=base&token=${CASES[0].addr}`, to);
    assert.equal(h.status, 200, h.body);
    const b = JSON.parse(h.body);
    assert.deepEqual([b.holders, b.total, b.top_bps, b.src], [[], null, null, "none"]);
  }
});

test("the info is read once a token and held INFO_FRESH_MS; a held page answers with no call and no wait", async (ctx) => {
  let t = NOW;
  calls = 0;
  const tok = createEvmToken("robinhood", { lists: listsOf("robinhood"), keyed: keyedOf("robinhood"), now: () => t });
  assert.equal((await tok.page(CASES[1].addr)).status, 200);
  assert.equal(calls, 1);
  // a held page waits on no timer: with the timers mocked and never moved, each answers at once
  enableTimers(ctx.mock.timers, { apis: ["setTimeout"] });
  try {
    for (let i = 0; i < 50; i++) assert.equal((await atOnce(tok.page(CASES[1].addr)))?.status, 200, `held page ${i} answered with no wait`);
  } finally {
    resetTimers(ctx.mock.timers);
  }
  await tok.holders(CASES[1].addr);
  assert.equal(calls, 1, "held: no second call");
  t += INFO_FRESH_MS;
  await tok.page(CASES[1].addr);
  assert.equal(calls, 2, "read again once INFO_FRESH_MS old");
});

test("a first info read slower than INFO_WAIT_MS: the page answers without it, the read lands for the next one", async (t) => {
  let release: () => void = () => {};
  const slow = new Promise<void>((ok) => (release = ok));
  const tok = createEvmToken("base", {
    lists: listsOf("base"),
    keyed: keyedOf("base", "ok", { gate: () => slow }),
    // a still clock: the page's wait is INFO_WAIT_MS from the request's start on it, never shortened by a slow machine
    // (the helper suite on a loaded box answered 1 ms before it, the rows' read having taken real time)
    now: () => NOW,
  });
  // the page's wait for the info on mocked timers: it answers at INFO_WAIT_MS, not 1 ms before
  enableTimers(t.mock.timers, { apis: ["setTimeout"] });
  let page: Awaited<ReturnType<typeof tok.page>> | undefined;
  try {
    const p = tok.page(CASES[0].addr);
    assert.equal(await atOnce(p), undefined, "it waits for the info read");
    t.mock.timers.tick(INFO_WAIT_MS - 1);
    assert.equal(await atOnce(p), undefined, "1 ms before INFO_WAIT_MS");
    t.mock.timers.tick(1);
    page = await atOnce(p);
  } finally {
    resetTimers(t.mock.timers);
  }
  assert.ok(page !== undefined, "answered at INFO_WAIT_MS");
  const first = JSON.parse(page.body);
  assert.equal(first.row.holders, null);
  release();
  await new Promise((ok) => setTimeout(ok, 10));
  assert.equal(JSON.parse((await tok.page(CASES[0].addr)).body).row.holders, CASES[0].holders);
});

test("the pool and decimals the swap reads found and checked on chain win over the info's decimals", async () => {
  const kept = { pool: "0x00000000000000000000000000000000000000000000000000000000000000ab", decimals: 6 };
  const tok = createEvmToken("base", { lists: listsOf("base"), keyed: keyedOf("base"), now: () => NOW, kept: (t) => (t === CASES[0].addr ? kept : undefined) });
  const p = JSON.parse((await tok.page(CASES[0].addr)).body);
  assert.equal(p.pool, kept.pool);
  assert.equal(p.decimals, 6);
});

test("a lists answer rebuilt with the same as_of_ms (a maker settled in a tick with no list read): the page takes its new tag", async () => {
  const snap = structuredClone(FX.base.lists);
  for (const r of Object.values(snap.lists).flat()) if (r.token === CASES[0].addr) r.launchpad = null;
  let body = JSON.stringify(snap);
  const lists = { get: async () => ({ status: 200, body, asOfMs: snap.as_of_ms }), listed: async () => true };
  const tok = createEvmToken("base", { lists, keyed: keyedOf("base"), now: () => NOW });
  assert.equal(JSON.parse((await tok.page(CASES[0].addr)).body).row.launchpad, null);
  body = FX.base.lists_body; // the same as_of_ms, the maker now read
  assert.equal(JSON.parse((await tok.page(CASES[0].addr)).body).row.launchpad, "doppler");
});

test("toInfo: only an answer naming this token; numbers in range or null", () => {
  const good = FX.base.info[CASES[0].addr];
  assert.notEqual(toInfo(CASES[0].addr, good, NOW), null);
  assert.equal(toInfo(UNLISTED, good, NOW), null, "another token's answer");
  assert.equal(toInfo(CASES[0].addr, FX.base.info_404, NOW), null);
  const bad = structuredClone(good) as { data: { attributes: Record<string, unknown> } };
  Object.assign(bad.data.attributes, { decimals: 99, holders: { count: -1, distribution_percentage: { top_10: "101.5" }, last_updated: "2099-01-01T00:00:00Z" } });
  assert.deepEqual(toInfo(CASES[0].addr, bad, NOW), { decimals: null, holders: null, top10Bps: null, asOfMs: NOW });
});

// Card market-data-evm-capacity: the holder count is display data that moves slowly, so a held one serves, dated by its
// own read, for INFO_SERVE_MS, while its re-read is background (it leaves callers the key's room). Card
// evm-token-page-off-the-5-call-window: a re-read the key misses leaves the held count served, never a 429.
test("a held info's re-read is background; missed, the held count serves, dated, while under INFO_SERVE_MS, never past it", async () => {
  let t = NOW;
  calls = 0;
  const bg: boolean[] = [];
  let mode: "ok" | "missed" = "ok";
  const ok = keyedOf("robinhood", "ok", { bg });
  const miss = keyedOf("robinhood", "missed", { bg });
  const tok = createEvmToken("robinhood", { lists: listsOf("robinhood"), keyed: { read: (p, f, b) => (mode === "ok" ? ok : miss).read(p, f, b) }, now: () => t, later: () => {} });
  const c = CASES[1];
  const first = JSON.parse((await tok.holders(c.addr)).body);
  assert.deepEqual([first.total, first.src], [c.holders, "coingecko"]);
  assert.deepEqual(bg, [false], "a first read is a caller's");
  // past INFO_FRESH_MS the key misses the re-read: the held count, dated by its read
  t += INFO_FRESH_MS;
  mode = "missed";
  const held = await tok.holders(c.addr);
  assert.equal(held.status, 200);
  assert.equal(JSON.parse(held.body).total, c.holders, "the held count");
  assert.equal(JSON.parse(held.body).as_of_ms, first.as_of_ms, "dated by its read, not by the answer");
  assert.equal(JSON.parse((await tok.page(c.addr)).body).row.holders, c.holders);
  assert.deepEqual(bg, [false, true, true], "each re-read background");
  // past INFO_SERVE_MS the held count is not served: no count from no source, never a count older than the bound and
  // never a 429 (card evm-chart-opens-without-a-vendor-call)
  t = NOW + INFO_SERVE_MS;
  const old = await tok.holders(c.addr);
  assert.equal(old.status, 200, old.body);
  assert.deepEqual([JSON.parse(old.body).total, JSON.parse(old.body).src], [null, "none"]);
  assert.equal(bg.at(-1), false, "past INFO_SERVE_MS a first read again, a caller's");
});

// Card evm-token-page-off-the-5-call-window: a first read the key misses (its minute spent by 50 users opening coins at
// once, token-load.test.ts) is chased in the background so the holders tab's next poll has the count, and a token the
// key never answers costs at most CHASE_TRIES + 1 calls an INFO_FRESH_MS.
test("a first read the key misses answers src none, is chased in the background, and the next read has the count with no call", async () => {
  let t = NOW;
  calls = 0;
  const due: { at: number; fn: () => void }[] = [];
  let mode: "ok" | "missed" = "missed";
  const ok = keyedOf("base");
  const miss = keyedOf("base", "missed");
  const tok = createEvmToken("base", { lists: listsOf("base"), keyed: { read: (p, f, b) => (mode === "ok" ? ok : miss).read(p, f, b) }, now: () => t, later: (fn, ms) => void due.push({ at: t + ms, fn }) });
  const h = await tok.holders(CASES[0].addr);
  assert.deepEqual([h.status, JSON.parse(h.body).total, JSON.parse(h.body).src], [200, null, "none"]);
  assert.equal(calls, 1);
  assert.equal(due.length, 1, "chased");
  assert.equal(due[0]!.at, NOW + CHASE_TICK_MS);
  // a read meanwhile makes no call of its own: the chase is on it
  assert.equal(JSON.parse((await tok.holders(CASES[0].addr)).body).src, "none");
  assert.equal(calls, 1);
  mode = "ok";
  t = due[0]!.at;
  due.shift()!.fn();
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  assert.equal(calls, 2, "the chase made its call");
  const again = await tok.holders(CASES[0].addr);
  assert.deepEqual([JSON.parse(again.body).total, JSON.parse(again.body).src], [CASES[0].holders, "coingecko"]);
  assert.equal(calls, 2, "served from the chase's read");
  assert.equal(due.length, 0, "the chase ended");
});

test("a token the key never answers: chased CHASE_TRIES times, then not read again for MISSED_HOLD_MS; at most CHASE_TRIES + 1 calls", async () => {
  let t = NOW;
  calls = 0;
  const due: { at: number; fn: () => void }[] = [];
  const tok = createEvmToken("base", { lists: listsOf("base"), keyed: keyedOf("base", "missed"), now: () => t, later: (fn, ms) => void due.push({ at: t + ms, fn }) });
  await tok.holders(CASES[0].addr);
  for (let i = 0; i < 100 && due.length > 0; i++) {
    const d = due.shift()!;
    t = d.at;
    d.fn();
    for (let k = 0; k < 20; k++) await new Promise((r) => setImmediate(r));
  }
  assert.equal(due.length, 0, "the chase ended");
  assert.equal(calls, CHASE_TRIES + 1);
  for (let i = 0; i < 10; i++) assert.equal(JSON.parse((await tok.holders(CASES[0].addr)).body).src, "none");
  assert.equal(calls, CHASE_TRIES + 1, "not read again inside MISSED_HOLD_MS");
  t += MISSED_HOLD_MS;
  await tok.holders(CASES[0].addr);
  assert.equal(calls, CHASE_TRIES + 2, "read again after it");
  assert.ok(CHASE_PER_TICK >= 1);
});

test("no key set: no read, holders src none at once, nothing chased", async () => {
  const due: unknown[] = [];
  const tok = createEvmToken("base", { lists: listsOf("base"), keyed: null, now: () => NOW, later: (fn) => void due.push(fn) });
  const h = await tok.holders(CASES[0].addr);
  assert.deepEqual([h.status, JSON.parse(h.body).src], [200, "none"]);
  assert.equal(JSON.parse((await tok.page(CASES[0].addr)).body).row.holders, null);
  assert.equal(due.length, 0);
});

// The CO's fold at b25a82fb7: the holders read within their own quarter of the CoinGecko key's day, apart from the charts'.
const callerCap = HOLDERS_DAY - Math.floor(HOLDERS_DAY * PROBE_DAY_SHARE);

test("HOLDERS_DAY is a quarter of the key's day; the holders' day stops at it and opens again at 00:00Z", () => {
  assert.equal(HOLDERS_DAY, Math.floor(CG_DAY / 4));
  let t = Date.parse("2026-11-18T10:00:00Z");
  const d = holdersDay(() => t);
  let n = 0;
  while (d.left() && n < 10_000) (d.spend(), n++);
  assert.equal(n, callerCap, "the cap, less the share every paced day keeps for probes (limits.ts PROBE_DAY_SHARE)");
  t = Date.parse("2026-11-19T00:00:00Z");
  assert.equal(d.left(), true, "a new UTC day");
});

test("the holders' day spent: no keyed call; a held count is still served, a token nothing is held for answers src none", async () => {
  let t = NOW;
  calls = 0;
  const day = holdersDay(() => t);
  const tok = createEvmToken("robinhood", { lists: listsOf("robinhood"), keyed: keyedOf("robinhood"), now: () => t, later: () => {}, day });
  const held = CASES[1];
  assert.equal(JSON.parse((await tok.holders(held.addr)).body).total, held.holders);
  assert.equal(calls, 1);
  while (day.left()) day.spend();
  t += INFO_FRESH_MS; // a re-read is due, the day is spent
  const h = await tok.holders(held.addr);
  assert.deepEqual([JSON.parse(h.body).total, JSON.parse(h.body).src], [held.holders, "coingecko"], "the held count, under INFO_SERVE_MS");
  const other = Object.keys(FX.robinhood.info).find((a) => a !== held.addr)!;
  const o = await tok.holders(other);
  assert.deepEqual([o.status, JSON.parse(o.body).total, JSON.parse(o.body).src], [200, null, "none"]);
  assert.equal(calls, 1, "no call once the holders' day is spent");
});

test("the holders' day is counted with the helper it replaces: a deploy's next helper starts from the day's spend", () => {
  let t = Date.parse("2026-11-18T10:00:00Z");
  const files = new Map<string, { day: number; units: Map<string, number> }>();
  const peersOf = (id: string): DayPeers => ({
    write: (day, units) => void files.set(id, { day, units: new Map(units) }),
    read: (day) => {
      const sum = new Map<string, number>();
      for (const [k, f] of files) if (k !== id && f.day === day) for (const [g, u] of f.units) sum.set(g, (sum.get(g) ?? 0) + u);
      return sum;
    },
  });
  const old = holdersDay(() => t, peersOf("a"));
  // a read each DAY_SYNC_MS (limits.ts), so each spend is written to the old helper's file as it is made
  for (let i = 0; i < callerCap - 10; i++) (old.spend(), (t += DAY_SYNC_MS));
  assert.equal(files.get("a")?.units.get(HOLDERS_GROUP) !== undefined, true, "the old helper's spend is in its day file");
  const next = holdersDay(() => t, peersOf("b"));
  let n = 0;
  while (next.left() && n < 10_000) (next.spend(), n++);
  assert.ok(n <= 10, `the next helper read ${n}, the day had ${10} left`);
});
