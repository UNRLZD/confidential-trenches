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
import { evmPoolProvidersOf, evmPoolVenues, evmRpcOperator } from "@blindfill/kit";
import { bindSenderFromEnv } from "./bind/env.ts";
import { evmPoolSendersFromEnv } from "./pool/evm.ts";
import { solanaPoolSendersFromEnv } from "./pool/solana.ts";
import { statusesOf, tokenWatchesFromEnv } from "./token-status/status.ts";
import type { FeeQuoter } from "./withdraw/fee.ts";
import { RPC_UPSTREAMS } from "./rpc/rpc.ts";
import { MAINNET_VAULT, withdrawSenderFromEnv } from "./withdraw/send.ts";

/** Throws the start's own refusal of a pool sender's settings. */
export function checkPoolEnv(env: Record<string, string | undefined>): void {
  evmPoolSendersFromEnv(env);
  solanaPoolSendersFromEnv(env);
}

/**
 * Throws when a keyed Base or Robinhood URL the helper would use (rpc/rpc.ts RPC_UPSTREAMS keyed names) is run by an
 * operator of that chain's pool list (the kit's evmPoolProvidersOf, by its evmRpcOperator), or has no operator (not an
 * http(s) URL): the device's EVM pool sync keeps old logs only when two operators give them alike, the helper's
 * ?keyed=only route counted as operator "helper" (packages/wallet/src/pool/evm.ts evmSourceOperator), so a keyed URL
 * of a pool-list operator would count one operator twice (card evm-pool-sync-holds). Names the variable and the
 * operator, never the URL or any part of it: a keyed URL carries its key.
 */
export function checkPoolRpcOperators(env: Record<string, string | undefined>): void {
  const venues = evmPoolVenues();
  for (const chain of ["base", "robinhood"] as const) {
    const pool = new Set((evmPoolProvidersOf(venues[chain]) ?? []).map(evmRpcOperator));
    for (const name of RPC_UPSTREAMS[chain].keyed) {
      const url = env[name];
      if (url === undefined || url === "") continue;
      const op = evmRpcOperator(url);
      if (op === null) throw new Error(`${name}: not an http(s) URL, so no operator apart from the device's pool list`);
      if (pool.has(op)) throw new Error(`${name}: its operator ${op} runs the device's ${chain} pool list`);
    }
  }
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
    checkPoolRpcOperators(process.env);
  } catch (e) {
    console.error(`helper env: ${(e as Error).message}`);
    process.exit(2);
  }
  console.log("helper env: the pool senders', the withdrawal relayer's and the deposit carry's settings are whole; no keyed Base or Robinhood URL is a pool-list operator's");
  process.exit(0);
}
