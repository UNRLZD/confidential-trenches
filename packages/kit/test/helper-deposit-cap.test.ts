// The beta cap per deposit and its refusal code, read through the kit's public entry as an app reads them.
//   node --test test/helper-deposit-cap.test.ts      (from packages/kit)
// The code list is kit-v1's list with amount_above_cap put right after amount_too_low; nothing else moves.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as Kit from "@blindfill/kit";

// HELPER_BIND_DEPOSIT_CODES as the kit-v1 tag holds it (packages/kit/src/helper/v1.ts at kit-v1).
const KIT_V1_CODES = [
  "bad_shape",
  "bad_signature",
  "no_account",
  "bad_key",
  "bad_nonce",
  "sender_struck",
  "expired",
  "resign_needed",
  "not_one_action",
  "not_ft_transfer_call",
  "token_not_accepted",
  "deposit_not_1_yocto",
  "gas_too_low",
  "gas_too_high",
  "bad_receiver",
  "amount_too_low",
  "amount_above_balance",
  "bad_msg",
  "p_used",
  "p_bound",
  "prepay_open",
  "in_flight",
  "token_halted",
  "relayer_low",
];

test("the cap is $1,000 in USDC base units, a bigint like MIN_DEPOSIT", () => {
  assert.equal(typeof Kit.HELPER_BIND_DEPOSIT_CAP, "bigint");
  assert.equal(Kit.HELPER_BIND_DEPOSIT_CAP, 1_000_000_000n);
  assert.equal(Kit.HELPER_BIND_DEPOSIT_CAP, 1_000n * Kit.VAULT_CONSTANTS.MIN_DEPOSIT);
});

test("the deposit codes are kit-v1's list with amount_above_cap right after amount_too_low", () => {
  const at = KIT_V1_CODES.indexOf("amount_too_low") + 1;
  assert.deepEqual([...Kit.HELPER_BIND_DEPOSIT_CODES], [...KIT_V1_CODES.slice(0, at), "amount_above_cap", ...KIT_V1_CODES.slice(at)]);
  const code: Kit.HelperBindCode = "amount_above_cap";
  assert.ok((Kit.HELPER_BIND_DEPOSIT_CODES as readonly string[]).includes(code));
});
