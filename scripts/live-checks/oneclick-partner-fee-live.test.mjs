// node --test scripts/live-checks/oneclick-partner-fee-live.test.mjs: the live check replays recorded answers
// (oneclick-partner-fee-live.answers.json, its note says where each was read). good and main_pin: HELPER_HOST's real
// answers, fee 1 on Solana USDC to NEAR USDC (a live dry:false quote and a dry one) and fee 20 on wNEAR to NEAR USDC: PASS
// (main_pin FAILed on main's kit, which pinned fee 20 for the partner path). bad_key_refused: 1Click's real 401 to a key
// it does not honour: FAIL. Bad answers derived from good by the unsigned appFees entry (fee 20 on the live and the dry
// USDC quote, fee 1 on wNEAR): FAIL, on app-fees.
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge, read, PATH, ROUTES } from "./oneclick-partner-fee-live.mjs";
import { DEPOSIT_DRY_PLACEHOLDER, ONECLICK_SIGNING_KEYS } from "../../packages/kit/src/index.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// The recorded bodies carry no signature (the check's --record leaves it out: an "ed25519:" signature has a NEAR secret
// key's shape). Each answer is signed again here, as 1Click signs (bs58(sha256(stable-json)) as UTF-8, built with
// node:crypto apart from the kit), with a throwaway key this test process alone adds to the kit's pinned set.
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const b58 = (b) => {
  let n = 0n, s = "";
  for (const x of b) n = (n << 8n) | BigInt(x);
  for (; n > 0n; n /= 58n) s = B58[Number(n % 58n)] + s;
  for (const x of b) { if (x !== 0) break; s = `1${s}`; }
  return s;
};
const stable = (v) => {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}`;
};
const KEY = generateKeyPairSync("ed25519");
ONECLICK_SIGNING_KEYS.push(`ed25519:${b58(Buffer.from(KEY.publicKey.export({ format: "jwk" }).x, "base64url"))}`);
const u = (x) => (x ? x : undefined);
function signBody(text) {
  const a = JSON.parse(text);
  if (!a?.quoteRequest || !a?.quote) return text;
  const r = a.quoteRequest, q = a.quote;
  const req = { dry: r.dry, swapType: r.swapType, slippageTolerance: r.slippageTolerance, originAsset: r.originAsset, depositType: r.depositType,
    destinationAsset: r.destinationAsset, amount: r.amount, refundTo: r.refundTo, refundType: r.refundType, recipient: r.recipient,
    recipientType: r.recipientType, deadline: r.deadline, quoteWaitingTimeMs: u(r.quoteWaitingTimeMs), referral: u(r.referral),
    virtualChainRecipient: u(r.virtualChainRecipient), virtualChainRefundRecipient: u(r.virtualChainRefundRecipient), customRecipientMsg: u(r.customRecipientMsg) };
  const base = { amountIn: q.amountIn, amountInFormatted: q.amountInFormatted, amountInUsd: q.amountInUsd, minAmountIn: q.minAmountIn,
    amountOut: q.amountOut, amountOutFormatted: q.amountOutFormatted, amountOutUsd: q.amountOutUsd, minAmountOut: q.minAmountOut };
  const quote = r.dry ? base : { ...base, depositAddress: u(q.depositAddress), depositMemo: u(q.depositMemo), deadline: u(q.deadline),
    timeWhenInactive: u(q.timeWhenInactive), timeEstimate: u(q.timeEstimate), refundFee: u(q.refundFee), withdrawFee: u(q.withdrawFee) };
  const h = b58(createHash("sha256").update(stable({ ...req, ...quote, timestamp: a.timestamp })).digest());
  a.signature = `ed25519:${b58(sign(null, Buffer.from(h, "utf8"), KEY.privateKey))}`;
  return JSON.stringify(a);
}
const signed = (rec) => {
  const r = structuredClone(rec);
  for (const a of Object.values(r.answers)) if (a.status === 200 || a.status === 201) a.body = signBody(a.body);
  return r;
};
const RAW = JSON.parse(readFileSync(path.join(HERE, "oneclick-partner-fee-live.answers.json"), "utf8"));
const A = { good: signed(RAW.good), main_pin: signed(RAW.main_pin), bad_key_refused: RAW.bad_key_refused };

test("the recorded answers carry no 1Click signature (the secret scan refuses its shape); unsigned, the check refuses them", () => {
  assert.doesNotMatch(readFileSync(path.join(HERE, "oneclick-partner-fee-live.answers.json"), "utf8"), /ed25519:/);
  assert.ok(bads(judge(RAW.good)).every((l) => /\(signature\)/.test(l)) && bads(judge(RAW.good)).length === 3);
});
const COLLECTOR = "5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd";
const bads = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const withFee = (rec, route, fee) => {
  const r = structuredClone(rec);
  const body = JSON.parse(r.answers[route].body);
  body.quoteRequest.appFees = [{ recipient: COLLECTOR, fee }];
  r.answers[route].body = JSON.stringify(body);
  return r;
};

test("recorded good answer: the three quotes pass the device's partner-path check (fee 1 USDC to USDC live and dry, 20 wNEAR): PASS", () => {
  const r = judge(A.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(r.lines.length, 3);
  assert.match(r.lines[0], /^ok {2}live: .*"fee":1[,}]/);
  assert.match(r.lines[1], /^ok {2}usdc: .*"fee":1\}\]$/);
  assert.match(r.lines[2], /^ok {2}pair: .*"fee":20\}\]$/);
  // the live one is a real live answer: asked dry false, answered with 1Click's signed deposit address
  assert.equal(A.good.answers.live.request.dry, false);
  assert.match(JSON.parse(A.good.answers.live.body).quote.depositAddress, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
});

test("the helper's answers read by this check on main (where it FAILed on the old pin) pass under this kit: PASS", () => {
  const r = judge(A.main_pin);
  assert.equal(r.ok, true, r.lines.join("\n"));
});

test("recorded bad answer: 1Click's 401 to a key it does not honour: FAIL on the three quotes", () => {
  const r = judge(A.bad_key_refused);
  assert.equal(r.ok, false);
  assert.deepEqual(bads(r), ["live", "usdc", "pair"].map((k) => `BAD ${k}: HTTP 401, want 1Click's 200 or 201`));
});

test("the live quote relabelled to the old pin's fee 20 is refused on app-fees alone, and one with no deposit address on the live rules: FAIL", () => {
  const r = judge(withFee(A.good, "live", 20));
  assert.equal(r.ok, false);
  assert.equal(bads(r).length, 1);
  assert.match(bads(r)[0], /^BAD live: .*\(app-fees\)/);
  const n = structuredClone(A.good);
  const body = JSON.parse(n.answers.live.body); delete body.quote.depositAddress;
  n.answers.live.body = JSON.stringify(body);
  assert.match(bads(judge(n))[0], /^BAD live: /);
});

test("the old pin's entry, fee 20 on the USDC route, is refused on app-fees alone: FAIL", () => {
  const r = judge(withFee(A.good, "usdc", 20));
  assert.equal(r.ok, false);
  assert.equal(bads(r).length, 1);
  assert.match(bads(r)[0], /^BAD usdc: .*\(app-fees\)/);
});

test("fee 1 on wNEAR to USDC (another pair) is refused on app-fees alone: FAIL", () => {
  const r = judge(withFee(A.good, "pair", 1));
  assert.equal(r.ok, false);
  assert.equal(bads(r).length, 1);
  assert.match(bads(r)[0], /^BAD pair: .*\(app-fees\)/);
});

test("a changed signed field fails the signature, a stale read fails freshness, a missing route fails", () => {
  const r = structuredClone(A.good);
  const body = JSON.parse(r.answers.usdc.body); body.quote.amountOut = String(BigInt(body.quote.amountOut) + 1n);
  r.answers.usdc.body = JSON.stringify(body);
  assert.match(bads(judge(r))[0], /\(signature\)/);
  const s = structuredClone(A.good); s.answers.usdc.at += 121_000;
  assert.match(bads(judge(s))[0], /\(timestamp\)/);
  const m = structuredClone(A.good); delete m.answers.pair;
  assert.deepEqual(bads(judge(m)), ["BAD pair: no answer recorded"]);
});

test("read() asks each quote once, as the device asks: POST its body to the proxy path, no cookie", async () => {
  const sent = [];
  const f = async (url, init) => {
    sent.push({ url, init });
    const b = JSON.parse(init.body);
    const route = b.originAsset === ROUTES.pair.originAsset ? "pair" : b.dry ? "usdc" : "live";
    return new Response(A.good.answers[route].body, { status: A.good.answers[route].status });
  };
  const rec = await read("https://h.example", f, () => A.good.answers.usdc.at);
  assert.deepEqual(sent.map((s) => s.url), [1, 2, 3].map(() => `https://h.example${PATH}`));
  for (const s of sent) {
    assert.equal(s.init.method, "POST");
    assert.equal(s.init.credentials, "omit");
    const b = JSON.parse(s.init.body);
    assert.equal(b.recipient, DEPOSIT_DRY_PLACEHOLDER);
    assert.equal(b.refundTo, DEPOSIT_DRY_PLACEHOLDER);
  }
  assert.deepEqual(sent.map((s) => JSON.parse(s.init.body).dry), [false, true, true]);
  assert.deepEqual(Object.keys(rec.answers), ["live", "usdc", "pair"]);
});
