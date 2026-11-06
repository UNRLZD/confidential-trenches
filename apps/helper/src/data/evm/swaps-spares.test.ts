// node --test apps/helper/src/data/evm/swaps-spares.test.ts: card evm-rpc-spare-list. The swap reader goes on while any
// listed provider answers. Base lists four (SWAP_RPCS); with the first two ranked providers down (HTTP 503, or a refused
// connection) the head read asked the third, then asked the first two again in its patient round and never the fourth: no
// head, and every tape, chart and discovery read of the chain stopped (5 Nov 2026, the spare list).
import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeChain, ICNT, open, REC } from "../../../test/evm-swaps/base.ts";

const FOUR = ["https://a.test", "https://b.test", "https://c.test", "https://d.test"];
type Down = "503" | "refused" | "history";

/** The fake chain behind four providers. `onlyFor` says which methods the dead providers fail ("head": the head read;
 *  "reads": the logs and calls, their head answering). The first two providers asked such a method are the dead ones, so
 *  the test does not depend on how the reader ranks four equal providers; the others answer as the fake chain does. */
function rig(how: Down, onlyFor: "head" | "reads") {
  const chain = fakeChain();
  chain.st.head = REC.firstHead + 200;
  const dead = new Set<string>();
  const asked: string[] = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const methods = (JSON.parse(String(init.body)) as { method: string }[]).map((r) => r.method);
    asked.push(`${url} ${methods.join(",")}`);
    // the dead ones are the first two providers asked a method of this kind
    const kind = onlyFor === "head" || methods.some((m) => m !== "eth_getBlockByNumber");
    if (kind && dead.size < 2) dead.add(url);
    if (kind && dead.has(url)) {
      if (how === "refused") throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });
      // a provider that keeps only its newest blocks (rpc-robinhood.blockmachine.io, read 2026-11-05 19:48Z): each call
      // of the batch answered with its -32002, HTTP 200
      if (how === "history") {
        const ids = (JSON.parse(String(init.body)) as { id: unknown }[]).map((r) => r.id);
        return new Response(JSON.stringify(ids.map((id) => ({ jsonrpc: "2.0", id, error: { code: -32002, message: "keyless requests are served for the most recent 5000 blocks only" } }))), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("down", { status: 503 });
    }
    return chain.fetch(url, init);
  };
  const s = open(chain, { t: 5_000_000 }, { rpcs: FOUR, fetch: fetch as never });
  return { s, dead, asked };
}

for (const how of ["503", "refused"] as const) {
  test(`with the first two of four providers answering ${how === "503" ? "HTTP 503" : "a refused connection"} to every read, the head read asks the third and the fourth before it asks any provider twice, and a first tape answers 200`, async () => {
    const { s, dead, asked } = rig(how, "head");
    try {
      const r = await s.trades(ICNT, 50);
      assert.equal(dead.size, 2);
      const live = FOUR.filter((u) => !dead.has(u));
      assert.ok(live.every((u) => asked.some((a) => a.startsWith(u))), `a provider that answers was never asked: ${asked.join(" | ")}`);
      // the head read walks the whole list before it asks any provider twice (a later read may rank the spare among its
      // first two and so answer; this one must not need that)
      const urls = asked.map((a) => a.split(" ")[0]!);
      const again = urls.findIndex((u, i) => urls.indexOf(u) < i);
      assert.ok(again === -1 || again >= FOUR.length, `${urls[again]} asked again as ask ${again + 1} before every provider was asked once: ${asked.join(" | ")}`);
      assert.equal(r.status, 200, r.body);
    } finally {
      s.stop();
    }
  });
}

test("guard: with the first two providers asked for logs and calls down (their head answering), the logs and calls are read from the third and fourth and the tape answers 200", async () => {
  const { s, dead, asked } = rig("503", "reads");
  try {
    const r = await s.trades(ICNT, 50);
    assert.equal(dead.size, 2);
    const live = FOUR.filter((u) => !dead.has(u));
    for (const u of live) assert.ok(asked.some((a) => a.startsWith(u) && /eth_getLogs|eth_call/.test(a)), `${u} was never asked for logs or calls: ${asked.join(" | ")}`);
    assert.equal(r.status, 200, r.body);
  } finally {
    s.stop();
  }
});

test("card evm-rpc-spare-list, 6 Nov: with the first two providers asked for logs and calls refusing their blocks (-32002, a keyless provider's history cap), the logs and calls are read from the third and fourth and the tape answers 200", async () => {
  const { s, dead, asked } = rig("history", "reads");
  try {
    const r = await s.trades(ICNT, 50);
    assert.equal(dead.size, 2);
    const live = FOUR.filter((u) => !dead.has(u));
    for (const u of live) assert.ok(asked.some((a) => a.startsWith(u) && /eth_getLogs|eth_call/.test(a)), `${u} was never asked for logs or calls: ${asked.join(" | ")}`);
    assert.equal(r.status, 200, r.body);
  } finally {
    s.stop();
  }
});
