// Card helper-scrubber-takes-the-kits-rule: the NEAR and Solana provider paths clean a provider's words with the kit's
// one rule (secretScrubber) before any log line or answer reads them. Found by the card's audit: the NEAR client's
// errors (an RpcError's JSON, a body that is not JSON, a fetch that failed) reached withdraw/send.ts's relayer_low line
// and bind/trade.ts's trade line as the provider wrote them; the Solana pool's rent line cut a URL to its host but left
// a key the provider echoed with no URL.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { ed25519 } from "@noble/curves/ed25519.js";
import { base58 } from "./bind/checks.ts";
import { nearRpc, RpcError } from "./bind/send.ts";
import { solanaPoolSender } from "./pool/solana.ts";

const NK = "NeArKeY0123456789abcdefXYZ";
const NEAR_URL = `https://rpc.example.com/v1/${NK}`;
const LEAK = /NeArKeY0|0123456789abcdef/i;
const answer = (status: number, text: string): typeof fetch => (async () => new Response(text, { status, headers: { "content-type": "application/json" } })) as typeof fetch;

test("the NEAR client's errors carry none of its URL's key: a JSON-RPC error that echoes it, a body that is not JSON, a fetch that failed", async () => {
  const said = async (f: typeof fetch): Promise<Error> => nearRpc(NEAR_URL, f)("query", {}).then(() => assert.fail("no error"), (e: Error) => e);
  // the provider's error object echoes the key, in its own case and cut short
  const r = await said(answer(200, JSON.stringify({ jsonrpc: "2.0", id: "r", error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_BLOCK" }, message: `invalid key ${NK.toLowerCase()} at ${NEAR_URL} (${NK.slice(0, 12)})` } })));
  assert.ok(r instanceof RpcError, "the class a caller reads is kept");
  assert.equal(r.cause_name, "UNKNOWN_BLOCK", "the provider's cause is still read");
  assert.ok(!LEAK.test(r.message) && !LEAK.test(String(r.stack)), r.message);
  assert.match(r.message, /^query: .*invalid key <key> at rpc\.example\.com/);
  // a body that is not JSON: the parser quotes its start
  const p = await said(answer(200, `${NK} is not a valid key for this plan`));
  assert.ok(p instanceof SyntaxError);
  assert.ok(!LEAK.test(p.message) && !LEAK.test(String(p.stack)), p.message);
  // a fetch that failed naming the URL
  const t = await said((async () => Promise.reject(new TypeError(`fetch failed for ${NEAR_URL}`, { cause: new Error(`connect refused ${NEAR_URL}`) }))) as typeof fetch);
  assert.ok(t instanceof TypeError);
  assert.ok(!LEAK.test(t.message) && !LEAK.test(String((t.cause as Error).message)), t.message);
  // a throttle keeps the words limits.ts throttleOf reads
  assert.equal((await said(answer(429, "slow down"))).message, "query: HTTP 429");
});

// a test key from a published-style derivation (pool/solana.test.ts testKey): no real key
const testKey = (name: string) => {
  const seed = new Uint8Array(createHash("sha256").update(`helper-pool-senders/test-key/${name}`).digest());
  const pub = ed25519.getPublicKey(seed);
  return { address: base58(pub), secret: base58(Uint8Array.from([...seed, ...pub])) };
};

test("the Solana pool's rent line carries none of a provider URL's key, echoed with its URL or alone", async () => {
  const SK = "SoLkEy0123456789abcdefXYZ";
  const lines: string[] = [];
  const s = solanaPoolSender(
    { cluster: "devnet", program: testKey("PROGRAM").address, feePayerSecret: testKey("FEE_PAYER").secret, fee: "1" },
    {
      providers: [{} as never, {} as never],
      urls: [`https://rpc.example.com/?api-key=${SK}`, "https://b.example.com/"],
      now: () => 0,
      readRent: async () => Promise.reject(new Error(`HTTP 401: key ${SK.slice(0, 14)} refused at https://rpc.example.com/?api-key=${SK}`)),
      log: (l) => lines.push(l),
    },
  );
  void s.ready.catch(() => {});
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(lines, ["helper: the devnet pool's rent read failed, its start check waits for a good one: HTTP 401: key <key> refused at rpc.example.com"]);
});
