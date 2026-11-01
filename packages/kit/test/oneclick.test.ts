// WU-04 (docs/plan1/wallet.md:1043 at research ffcba5e): the 1Click quote check on real signed answers.
//   node --test test/oneclick.test.ts      (from packages/kit)
// fixtures/oneclick-quotes.json holds two real answers that verify under 1Click's key: a live one (read back by status)
// and a keyless dry one. A changed signed field must fail the signature, a changed request must fail the echo, an
// unsigned field (appFees, a live answer's request deadline) is bound some other way, and the floors are the device's.
/// <reference types="node" />
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { base58 } from "@scure/base";
import {
  checkOneClickQuote,
  ONECLICK_SIGNING_KEYS,
  oneClickFloors,
  OneClickQuoteError,
  type OneClickCheck,
  type OneClickCheckOptions,
  type OneClickRequest,
} from "../src/checks/oneclick.ts";

type Answer = { quoteRequest: Record<string, unknown>; quote: Record<string, unknown>; signature: string; timestamp: string } & Record<string, unknown>;
const fx = JSON.parse(readFileSync(new URL("./fixtures/oneclick-quotes.json", import.meta.url), "utf8")) as {
  live: { answer: Answer };
  dry: { request: OneClickRequest; answer: Answer };
};
const clone = <T>(v: T): T => structuredClone(v);

// The live request as the G1 arm-swap run sent it (its quoteRequest less what 1Click adds).
const liveQr = fx.live.answer.quoteRequest;
const LIVE_REQ: OneClickRequest = {
  dry: false, swapType: "EXACT_INPUT", slippageTolerance: liveQr.slippageTolerance as number,
  originAsset: liveQr.originAsset as string, depositType: liveQr.depositType as string,
  destinationAsset: liveQr.destinationAsset as string, amount: liveQr.amount as string, refundTo: liveQr.refundTo as string,
  refundType: liveQr.refundType as string, recipient: liveQr.recipient as string, recipientType: liveQr.recipientType as string,
  deadline: liveQr.deadline as string,
};
const DRY_REQ = fx.dry.request;
const at = (a: Answer, ms = 1_000): number => Date.parse(a.timestamp) + ms;
// 0.4525 NEAR into NEAR USDC: NEAR's lower read 4.426776 puts the floor exactly at the signed minAmountOut 1,983,085.
const LIVE_OPTS: OneClickCheckOptions = {
  path: "partner", pricing: { in: ["4.426776", "4.43"], out: ["1", "1"] }, decimalsIn: 24, decimalsOut: 6, intoVault: false,
  now: at(fx.live.answer),
};
const DRY_OPTS: OneClickCheckOptions = { path: "keyless", pricing: "usdc", decimalsIn: 6, decimalsOut: 6, intoVault: true, now: at(fx.dry.answer) };

function refused(check: OneClickCheck, f: () => unknown): void {
  assert.throws(f, (e: unknown) => {
    assert.ok(e instanceof OneClickQuoteError, `not a OneClickQuoteError: ${String(e)}`);
    assert.equal(e.check, check, e.message);
    return true;
  });
}

// An independent build of the signed bytes (node:crypto, not the kit's noble path) to sign with a throwaway key.
function stable(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(",")}}`;
}
function signWith(a: Answer, key: ReturnType<typeof generateKeyPairSync>["privateKey"]): void {
  const r = a.quoteRequest, q = a.quote, u = (x: unknown) => (x ? x : undefined);
  const req = { dry: r.dry, swapType: r.swapType, slippageTolerance: r.slippageTolerance, originAsset: r.originAsset, depositType: r.depositType,
    destinationAsset: r.destinationAsset, amount: r.amount, refundTo: r.refundTo, refundType: r.refundType, recipient: r.recipient,
    recipientType: r.recipientType, deadline: r.deadline, quoteWaitingTimeMs: u(r.quoteWaitingTimeMs), referral: u(r.referral),
    virtualChainRecipient: u(r.virtualChainRecipient), virtualChainRefundRecipient: u(r.virtualChainRefundRecipient),
    customRecipientMsg: u(r.customRecipientMsg) };
  const base = { amountIn: q.amountIn, amountInFormatted: q.amountInFormatted, amountInUsd: q.amountInUsd, minAmountIn: q.minAmountIn,
    amountOut: q.amountOut, amountOutFormatted: q.amountOutFormatted, amountOutUsd: q.amountOutUsd, minAmountOut: q.minAmountOut };
  const quote = r.dry ? base : { ...base, depositAddress: u(q.depositAddress), depositMemo: u(q.depositMemo), deadline: u(q.deadline),
    timeWhenInactive: u(q.timeWhenInactive), timeEstimate: u(q.timeEstimate), refundFee: u(q.refundFee), withdrawFee: u(q.withdrawFee) };
  const h = base58.encode(createHash("sha256").update(stable({ ...req, ...quote, timestamp: a.timestamp })).digest());
  a.signature = `ed25519:${base58.encode(sign(null, Buffer.from(h, "utf8"), key))}`;
}
const other = (v: unknown): unknown => (typeof v === "boolean" ? !v : typeof v === "number" ? v + 1 : `${String(v)}1`);

test("the pinned key set is 1Click's SDK key, one to three keys", () => {
  assert.deepEqual([...ONECLICK_SIGNING_KEYS], ["ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc"]);
  assert.ok(ONECLICK_SIGNING_KEYS.length >= 1 && ONECLICK_SIGNING_KEYS.length <= 3);
});

test("a real live quote verifies and passes; its signed deposit address and deadline come back", () => {
  const r = checkOneClickQuote(LIVE_REQ, clone(fx.live.answer), LIVE_OPTS);
  assert.equal(r.depositAddress, "a998c6585100ca4bccbc0e0bcceb9abd66e59666e87bd03b1d83bb9544f7ce2f");
  assert.equal(r.deadline, "2026-11-03T22:06:55.133Z");
  assert.equal(r.minAmountOut, 1_983_085n);
});

test("a real dry quote verifies and passes, and hands on no deposit address", () => {
  const r = checkOneClickQuote(DRY_REQ, clone(fx.dry.answer), DRY_OPTS);
  assert.equal(r.depositAddress, undefined);
  assert.equal(r.amountOut, 1_994_124n);
});

// Each signed field of each real answer, changed in the answer: the signature fails.
const SIGNED_REQ = ["dry", "swapType", "slippageTolerance", "originAsset", "depositType", "destinationAsset", "amount", "refundTo",
  "refundType", "recipient", "recipientType", "quoteWaitingTimeMs", "referral", "virtualChainRecipient",
  "virtualChainRefundRecipient", "customRecipientMsg"];
const SIGNED_QUOTE = ["amountIn", "amountInFormatted", "amountInUsd", "minAmountIn", "amountOut", "amountOutFormatted", "amountOutUsd",
  "minAmountOut"];
const SIGNED_LIVE = ["depositAddress", "depositMemo", "deadline", "timeWhenInactive", "timeEstimate", "refundFee", "withdrawFee"];
for (const [name, fixture, req, opts] of [["live", fx.live, LIVE_REQ, LIVE_OPTS], ["dry", fx.dry, DRY_REQ, DRY_OPTS]] as const) {
  const quoteFields = name === "live" ? [...SIGNED_QUOTE, ...SIGNED_LIVE] : SIGNED_QUOTE;
  for (const f of SIGNED_REQ) {
    test(`${name}: quoteRequest.${f} changed fails the signature`, () => {
      const a = clone(fixture.answer); a.quoteRequest[f] = other(a.quoteRequest[f] ?? "x");
      refused("signature", () => checkOneClickQuote(req, a, opts));
    });
  }
  for (const f of quoteFields) {
    test(`${name}: quote.${f} changed fails the signature`, () => {
      const a = clone(fixture.answer); a.quote[f] = other(a.quote[f] ?? "x");
      refused("signature", () => checkOneClickQuote(req, a, opts));
    });
  }
  if (name === "dry")
    test("dry: quoteRequest.deadline changed fails the signature (signed on a dry answer)", () => {
      const a = clone(fixture.answer); a.quoteRequest.deadline = "2026-12-01T00:00:00.000Z";
      refused("signature", () => checkOneClickQuote(req, a, opts));
    });
  test(`${name}: the timestamp changed fails the signature`, () => {
    const a = clone(fixture.answer); a.timestamp = new Date(Date.parse(a.timestamp) + 1).toISOString();
    refused("signature", () => checkOneClickQuote(req, a, opts));
  });
  test(`${name}: a signature by a key outside the pinned set is refused`, () => {
    const a = clone(fixture.answer); signWith(a, generateKeyPairSync("ed25519").privateKey);
    refused("signature", () => checkOneClickQuote(req, a, opts));
  });
  test(`${name}: no signature, or a malformed one, is refused`, () => {
    for (const s of [undefined, "", "ed25519:", "ed25519:0OIl", fixture.answer.signature.slice(8)]) {
      const a = clone(fixture.answer) as Record<string, unknown>; a.signature = s;
      refused("signature", () => checkOneClickQuote(req, a, opts));
    }
  });
  // The answer is real; the device's request differs in one field: the echo refuses it.
  for (const f of ["slippageTolerance", "originAsset", "depositType", "destinationAsset", "amount", "refundTo", "refundType",
    "recipient", "recipientType", "deadline"] as const) {
    test(`${name}: an answer to another ${f} than the device asked is refused`, () => {
      const r = { ...req, [f]: f === "amount" ? "1" : f === "deadline" ? "2026-12-01T00:00:00.000Z" : other(req[f]) } as OneClickRequest;
      refused("echo", () => checkOneClickQuote(r, clone(fixture.answer), opts));
    });
  }
  for (const f of ["quoteWaitingTimeMs", "referral", "virtualChainRecipient", "virtualChainRefundRecipient"] as const) {
    test(`${name}: an answer that drops the requested ${f} is refused`, () => {
      const r = { ...req, [f]: f === "quoteWaitingTimeMs" ? 60_000 : "ct" } as OneClickRequest;
      refused("echo", () => checkOneClickQuote(r, clone(fixture.answer), opts));
    });
  }
  // appFees is not signed (D4): the signature still verifies, the pinned entry refuses it.
  for (const [what, fees] of [
    ["another collector", [{ recipient: "ab".repeat(32), fee: name === "live" ? 20 : 1 }]],
    ["a higher fee", [{ recipient: "5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd", fee: 50 }]],
    ["a second entry", [{ recipient: "5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd", fee: name === "live" ? 20 : 1 }, { recipient: "ab".repeat(32), fee: 1 }]],
    ["no entry", []],
    ["no appFees at all", undefined],
  ] as const) {
    test(`${name}: an unsigned appFees with ${what} is refused`, () => {
      const a = clone(fixture.answer); a.quoteRequest.appFees = fees;
      refused("app-fees", () => checkOneClickQuote(req, a, opts));
    });
  }
  test(`${name}: a stale signed timestamp is refused (121 s old), and one 61 s ahead of the device clock`, () => {
    refused("timestamp", () => checkOneClickQuote(req, clone(fixture.answer), { ...opts, now: at(fixture.answer, 121_000) }));
    refused("timestamp", () => checkOneClickQuote(req, clone(fixture.answer), { ...opts, now: at(fixture.answer, -61_000) }));
    assert.doesNotThrow(() => checkOneClickQuote(req, clone(fixture.answer), { ...opts, now: at(fixture.answer, 120_000) }));
  });
  test(`${name}: a request with a customRecipientMsg is refused before anything else`, () => {
    const r = { ...req, customRecipientMsg: "x" } as OneClickRequest;
    refused("request", () => checkOneClickQuote(r, clone(fixture.answer), opts));
  });
  test(`${name}: a customRecipientMsg in the answer is refused`, () => {
    const a = clone(fixture.answer); a.quoteRequest.customRecipientMsg = "x";
    refused("signature", () => checkOneClickQuote(req, a, opts));
    signWith(a, generateKeyPairSync("ed25519").privateKey);
    refused("signature", () => checkOneClickQuote(req, a, opts));
  });
}

// The dry-flip (D4; the G1 proof 6 Verifier's finding): a real signed dry answer, given a deposit address of the
// proxy's choosing, to a live request.
test("a signed dry answer to a live request is refused, with or without a deposit address", () => {
  const live = { ...DRY_REQ, dry: false };
  refused("echo", () => checkOneClickQuote(live, clone(fx.dry.answer), DRY_OPTS));
  const a = clone(fx.dry.answer); a.quote.depositAddress = "ab".repeat(32);
  refused("echo", () => checkOneClickQuote(live, a, DRY_OPTS));
});
test("a signed live answer to a dry request is refused", () => {
  refused("echo", () => checkOneClickQuote({ ...LIVE_REQ, dry: true }, clone(fx.live.answer), LIVE_OPTS));
});

// A live answer's request deadline is not in the signed bytes: the quote's own deadline replaces it (the SDK spreads
// the quote over the request). A proxy that sent 1Click another deadline is caught by the signed deadline, which is
// always the requested one + 72 h.
test("live: the request deadline is unsigned, so the echo and the signed +72 h deadline bind it", () => {
  const a = clone(fx.live.answer); a.quoteRequest.deadline = "2026-12-01T00:00:00.000Z";
  refused("echo", () => checkOneClickQuote(LIVE_REQ, a, LIVE_OPTS)); // the signature still verifies; the echo refuses
  const proxied = { ...LIVE_REQ, deadline: "2026-10-31T23:06:55.133Z" }; // the device asked 1 h later than 1Click saw
  const b = clone(fx.live.answer); b.quoteRequest.deadline = proxied.deadline;
  refused("deadline", () => checkOneClickQuote(proxied, b, LIVE_OPTS));
});
test("live: an answer with no deposit address is refused", () => {
  const a = clone(fx.live.answer); delete a.quote.depositAddress;
  assert.throws(() => checkOneClickQuote(LIVE_REQ, a, LIVE_OPTS), OneClickQuoteError);
});

// Floors (§2.8 deposit quote row), on the real answers and on the paper's numbers.
test("live other-pair floor: the lower NEAR read at the boundary passes, 0.000003 higher is refused", () => {
  assert.doesNotThrow(() => checkOneClickQuote(LIVE_REQ, clone(fx.live.answer), LIVE_OPTS));
  refused("floor", () => checkOneClickQuote(LIVE_REQ, clone(fx.live.answer), { ...LIVE_OPTS, pricing: { in: ["4.426779", "4.43"], out: ["1", "1"] } }));
  // p_in is the lower of the two reads, whichever order they come in
  assert.doesNotThrow(() => checkOneClickQuote(LIVE_REQ, clone(fx.live.answer), { ...LIVE_OPTS, pricing: { in: ["4.43", "4.426776"], out: ["1", "1"] } }));
  // p_out is the higher of the destination's two reads: the refused NEAR read passes against a USDC read of 1.000002
  assert.doesNotThrow(() => checkOneClickQuote(LIVE_REQ, clone(fx.live.answer), { ...LIVE_OPTS, pricing: { in: ["4.426779", "4.43"], out: ["1", "1.000002"] } }));
});
test("two price reads further apart than the slippage are refused", () => {
  refused("price", () => checkOneClickQuote(LIVE_REQ, clone(fx.live.answer), { ...LIVE_OPTS, pricing: { in: ["4.40", "4.45"], out: ["1", "1"] } }));
  for (const p of ["-1", "0", "4,4", "1e3", "", " 4.4"])
    refused("price", () => checkOneClickQuote(LIVE_REQ, clone(fx.live.answer), { ...LIVE_OPTS, pricing: { in: [p, "4.43"], out: ["1", "1"] } }));
});
test("dry USDC-to-USDC on the partner path: the fee entry is not the keyless one, refused", () => {
  refused("app-fees", () => checkOneClickQuote(DRY_REQ, clone(fx.dry.answer), { ...DRY_OPTS, path: "partner" }));
});
test("USDC-to-USDC floors at $2 and $10,000 (F 1 keyless, 20 partner; S 15; withdrawFee taken off, refundFee never)", () => {
  const base = { withdrawFee: 5_538n, slippageBps: 100, pricing: "usdc", decimalsIn: 6, decimalsOut: 6, intoVault: true } as const;
  assert.deepEqual(oneClickFloors({ ...base, amountIn: 2_000_000n, path: "keyless" }), { amountOut: 1_991_262n, minAmountOut: 1_971_350n });
  assert.deepEqual(oneClickFloors({ ...base, amountIn: 10_000_000_000n, path: "keyless" }), { amountOut: 9_983_994_462n, minAmountOut: 9_884_154_518n });
  assert.deepEqual(oneClickFloors({ ...base, amountIn: 2_000_000n, path: "partner" }), { amountOut: 1_987_462n, minAmountOut: 1_967_588n });
  // the real dry answer sits above the keyless floor: 1,994,124 ≥ 1,991,262 and 1,974,182 ≥ 1,971,350
});
test("a quote into the vault never floors under MIN_DEPOSIT (1 USDC)", () => {
  const f = oneClickFloors({ amountIn: 500_000n, withdrawFee: 5_538n, slippageBps: 100, path: "keyless", pricing: "usdc", decimalsIn: 6, decimalsOut: 6, intoVault: true });
  assert.equal(f.minAmountOut, 1_000_000n);
  const g = oneClickFloors({ amountIn: 500_000n, withdrawFee: 5_538n, slippageBps: 100, path: "keyless", pricing: "usdc", decimalsIn: 6, decimalsOut: 6, intoVault: false });
  assert.ok(g.minAmountOut < 1_000_000n);
});
test("a quote whose fees take the whole amount is refused, whatever it signs", () => {
  // the real dry answer under a 2,000,000-unit withdrawFee floor: the device's floor is at or under zero
  assert.ok(oneClickFloors({ amountIn: 2_000_000n, withdrawFee: 2_000_000n, slippageBps: 100, path: "keyless", pricing: "usdc", decimalsIn: 6, decimalsOut: 6, intoVault: false }).minAmountOut <= 0n);
  refused("floor", () => checkOneClickQuote(LIVE_REQ, clone(fx.live.answer), { ...LIVE_OPTS, pricing: { in: ["0.000001", "0.000001"], out: ["1", "1"] } }));
});
test("a request that is not EXACT_INPUT, or has no dry flag, is refused", () => {
  refused("request", () => checkOneClickQuote({ ...DRY_REQ, swapType: "EXACT_OUTPUT" } as unknown as OneClickRequest, clone(fx.dry.answer), DRY_OPTS));
  const { dry: _, ...noDry } = DRY_REQ;
  refused("request", () => checkOneClickQuote(noDry as OneClickRequest, clone(fx.dry.answer), DRY_OPTS));
});
test("hostile answers that are not objects are refused, never thrown as TypeErrors", () => {
  for (const a of [null, undefined, 1, "x", [], {}, { quote: {} }, { quoteRequest: {} }])
    assert.throws(() => checkOneClickQuote(DRY_REQ, a, DRY_OPTS), OneClickQuoteError);
});
