// WU-04 (docs/plan1/wallet.md:1043; the deposit quote row :889 at research faacb62): the 1Click quote check on real
// signed answers.   node --test test/oneclick.test.ts      (from packages/kit)
// fixtures/oneclick-quotes.json holds four real answers that verify under 1Click's key: a live one (read back by status)
// and three keyless dry ones (USDC Solana to NEAR, NEAR USDC same-asset, and the same with a customRecipientMsg). A
// changed signed field must fail the signature, a changed request must fail the echo, an unsigned field (appFees, a
// live answer's request deadline) is bound some other way, and the floors are the device's.
// Mutations of src/checks/oneclick.ts that must each turn tests red (re-apply one at a time):
//   1. signature:  `if (!verifiesUnder(ONECLICK_SIGNING_KEYS, a)) fail` -> `if (false) fail`
//   2. live deadline: `Date.parse(q.deadline) !== Date.parse(request.deadline) + ONECLICK_LIVE_DEADLINE_MS` -> `false`
//   3. appFees pin: `if (!ok) fail("app-fees"` -> `if (false) fail("app-fees"`
//   4. echo: drop `"deadline"` from REQ_SIGNED
//   5. price side: `const [pIn] = reads(x.pricing.in` -> `const [, pIn] = reads(x.pricing.in`
//   6. freshness: `now - t <= ONECLICK_MAX_AGE_MS` -> `true`
//   7. zero floor: `if (amountOut <= 0n || minAmountOut <= 0n) fail(` -> `if (false) fail(`
//   8. F and S in the pair floor: `* (10_000n - fs), pIn.d` -> `* 10_000n, pIn.d`
//   9. decimals: `if (!ok) fail("request", \`${name}` -> `if (false) fail("request", \`${name}`
/// <reference types="node" />
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { base58 } from "@scure/base";
import {
  checkOneClickFormatted,
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
  same: { request: OneClickRequest; answer: Answer };
  customRecipientMsg: { request: OneClickRequest & { customRecipientMsg?: string }; answer: Answer };
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
// 0.4525 NEAR into NEAR USDC on the partner path (F 20, S 15): NEAR's lower read 4.442323 puts the floor exactly at the
// signed minAmountOut 1,983,085; 4.442324 puts it one base unit above.
const LIVE_OPTS: OneClickCheckOptions = {
  path: "partner", pricing: { in: ["4.442323", "4.45"], out: ["1", "1"] }, decimalsIn: 24, decimalsOut: 6, intoVault: false,
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
  assert.equal(r.withdrawFee, 0n);
  assert.equal(r.unsignedDryWithdrawFee, undefined);
});

test("a real dry quote verifies and passes, and hands on no deposit address", () => {
  const r = checkOneClickQuote(DRY_REQ, clone(fx.dry.answer), DRY_OPTS);
  assert.equal(r.depositAddress, undefined);
  assert.equal(r.amountOut, 1_994_124n);
  // a dry answer's withdrawFee is not signed: it comes back only under a name that says so
  assert.equal(r.withdrawFee, undefined);
  assert.equal(r.unsignedDryWithdrawFee, 5_538n);
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
      const usdcB = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near"; // another release USDC
      const v = f === "amount" ? "1" : f === "deadline" ? "2026-12-01T00:00:00.000Z"
        : (f === "originAsset" || f === "destinationAsset") && opts.pricing === "usdc" ? usdcB : other(req[f]);
      const r = { ...req, [f]: v } as OneClickRequest;
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

// Floors (§2.8 deposit quote row at faacb62), on the real answers and on the paper's numbers.
test("live other-pair floor (F and S taken off): 1Click's own implied $4.44 passes; one base unit each side of the boundary", () => {
  const p = (lo: string, hi = "4.45", out: readonly [string, string] = ["1", "1"]) => ({ ...LIVE_OPTS, pricing: { in: [lo, hi] as const, out } });
  assert.doesNotThrow(() => checkOneClickQuote(LIVE_REQ, clone(fx.live.answer), p("4.44"))); // 2.0091 / 0.4525
  const f = (px: string) => oneClickFloors({ amountIn: 452_500_000_000_000_000_000_000n, withdrawFee: 0n, slippageBps: 100, feeBps: 20,
    pricing: { in: [px, px], out: ["1", "1"] }, decimalsIn: 24, decimalsOut: 6, intoVault: false }).minAmountOut;
  assert.equal(f("4.442323"), 1_983_085n); // = the signed minAmountOut: passes
  assert.equal(f("4.442324"), 1_983_086n); // one base unit above it: refused
  assert.doesNotThrow(() => checkOneClickQuote(LIVE_REQ, clone(fx.live.answer), LIVE_OPTS));
  refused("floor", () => checkOneClickQuote(LIVE_REQ, clone(fx.live.answer), p("4.442324")));
  // p_in is the lower of the two reads, whichever order they come in
  assert.doesNotThrow(() => checkOneClickQuote(LIVE_REQ, clone(fx.live.answer), p("4.45", "4.442323")));
  // p_out is the higher of the destination's two reads: the refused NEAR read passes against a USDC read of 1.000002
  assert.doesNotThrow(() => checkOneClickQuote(LIVE_REQ, clone(fx.live.answer), p("4.442324", "4.45", ["1", "1.000002"])));
});
test("two price reads further apart than the slippage are refused", () => {
  refused("price", () => checkOneClickQuote(LIVE_REQ, clone(fx.live.answer), { ...LIVE_OPTS, pricing: { in: ["4.40", "4.45"], out: ["1", "1"] } }));
  for (const p of ["-1", "0", "4,4", "1e3", "", " 4.4"])
    refused("price", () => checkOneClickQuote(LIVE_REQ, clone(fx.live.answer), { ...LIVE_OPTS, pricing: { in: [p, "4.43"], out: ["1", "1"] } }));
});
test("dry USDC-to-USDC on the partner path: the fee entry is not the keyless one, refused", () => {
  refused("app-fees", () => checkOneClickQuote(DRY_REQ, clone(fx.dry.answer), { ...DRY_OPTS, path: "partner" }));
});
const usdcFloor = (amountIn: bigint, feeBps: number, withdrawFee = 5_538n, intoVault = true) =>
  oneClickFloors({ amountIn, withdrawFee, slippageBps: 100, feeBps, pricing: "usdc", decimalsIn: 6, decimalsOut: 6, intoVault });
test("USDC-to-USDC floors at $2 and $10,000 (F 1 keyless, 20 partner; S 15; withdrawFee taken off, refundFee never)", () => {
  assert.deepEqual(usdcFloor(2_000_000n, 1), { amountOut: 1_991_262n, minAmountOut: 1_971_350n });
  assert.deepEqual(usdcFloor(10_000_000_000n, 1), { amountOut: 9_983_994_462n, minAmountOut: 9_884_154_518n });
  assert.deepEqual(usdcFloor(2_000_000n, 20), { amountOut: 1_987_462n, minAmountOut: 1_967_588n });
  // the real dry answer sits above the keyless floor: 1,994,124 ≥ 1,991,262 and 1,974,182 ≥ 1,971,350
});
test("every rounding raises the floor: the cut rounds down, the scaled amount up", () => {
  // 2,000,001 × 16 / 10,000 = 3,200.0016: the cut is 3,200, so the floor is 2,000,001 − 5,538 − 3,200
  assert.equal(usdcFloor(2_000_001n, 1).amountOut, 1_991_263n);
  // 18 decimals in, 6 out: 1.0000000000000000001 USDC scales up to 1,000,001 base units, never down
  const f = oneClickFloors({ amountIn: 1_000_000_000_000_000_001n, withdrawFee: 0n, slippageBps: 0, feeBps: 0, pricing: "usdc", decimalsIn: 18, decimalsOut: 6, intoVault: false });
  assert.equal(f.amountOut, 1_000_001n - (1_000_001n * 15n) / 10_000n);
});
test("a quote into the vault never floors under MIN_DEPOSIT (1 USDC)", () => {
  assert.equal(usdcFloor(500_000n, 1).minAmountOut, 1_000_000n);
  assert.ok(usdcFloor(500_000n, 1, 5_538n, false).minAmountOut < 1_000_000n);
});
test("a floor whose fees take the whole amount is refused before MIN_DEPOSIT raises it, into the vault or not", () => {
  refused("floor", () => usdcFloor(2_000_000n, 1, 2_000_000n, true));
  refused("floor", () => usdcFloor(2_000_000n, 1, 2_000_000n, false));
  refused("floor", () => usdcFloor(2_000_000n, 1, 1_996_800n, true)); // amountOut floor exactly 0
  // the other-pair floor: the live quote's 0.4525 NEAR at $4.44 under a withdrawFee as large as its value
  for (const intoVault of [true, false])
    refused("floor", () => oneClickFloors({ amountIn: 452_500_000_000_000_000_000_000n, withdrawFee: 2_000_000n, slippageBps: 100, feeBps: 20,
      pricing: { in: ["4.44", "4.44"], out: ["1", "1"] }, decimalsIn: 24, decimalsOut: 6, intoVault }));
});

// Same-asset quotes answer appFees [] (D52; the keyless dry fixture "same"), with no fee in the floor.
test("a real same-asset dry quote with appFees [] passes; a fee entry on it, or [] on another pair, is refused", () => {
  const opts = { ...DRY_OPTS, now: at(fx.same.answer) };
  const r = checkOneClickQuote(fx.same.request, clone(fx.same.answer), opts);
  assert.equal(r.amountOut, 1_994_400n); // amountIn − withdrawFee 5,600, nothing more (floor 1,991,400 with F 0)
  const a = clone(fx.same.answer); a.quoteRequest.appFees = [{ recipient: "5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd", fee: 1 }];
  refused("app-fees", () => checkOneClickQuote(fx.same.request, a, opts));
  const b = clone(fx.dry.answer); b.quoteRequest.appFees = [];
  refused("app-fees", () => checkOneClickQuote(DRY_REQ, b, DRY_OPTS));
});

// A real answer that 1Click signed with a customRecipientMsg: the signature verifies, the echo refuses it.
test("a signed customRecipientMsg the device did not ask for is refused by the echo", () => {
  const { customRecipientMsg: _, ...req } = fx.customRecipientMsg.request;
  refused("echo", () => checkOneClickQuote(req, clone(fx.customRecipientMsg.answer), { ...DRY_OPTS, now: at(fx.customRecipientMsg.answer) }));
});

// The caller's inputs: pricing "usdc" only for the release's USDC assets; decimals bound by the signed formatted amounts.
test("pricing \"usdc\" for an asset outside the release's USDC list is refused", () => {
  refused("request", () => checkOneClickQuote(LIVE_REQ, clone(fx.live.answer), { ...LIVE_OPTS, pricing: "usdc" }));
});
test("decimals that do not match the signed formatted amounts are refused", () => {
  for (const d of [23, 25, 18]) refused("request", () => checkOneClickQuote(LIVE_REQ, clone(fx.live.answer), { ...LIVE_OPTS, decimalsIn: d }));
  for (const d of [5, 7]) refused("request", () => checkOneClickQuote(DRY_REQ, clone(fx.dry.answer), { ...DRY_OPTS, decimalsOut: d }));
  refused("request", () => checkOneClickQuote(DRY_REQ, clone(fx.dry.answer), { ...DRY_OPTS, decimalsIn: 5 }));
});

test("a formatted amount binds the decimals by truncation only: a larger decimals value never passes a short amount", () => {
  refused("request", () => checkOneClickFormatted("0.1", 100_000n, 7, "amountOutFormatted"));
  refused("request", () => checkOneClickFormatted("0.1", 100_000n, 12, "amountOutFormatted"));
  refused("request", () => checkOneClickFormatted("0.1", 10n ** 23n, 30, "amountOutFormatted"));
  // truncation passes: the right decimals, and digits cut off the end
  assert.doesNotThrow(() => checkOneClickFormatted("0.1", 100_000n, 6, "amountOutFormatted"));
  assert.doesNotThrow(() => checkOneClickFormatted("0.1", 199_999n, 6, "amountOutFormatted"));
  refused("request", () => checkOneClickFormatted("0.1", 99_999n, 6, "amountOutFormatted"));
  refused("request", () => checkOneClickFormatted("0.1", 200_000n, 6, "amountOutFormatted"));
});

// Deadlines (wallet.md:410): a request deadline already past, or one without a time zone, is refused.
test("a request deadline that has passed, or has no time zone, is refused", () => {
  refused("request", () => checkOneClickQuote({ ...DRY_REQ, deadline: "2026-11-01T00:57:00.000Z" }, clone(fx.dry.answer), DRY_OPTS));
  refused("request", () => checkOneClickQuote({ ...DRY_REQ, deadline: DRY_REQ.deadline.replace("Z", "") }, clone(fx.dry.answer), DRY_OPTS));
  refused("request", () => checkOneClickQuote({ ...DRY_REQ, deadline: "2026-11-01" }, clone(fx.dry.answer), DRY_OPTS));
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
