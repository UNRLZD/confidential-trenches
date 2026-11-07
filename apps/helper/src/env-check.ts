// node src/env-check.ts (card helper-evm-sender): the senders' settings, read from this process's environment by the
// same readers the helper's start runs: the pool senders (pool/evm.ts evmPoolSendersFromEnv, pool/solana.ts
// solanaPoolSendersFromEnv) and, card helper-v1-cutover, the withdrawal relayer and the deposit carry
// (withdraw/send.ts withdrawSenderFromEnv, bind/env.ts bindSenderFromEnv), each with the release's mainnet vault pin
// (withdraw/send.ts MAINNET_VAULT). A network with some of its names set and not the rest, a value a reader refuses, or a
// WITHDRAW_VAULT_MAINNET or BIND_VAULT_MAINNET that is not the pin (the lines left from the vault before) exits 2 with
// the reader's message, which names the variable, never its value; otherwise it exits 0. deploy/redeploy.sh runs it in
// the new image, with the environment compose gives the helper, before any helper is started or stopped, so a set the
// start would refuse stops the redeploy there instead of after the swap's wait (REDEPLOY_READY_S) with a new helper
// that never gets ready. deploy/vault-lines.sh moves the two vault lines to the deploy record's vault.
import { bindSenderFromEnv } from "./bind/env.ts";
import { evmPoolSendersFromEnv } from "./pool/evm.ts";
import { solanaPoolSendersFromEnv } from "./pool/solana.ts";
import { statusesOf, tokenWatchesFromEnv } from "./token-status/status.ts";
import type { FeeQuoter } from "./withdraw/fee.ts";
import { MAINNET_VAULT, withdrawSenderFromEnv } from "./withdraw/send.ts";

/** Throws the start's own refusal of a pool sender's settings. */
export function checkPoolEnv(env: Record<string, string | undefined>): void {
  evmPoolSendersFromEnv(env);
  solanaPoolSendersFromEnv(env);
}

/**
 * The withdrawal sender's fee quoter, never asked here: the sender reads its settings at construction and its quoter
 * only at a request. The real quoter (withdraw/fee.ts feeQuoterFromEnv) takes its store's lock as it is made, which the
 * running helper holds on the same volume while this check runs beside it, so it is not made here.
 */
const UNASKED: FeeQuoter = {
  networkOf: () => null,
  quote: () => Promise.reject(new Error("env-check asks no fee")),
  reads: () => {
    throw new Error("env-check asks no fee");
  },
};

/**
 * Throws the start's own refusal of the withdrawal relayer's or the deposit carry's settings, the mainnet vault held to
 * `mainnetVault` (the release's pin; a test passes the next one). Both readers only read: no store is opened and
 * nothing is sent until a request, and both are stopped here.
 */
export function checkSenderEnv(env: Record<string, string | undefined>, mainnetVault: string = MAINNET_VAULT): void {
  const watches = tokenWatchesFromEnv(env);
  withdrawSenderFromEnv(env, UNASKED, statusesOf(watches), fetch, mainnetVault).stop();
  bindSenderFromEnv(env, watches, fetch, mainnetVault).stop();
}

if (import.meta.main) {
  try {
    checkPoolEnv(process.env);
    checkSenderEnv(process.env);
  } catch (e) {
    console.error(`helper env: ${(e as Error).message}`);
    process.exit(2);
  }
  console.log("helper env: the pool senders', the withdrawal relayer's and the deposit carry's settings are whole");
  process.exit(0);
}
