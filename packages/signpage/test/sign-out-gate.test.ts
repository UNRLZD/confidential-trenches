// Card sign-out-stops-the-pages-reads: once signed out, no request leaves the page for any host past its own origin, by
// one gate every outbound request passes (../../wallet/src/throttle.ts: closeHostLanes closes it once the store's sign
// out holds the seed lock, nothing opens it but a page load, gatedFetch is the page's fetch as src/main.ts installs it).
// Each case starts a read, signs out while it is in flight or queued, and counts what is sent after; the last two hold
// that a sign out's tap leaves a money run's reads open. No network: fetch is stubbed and every host is .example.
import assert from "node:assert/strict";
import { test } from "node:test";
import { lanedRpc, seatRpc } from "../src/page-rpc.ts";
import { solanaPacedRpc } from "../../kit/src/trade/solana/send.ts";
import { poolUsdPrice } from "../../kit/src/price/pool-usd.ts";
import { PACE, pacedNearRpc, resetPaces } from "../../wallet/src/pace.ts";
import { NEAR_NETWORKS } from "../../kit/src/near/networks.ts";
import * as lanes from "../../wallet/src/throttle.ts";

const OWN = "https://sign.example";
// the page's fetch as main.ts installs it (the gate over the browser's), read by name so this file also runs on a tree
// without the gate, where each case fails on what it counts
const gate = (lanes as Record<string, unknown>).gatedFetch as ((raw: typeof fetch, own: string) => typeof fetch) | undefined;
const pageFetch = (raw: typeof fetch): typeof fetch => (gate ? gate(raw, OWN) : raw);
// the sign out as main.ts makes it: the tap's stop, then the gate's close once the store holds the seed lock (a tree
// before that close has the tap's stop alone)
const tap = (): void => lanes.stopHostLaneWaits(new Error("signed out"));
const close = (lanes as Record<string, unknown>).closeHostLanes as ((reason: unknown) => void) | undefined;
const signOut = (): void => (tap(), close?.(new Error("signed out")));

const answer = (init: RequestInit | undefined, result: unknown): Response => {
  const id = (JSON.parse(String(init?.body)) as { id: unknown }).id;
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), { status: 200, headers: { "content-type": "application/json" } });
};
const until = async (ok: () => boolean): Promise<void> => {
  while (!ok()) await new Promise((r) => setTimeout(r, 1));
};
// globalThis.fetch as the page's, over `raw`, for one case
async function withPageFetch(raw: typeof fetch, run: () => Promise<void>): Promise<void> {
  const was = globalThis.fetch;
  lanes.resetHostLanes();
  globalThis.fetch = pageFetch(raw);
  try {
    await run();
  } finally {
    globalThis.fetch = was;
    lanes.resetHostLanes();
  }
}

test("a seat's read in flight at the sign out that answers 503 does not fail over to the other member", async () => {
  const sent: string[] = [];
  let free!: () => void;
  const held = new Promise<void>((r) => (free = r));
  await withPageFetch(
    (async (u: string | URL | Request, init?: RequestInit) => {
      sent.push(new URL(String(u)).host);
      if (sent.length === 1) return held.then(() => new Response("busy", { status: 503 }));
      return answer(init, 1);
    }) as typeof fetch,
    async () => {
      const seat = seatRpc(["https://seat-a.example", "https://seat-b.example"], "trade", { deadlineMs: 10_000, backoffMs: 1 });
      const call = seat("getSlot", []);
      await until(() => sent.length === 1);
      signOut();
      const at = sent.length;
      free();
      await assert.rejects(call);
      assert.deepEqual(sent.slice(at), [], "sent after the sign out");
    },
  );
});

test("a paced Solana call parked before the sign out is never sent after it", async () => {
  let sent = 0;
  await withPageFetch(
    (async (_u: string | URL | Request, init?: RequestInit) => (sent++, answer(init, 1))) as typeof fetch,
    async () => {
      const rpc = solanaPacedRpc(lanedRpc("https://paced.example", { kind: "pass" }), { windowMs: 300, total: 1, perMethod: 1 });
      const first = rpc("getSlot", []);
      const parked = rpc("getSlot", []);
      await first;
      signOut();
      const at = sent;
      await assert.rejects(parked);
      assert.equal(sent - at, 0, "a parked call went out after the sign out");
    },
  );
});

test("a price read in flight at the sign out asks no next round (Base's chain id answered after it)", async () => {
  const sent: string[] = [];
  let free!: () => void;
  const held = new Promise<void>((r) => (free = r));
  await withPageFetch(
    (async (u: string | URL | Request, init?: RequestInit) => {
      const method = (JSON.parse(String(init?.body)) as { method: string }).method;
      sent.push(`${new URL(String(u)).host} ${method}`);
      if (method === "eth_chainId") return held.then(() => answer(init, "0x2105"));
      return answer(init, "0x1");
    }) as typeof fetch,
    async () => {
      const rpcs = [lanedRpc("https://base-a.example", { kind: "pass" }), lanedRpc("https://base-b.example", { kind: "pass" })] as const;
      const read = poolUsdPrice({ chain: "base", rpcs, nowMs: Date.now() });
      await until(() => sent.length === 2);
      signOut();
      const at = sent.length;
      free();
      await assert.rejects(read);
      assert.deepEqual(sent.slice(at), [], "a price round sent after the sign out");
    },
  );
});

test("a NEAR settle's call paced behind another at the sign out is never sent (the page's fetch)", async () => {
  let sent = 0;
  await withPageFetch(
    (async (_u: string | URL | Request, init?: RequestInit) => (sent++, answer(init, { ok: true }))) as typeof fetch,
    async () => {
      // the network's dRPC URL, whose pace lets PACE.drpc.burst go at once and parks the next (the fetch is stubbed:
      // nothing reaches it)
      resetPaces();
      const near = pacedNearRpc(NEAR_NETWORKS.mainnet.drpc);
      const view = (i: number) => near.query({ request_type: "view_account", finality: "final", account_id: `a${i}.near` });
      const burst = Array.from({ length: PACE.drpc.burst }, (_, i) => view(i));
      const paced = view(PACE.drpc.burst);
      await Promise.all(burst);
      assert.equal(sent, PACE.drpc.burst, "the burst went, the next is parked");
      signOut();
      const at = sent;
      await assert.rejects(paced);
      assert.equal(sent - at, 0, "a NEAR call went out after the sign out");
      resetPaces();
    },
  );
});

// the review of 03d5b772, P2: a sign out during a trade cut it between its reads (the gate closed at the tap); the tap
// ends waits only, and a money run holding the seed lock finishes, its reads open
test("a laned call in flight at a sign out's tap that meets a 503 is asked again: the tap leaves a run's reads open", async () => {
  const sent: string[] = [];
  let free!: () => void;
  const held = new Promise<void>((r) => (free = r));
  await withPageFetch(
    (async (u: string | URL | Request, init?: RequestInit) => {
      sent.push(new URL(String(u)).host);
      if (sent.length === 1) return held.then(() => new Response("busy", { status: 503 }));
      return answer(init, 5);
    }) as typeof fetch,
    async () => {
      const rpc = lanedRpc("https://trade-read.example", { retry: { deadlineMs: 10_000, backoffMs: 1 } });
      const call = rpc("getSlot", []);
      await until(() => sent.length === 1);
      tap();
      free();
      assert.equal(await call, 5, "the read's own answer, asked again after the tap");
      assert.equal(await lanedRpc("https://trade-read-2.example")("getSlot", []), 5, "and a new read of the run goes");
      assert.equal(sent.length, 3);
    },
  );
});

test("once closed, the gate stays closed: no later tap, close or export opens it, so an old account's loop never reads again in this page", async () => {
  let sent = 0;
  await withPageFetch(
    (async (_u: string | URL | Request, init?: RequestInit) => (sent++, answer(init, 1))) as typeof fetch,
    async () => {
      signOut();
      assert.equal("openHostLanes" in lanes, false, "no export opens the gate (a page load does)");
      tap();
      close?.(new Error("again"));
      // the loop's next turns, on every way
      await assert.rejects(lanedRpc("https://loop-a.example")("getSlot", []));
      await assert.rejects(globalThis.fetch("https://loop-b.example/", { method: "POST", body: JSON.stringify({ id: 1 }) }));
      await assert.rejects(lanes.laneFetch()("https://loop-c.example/"));
      assert.equal(sent, 0);
    },
  );
});
