// node --test apps/helper/src/data/evm/swaps-batch-fit.test.ts (card helper-rpc-batch-learns-reader-size): the tape's
// reads fit each provider's batch size. A provider that refuses a batch for its size (Pocket's HTTP 413 past 5, Sentio's
// HTTP 429 code 8 past 5, both read on mainnet 2026-11-18 20:41Z and 23:20Z) is sent the batch in parts of the size it
// takes, kept per provider in the helper's one map (rpc/batch-sizes.ts); Pocket starts at 5 (lists.ts BATCH_MAX). A
// throttle's 429 still holds the provider. Every URL but Pocket's is made up; the chain is the recorded fake.
import assert from "node:assert/strict";
import { test } from "node:test";
import { providerHolds } from "../../limits/limits.ts";
import { fakeChain, ICNT, open, REC } from "../../../test/evm-swaps/base.ts";

const POCKET = "https://base.api.pocket.network";
type Post = { url: string; n: number; refused: boolean };
/** The recorded chain behind `refuse` (url, calls) => a refusal or null, each post recorded. */
function chainWith(refuse: (url: string, n: number) => Response | null) {
  const chain = fakeChain();
  const posts: Post[] = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init.body)) as unknown;
    const n = Array.isArray(body) ? body.length : 1;
    const r = refuse(url, n);
    posts.push({ url, n, refused: r !== null });
    return r ?? chain.fetch(url, init);
  };
  return { chain: { ...chain, fetch }, posts };
}
const tape = async (rpcs: string[], refuse: (url: string, n: number) => Response | null) => {
  const { chain, posts } = chainWith(refuse);
  const holds = providerHolds(() => 1_000_000, {});
  const s = open(chain, undefined, { rpcs, holds });
  chain.st.head = REC.firstHead + 100;
  const t = await s.trades(ICNT, 50);
  s.stop();
  assert.equal(t.status, 200, t.body);
  return { body: JSON.parse(t.body) as { trades: { trader?: string }[]; filling: boolean }, posts, holds };
};
const tooLarge = () => new Response("request entity too large: the batch has more items than this window allows\n", { status: 413, headers: { "content-type": "text/plain" } });

test("Pocket and two providers that answer 413 past 5: the tape fills with every trade's trader, no post past 5 answered, Pocket never refused (it starts at 5)", async () => {
  const rpcs = [POCKET, "https://413-a.test", "https://413-b.test"];
  const { body, posts } = await tape(rpcs, (_u, n) => (n > 5 ? tooLarge() : null));
  assert.ok(body.trades.length > 0, `no trades: ${JSON.stringify(body)} ${JSON.stringify(posts)}`);
  assert.ok(body.trades.every((t) => typeof t.trader === "string"), "every trade's trader");
  assert.ok(posts.filter((p) => !p.refused).every((p) => p.n <= 5));
  assert.equal(posts.filter((p) => p.url === POCKET && p.refused).length, 0, "Pocket's known size: no refused post");
  // a provider learns once: its refused posts (the batches in flight together) all come before its first part, and no
  // post past 5 is sent to it after that
  for (const u of rpcs.slice(1)) {
    const mine = posts.filter((p) => p.url === u);
    const part = mine.findIndex((p) => !p.refused && p.n > 2);
    const lastRefused = mine.findLastIndex((p) => p.refused);
    if (part >= 0) assert.ok(lastRefused < part && mine.slice(part).every((p) => p.n <= 5), `${u}: ${mine.map((p) => `${p.n}${p.refused ? "R" : ""}`).join(",")}`);
  }
});

test("Sentio's 429 code 8 past 5 is a size refusal, never a throttle: the provider is not held and serves the tape in parts", async () => {
  const S = "https://sentio-like.test";
  const { body, posts, holds } = await tape([S, "https://413-c.test"], (u, n) => (n > 5 ? (u === S ? Response.json({ code: 8, message: "JSON-RPC batch exceeds the maximum of 5 requests" }, { status: 429 }) : tooLarge()) : null));
  assert.ok(body.trades.length > 0 && body.trades.every((t) => typeof t.trader === "string"), JSON.stringify(body));
  assert.equal(holds.heldFor(S), 0, "not held");
  assert.ok(posts.some((p) => p.url === S && !p.refused && p.n > 1 && p.n <= 5), `parts to Sentio: ${JSON.stringify(posts.filter((p) => p.url === S))}`);
});

test("a throttle's 429 on a batch (Retry-After, Too Many Requests) still holds the provider, and the others serve the tape", async () => {
  const T = "https://throttle.test";
  const { body, holds } = await tape([T, "https://b-ok.test", "https://c-ok.test"], (u, n) => (u === T && n > 1 ? new Response("Too Many Requests", { status: 429, headers: { "retry-after": "20" } }) : null));
  assert.ok(body.trades.length > 0, JSON.stringify(body));
  assert.ok(holds.heldFor(T) > 0, "held");
});
