// node --test apps/helper/src/data/solana/page-timing.test.ts (card helper-ready-page-warm): a token page answer names
// what it waited on, in the standard Server-Timing header: the lists, the Solana RPC read (its wait for a hold or the
// provider's pace, its send, and a keyed provider's time before it fell back to the public endpoint), Jupiter's search
// (its wait for its turn, the search itself), the launch read, and the helper's whole time. Helper live run 42078439435
// (787f2a4): the first run of helper-token-page-cold after the deploy read p95 1672 ms, max 2784 ms, and nothing said
// which wait it was.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { b58encode } from "./lists.ts";
import * as T from "./token.ts";
import * as R from "../../rpc/rpc.ts";
import * as server from "../../server.ts";

const FX = JSON.parse(readFileSync(new URL("./fixtures/token-page.json", import.meta.url), "utf8"));
const PUMP = "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const mint = (n: number) => b58encode(Uint8Array.from({ length: 32 }, (_, i) => (i === 0 ? 1 + (n >> 8) : i === 1 ? n & 0xff : 7)));
const rowOf = (m: string) => ({ ...FX.tokens[PUMP].search[0], id: m });
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
/** Each entry's name and its dur (or its desc), in order. */
const entries = (h: string) => h.split(", ").map((e) => e.split(";")[0]);
const dur = (h: string, name: string) => Number(/dur=(\d+)/.exec(h.split(", ").find((e) => e.split(";")[0] === name) ?? "")?.[1] ?? NaN);

/** The RPC path as rpc.ts answers it: PUMP's mint account, with that read's timing entries. */
const rpc = {
  async handle(_c: string, _ct: string | undefined, body: string) {
    const r = JSON.parse(body) as { params: [string[], { encoding: string }] };
    const keys = r.params[0];
    await sleep(20);
    if (r.params[1].encoding === "base64") return { status: 200, body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: { context: { slot: 464517653 }, value: keys.map(() => null) } }) };
    const rec = FX.tokens[PUMP].accounts;
    return { status: 200, body: JSON.stringify({ ...rec, result: { ...rec.result, value: keys.map(() => rec.result.value[0]) } }), timing: ["rpc-wait;dur=300", 'rpc;dur=20;desc="solana"'] };
  },
};
/** Jupiter's search, answering after `lat` ms. */
const proxyOf = (lat: number) => ({
  async handle(_v: string, _p: string, q: string) {
    await sleep(lat);
    const mints = new URLSearchParams(q).get("query")!.split(",");
    return { status: 200, headers: { "X-Fetched-At": new Date().toISOString() }, body: JSON.stringify(mints.map(rowOf)) };
  },
});

test("card helper-ready-page-warm: a cold page's answer names each wait: the lists, the RPC read's wait and send, Jupiter's search turn and search, the launch read; served again from what is held it says cache (red at 787f2a4: no timing)", async () => {
  const tok = T.createSolanaToken(proxyOf(60) as never, rpc as never);
  // the second mint is asked while the first's search is out, so it goes in the next search
  const pa = tok.page(mint(1));
  await sleep(15);
  const [a, b] = await Promise.all([pa, tok.page(mint(2))]);
  assert.equal(a.status, 200);
  const h = (a as { timing?: string }).timing ?? "";
  assert.deepEqual(entries(h), ["lists", "rpc-wait", "rpc", "jup-wait", "jup", "launch", "read"], h);
  assert.equal(dur(h, "rpc-wait"), 300, "the RPC read's own wait carried as rpc.ts names it");
  assert.ok(dur(h, "jup") >= 55, h);
  // the second mint's search went once the first returned: its turn is the first search's time
  const hb = (b as { timing?: string }).timing ?? "";
  assert.ok(dur(hb, "jup-wait") >= 35, `the second search waited its turn: ${hb}`);
  assert.equal((await tok.page(mint(1)) as { timing?: string }).timing, "cache");
  // a page whose launch came in after it was built is served as filled from what is held: still cache
  await sleep(T.LAUNCH_WAIT_MS);
  assert.equal((await tok.page(mint(2)) as { timing?: string }).timing, "cache");
  assert.equal((await tok.holders(mint(1)) as { timing?: string }).timing, undefined, "a holders read made now names nothing yet");
  assert.equal((await tok.holders(mint(1)) as { timing?: string }).timing, "cache");
});

test("card helper-ready-page-warm: a keyed Solana provider's 429 names its time before the read fell back and the public endpoint's send (red at 787f2a4: no timing)", async () => {
  const KEYED = "https://solana.keyed.example/ct-proof-0123456789abcdef";
  const fetch = async (url: string, init: RequestInit) => {
    const id = (JSON.parse(String(init.body)) as { id: number }).id;
    if (url === KEYED) return new Response("{}", { status: 429, headers: { "retry-after": "1" } });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: 1 }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const rpcK = R.createRpc({ SOLANA_RPC_URL: KEYED }, { fetch, log: () => undefined });
  const a = (await rpcK.handle("solana", "application/json", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getMultipleAccounts", params: [[PUMP]] }))) as { status: number; timing?: string[] };
  assert.equal(a.status, 200);
  assert.deepEqual((a.timing ?? []).map((e) => e.split(";")[0]), ["rpc-keyed", "rpc"], String(a.timing));
  assert.match(a.timing![0]!, /desc="fell back"/);
  assert.match(a.timing![1]!, /desc="public"/);
});

test("card helper-ready-page-warm: GET /v1/market/token sends the read's entries and the helper's total in Server-Timing (red at 787f2a4: no header)", async (t) => {
  const token = { page: async () => (await sleep(30), { status: 200, body: "{}", src: "jupiter", asOfMs: 1, timing: 'rpc;dur=12;desc="solana"' }) };
  const h = server.start(COMMIT, 0, undefined, undefined, undefined, undefined, undefined, undefined, token as never);
  t.after(() => new Promise<void>((done) => (h.closeAllConnections(), h.close(() => done()))));
  await new Promise<void>((done) => h.on("listening", () => done()));
  const port = (h.address() as AddressInfo).port;
  const st = await new Promise<string>((done, fail) =>
    request({ host: "127.0.0.1", port, path: `/v1/market/token?chain=solana&token=${PUMP}` }, (res) => (res.resume(), done(String(res.headers["server-timing"] ?? "")))).on("error", fail).end(),
  );
  assert.deepEqual(entries(st), ["rpc", "total"], st);
  assert.ok(dur(st, "total") >= 25, st);
});
