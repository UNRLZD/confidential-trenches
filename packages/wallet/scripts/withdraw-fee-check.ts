// The device half of card signpage-withdraw-handoff's live check (scripts/live-checks/signpage-withdraw-handoff.mjs runs
// it as a child process, so Blindfill's code stays behind the kit's entry for that file and the check has no second
// implementation of the wallet's): the withdraw form's fee read on the testnet release, with the page's own code, on
// the network's release pair and mainnet's for the price, against the release's helper.
//   node packages/wallet/scripts/withdraw-fee-check.ts           one JSON line: { fee, feeMax, feeError }
//     fee: the helper's GET /v1/withdraw/fee answer for the testnet token, as it came; feeMax: the device's own
//     fee_max at the token's storage minimum (readTokenStorageMin, readWithdrawFeeMax); feeError: the first refusal of
//     askWithdrawFee's checks (the release's relayer, byte for byte) or of a read, else null
//   node packages/wallet/scripts/withdraw-fee-check.ts --consts  one JSON line: the release values the check judges by
// Nothing is signed or sent; no request names an account of the user's.
import { NEAR_NETWORKS } from "../src/deposit/account.ts";
import { readTokenStorageMin } from "../src/arming/accounts.ts";
import { readWithdrawFeeMax } from "../src/withdraw/feemax.ts";
import { askWithdrawFee, RELEASE_WITHDRAW_RELAYER, relayRpc, WITHDRAW_FEE_URL } from "../src/withdraw/relay.ts";

const T = NEAR_NETWORKS.testnet;
const M = NEAR_NETWORKS.mainnet;
const relayer = RELEASE_WITHDRAW_RELAYER.testnet!;
if (process.argv.includes("--consts")) {
  console.log(JSON.stringify({ relayer, feeUrl: WITHDRAW_FEE_URL, token: T.usdc, testnetHosts: [...T.fastnear, T.drpc], mainnetPair: [M.fastnear[0], M.drpc] }));
} else {
  const rpcs = [relayRpc(T.fastnear[0]), relayRpc(T.drpc)] as const;
  const priceRpcs = [relayRpc(M.fastnear[0]), relayRpc(M.drpc)] as const;
  let fee: unknown = null;
  let feeMax: string | null = null;
  let feeError: string | null = null;
  try {
    fee = await (await fetch(`${WITHDRAW_FEE_URL}?token=${encodeURIComponent(T.usdc)}`, { redirect: "error" })).json();
    const registerDeposit = await readTokenStorageMin("testnet", rpcs);
    feeMax = String(await readWithdrawFeeMax({ network: "testnet", rpcs, priceRpcs, registerDeposit }));
    // the form's own checks on the answer: the release's relayer, a u128 fee (the amount the most one note can carry)
    await askWithdrawFee({ token: T.usdc, relayer, amount: (1n << 128n) - 1n });
  } catch (e) {
    feeError = e instanceof Error ? e.message : String(e);
  }
  console.log(JSON.stringify({ fee, feeMax, feeError }));
}
