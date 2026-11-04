// node --test apps/helper/src/ready.test.ts (card helper-ready-gate): a deploy or restart of the helper is invisible to
// users. /v1/health answers ready only once the lists, a token page and its holders answer 200; a replacing helper takes
// the senders (their store and keys) only once the old one has let them go, and its sends wait for that; GeckoTerminal's
// one address is never asked twice for one window by two helpers: the next one takes the old one's calls and lists.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request } from "node:http";
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

function get(port: number, method: string, path: string, body?: string): Promise<{ status: number; body: string }> {
  return new Promise((done, fail) => {
    const r = request({ host: "127.0.0.1", port, method, path, headers: body === undefined ? {} : { "content-type": "application/json" } }, (res) => {
      let b = "";
      res.setEncoding("utf8").on("data", (d) => (b += d)).on("end", () => done({ status: res.statusCode ?? 0, body: b }));
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
  assert.equal(fresh().restore({ reads: Object.fromEntries(Object.entries(st.reads).map(([k, r]: [string, any]) => [k, { ...r, at: now - 300_000 }])) }), false, "older than STALE_MS");
  assert.equal(fresh().restore({ reads: Object.fromEntries(Object.entries(st.reads).map(([k, r]: [string, any]) => [k, { ...r, at: now + 1 }])) }), false, "from the future");
  const m = fresh();
  m.restore({ ...st, makers: [["0x" + "b".repeat(40), "not-a-pad"], ["not an address", null]] });
  assert.ok(JSON.parse((await m.get()).body).unsettled.length > 0, "a maker with no pad of this chain or no address is not taken");
});
