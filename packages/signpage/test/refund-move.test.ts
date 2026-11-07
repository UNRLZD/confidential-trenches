// SIGN_HOST's refund move (card wallet-refund-move; src/deposit-follow.ts refundMover over the wallet's runRefundMove,
// wallet.md §2.4 point 8 and the §2.8 refund move row): a USDC refund under U inside intents.near is quoted, checked by
// the page's rules (src/rules/refund.ts), signed by U's key and handed to the relayer's POST /v1/intents; one under
// MIN_DEPOSIT, or short only of it at the quote's floor, is held; a quote off the request signs and sends nothing.
// 1Click answers come from the H-1c mock (test/oneclick-mock.ts), signed by a key only this process trusts. The id's key
// is RFC 8032 test 1, a published vector. A load hook names a test vault on mainnet, as test/rules-refund.test.ts does.
//   node --test test/refund-move.test.ts      (from packages/signpage)
/// <reference types="node" />
import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { after, test } from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { ed25519 } from "@noble/curves/ed25519.js";
import { base58, base64 } from "@scure/base";
import type { OneClickRequest } from "../../kit/src/checks/oneclick.ts";
import { ATTACKER, NOW, SOL_USDC, liveAnswer, mockKey, signAnswer, type Answer } from "./oneclick-mock.ts";
const VAULT = "vault.blindfill-test.near";
const NETWORKS_URL = new URL("../../kit/src/near/networks.ts", import.meta.url).href;
registerHooks({
  load(url, context, next) {
    if (url !== NETWORKS_URL) return next(url, context);
    const real = JSON.stringify(`${NETWORKS_URL}?real`);
    const source = `import { NEAR_NETWORKS as REAL } from ${real};
export * from ${real};
export const NEAR_NETWORKS = Object.freeze({ ...REAL, mainnet: Object.freeze({ ...REAL.mainnet, vault: ${JSON.stringify(VAULT)} }) });
`;
    return { format: "module", source, shortCircuit: true };
  },
});
const { depositFollows, refundMover } = await import("../src/deposit-follow.ts");
const { openWalletStore } = await import("@blindfill/wallet/store");
const { depositAccount } = await import("../../wallet/src/deposit/account.ts");
const d = await import("../../wallet/src/derive/index.ts");
type FollowRpc = import("../../wallet/src/deposit/follow.ts").FollowRpc;
const { ID_INTENT_WINDOW_MS } = await import("../src/rules/refund.ts");
const { REFUND_INTENT_WINDOW_MS, RELEASE_INTENTS_URL } = await import("../../wallet/src/deposit/refund.ts");
const { DEPOSIT_QUOTE_URL } = await import("../../wallet/src/deposit/quote.ts");
type FollowMoveAsk = import("../../wallet/src/deposit/follow.ts").FollowMoveAsk;
type MoveRecord = import("../../wallet/src/deposit/refund.ts").MoveRecord;

const fromHex = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));
const ID_SECRET = fromHex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"); // gitleaks:allow (RFC 8032 test 1)
const ID_PUB = ed25519.getPublicKey(ID_SECRET);
const ID = Buffer.from(ID_PUB).toString("hex");
const DEPOSIT = "ab".repeat(32);
const AMOUNT = 25_000_000n;
const BLOCK_MS = NOW - 2_000;
const SALT = "252812b3";

/** The run's parties: the helper (quote proxy and /v1/intents) as a fetch, U's key behind openKey, the record. */
function harness(o: { held?: bigint; answer?: (req: OneClickRequest) => Answer; status?: number } = {}) {
  const held = o.held ?? AMOUNT;
  const log: string[] = [];
  const posted: { url: string; body: any }[] = [];
  const records: MoveRecord[] = [];
  const keys: Uint8Array[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    assert.equal(init?.credentials, "omit");
    const body = JSON.parse(String(init?.body));
    posted.push({ url, body });
    log.push(url === DEPOSIT_QUOTE_URL ? "quote" : url === RELEASE_INTENTS_URL ? "send" : `?${url}`);
    if (url === DEPOSIT_QUOTE_URL) {
      const a = o.answer ? o.answer(body) : liveAnswer(body, NOW - 500);
      if (!o.answer) {
        a.quote.depositAddress = DEPOSIT;
        signAnswer(a, mockKey.privateKey);
      }
      return Response.json(a, { status: 201 });
    }
    return Response.json({ tx_hash: "11111111111111111111111111111111" }, { status: o.status ?? 200 });
  }) as typeof fetch;
  const ask: FollowMoveAsk = {
    u: ID,
    asset: SOL_USDC,
    reads: [{ blockTimeNs: BigInt(BLOCK_MS) * 1_000_000n, held }, { blockTimeNs: BigInt(BLOCK_MS) * 1_000_000n, held }],
    salt: SALT,
    priorMs: null,
    openKey: async (fn) => {
      log.push("key");
      const k = Uint8Array.from(ID_SECRET);
      keys.push(k);
      try {
        return fn(k);
      } finally {
        k.fill(0);
      }
    },
    record: async (m) => void (log.push("record"), records.push(m)),
  };
  return { ask, fetchFn, log, posted, records, keys, run: () => refundMover("mainnet", { fetch: fetchFn, now: () => NOW })(ask) };
}

test("the intent's window is the rule's: lower block time + 120 s", () => {
  assert.equal(REFUND_INTENT_WINDOW_MS, ID_INTENT_WINDOW_MS);
});

test("a refund is moved: the quote asked as §2.4 point 8 names it, checked, the intent signed by U's key, recorded, then sent to /v1/intents", async () => {
  const h = harness();
  const out = await h.run();
  assert.equal(out.kind, "sent", JSON.stringify(out));
  assert.deepEqual(h.log, ["quote", "key", "record", "send"], "the key opens after the quote check, the move is recorded before it is sent");
  const req = h.posted[0]!.body as OneClickRequest;
  assert.deepEqual(
    { dry: req.dry, originAsset: req.originAsset, depositType: req.depositType, recipient: req.recipient, recipientType: req.recipientType, refundTo: req.refundTo, refundType: req.refundType, amount: req.amount, swapType: req.swapType },
    { dry: false, originAsset: SOL_USDC, depositType: "INTENTS", recipient: ID, recipientType: "DESTINATION_CHAIN", refundTo: ID, refundType: "INTENTS", amount: AMOUNT.toString(), swapType: "EXACT_INPUT" },
  );
  const signed = h.posted[1]!.body.signed_intent;
  assert.deepEqual(Object.keys(h.posted[1]!.body), ["signed_intent"]);
  assert.equal(signed.standard, "raw_ed25519");
  assert.equal(signed.public_key, `ed25519:${base58.encode(ID_PUB)}`);
  assert.ok(ed25519.verify(base58.decode(signed.signature.slice(8)), new TextEncoder().encode(signed.payload), ID_PUB), "U's signature over the payload");
  const p = JSON.parse(signed.payload);
  assert.deepEqual(p.intents, [{ intent: "transfer", receiver_id: DEPOSIT, tokens: { [SOL_USDC]: AMOUNT.toString() } }]);
  assert.equal(p.signer_id, ID);
  assert.equal(Date.parse(p.deadline), BLOCK_MS + 120_000);
  const n = base64.decode(p.nonce);
  assert.equal(Buffer.from(n.subarray(0, 9)).toString("hex"), `5628f6c600${SALT}`, "a V1 nonce under the read salt");
  assert.deepEqual(h.records, [{ nonce: p.nonce, deadline_ms: BLOCK_MS + 120_000, asset: SOL_USDC, amount: AMOUNT.toString() }]);
  assert.ok(h.keys.every((k) => k.every((b) => b === 0)), "U's key zeroed");
});

test("one under MIN_DEPOSIT is held: nothing asked, signed or sent", async () => {
  const h = harness({ held: 999_999n });
  assert.deepEqual(await h.run(), { kind: "under_min" });
  assert.deepEqual(h.log, []);
});

test("a quote short only of MIN_DEPOSIT at its floor is held (under_min); nothing signed or sent", async () => {
  const h = harness({
    held: 1_000_000n,
    answer: (req) => {
      const a = liveAnswer(req, NOW - 500);
      Object.assign(a.quote, { depositAddress: DEPOSIT, amountIn: "1000000", minAmountIn: "1000000", amountInFormatted: "1.0", amountOut: "999000", amountOutFormatted: "0.999", minAmountOut: "989010", withdrawFee: "0" });
      signAnswer(a, mockKey.privateKey);
      return a;
    },
  });
  assert.deepEqual(await h.run(), { kind: "under_min" });
  assert.deepEqual(h.log, ["quote"]);
});

test("a quote off the request is refused: nothing signed, recorded or sent", async () => {
  const planted: [string, (a: Answer) => void][] = [
    ["recipient another id", (a) => void (a.quoteRequest.recipient = ATTACKER)],
    ["refund to another id", (a) => void (a.quoteRequest.refundTo = ATTACKER)],
    ["deposit type ORIGIN_CHAIN", (a) => void (a.quoteRequest.depositType = "ORIGIN_CHAIN")],
    ["a larger amount in", (a) => void ((a.quoteRequest.amount = "26000000"), (a.quote.amountIn = "26000000"))],
  ];
  for (const [what, edit] of planted) {
    const h = harness({
      answer: (req) => {
        const a = liveAnswer(req, NOW - 500);
        a.quote.depositAddress = DEPOSIT;
        edit(a);
        signAnswer(a, mockKey.privateKey); // signed by 1Click's key: only the echo of the request catches it
        return a;
      },
    });
    const out = await h.run();
    assert.equal(out.kind, "refused", what);
    assert.deepEqual(h.log, ["quote"], what);
  }
  // an answer not signed by a pinned key
  const h = harness({ answer: (req) => Object.assign(liveAnswer(req, NOW - 500), { signature: "ed25519:1111" }) });
  assert.equal((await h.run()).kind, "refused");
  assert.deepEqual(h.log, ["quote"]);
});

test("not USDC: refused before anything is asked (only USDC is quoted on SIGN_HOST)", async () => {
  const h = harness();
  h.ask.asset = "nep141:wrap.near";
  assert.equal((await h.run()).kind, "refused");
  assert.deepEqual(h.log, []);
});

test("a move after one that never landed hands the rule its deadline, and is refused while the reads are not past it", async () => {
  const h = harness();
  h.ask.priorMs = BLOCK_MS - 1;
  assert.equal((await h.run()).kind, "sent");
  const g = harness();
  g.ask.priorMs = BLOCK_MS; // the lower block time not past the earlier deadline
  const out = await g.run();
  assert.deepEqual(out, { kind: "refused", why: "intent" });
  assert.deepEqual(g.log, ["quote"]);
});

test("a relayer's refusal or no answer ends nothing: the move stays recorded, the follow reads the chain", async () => {
  const h = harness({ status: 409 });
  const out = await h.run();
  assert.equal(out.kind, "sent");
  assert.equal(h.records.length, 1);
});

test("SIGN_HOST's follow passes the refund move: a REFUNDED op on mainnet with U's refund inside intents.near is quoted, signed by U's key from the seed and sent", async () => {
  const SEED = d.wordsToSeed64(d.entropyToWords(new Uint8Array(16))); // the first published BIP-39 vector (all-zero entropy)
  const u = depositAccount(SEED, 7n, 3).account;
  const w = await openWalletStore({ indexedDB: new IDBFactory() });
  after(() => w.close());
  await w.put("ops", "dq-r", { kind: "deposit", stage: "refunded", held_id: u, since_ms: NOW, txs: [], created_ms: NOW, follow: { network: "mainnet", s: "7", i: 3, u, address: "f".repeat(64), deadline_ms: NOW + 72 * 3_600_000, origin: SOL_USDC, min_out: "24705126", sent: true, status: "REFUNDED" } });
  // both RPCs at one final block: U holds 25 USDC (Solana) inside intents.near, nothing on the token
  const view = (method: string, args: any): unknown =>
    method === "mt_balance_of" ? (args.account_id === u && args.token_id === SOL_USDC ? AMOUNT.toString() : "0")
    : method === "current_salt" ? SALT
    : method === "is_nonce_used" ? false
    : "0";
  const one = (name: string): FollowRpc => ({
    name,
    tx: async () => ({}),
    block: async () => ({ result: { header: { height: 100, timestamp_nanosec: (BigInt(BLOCK_MS) * 1_000_000n).toString() } } }),
    query: async (p: any) => {
      const args = JSON.parse(Buffer.from(p.args_base64 ?? "e30=", "base64").toString());
      return { result: { block_height: 100, block_hash: "h", logs: [], result: [...Buffer.from(JSON.stringify(view(p.method_name, args)))] } };
    },
  });
  const posted: any[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    if (url === DEPOSIT_QUOTE_URL) {
      const a = liveAnswer(JSON.parse(String(init?.body)), NOW - 500);
      a.quote.depositAddress = DEPOSIT;
      signAnswer(a, mockKey.privateKey);
      return Response.json(a, { status: 201 });
    }
    if (url === RELEASE_INTENTS_URL) return (posted.push(JSON.parse(String(init?.body))), Response.json({ tx_hash: "1" }));
    return new Response("{}", { status: 404 }); // 1Click's status: no read
  }) as typeof fetch;
  const f = depositFollows({ network: () => "mainnet", store: async () => w, seed64: async () => Uint8Array.from(SEED), rpcs: () => [one("a"), one("b")], fetch: fetchFn, sleep: async () => void (await new Promise<void>((ok) => setImmediate(ok))), locks: () => null, now: () => NOW });
  await f.settle();
  for (let k = 0; k < 200 && posted.length === 0; k++) await new Promise<void>((ok) => setImmediate(ok));
  f.signedOut();
  await f.idle();
  assert.equal(posted.length >= 1, true, "a signed intent went to /v1/intents");
  const signed = posted[0].signed_intent;
  const p = JSON.parse(signed.payload);
  assert.equal(p.signer_id, u);
  assert.deepEqual(p.intents, [{ intent: "transfer", receiver_id: DEPOSIT, tokens: { [SOL_USDC]: AMOUNT.toString() } }]);
  assert.ok(ed25519.verify(base58.decode(signed.signature.slice(8)), new TextEncoder().encode(signed.payload), Buffer.from(u, "hex")), "signed by U's key");
  const op = (await w.get("ops", "dq-r")) as any;
  assert.equal(op.follow.move.nonce, p.nonce, "recorded in the op");
  assert.equal(op.stage, "refund_move");
});
