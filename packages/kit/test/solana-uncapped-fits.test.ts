/// <reference types="node" />
// Card solana-uncapped-fits: a trade whose first build (maxAccounts=40) finds no route still lands. The kit's one retry
// once ran without maxAccounts, and an uncapped route can assemble to more than a Solana transaction may hold
// (BZFYNPeQ…B96W's buy, 1,244 bytes, in helper live run 41956857743; the device refused it too_large). The replay
// (test/fixtures/solana-uncapped-fits.json, its `source` says how each answer was read): one request, the sell of
// A7bdiYdS…XaS from test/fixtures/solana-builds.json, answered by real /swap/v2/build answers through HELPER_HOST for
// the cap the kit asks: without maxAccounts the recorded 1,244-byte route, at 48 the route recorded there; each answer
// assembled on its own recorded reads. The first build's "No routes found" is made (this token routes at 40), so the
// replay reaches the retry. Only functions the kit had before the card are used, so the test runs on both.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { noneWritten } from "./solana-writes.ts";
import { SolanaBuildError, assembleSolanaSwap, fetchSolanaJupiterBuild, type SolanaBuildRequest, type SolanaJupiterBuild } from "../src/trade/solana/build.ts";
import { SOLANA_MAX_TX_BYTES, solanaDecodeLookupTable, type SolanaLookupTable } from "../src/checks/solana/message.ts";
import { checkSolanaQuote } from "../src/checks/solana/checks.ts";
import type { SolanaFetch } from "../src/trade/solana/send.ts";

type Acc = { owner: string; data: string } | null;
type Answer = { cap: number | null; query: string; status: number; body: string; accounts: Record<string, [Acc, Acc]>; blockhash: { blockhash: string; lastValidBlockHeight: number } };
const F = JSON.parse(readFileSync(new URL("./fixtures/solana-uncapped-fits.json", import.meta.url), "utf8")) as {
  base: string;
  mint: string;
  wallet: string;
  amount: string;
  oversize: Answer;
  atCap: Answer;
};
const req: SolanaBuildRequest = { side: "sell", wallet: F.wallet, token: F.mint, amount: BigInt(F.amount), slippageBps: 1000 };
const bytesOf = (a: Acc) => (a ? Uint8Array.from(Buffer.from(a.data, "base64")) : null);
const read = (a: Acc) => (a ? { owner: a.owner, data: bytesOf(a)! } : null);
const assemble = (a: Answer, build: SolanaJupiterBuild) =>
  assembleSolanaSwap(req, build, {
    blockhash: a.blockhash.blockhash,
    lastValidBlockHeight: a.blockhash.lastValidBlockHeight,
    tables: Object.fromEntries(build.tables.flatMap((t) => (a.accounts[t]?.[0] ? [[t, solanaDecodeLookupTable(bytesOf(a.accounts[t][0])!)]] : []))) as Record<string, SolanaLookupTable>,
    tokenProgram: a.accounts[F.mint]![0]!.owner,
  });

// No route at 40; the retry is answered by the recorded build for the cap it asks; any other ask is refused.
function replay() {
  const asked: (string | null)[] = [];
  let served: Answer | null = null;
  const f: SolanaFetch = async (url) => {
    const cap = new URL(url).searchParams.get("maxAccounts");
    asked.push(cap);
    if (asked.length === 1) {
      assert.equal(cap, "40");
      return new Response('{"error":"No routes found"}', { status: 400 });
    }
    served = cap === null ? F.oversize : cap === String(F.atCap.cap) ? F.atCap : null;
    if (!served) throw new Error(`no recorded build at maxAccounts=${cap}`);
    return new Response(served.body, { status: served.status, headers: { "content-type": "application/json" } });
  };
  return { f, asked, served: () => served };
}

test("the recorded uncapped answer is the 1,244-byte route the device refuses too_large", async () => {
  const build = (await fetchSolanaJupiterBuild(F.base, req, { fetch: async () => new Response(F.oversize.body, { status: 200 }) })).build;
  assert.throws(() => assemble(F.oversize, build), (e: unknown) => e instanceof SolanaBuildError && e.code === "too_large" && /^too_large: 1244 bytes > 1232$/.test(e.message));
  assert.ok(!new URLSearchParams(F.oversize.query).has("maxAccounts"));
  assert.ok(new URLSearchParams(F.atCap.query).get("maxAccounts") === "48");
});

test("no route at 40: the retry's build fits the device's transaction and passes the frame checks", async () => {
  const s = replay();
  const got = await fetchSolanaJupiterBuild(F.base, req, { fetch: s.f });
  assert.equal(s.asked.length, 2);
  const a = s.served()!;
  let tx;
  try {
    tx = assemble(a, got.build);
  } catch (e) {
    assert.fail(`the retry (maxAccounts=${s.asked[1]}) was refused: ${e instanceof SolanaBuildError ? e.message : String(e)} (route ${got.build.route.join(" + ")})`);
  }
  assert.ok(tx.size <= SOLANA_MAX_TX_BYTES, `${tx.size} bytes`);
  const v = checkSolanaQuote(tx.wire, { ...req, spendable: req.amount, minOut: 1n, otherWallets: [] }, {
    tables: Object.fromEntries(got.build.tables.map((t) => [t, [read(a.accounts[t]![0]), read(a.accounts[t]![1])] as const])),
    mint: [read(a.accounts[F.mint]![0]), read(a.accounts[F.mint]![1])],
    rent: { tokenAccount: [0n, 0n], pumpVolumeAccumulator: [0n, 0n] },
    simulations: [null, null],
    writable: noneWritten(tx.wire, Object.fromEntries(got.build.tables.flatMap((t) => (a.accounts[t]?.[0] ? [[t, solanaDecodeLookupTable(bytesOf(a.accounts[t][0])!)]] : [])))),
    reference: null,
  });
  const frame = ["S1", "S2", "S3", "S4", "S5", "S6", "S8", "S9", "S10", "S13"];
  assert.deepEqual(v.results.filter((r) => frame.includes(r.id) && !r.ok).map((r) => `${r.id} ${r.detail}`), []);
});
