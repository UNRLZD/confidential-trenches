// node --test apps/helper/src/rpc/timing.test.ts (card solana-quote-under-1s): every POST /v1/rpc/{chain} answer, 200,
// 429 and 503, carries the standard Server-Timing header: rpc-wait (the hold and pace waits before the send), rpc (the
// upstream sends' time) and, in rpc's desc, the provider of the keyed list that was sent to, by its environment NAME
// only. A provider-B read that answers slowly can then be told apart from a read that waited for its second's room.
// No entry ever holds a URL, a host or a key: a key-like path segment is planted and looked for in every header.
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createRpc } from "./rpc.ts";
import { handler } from "../server.ts";

// planted key-like path segments (16 characters or more: rpc.ts readUpstreams takes them as a key's place)
const KEY_MAIN = `ctproof-main-${"0".repeat(20)}`;
const KEY_QN = `ctproof-qn-${"1".repeat(20)}`;
const MAIN = `https://solana-main.keyed.example/${KEY_MAIN}`;
const QN = `https://solana-qn.quiknode.example/${KEY_QN}/`;
const SECRETS = [KEY_MAIN, KEY_QN, "solana-main.keyed.example", "solana-qn.quiknode.example", "https://", "ctproof"];
const BODY = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBalance", params: ["11111111111111111111111111111111"] });
const ok = (id = 1) => new Response(JSON.stringify({ jsonrpc: "2.0", id, result: { context: { slot: 1 }, value: 0 } }), { status: 200, headers: { "content-type": "application/json" } });

type Entry = { name: string; dur: number; desc?: string };
const entries = (h: string): Entry[] =>
  h.split(/,\s*/).map((e) => {
    const [name, ...params] = e.split(";");
    const p = Object.fromEntries(params.map((x) => x.split("=") as [string, string]));
    return { name: name!, dur: Number(p.dur), ...(p.desc === undefined ? {} : { desc: p.desc.replace(/^"|"$/g, "") }) };
  });
const clean = (where: string, text: string) => {
  for (const s of SECRETS) assert.ok(!text.includes(s), `${where} holds ${s}: ${text}`);
};

async function serve(rpc: ReturnType<typeof createRpc>) {
  const h = createServer(handler("a".repeat(40), undefined, rpc, undefined, undefined, undefined, undefined, undefined, undefined, null, new Map(), new Map()));
  await new Promise<void>((done) => h.listen(0, "127.0.0.1", () => done()));
  const port = (h.address() as AddressInfo).port;
  const post = (ip: string) =>
    new Promise<{ status: number; headers: Record<string, string | string[] | undefined> }>((done, fail) => {
      const r = request({ host: "127.0.0.1", port, method: "POST", path: "/v1/rpc/solana", headers: { "content-type": "application/json", origin: "https://ct-app.unrealized.trade", "x-forwarded-for": ip } }, (res) => {
        res.resume().on("end", () => done({ status: res.statusCode ?? 0, headers: res.headers }));
      });
      r.on("error", fail).end(BODY);
    });
  return { post, close: () => new Promise<void>((done) => (h.closeAllConnections(), h.close(() => done()))) };
}

test("a paced burst on the first key: every 200 names rpc-wait, rpc and SOLANA_RPC_URL; a later one waited for its second", async () => {
  // 30 a 10 s: 3 sends a second on the first key (rpc.ts pacedOf)
  const rpc = createRpc({ SOLANA_RPC_URL: MAIN, RPC_BUDGET_SOLANA: "30,20" }, { fetch: async (_u, i) => ok(JSON.parse(String(i!.body)).id), log: () => undefined });
  const S = await serve(rpc);
  try {
    const all = await Promise.all(Array.from({ length: 6 }, (_, k) => S.post(`203.0.113.${10 + k}`)));
    const waits: number[] = [];
    for (const r of all) {
      assert.equal(r.status, 200);
      const h = String(r.headers["server-timing"] ?? "");
      clean("Server-Timing", JSON.stringify(r.headers));
      const e = entries(h);
      assert.deepEqual(e.map((x) => x.name), ["rpc-wait", "rpc"], h);
      assert.equal(e[1]!.desc, "SOLANA_RPC_URL", h);
      assert.ok(e.every((x) => Number.isFinite(x.dur) && x.dur >= 0), h);
      waits.push(e[0]!.dur);
    }
    assert.ok(Math.max(...waits) >= 500, `a later send waited for the next second: ${waits.join(" ")}`);
    assert.equal(Math.min(...waits), 0, `the first sends went at once: ${waits.join(" ")}`);
  } finally {
    await S.close();
  }
});

test("the first key throttled: the read is answered by the QuickNode spare, named SOLANA_RPC_URL_QUICKNODE, after the first key's send", async () => {
  const rpc = createRpc({ SOLANA_RPC_URL: MAIN, SOLANA_RPC_URL_QUICKNODE: QN }, {
    fetch: async (u, i) => (u === MAIN ? new Response(`{"error":"slow down ${KEY_MAIN}"}`, { status: 429, headers: { "retry-after": "5" } }) : ok(JSON.parse(String(i!.body)).id)),
    log: () => undefined,
  });
  const S = await serve(rpc);
  try {
    const r = await S.post("203.0.113.40");
    assert.equal(r.status, 200);
    const h = String(r.headers["server-timing"] ?? "");
    clean("headers", JSON.stringify(r.headers));
    const rpcEntries = entries(h).filter((x) => x.name === "rpc");
    assert.equal(rpcEntries.at(-1)!.desc, "SOLANA_RPC_URL_QUICKNODE", h);
    assert.ok(entries(h).some((x) => x.name === "rpc-wait"), h);
  } finally {
    await S.close();
  }
});

test("a 503 (every provider down) and a 429 (the chain held) carry Server-Timing too, with no URL, host or key", async () => {
  let mode: "down" | "429" = "down";
  const rpc = createRpc({ SOLANA_RPC_URL: MAIN }, {
    fetch: async (u) => {
      if (mode === "down") throw new Error(`connect ECONNREFUSED ${u}`);
      return new Response(`slow ${KEY_MAIN}`, { status: 429, headers: { "retry-after": "30" } });
    },
    publicFallback: false,
    log: () => undefined,
  });
  const S = await serve(rpc);
  try {
    const down = await S.post("203.0.113.50");
    assert.equal(down.status, 503);
    clean("503 headers", JSON.stringify(down.headers));
    const d = entries(String(down.headers["server-timing"] ?? ""));
    assert.deepEqual(d.map((x) => x.name), ["rpc-wait", "rpc"], String(down.headers["server-timing"]));
    assert.equal(d[1]!.desc, "SOLANA_RPC_URL", "the provider it sent to");
    mode = "429";
    let held: { status: number; headers: Record<string, string | string[] | undefined> } | undefined;
    for (let k = 0; k < 3 && held?.status !== 429; k++) held = await S.post(`203.0.113.${60 + k}`);
    assert.equal(held!.status, 429);
    clean("429 headers", JSON.stringify(held!.headers));
    const t = entries(String(held!.headers["server-timing"] ?? ""));
    assert.deepEqual(t.map((x) => x.name), ["rpc-wait", "rpc"], String(held!.headers["server-timing"]));
  } finally {
    await S.close();
  }
});

test("a refused request (not JSON-RPC, a method off the list) still carries Server-Timing, naming no provider", async () => {
  const rpc = createRpc({ SOLANA_RPC_URL: MAIN }, { fetch: async () => ok(), log: () => undefined });
  const a = await rpc.handle("solana", "application/json", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "requestAirdrop", params: [] }));
  assert.equal(a.status, 400);
  assert.deepEqual((a as { timing?: string[] }).timing, ["rpc-wait;dur=0", 'rpc;dur=0;desc="none"']);
});
