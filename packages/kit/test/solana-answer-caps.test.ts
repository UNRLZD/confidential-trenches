// node --test packages/kit/test/solana-answer-caps.test.ts (card solana-quote-under-1s): the helper now compresses its
// answers (deploy/Caddyfile `encode zstd gzip`), so the device's answer caps must count the bytes fetch decodes, not the
// bytes on the wire. Each test serves a gzip bomb on 127.0.0.1: 10 MB of zeros, ~10 KB on the wire, no decoded
// content-length. The build reader (build.ts readCapped, SOLANA_BUILD_ANSWER_MAX_BYTES) and the helper RPC reader
// (send.ts readBounded behind solanaHelperRpc, SOLANA_ANSWER_MAX_BYTES) must refuse it and cancel the body, having
// taken in at most one decoded chunk past their cap.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { SOLANA_BUILD_ANSWER_MAX_BYTES, fetchSolanaJupiterBuild } from "../src/trade/solana/build.ts";
import { SOLANA_ANSWER_MAX_BYTES, solanaHelperRpc, type SolanaFetch } from "../src/trade/solana/send.ts";

// two well-known public Solana addresses, as the request's wallet and mint (the bomb answers before either is read)
const VOTE_PROGRAM = "Vote111111111111111111111111111111111111111";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const DECODED = 10 * 1024 * 1024;
const BOMB = gzipSync(Buffer.alloc(DECODED));
// the largest chunk a decoded body is handed out in is far under a megabyte (zlib's output chunks); the bound below is
// generous so the test reads "stopped near the cap", never "read the whole 10 MB"
const SLACK = 1024 * 1024;

async function bombServer(): Promise<{ origin: string; server: Server }> {
  const server = createServer((req, res) => {
    req.resume();
    res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
    res.end(BOMB);
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}

/** The real fetch, its decoded body counted as the reader takes it, and whether the reader cancelled it. */
function countingFetch() {
  const seen = { bytes: 0, cancelled: false, calls: 0 };
  const f: SolanaFetch = async (url, init) => {
    seen.calls++;
    const r = await fetch(url, init);
    const inner = r.body!.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(c) {
        const { done, value } = await inner.read();
        if (done) return c.close();
        seen.bytes += value.byteLength;
        c.enqueue(value);
      },
      cancel(why) {
        seen.cancelled = true;
        return inner.cancel(why);
      },
    });
    return new Response(body, { status: r.status, headers: r.headers });
  };
  return { f, seen };
}

test("the bomb is what it says: ~10 KB on the wire, 10 MB decoded, both caps far below the decoded size", () => {
  assert.ok(BOMB.byteLength < 64 * 1024, `${BOMB.byteLength} bytes on the wire`);
  assert.ok(SOLANA_BUILD_ANSWER_MAX_BYTES * 4 < DECODED && SOLANA_ANSWER_MAX_BYTES * 4 < DECODED);
});

test("the build fetch refuses a gzip bomb as too large and cancels the body near its cap", async () => {
  const { origin, server } = await bombServer();
  try {
    const { f, seen } = countingFetch();
    const req = { side: "buy" as const, wallet: VOTE_PROGRAM, token: USDC_MINT, amount: 1_000_000n, slippageBps: 100 };
    const t = performance.now();
    await assert.rejects(fetchSolanaJupiterBuild(origin, req, { fetch: f }), /the build answer is too large/);
    const ms = performance.now() - t;
    assert.equal(seen.calls, 1, "one ask: a too-large answer is never asked again");
    assert.ok(seen.cancelled, "the reader cancelled the body");
    assert.ok(seen.bytes > SOLANA_BUILD_ANSWER_MAX_BYTES && seen.bytes <= SOLANA_BUILD_ANSWER_MAX_BYTES + SLACK, `decoded bytes taken in: ${seen.bytes}`);
    assert.ok(ms < 2000, `${ms} ms`);
  } finally {
    server.close();
  }
});

test("the helper RPC reader refuses a gzip bomb with 'answer too large' and cancels the body near its cap", async () => {
  const { origin, server } = await bombServer();
  try {
    const { f, seen } = countingFetch();
    const rpc = solanaHelperRpc(origin, { fetch: f });
    const t = performance.now();
    await assert.rejects(rpc("getLatestBlockhash", [{ commitment: "confirmed" }]), /^Error: answer too large$/);
    const ms = performance.now() - t;
    assert.equal(seen.calls, 1);
    assert.ok(seen.cancelled, "the reader cancelled the body");
    assert.ok(seen.bytes > SOLANA_ANSWER_MAX_BYTES && seen.bytes <= SOLANA_ANSWER_MAX_BYTES + SLACK, `decoded bytes taken in: ${seen.bytes}`);
    assert.ok(ms < 2000, `${ms} ms`);
  } finally {
    server.close();
  }
});
