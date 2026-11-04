// node --test apps/helper/src/ready.test.ts (card helper-ready-gate): a deploy or restart of the helper is invisible to
// users. /v1/health answers ready only once the lists, a token page and its holders answer 200; a replacing helper takes
// the senders (their store and keys) only once the old one has let them go, and its sends wait for that; GeckoTerminal's
// one address is never asked twice for one window by two helpers: the next one takes the old one's calls and lists.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { Agent, createServer, request, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as nodeFs from "node:fs";
import * as server from "./server.ts";
import * as gk from "./data/gecko.ts";
import { createEvmLists } from "./data/evm/lists.ts";
import { openDurableDir } from "./store/durable.ts";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
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
  assert.equal(await S.isReady(parts(down, ok({}), ok({}), ok({}))), false, "the Solana lists cold");
  assert.equal(await S.isReady(parts(sol, down, ok({}), ok({}))), false, "an EVM chain's lists cold");
  assert.equal(await S.isReady(parts(sol, ok({}), { status: 429, body: "{}" }, ok({}))), false, "the token page throttled");
  assert.equal(await S.isReady(parts(sol, ok({}), ok({}), down)), false, "the holders down");
  assert.equal(await S.isReady(parts(ok({ lists: { new: [] } }), ok({}), ok({}), ok({}))), false, "no token to read");
  asked.length = 0;
  assert.equal(await S.isReady(parts(sol, ok({}), ok({}), ok({}))), true);
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
  t.mock.timers.enable({ apis: ["setTimeout"] });
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
  t.mock.timers.enable({ apis: ["setTimeout"] });
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
