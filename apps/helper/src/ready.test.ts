// node --test apps/helper/src/ready.test.ts (card helper-ready-gate): a deploy or restart of the helper is invisible to
// users. /v1/health answers ready only once the lists, a token page and its holders answer 200; a replacing helper takes
// the senders (their store and keys) only once the old one has let them go, and its sends wait for that; GeckoTerminal's
// one address is never asked twice for one window by two helpers: the next one takes the old one's calls and lists.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { Agent, createServer, request, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { enableTimers, resetTimers } from "../test/mock-timers.ts";
import * as nodeFs from "node:fs";
import * as server from "./server.ts";
import * as gk from "./data/gecko.ts";
import { createEvmLists, FACTORIES } from "./data/evm/lists.ts";
import { openDurableDir } from "./store/durable.ts";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const createHashOf = (label: string) => createHash("sha256").update(label).digest("hex");
// read off the modules, so this file loads at a base without them and each test fails on the behaviour (red runs)
const S = server as unknown as Record<string, any>;
const G = gk as unknown as Record<string, any>;

const ok = (body: unknown) => ({ status: 200, body: JSON.stringify(body), asOfMs: 1 });
const down = { status: 503, body: JSON.stringify({ error: { code: "upstream" } }) };
const MINT = "4Tdj8MDuQ7Nx1drP1fkf1H4FVvUDrgZ3kbgQpHWXpump";

function get(port: number, method: string, path: string, body?: string, agent?: Agent): Promise<{ status: number; body: string; headers: IncomingHttpHeaders }> {
  return new Promise((done, fail) => {
    const r = request({ host: "127.0.0.1", port, method, path, agent, headers: body === undefined ? {} : { "content-type": "application/json" } }, (res) => {
      let b = "";
      res.setEncoding("utf8").on("data", (d) => (b += d)).on("end", () => done({ status: res.statusCode ?? 0, body: b, headers: res.headers }));
    });
    r.on("error", fail).end(body);
  });
}

test("ready only once the Solana and EVM lists, a Solana token page and its holders answer 200", async () => {
  assert.equal(typeof S.isReady, "function", "server.ts isReady");
  const asked: string[] = [];
  const parts = (sol: object, evm: object, page: object, holders: object) => ({
    lists: { get: async () => sol },
    evmLists: { base: { get: async () => evm }, robinhood: { get: async () => evm } },
    token: { page: async (m: string) => (asked.push(`page ${m}`), page), holders: async (m: string) => (asked.push(`holders ${m}`), holders) },
  });
  const sol = ok({ lists: { new: [{ token: MINT }] } });
  const evm = ok({ lists: { new: [{ token: "0xa" }] }, unsettled: [] });
  assert.equal(await S.isReady(parts(down, evm, ok({}), ok({}))), false, "the Solana lists cold");
  assert.equal(await S.isReady(parts(sol, down, ok({}), ok({}))), false, "an EVM chain's lists cold");
  assert.equal(await S.isReady(parts(sol, evm, { status: 429, body: "{}" }, ok({}))), false, "the token page throttled");
  assert.equal(await S.isReady(parts(sol, evm, ok({}), down)), false, "the holders down");
  assert.equal(await S.isReady(parts(ok({ lists: { new: [] } }), evm, ok({}), ok({}))), false, "no token to read");
  asked.length = 0;
  assert.equal(await S.isReady(parts(sol, evm, ok({}), ok({}))), true);
  assert.deepEqual(asked.sort(), [`holders ${MINT}`, `page ${MINT}`], "the token read is one of the Solana list's");
});

test("GET /v1/health carries ready: false while warming, true once ready", async (t) => {
  let ready = false;
  const h = server.start(COMMIT, 0, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, ...([() => ready] as never[]));
  t.after(() => new Promise<void>((done) => (h.closeAllConnections(), h.close(() => done()))));
  await new Promise<void>((done) => h.on("listening", () => done()));
  const port = (h.address() as AddressInfo).port;
  assert.equal(JSON.parse((await get(port, "GET", "/v1/health")).body).ready, false);
  ready = true;
  assert.equal(JSON.parse((await get(port, "GET", "/v1/health")).body).ready, true);
});

test("a replacing helper takes the senders only once the old one lets their store go; its sends wait for that, then go", async (t) => {
  assert.equal(typeof S.sendersFromEnv, "function", "server.ts sendersFromEnv");
  const dir = mkdtempSync(join(tmpdir(), "senders-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // the old helper: it holds the senders' lock for its life (a second holder in one process is refused as in two)
  const old = openDurableDir(join(dir, "senders"), nodeFs, (d) => d);
  const env = { HELPER_STORE_DIR: dir };
  const s = S.sendersFromEnv(env, 20) as { held: Promise<void>; peer: boolean };
  assert.equal(s.peer, true, "another helper holds them: this one is a peer and takes no traffic until ready");
  let carried = 0;
  const withdraw = { carry: async () => (carried++, { status: 200, body: { ok: true } }), warm: () => undefined, stop: () => undefined };
  const h = server.start(COMMIT, 0, undefined, undefined, undefined, undefined, undefined, withdraw as never, undefined, undefined, undefined, undefined, undefined, ...([() => true, s.held] as never[]));
  t.after(() => new Promise<void>((done) => (h.closeAllConnections(), h.close(() => done()))));
  await new Promise<void>((done) => h.on("listening", () => done()));
  const port = (h.address() as AddressInfo).port;
  const sent = get(port, "POST", "/v1/withdraw", JSON.stringify({ token: "x" }));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(carried, 0, "no send while the old helper holds the store");
  old.close(); // the old helper exits
  const a = await sent;
  assert.equal(a.status, 200);
  assert.equal(carried, 1, "the send went once the store was this helper's");
  await s.held;
  // the helper before this card holds only the fee quoter's store (withdraw/fee.ts), which a second start used to stop
  // on (exit 2): the next one waits for it as for the senders' lock
  const dir2 = mkdtempSync(join(tmpdir(), "senders-"));
  t.after(() => rmSync(dir2, { recursive: true, force: true }));
  const oldFee = openDurableDir(join(dir2, "withdraw-fee"), nodeFs, (d) => d);
  const relayer = { HELPER_STORE_DIR: dir2, WITHDRAW_RELAYER_TESTNET: "relayer.testnet", WITHDRAW_FEE_RECIPIENT_TESTNET: "fees.testnet" };
  const s2 = S.sendersFromEnv(relayer, 20) as { held: Promise<void>; peer: boolean; fee: { networkOf(t: string): unknown } };
  assert.equal(s2.peer, true, "the old helper's fee store is held: a peer, never an exit");
  let took = false;
  void s2.held.then(() => (took = true));
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(took, false);
  oldFee.close();
  await s2.held;
  // a start alone: no peer, the senders at once
  const solo = S.sendersFromEnv({ HELPER_STORE_DIR: mkdtempSync(join(tmpdir(), "senders-")) }) as { peer: boolean };
  assert.equal(solo.peer, false);
});

test("GeckoTerminal's budget: a helper takes the old one's calls of the window and makes none while held", () => {
  let t = 1_800_000_000_000;
  const b = gk.geckoBudget(() => t) as unknown as gk.GeckoBudget & Record<string, any>;
  assert.equal(typeof b.seed, "function", "gecko.ts seed");
  b.seed([t - 70_000, t - 1_000, t - 1_000, t - 500, t - 100]);
  assert.equal(b.take("pages"), false, "the old helper's five calls fill the window");
  t += 5_001; // the oldest leaves the 75 s window
  assert.equal(b.take("pages"), true);
  b.hold();
  t += G.WINDOW_MS;
  assert.equal(b.take("pages"), false, "no call while held (the old helper may still be calling)");
  assert.ok(b.retryAt("pages") >= t + G.WINDOW_MS, "a page waits at least a window");
  b.release();
  assert.equal(b.take("pages"), true);
  assert.deepEqual(b.calls(), [t], "the calls of the window, for the next helper");
});

test("the EVM lists a helper read come back whole in the next one, parsed again, with no GeckoTerminal call", async () => {
  let now = Date.parse("2026-11-03T11:36:00Z");
  // GeckoTerminal's Base lists as recorded (data/evm/fixtures/gt-base-*, read 2026-11-03 11:35Z)
  const fx = (f: string) => readFileSync(new URL(`./data/evm/fixtures/${f}`, import.meta.url), "utf8");
  const answerOf = (url: string) => fx(url.includes("new_pools") ? "gt-base-new.json" : url.includes("duration=5m") ? "gt-base-trending-5m.json" : "gt-base-trending-1h.json");
  let gtCalls = 0;
  const fetch = (async (url: string) => {
    if (String(url).includes("geckoterminal")) return (gtCalls++, new Response(answerOf(String(url)), { status: 200, headers: { "content-type": "application/json" } }));
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "no" } }), { status: 200 });
  }) as never;
  const first = createEvmLists("base", gk.geckoBudget(() => now, 100), { fetch, now: () => now }) as ReturnType<typeof createEvmLists> & Record<string, any>;
  assert.equal(typeof first.state, "function", "evm/lists.ts state");
  await first.tick();
  assert.equal((await first.get()).status, 200);
  assert.equal(gtCalls, 3, "three lists read");
  const before = await first.get();
  const st = JSON.parse(JSON.stringify(first.state()));
  now += 10_000;
  const next = createEvmLists("base", gk.geckoBudget(() => now), { fetch, now: () => now }) as typeof first;
  assert.equal(next.restore(st), true, "every list taken over");
  const after = await next.get();
  assert.equal(after.status, 200);
  assert.equal(gtCalls, 3, "no GeckoTerminal call");
  assert.deepEqual(JSON.parse(after.body).lists, JSON.parse(before.body).lists);
  // hostile or stale state is not taken
  const fresh = () => createEvmLists("base", gk.geckoBudget(() => now), { fetch, now: () => now }) as typeof first;
  assert.equal(fresh().restore({ reads: { new: { raw: "not json", at: now }, trending_5m: st.reads.trending_5m, trending_1h: st.reads.trending_1h } }), false, "an answer that does not parse");
  // a read behind STALE_MS is taken over and served dated by it (card app-console-429: the lists never 503 once read)
  const behind = fresh();
  assert.equal(behind.restore({ reads: Object.fromEntries(Object.entries(st.reads).map(([k, r]: [string, any]) => [k, { ...r, at: now - 300_001 }])) }), true, "older than STALE_MS is taken, dated");
  const old = await behind.get();
  assert.deepEqual([old.status, JSON.parse(old.body).as_of_ms], [200, now - 300_001], "served with its own read time");
  assert.equal(fresh().restore({ reads: Object.fromEntries(Object.entries(st.reads).map(([k, r]: [string, any]) => [k, { ...r, at: now + 1 }])) }), false, "from the future");
  const m = fresh();
  m.restore({ ...st, makers: [["0x" + "b".repeat(40), "not-a-pad"], ["not an address", null]] });
  assert.ok(JSON.parse((await m.get()).body).unsettled.length > 0, "a maker with no pad of this chain or no address is not taken");
  // a none settled on another block clock is read again, a pad kept (card helper-ready-page-warm: from 18:00Z on
  // 2026-11-05 Base's old 2 s clock settled every new token as none, and the warm file carried each into the next helper)
  const toks: string[] = JSON.parse(before.body).lists.new.map((r: { token: string }) => r.token);
  const pad = FACTORIES.base[0]!.pad;
  const n = fresh();
  n.restore({ reads: st.reads, makers: [[toks[0], null], [toks[1], pad]] });
  const left: string[] = JSON.parse((await n.get()).body).unsettled;
  assert.ok(left.includes(toks[0]!), "a none restored from a file with no block clock is read again");
  assert.ok(!left.includes(toks[1]!), "a pad restored is kept");
  const other = fresh();
  other.restore({ reads: st.reads, clock: "[]", makers: [[toks[0], null]] });
  assert.ok(JSON.parse((await other.get()).body).unsettled.includes(toks[0]!), "a none settled on another block clock is read again");
});

test("card helper-ready-page-warm: a none settled on this chain's block clock comes back settled, so a swap's Base lists are as settled as the old helper's (live run 42104885123 attempt 1, 20:36Z: 35 of 44 listed tokens unsettled straight after the swap, every none dropped at the restore and read again at 10 a tick)", async () => {
  const now = Date.parse("2026-11-03T11:36:00Z");
  const fx = (f: string) => readFileSync(new URL(`./data/evm/fixtures/${f}`, import.meta.url), "utf8");
  const answerOf = (url: string) => fx(url.includes("new_pools") ? "gt-base-new.json" : url.includes("duration=5m") ? "gt-base-trending-5m.json" : "gt-base-trending-1h.json");
  const fetch = (async (url: string) => {
    if (String(url).includes("geckoterminal")) return new Response(answerOf(String(url)), { status: 200, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "no" } }), { status: 200 });
  }) as never;
  const old = createEvmLists("base", gk.geckoBudget(() => now, 100), { fetch, now: () => now }) as ReturnType<typeof createEvmLists> & Record<string, any>;
  await old.tick();
  const listed: string[] = [...new Set(Object.values(JSON.parse((await old.get()).body).lists as Record<string, { token: string }[]>).flat().map((r) => r.token))];
  // the old helper settled every listed token as none (the maker reads it made over its life)
  const st = JSON.parse(JSON.stringify(old.state()));
  st.makers = listed.map((t) => [t, null]);
  const next = createEvmLists("base", gk.geckoBudget(() => now), { fetch, now: () => now });
  assert.equal(next.restore(st), true);
  assert.deepEqual(JSON.parse((await next.get()).body).unsettled, [], "every none the old helper settled on this clock is kept");
});

test("card helper-ready-page-warm: ready waits until every EVM chain's lists have at most half their listed tokens unsettled, the rule market-data-evm reads", async () => {
  const row = (token: string) => ({ token });
  const evm = (unsettled: string[]) => ok({ lists: { new: [row("0xa"), row("0xb")], trending_5m: [row("0xc")], trending_1h: [row("0xd")], trending: [row("0xd")], graduating: [] }, unsettled });
  const parts = (base: object) => ({
    lists: { get: async () => ok({ lists: { new: [{ token: MINT }] } }) },
    evmLists: { base: { get: async () => base }, robinhood: { get: async () => evm([]) } },
    token: { page: async () => ok({}), holders: async () => ok({}) },
  });
  assert.equal(await S.isReady(parts(evm(["0xa", "0xb", "0xc"]))), false, "3 of 4 unsettled");
  assert.equal(await S.isReady(parts(ok({ lists: {} }))), false, "no unsettled list: not read as settled");
  assert.equal(await S.isReady(parts(evm(["0xa", "0xb"]))), true, "2 of 4 unsettled");
});

/** Real time for the loopback's I/O while setTimeout may be mocked (setImmediate never is). */
async function settle(ms = 150): Promise<void> {
  const until = performance.now() + ms;
  while (performance.now() < until) await new Promise((r) => setImmediate(r));
}
const RELAYER_ENV = { WITHDRAW_RELAYER_TESTNET: "relayer.testnet", WITHDRAW_FEE_RECIPIENT_TESTNET: "fees.testnet" };

test("a peer's retries never stall its event loop while the old helper holds the senders' lock or the fee store", async (t) => {
  for (const heldDir of ["senders", "withdraw-fee"]) {
    const dir = mkdtempSync(join(tmpdir(), "senders-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const old = openDurableDir(join(dir, heldDir), nodeFs, (d) => d);
    const s = S.sendersFromEnv({ HELPER_STORE_DIR: dir, ...RELAYER_ENV }) as { held: Promise<void>; peer: boolean }; // the 250 ms retry a start uses
    assert.equal(s.peer, true);
    // 200 ticks of a 10 ms interval (about 2 s of retries): each on time when it fires within 50 ms of the one before
    const gaps: number[] = [];
    await new Promise<void>((done) => {
      let last = performance.now();
      const tick = setInterval(() => {
        const t1 = performance.now();
        gaps.push(t1 - last);
        last = t1;
        if (gaps.length === 200) clearInterval(tick), done();
      }, 10);
    });
    old.close();
    await s.held;
    const onTime = gaps.filter((g) => g < 50).length;
    assert.ok(onTime >= 180, `${heldDir} held by the old helper: ${onTime} of 200 10 ms ticks on time (the longest gap ${Math.round(Math.max(...gaps))} ms)`);
  }
});

test("a stopping helper drains: the answer in flight closes its connection, and that connection carries no more requests", async (t) => {
  let release = () => undefined as void;
  let started = () => undefined as void;
  const withdraw = {
    carry: () => (started(), new Promise((ok) => (release = () => ok({ status: 200, body: { ok: true } })))),
    warm: () => undefined,
    stop: () => undefined,
  };
  /** One withdrawal in flight on a kept-alive connection, the stop, its answer, then a second request on that agent. */
  const run = async (stopOf: (h: ReturnType<typeof server.start>) => () => void) => {
    const h = server.start(COMMIT, 0, undefined, undefined, undefined, undefined, undefined, withdraw as never);
    const stop = stopOf(h); // set up at the start, as main does
    t.after(() => new Promise<void>((done) => (h.closeAllConnections(), h.close(() => done()))));
    await new Promise<void>((done) => h.on("listening", () => done()));
    const port = (h.address() as AddressInfo).port;
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    t.after(() => agent.destroy());
    const inFlight = new Promise<void>((ok) => (started = ok));
    const first = get(port, "POST", "/v1/withdraw", "{}", agent);
    await inFlight;
    stop();
    release();
    const a = await first;
    await settle(50);
    const next = await get(port, "GET", "/v1/health", undefined, agent).then((r) => r.status, (e: NodeJS.ErrnoException) => e.code);
    return { status: a.status, connection: a.headers.connection, next };
  };
  // Node 24's close alone: the busy connection stays kept alive and the old helper answers its next request
  const bare = await run((h) => () => (h.close(), h.closeIdleConnections()));
  assert.deepEqual(bare, { status: 200, connection: "keep-alive", next: 200 }, "server.close() alone never drains a busy connection");
  assert.equal(typeof S.drainer, "function", "server.ts drainer");
  const fixed = await run((h) => S.drainer(h));
  assert.equal(fixed.status, 200, "the answer in flight is out");
  assert.equal(fixed.connection, "close", "it closes its connection");
  assert.notEqual(fixed.next, 200, "no more requests reach the stopping helper");
});

/** The handler on a port, the senders `held` and the clock `now` given; every part not given is the env's default. */
async function listenOn(t: { after(f: () => unknown): void }, parts: { bind?: unknown; pools?: unknown; evmPools?: unknown; fee?: unknown; withdraw?: unknown }, held: Promise<unknown>, now: () => number): Promise<number> {
  const h = createServer(server.handler(COMMIT, undefined, undefined, undefined, undefined, parts.fee as never, parts.withdraw as never, undefined, parts.bind as never, null, parts.pools as never, parts.evmPools as never, now, {}, {}, () => true, held));
  t.after(() => new Promise<void>((done) => (h.closeAllConnections(), h.close(() => done()))));
  await new Promise<void>((done) => h.listen(0, "127.0.0.1", () => done()));
  return (h.address() as AddressInfo).port;
}
const pending = () => {
  let ok = () => undefined as void;
  const p = new Promise<void>((r) => (ok = r));
  return { p, ok };
};

test("a bind answers within HELPER_BIND_ANSWER_MS of its arrival: the wait for the senders is inside that bound", async (t) => {
  enableTimers(t.mock.timers, { apis: ["setTimeout"] });
  t.after(() => resetTimers(t.mock.timers));
  let clock = 1_800_000_000_000;
  const senders = pending();
  let carried = 0;
  // a loaded runner's real time before the carry is entered moves no clock the test drives (`clock` is the only one)
  const stall = () => {
    for (const until = performance.now() + 5; performance.now() < until; );
  };
  const bind = { carry: () => (stall(), carried++, new Promise(() => undefined)), warm: () => undefined };
  const port = await listenOn(t, { bind }, senders.p, () => clock);
  let answer: { status: number; body: string } | undefined;
  void get(port, "POST", "/v1/bind", "{}").then((a) => (answer = a));
  await settle();
  // the senders come 30 s after the bind arrived; its carry hangs
  clock += 30_000;
  t.mock.timers.tick(30_000);
  senders.ok();
  await settle();
  assert.equal(carried, 1, "carried once the senders are this helper's");
  clock += 15_000;
  t.mock.timers.tick(15_000);
  await settle();
  assert.ok(answer !== undefined, "answered by 45 s after it arrived, inside the device's 50 s");
  assert.equal(JSON.parse(answer.body).error.code, "in_flight", "the carry is out and its end not known: in_flight");
  // senders that never come: refused (nothing sent) by the same bound
  const never = pending();
  const port2 = await listenOn(t, { bind }, never.p, () => clock);
  let refused: { status: number; body: string } | undefined;
  void get(port2, "POST", "/v1/bind", "{}").then((a) => (refused = a));
  await settle();
  t.mock.timers.tick(45_000);
  await settle();
  assert.equal(refused?.status, 503);
  assert.equal(carried, 1, "nothing carried");
});

test("every route the senders serve waits for them, bounded: a send, a pool send and a fee quote go once they are this helper's, else 503 and nothing done", async (t) => {
  enableTimers(t.mock.timers, { apis: ["setTimeout"] });
  t.after(() => resetTimers(t.mock.timers));
  const done: string[] = [];
  const carrier = (name: string) => ({ carry: async () => (done.push(name), { status: 200, body: { ok: true } }), fee: () => ({}), ready: Promise.resolve(), warm: () => undefined, stop: () => undefined });
  const parts = {
    withdraw: carrier("withdraw"),
    pools: new Map([["sol-pool", carrier("pool solana")]]),
    evmPools: new Map([["evm-pool", carrier("pool evm")]]),
    fee: { networkOf: () => "testnet", quote: async () => (done.push("fee quote"), { fee: "1" }), reads: () => ({ feeMin: async () => 1n }) },
  };
  const asks: [string, string, string?][] = [
    ["POST", "/v1/withdraw", "{}"],
    ["POST", "/v1/pool/solana/send", JSON.stringify({ pool: "sol-pool" })],
    ["POST", "/v1/pool/evm/send", JSON.stringify({ pool: "evm-pool" })],
    ["GET", "/v1/withdraw/fee?token=nep141:wrap.testnet"],
  ];
  // the senders come: each waits, then goes
  const senders = pending();
  const port = await listenOn(t, parts, senders.p, Date.now);
  const answers = asks.map(([m, p, b]) => get(port, m, p, b));
  await settle();
  assert.deepEqual(done, [], "nothing goes while the old helper holds the senders");
  senders.ok();
  assert.deepEqual((await Promise.all(answers)).map((a) => a.status), [200, 200, 200, 200]);
  assert.deepEqual(done.sort(), ["fee quote", "pool evm", "pool solana", "withdraw"]);
  // they never come: each answers 503 at SENDERS_WAIT_MS, nothing done
  done.length = 0;
  const port2 = await listenOn(t, parts, pending().p, Date.now);
  const late = asks.map(([m, p, b]) => get(port2, m, p, b));
  await settle();
  t.mock.timers.tick(S.SENDERS_WAIT_MS);
  assert.deepEqual((await Promise.all(late)).map((a) => [a.status, JSON.parse(a.body).error?.code]), asks.map(() => [503, "upstream"]));
  assert.deepEqual(done, []);
});

test("the stop's drain outlasts a bind's answer, and the senders' wait outlasts the drain", () => {
  assert.ok(S.STOP_MS > 45_000, "a bind answers within HELPER_BIND_ANSWER_MS (45 s): the stop lets it finish");
  assert.ok(S.SENDERS_WAIT_MS >= S.STOP_MS, "the next helper waits as long as the old one may drain");
  const redeploy = readFileSync(new URL("../deploy/redeploy.sh", import.meta.url), "utf8");
  const stopS = Number(/docker stop -t ([0-9]+)/.exec(redeploy)?.[1]);
  assert.ok(stopS * 1000 > S.STOP_MS, `docker stop -t ${stopS} kills only past the drain`);
  assert.ok(S.SENDERS_WAIT_MS >= stopS * 1000, "the senders' wait covers a killed old helper's stop");
  const compose = readFileSync(new URL("../deploy/compose.yaml", import.meta.url), "utf8");
  assert.equal(/\n    stop_grace_period: ([0-9]+)s\n/.exec(compose)?.[1], String(stopS), "every compose stop of the helper waits as long as the redeploy's");
});

test("a peer writes no warm file until the senders are its own: the old helper's file at its stop is the one it seeds from", async (t) => {
  assert.equal(typeof S.warmWriter, "function", "server.ts warmWriter");
  const dir = mkdtempSync(join(tmpdir(), "warm-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "market", "warm.json");
  const senders = pending();
  const save = S.warmWriter(dir, senders.p, () => ({ at: Date.now(), gecko: [1], evm: {} })) as () => void;
  save();
  assert.equal(nodeFs.existsSync(file), false, "no write while the old helper holds the senders");
  senders.ok();
  await senders.p;
  await null;
  save();
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).gecko, [1]);
});

test("card helper-ready-without-gt: a helper beside a running one whose environment it refuses stops at its start with exit 2 naming the variable, never later in its warm-up (redeploys 18:55-18:58Z: the env file held POOL_EVM_SENDER_KEY_BASE_SEPOLIA with no POOL_EVM_ADDRESS_BASE_SEPOLIA; the peer threw it in its deferred listen, an unhandled rejection, exit 1 and a restart loop until the 300 s bound)", async (t) => {
  const { spawn } = await import("node:child_process");
  const { createHash } = await import("node:crypto");
  const dir = mkdtempSync(join(tmpdir(), "peer-env-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const old = openDurableDir(join(dir, "senders"), nodeFs, (d) => d); // the old helper holds the senders: this start is its peer
  t.after(() => old.close());
  const key = `0x${createHash("sha256").update("helper-pool-senders/test-key/EVM_SENDER").digest("hex")}`; // pool/evm.test.ts's test key
  const env = { PATH: process.env.PATH, HELPER_COMMIT: "0123456789abcdef0123456789abcdef01234567", PORT: "0", HELPER_STORE_DIR: dir, JUPITER_API_KEY: "test-jupiter-0001", RELAY_API_KEY: "test-relay-0001", LIFI_API_KEY: "test-lifi-0001", ONECLICK_JWT: "test-oneclick-0001", POOL_EVM_SENDER_KEY_BASE_SEPOLIA: key };
  const c = spawn(process.execPath, [join(import.meta.dirname, "server.ts")], { env, stdio: ["ignore", "ignore", "pipe"] });
  let err = "";
  c.stderr.on("data", (d) => (err += d));
  const code = await new Promise<number | string>((done) => {
    const timer = setTimeout(() => (c.kill("SIGKILL"), done("still running after 5 s")), 5_000);
    c.on("exit", (n) => (clearTimeout(timer), done(n ?? "signal")));
  });
  assert.equal(code, 2, `exit ${code}; stderr: ${err.replace(/\(node:\d+\) ExperimentalWarning[^\n]*\n(\(Use[^\n]*\n)?/g, "")}`);
  assert.match(err, /helper: POOL_EVM_ADDRESS_BASE_SEPOLIA must be an address/);
  assert.ok(!err.includes(key.slice(2)), "the key is never printed");
});

// card evm-pool-sync-holds: the start runs env-check.ts checkPoolRpcOperators beside the other readers, so a keyed
// Base or Robinhood URL of a pool-list operator stops it with exit 2, naming the variable, never the URL or its key
test("evm-pool-sync-holds: a start with a keyed Robinhood URL whose operator runs Robinhood's pool list exits 2 naming the variable, never the URL or its key", async (t) => {
  const { spawn } = await import("node:child_process");
  const dir = mkdtempSync(join(tmpdir(), "start-op-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { PATH: process.env.PATH, HELPER_COMMIT: COMMIT, PORT: "0", HELPER_STORE_DIR: dir, JUPITER_API_KEY: "test-jupiter-0001", RELAY_API_KEY: "test-relay-0001", LIFI_API_KEY: "test-lifi-0001", ONECLICK_JWT: "test-oneclick-0001", ROBINHOOD_RPC_URL_DRPC_1: "https://robinhood.rpc.grove.city/v1/FAKEKEY123" };
  const c = spawn(process.execPath, [join(import.meta.dirname, "server.ts")], { env, stdio: ["ignore", "ignore", "pipe"] });
  let err = "";
  c.stderr.on("data", (d) => (err += d));
  const code = await new Promise<number | string>((done) => {
    const timer = setTimeout(() => (c.kill("SIGKILL"), done("still running after 5 s")), 5_000);
    c.on("exit", (n) => (clearTimeout(timer), done(n ?? "signal")));
  });
  assert.equal(code, 2, `exit ${code}; stderr: ${err.replace(/\(node:\d+\) ExperimentalWarning[^\n]*\n(\(Use[^\n]*\n)?/g, "")}`);
  assert.match(err, /helper: ROBINHOOD_RPC_URL_DRPC_1: its operator pocket\.network runs the device's robinhood pool list/);
  assert.ok(!err.includes("FAKEKEY123") && !err.includes("grove.city"), "the URL or its key was printed");
});

test("card helper-ready-without-gt: a new helper whose GeckoTerminal window is full of the old helper's calls, and held for the handover, still turns ready: readiness reads the lists the warm file handed over, the Solana list, a token page and its holders, never GeckoTerminal", async () => {
  let now = Date.parse("2026-11-03T11:36:00Z");
  const fx = (f: string) => readFileSync(new URL(`./data/evm/fixtures/${f}`, import.meta.url), "utf8");
  const answerOf = (url: string) => fx(url.includes("new_pools") ? "gt-base-new.json" : url.includes("duration=5m") ? "gt-base-trending-5m.json" : "gt-base-trending-1h.json");
  let gtCalls = 0;
  const fetch = (async (url: string) => (gtCalls++, new Response(answerOf(String(url)), { status: 200, headers: { "content-type": "application/json" } }))) as never;
  const old = createEvmLists("base", gk.geckoBudget(() => now, 100), { fetch, now: () => now });
  await old.tick();
  const st = JSON.parse(JSON.stringify(old.state()));
  // the old helper settled its makers over its life (every listed token none here): its lists are as settled as they go
  st.makers = [...new Set(Object.values(JSON.parse((await old.get()).body).lists as Record<string, { token: string }[]>).flat().map((r) => r.token))].map((t) => [t, null]);
  const calls = gtCalls;
  now += 10_000;
  const budget = gk.geckoBudget(() => now);
  budget.seed(Array.from({ length: gk.GT_LIMIT_PER_MIN }, (_, i) => now - 1_000 * (i + 1))); // the old helper's window, full
  budget.hold(); // and none until the handover
  const lists = { base: createEvmLists("base", budget, { fetch, now: () => now }), robinhood: createEvmLists("robinhood", budget, { fetch, now: () => now }) };
  assert.equal(lists.base.restore(st), true);
  assert.equal(lists.robinhood.restore({ reads: Object.fromEntries(Object.entries(st.reads)), makers: st.makers, clock: "null" }), true);
  const ok200 = (body: unknown) => async () => ({ status: 200, body: JSON.stringify(body) });
  const PUMP = "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn";
  const p = { lists: { get: ok200({ lists: { new: [{ token: PUMP }] } }) }, evmLists: lists, token: { page: ok200({}), holders: ok200({}) } };
  assert.equal(await (S.isReady as (p: unknown) => Promise<boolean>)(p), true, "ready with the window full and held");
  assert.equal(gtCalls, calls, "no GeckoTerminal call");
});

// card evm-buy-hookdata-fee, review fold 4 MEDIUM-1: /v1/health says ready only once every pool's start check has
// passed, so a start that refuses (exit 2) never turns ready and redeploy.sh keeps the old helper serving
test("MEDIUM-1 poolsChecked: resolves once every Solana and EVM pool's start check has passed, asks a Solana pool again until its check settles, and a refusal calls refuse and rejects", async () => {
  assert.equal(typeof S.poolsChecked, "function", "server.ts poolsChecked");
  const later = () => {
    let ok!: () => void, no!: (e: Error) => void;
    const p = new Promise<void>((a, b) => ((ok = a), (no = b)));
    p.catch(() => {});
    return { p, ok, no };
  };
  const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
  const state = (p: Promise<void>) => {
    const s = { v: "pending" };
    p.then(() => (s.v = "ok"), () => (s.v = "rejected"));
    return s;
  };
  // a Solana check still waiting holds it; each ask is a getter read (pool/solana.ts ready reads the rent again)
  const sol = later();
  let asks = 0;
  const solPool = { get ready() { return (asks++, sol.p); } };
  const evm = later();
  const refused: string[] = [];
  const all = state(S.poolsChecked(new Map([["s", solPool]]), new Map([["e", { ready: () => evm.p }]]), (e: Error) => refused.push(e.message), 10) as Promise<void>);
  evm.ok();
  await tick(55);
  assert.equal(all.v, "pending", "the Solana check has not passed");
  assert.ok(asks >= 4, `asked again every 10 ms while it waits: ${asks}`);
  sol.ok();
  await tick();
  assert.equal(all.v, "ok");
  const after = asks;
  await tick(40);
  assert.equal(asks, after, "no ask once the check has settled");
  // an EVM refusal: refuse once with its message, and the gate rejects, while the Solana check still waits
  const sol2 = later();
  const evm2 = later();
  const refused2: string[] = [];
  const all2 = state(S.poolsChecked(new Map([["s", { ready: sol2.p }]]), new Map([["e", { ready: () => evm2.p }]]), (e: Error) => refused2.push(e.message), 10) as Promise<void>);
  evm2.no(new Error("POOL_EVM_RPCS_BASE_SEPOLIA: 127.0.0.1:1: no answer"));
  await tick();
  assert.deepEqual([all2.v, refused2], ["rejected", ["POOL_EVM_RPCS_BASE_SEPOLIA: 127.0.0.1:1: no answer"]]);
  sol2.ok();
  // a Solana refusal the same way
  const sol3 = later();
  const refused3: string[] = [];
  const all3 = state(S.poolsChecked(new Map([["s", { ready: sol3.p }]]), new Map(), (e: Error) => refused3.push(e.message), 10) as Promise<void>);
  sol3.no(new Error("the devnet pool fee must be the kit's fee for this rent, 1300000 lamports"));
  await tick();
  assert.deepEqual([all3.v, refused3.length], ["rejected", 1]);
  // no pools: passed at once
  assert.equal(await S.poolsChecked(new Map(), new Map(), () => assert.fail("no refusal")), undefined);
  assert.deepEqual(refused, []);
});

test("the helper is never ready before every pool's start check: with the warm-up ready (its lists 200), a Solana pool whose rent reads fail, a Solana fee refused or an EVM check refused keeps /v1/health at ready: false", async (t) => {
  assert.equal(typeof S.readyGate, "function", "server.ts readyGate");
  const { ed25519 } = await import("@noble/curves/ed25519.js");
  const { base58 } = await import("./bind/checks.ts");
  const { solanaPoolSender } = await import("./pool/solana.ts");
  const { solanaPoolFee } = await import("@blindfill/kit");
  const seed = new Uint8Array(Buffer.from(createHashOf("helper-pool-senders/server/FP"), "hex"));
  const feePayerSecret = base58(Uint8Array.from([...seed, ...ed25519.getPublicKey(seed)]));
  const program = base58(ed25519.getPublicKey(new Uint8Array(Buffer.from(createHashOf("helper-pool-senders/server/PROGRAM"), "hex"))));
  const RENT = { lamportsPerByte: 5_080n, factor: 1n as const }; // devnet's and mainnet's: fee 1,300,000
  const fee = String(solanaPoolFee(RENT));
  const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));
  // the warm-up's reads all answer 200: warmUntilReady resolves at its first ask
  const parts = { lists: { get: async () => ok({ lists: { new: [{ token: MINT }] } }) }, evmLists: { base: { get: async () => ok({ lists: {}, unsettled: [] }) } }, token: { page: async () => ok({}), holders: async () => ok({}) } };
  const health = async (ready: () => boolean) => {
    const h = server.start(COMMIT, 0, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, ...([ready] as never[]));
    t.after(() => new Promise<void>((done) => (h.closeAllConnections(), h.close(() => done()))));
    await new Promise<void>((done) => h.on("listening", () => done()));
    const port = (h.address() as AddressInfo).port;
    return async () => (JSON.parse((await get(port, "GET", "/v1/health")).body) as { ready: unknown }).ready;
  };
  const gateOf = (pools: Map<string, unknown>, evmPools: Map<string, unknown>, refused: string[]) => {
    const warm = S.warmUntilReady(parts, 10) as Promise<void>;
    const g = S.readyGate(warm, S.poolsChecked(pools, evmPools, (e: Error) => refused.push(e.message), 10)) as { ready: () => boolean; warmed: Promise<void> };
    let settled = "pending";
    g.warmed.then(() => (settled = "ok"), () => (settled = "rejected"));
    return { warm, g, settled: () => settled };
  };
  // 1. the Solana pool's rent reads fail: the check never settles, and the helper is not ready until a read is good
  let down = true;
  let reads = 0;
  const pool = solanaPoolSender({ cluster: "devnet", program, feePayerSecret, fee }, { providers: [(async () => null) as never, (async () => null) as never], log: () => {}, readRent: async () => { reads++; if (down) throw new Error("HTTP 503"); return RENT; } });
  const refused: string[] = [];
  const a = gateOf(new Map([["s", pool]]), new Map(), refused);
  const readyOf = await health(a.g.ready);
  await a.warm;
  for (let i = 0; i < 6; i++) {
    assert.equal(await readyOf(), false, `the warm-up is ready, the rent check is not (${reads} reads)`);
    await tick(15);
  }
  assert.ok(reads >= 3, `asked again while it waits: ${reads}`);
  assert.equal(a.settled(), "pending");
  down = false;
  await a.g.warmed;
  assert.equal(await readyOf(), true, "ready once the rent check passed");
  assert.deepEqual(refused, []);
  // 2. a fee off the kit's for the rent: refused, never ready
  const off = solanaPoolSender({ cluster: "devnet", program, feePayerSecret, fee: "1400000" }, { providers: [(async () => null) as never, (async () => null) as never], log: () => {}, readRent: async () => RENT });
  const refused2: string[] = [];
  const b = gateOf(new Map([["s", off]]), new Map(), refused2);
  const readyOf2 = await health(b.g.ready);
  await b.warm;
  await tick(30);
  assert.deepEqual([await readyOf2(), b.settled(), refused2.length], [false, "rejected", 1]);
  assert.match(refused2[0]!, /the devnet pool fee must be the kit's fee for this rent, 1300000 lamports/);
  // 3. an EVM pool's check refused, the same way
  const refused3: string[] = [];
  const c = gateOf(new Map(), new Map([["e", { ready: () => Promise.reject(new Error("POOL_EVM_RPCS_BASE_SEPOLIA: 127.0.0.1:1: no answer")) }]]), refused3);
  const readyOf3 = await health(c.g.ready);
  await c.warm;
  await tick(30);
  assert.deepEqual([await readyOf3(), c.settled(), refused3], [false, "rejected", ["POOL_EVM_RPCS_BASE_SEPOLIA: 127.0.0.1:1: no answer"]]);
});

/** The helper's own main on `env` (test keys only), /v1/health read every 50 ms until it exits or `boundMs` passes:
 *  its exit code (or "still running"), its stderr, and every health answer's `ready`. */
async function startOnce(env: Record<string, string>, boundMs: number): Promise<{ code: number | string; err: string; readies: unknown[] }> {
  const { spawn } = await import("node:child_process");
  const free = createServer().listen(0, "127.0.0.1");
  await new Promise((ok) => free.on("listening", ok));
  const port = (free.address() as AddressInfo).port;
  await new Promise((ok) => free.close(ok));
  const dir = mkdtempSync(join(tmpdir(), "pools-checked-"));
  const c = spawn(process.execPath, [join(import.meta.dirname, "server.ts")], {
    env: { PATH: process.env.PATH!, HELPER_COMMIT: COMMIT, PORT: String(port), HELPER_STORE_DIR: dir, JUPITER_API_KEY: "test-jupiter-0001", RELAY_API_KEY: "test-relay-0001", LIFI_API_KEY: "test-lifi-0001", ONECLICK_JWT: "test-oneclick-0001", ...env },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let err = "";
  c.stderr.on("data", (d) => (err += d));
  const readies: unknown[] = [];
  let exited = false;
  const code = new Promise<number | string>((done) => {
    const timer = setTimeout(() => (c.kill("SIGKILL"), done("still running")), boundMs);
    c.on("exit", (n) => ((exited = true), clearTimeout(timer), done(n ?? "signal")));
  });
  void (async () => {
    while (!exited) {
      const h = await get(port, "GET", "/v1/health").catch(() => null);
      if (h?.status === 200) readies.push((JSON.parse(h.body) as { ready: unknown }).ready);
      await new Promise((r) => setTimeout(r, 50));
    }
  })();
  const out = { code: await code, err: err.replace(/\(node:\d+\) ExperimentalWarning[^\n]*\n(\(Use[^\n]*\n)?/g, ""), readies };
  rmSync(dir, { recursive: true, force: true });
  return out;
}

test("MEDIUM-1 an EVM pool whose second RPC keeps 15 s of state stops the start with exit 2 naming that host, and /v1/health never says ready before it", async (t) => {
  // two JSON-RPC nodes on loopback, a block every 2 s up to now; the second answers state reads only for the last
  // 15 s, and each a second late, so the helper is up and answering its health while the check runs
  const g = BigInt(Math.floor(Date.now() / 1000)) - 2_000n;
  // two loopback addresses: an env pair must be two operators (fold B), and an IP host is its address
  const nodes = [0, 15].map((keepS) =>
    createServer((q, r) => {
      let body = "";
      q.on("data", (d) => (body += d)).on("end", () => {
        const { id, method, params } = JSON.parse(body) as { id: number; method: string; params: unknown[] };
        const latest = (BigInt(Math.floor(Date.now() / 1000)) - g) / 2n;
        const block = (n: bigint) => ({ number: `0x${n.toString(16)}`, timestamp: `0x${(g + 2n * n).toString(16)}`, hash: `0x${n.toString(16).padStart(64, "0")}`, baseFeePerGas: "0x3b9aca00" });
        const answer = (out: object) => r.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id, ...out }));
        if (method === "eth_getBlockByNumber") return answer({ result: block(params[0] === "latest" ? latest : BigInt(params[0] as string)) });
        if (method !== "eth_call") return answer({ error: { code: -32601, message: "no" } });
        const at = BigInt((params[1] as { blockHash: string }).blockHash);
        if (keepS === 0) return answer({ result: `0x${"0".repeat(63)}2` });
        setTimeout(() => answer(g + 2n * at < BigInt(Math.floor(Date.now() / 1000)) - 15n ? { error: { code: -32000, message: `historical state ${"ab".repeat(32)} is not available` } } : { result: `0x${"0".repeat(63)}2` }), 1_000);
      });
    }).listen(0, keepS === 0 ? "::1" : "127.0.0.1"),
  );
  t.after(() => nodes.forEach((s) => (s.closeAllConnections(), s.close())));
  await Promise.all(nodes.map((s) => new Promise((ok) => (s.listening ? ok(null) : s.once("listening", ok)))));
  const urls = nodes.map((s, i) => `http://${i === 0 ? "[::1]" : "127.0.0.1"}:${(s.address() as AddressInfo).port}`);
  const key = `0x${createHashOf("helper-pool-senders/test-key/EVM_SENDER")}`; // pool/evm.test.ts's test key
  const r = await startOnce({ POOL_EVM_ADDRESS_BASE_SEPOLIA: "0x00000000000000000000000000000000b1f1f001", POOL_EVM_SENDER_KEY_BASE_SEPOLIA: key, POOL_EVM_RPCS_BASE_SEPOLIA: urls.join(",") }, 15_000);
  assert.equal(r.code, 2, `exit ${r.code}; stderr: ${r.err}`);
  assert.match(r.err, new RegExp(`helper: POOL_EVM_RPCS_BASE_SEPOLIA: ${new URL(urls[1]!).host.replace(/\./g, "\\.")}: no answer to 0x[0-9a-f]{8} .*historical state`));
  assert.ok(!r.err.includes(new URL(urls[0]!).host), "the first provider answered");
  assert.ok(!r.err.includes(key.slice(2)), "the key is never printed");
  assert.ok(r.readies.length > 0, "the helper answered its health while the check ran");
  assert.ok(r.readies.every((x) => x === false), `never ready before the exit: ${JSON.stringify(r.readies)}`);
});

test("MEDIUM-1 a Solana pool whose configured fee is not the kit's stops the start with exit 2 even when its first rent read fails and no caller asks, and /v1/health never says ready before it", async (t) => {
  const { ed25519 } = await import("@noble/curves/ed25519.js");
  const { base58 } = await import("./bind/checks.ts");
  const seed = new Uint8Array(Buffer.from(createHashOf("helper-pool-senders/server/FP"), "hex"));
  const feePayer = base58(Uint8Array.from([...seed, ...ed25519.getPublicKey(seed)]));
  const program = base58(ed25519.getPublicKey(new Uint8Array(Buffer.from(createHashOf("helper-pool-senders/server/PROGRAM"), "hex"))));
  const RENT = "2BMAAAAAAAAAAAAAAADwPzI="; // the Rent sysvar devnet and mainnet answer: fee 1,300,000
  // the RPCs are down for the helper's first 3 s (its start read fails), then answer the rent
  const upAt = Date.now() + 3_000;
  let reads = 0;
  const stubs = [0, 1].map(() =>
    createServer((q, r) => {
      let b = "";
      q.on("data", (d) => (b += d)).on("end", () => {
        reads++;
        if (Date.now() < upAt) return void r.writeHead(500).end();
        const { id } = JSON.parse(b) as { id: number };
        r.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id, result: { context: { slot: 1 }, value: { owner: "Sysvar1111111111111111111111111111111111111", data: [RENT, "base64"], lamports: 1, executable: false } } }));
      });
    }).listen(0, "127.0.0.1"),
  );
  t.after(() => stubs.forEach((s) => (s.closeAllConnections(), s.close())));
  await Promise.all(stubs.map((s) => new Promise((ok) => (s.listening ? ok(null) : s.once("listening", ok)))));
  const urls = stubs.map((s) => `http://127.0.0.1:${(s.address() as AddressInfo).port}`).join(",");
  const r = await startOnce({ POOL_SOLANA_PROGRAM_DEVNET: program, POOL_SOLANA_FEE_PAYER_KEY_DEVNET: feePayer, POOL_SOLANA_FEE_DEVNET: "1400000", POOL_SOLANA_RPCS_DEVNET: urls }, 15_000);
  assert.equal(r.code, 2, `exit ${r.code} after ${reads} rent reads; stderr: ${r.err}`);
  assert.match(r.err, /helper: the devnet pool fee must be the kit's fee for this rent, 1300000 lamports/);
  assert.ok(r.readies.length > 0, "the helper answered its health while the check waited");
  assert.ok(r.readies.every((x) => x === false), `never ready before the exit: ${JSON.stringify(r.readies)}`);
});

test("card helper-ready-page-warm: the settle rule holds ready only for READY_SETTLE_MAX_MS from the warm-up's start: past it, lists that answer 200 are enough and one line names each chain still unsettled with its counts, so a maker-RPC outage never blocks a deploy (a security fix included)", async (t) => {
  const NOW0 = Date.parse("2026-11-05T22:00:00Z");
  enableTimers(t.mock.timers, { apis: ["setTimeout", "Date"], now: NOW0 });
  t.after(() => resetTimers(t.mock.timers));
  const lines: string[] = [];
  t.mock.method(console, "log", (l: string) => void lines.push(String(l)));
  const row = (token: string) => ({ token });
  const unsettledBase = ok({ lists: { new: [row("0xa"), row("0xb")], trending_5m: [row("0xc")], trending_1h: [row("0xd")], trending: [row("0xd")], graduating: [] }, unsettled: ["0xa", "0xb", "0xc"] });
  const parts = {
    lists: { get: async () => ok({ lists: { new: [{ token: MINT }] } }) },
    evmLists: { base: { get: async () => unsettledBase }, robinhood: { get: async () => ok({ lists: {}, unsettled: [] }) } },
    token: { page: async () => ok({}), holders: async () => ok({}) },
  };
  const bound: number = (S.READY_SETTLE_MAX_MS as number | undefined) ?? 240_000;
  assert.ok(bound > 0 && bound < 300_000, "inside redeploy.sh's REDEPLOY_READY_S default (300 s)");
  let done = false;
  void (S.warmUntilReady(parts, 1_000) as Promise<void>).then(() => (done = true));
  const step = async (ms: number) => {
    for (let left = ms; left > 0; left -= 1_000) {
      for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
      t.mock.timers.tick(Math.min(1_000, left));
    }
    for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
  };
  await step(bound - 2_000);
  assert.equal(done, false, "before the bound: 3 of 4 unsettled holds ready");
  await step(4_000);
  assert.equal(done, true, "past the bound: the lists answering 200 are enough");
  assert.deepEqual(lines.filter((l) => /unsettled/.test(l)).length, 1, "one line");
  assert.match(lines.find((l) => /unsettled/.test(l)) ?? "", /base 3 of 4/);
  assert.doesNotMatch(lines.find((l) => /unsettled/.test(l)) ?? "", /robinhood/);
});
