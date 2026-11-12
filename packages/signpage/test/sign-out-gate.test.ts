// Card sign-out-stops-the-pages-reads: once signed out, no request leaves the page for any host past its own origin, by
// one gate every outbound request passes (../../wallet/src/throttle.ts: stopHostLaneWaits closes it, openHostLanes opens
// it, gatedFetch is the page's fetch as src/main.ts installs it). Each case starts a read, signs out while it is in
// flight or queued, and counts what is sent after; the last signs in again and reads. No network: fetch is stubbed and
// every host is .example.
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
const signIn = (): void => ((lanes as Record<string, unknown>).openHostLanes as (() => void) | undefined)?.();
const signOut = (): void => lanes.stopHostLaneWaits(new Error("signed out"));

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

test("a sign-in after the sign out reads again on every way: a laned call, a seat, a paced call and the page's fetch", async () => {
  let sent = 0;
  await withPageFetch(
    (async (_u: string | URL | Request, init?: RequestInit) => (sent++, answer(init, 7))) as typeof fetch,
    async () => {
      signOut();
      signIn();
      assert.equal(await lanedRpc("https://again-a.example")("getSlot", []), 7);
      assert.equal(await seatRpc(["https://again-b.example", "https://again-c.example"])("getSlot", []), 7);
      assert.equal(await solanaPacedRpc(lanedRpc("https://again-d.example", { kind: "pass" }), { windowMs: 300, total: 1, perMethod: 1 })("getSlot", []), 7);
      assert.equal((await globalThis.fetch("https://again-e.example/", { method: "POST", body: JSON.stringify({ id: 1 }) })).status, 200);
      assert.equal(sent, 4);
    },
  );
});
