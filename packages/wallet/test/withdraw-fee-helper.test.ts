// The helper's fee answer through the device's own parser and cap (card relayer-withdraw-fee). The helper's recorded
// quote (apps/helper/src/withdraw/fixtures/withdraw-fee-reads.json: its reads of 2026-11-02 on mainnet and testnet and
// the answers they gave) is read as data, never imported:
// - askWithdrawFee (../src/withdraw/relay.ts) takes each recorded answer as it is, from the release's relayer;
//   the same answer with its fee as a rate ("0.0005"), or naming another relayer, is refused;
// - the device's withdrawFeeMax (../src/withdraw/feemax.ts) at the same reads is at least twice the quote (P1,
//   markets.md l.3010), and so is it on every row of the helper's P1 table (fixtures/withdraw-fee-table.json, held to
//   the helper's withdrawFeeMin by apps/helper/src/withdraw/fee.test.ts).
//   node --test packages/wallet/test/withdraw-fee-helper.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { VAULT_CONSTANTS } from "@blindfill/kit";
import { NEAR_NETWORKS } from "../src/deposit/account.ts";
import { withdrawFeeMax } from "../src/withdraw/feemax.ts";
import { askWithdrawFee, WITHDRAW_FEE_URL, WithdrawRelayRefused } from "../src/withdraw/relay.ts";

const FIXTURES = new URL("../../../apps/helper/src/withdraw/fixtures/", import.meta.url);
type Call = { url: string; method: string; params: Record<string, unknown>; result: Record<string, unknown> };
const REC = JSON.parse(readFileSync(new URL("withdraw-fee-reads.json", FIXTURES), "utf8").replaceAll("$USDC", VAULT_CONSTANTS.TOKEN)) as {
  relayer: { relayer_account: string; fee_recipient: string };
  answers: Record<"mainnet" | "testnet", Record<string, unknown>>;
  calls: Call[];
};
const TABLE = JSON.parse(readFileSync(new URL("withdraw-fee-table.json", FIXTURES), "utf8")) as { rows: { gp: string; pool_token: string; pool_near: string; register_deposit: string; fee_min: string }[] };

const answering = (body: unknown) =>
  (async (url: string | URL | Request) => {
    assert.ok(String(url).startsWith(`${WITHDRAW_FEE_URL}?token=`));
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
const AMOUNT = 10_000_000n; // 10 USDC

test("askWithdrawFee takes the helper's recorded answers, mainnet and testnet, from the release's relayer", async () => {
  for (const network of ["mainnet", "testnet"] as const) {
    const got = await askWithdrawFee({ token: NEAR_NETWORKS[network].token, relayer: REC.relayer, amount: AMOUNT, fetchFn: answering(REC.answers[network]) });
    assert.deepEqual(got, { relayFee: BigInt(REC.answers[network].relay_fee as string), feeRecipient: REC.relayer.fee_recipient, validUntilBlock: REC.answers[network].valid_until_block });
  }
});

test("the same answer with its fee as a rate, as a number, or from another relayer: refused", async () => {
  const cases: [Record<string, unknown>, string][] = [
    [{ relay_fee: "0.0005" }, "answer"],
    [{ relay_fee: 207609 }, "answer"],
    [{ fee_recipient: "thief.near" }, "relayer"],
    [{ relayer_account: "thief.near" }, "relayer"],
  ];
  for (const [edit, code] of cases) {
    await assert.rejects(
      askWithdrawFee({ token: VAULT_CONSTANTS.TOKEN, relayer: REC.relayer, amount: AMOUNT, fetchFn: answering({ ...REC.answers.mainnet, ...edit }) }),
      (e: Error) => e instanceof WithdrawRelayRefused && e.code === code,
    );
  }
});

/** The device's inputs from the helper's own recorded reads: the agreed block's gas price, the pool, the token's minimum. */
function inputsAt(token: string) {
  const bytes = (c: Call) => JSON.parse(Buffer.from(c.result.result as number[]).toString()) as Record<string, unknown>;
  const pool = bytes(REC.calls.find((c) => c.params.method_name === "get_pool")!);
  const bounds = REC.calls.find((c) => c.params.method_name === "storage_balance_bounds" && c.params.account_id === token)!;
  const header = REC.calls.find((c) => c.method === "block" && c.params.block_id === bounds.params.block_id)!.result.header as { gas_price: string };
  const [poolToken, poolNear] = pool.amounts as [string, string];
  return { gasPrice: BigInt(header.gas_price), poolToken: BigInt(poolToken), poolNear: BigInt(poolNear), registerDeposit: BigInt(bytes(bounds).min as string) };
}

test("P1 at the helper's recorded reads: the device's fee_max is 438,172, the quote 207,609 at most half of it, on both networks", () => {
  for (const network of ["mainnet", "testnet"] as const) {
    const max = withdrawFeeMax(inputsAt(NEAR_NETWORKS[network].token));
    const fee = BigInt(REC.answers[network].relay_fee as string);
    assert.equal(max, 438_172n);
    assert.equal(fee, 207_609n);
    assert.ok(2n * fee <= max, `${network}: 2 x ${fee} > ${max}`);
  }
});

test("P1 over the helper's table: 200 rows over gp 1e8-1e10 and px 0.5-50, 2 x fee_min <= the device's fee_max on each", () => {
  assert.equal(TABLE.rows.length, 200);
  let worst = 0;
  for (const r of TABLE.rows) {
    const max = withdrawFeeMax({ gasPrice: BigInt(r.gp), poolToken: BigInt(r.pool_token), poolNear: BigInt(r.pool_near), registerDeposit: BigInt(r.register_deposit) });
    assert.ok(2n * BigInt(r.fee_min) <= max, `row ${JSON.stringify(r)}: fee_max ${max}`);
    worst = Math.max(worst, Number(r.fee_min) / Number(max));
  }
  assert.ok(worst < 0.5, `the highest fee_min / fee_max is ${worst}`);
});
