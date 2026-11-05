// node src/env-check.ts (card helper-evm-sender): the pool senders' settings, read from this process's environment by
// the same readers the helper's start runs (pool/evm.ts evmPoolSendersFromEnv, pool/solana.ts solanaPoolSendersFromEnv).
// A network with some of its names set and not the rest, or a value either reader refuses, exits 2 with the reader's
// message, which names the variable, never its value; otherwise it exits 0. deploy/redeploy.sh runs it in the new image,
// with the environment compose gives the helper, before any helper is started or stopped, so a set the start would
// refuse stops the redeploy there instead of leaving a new helper that never gets ready.
import { evmPoolSendersFromEnv } from "./pool/evm.ts";
import { solanaPoolSendersFromEnv } from "./pool/solana.ts";

/** Throws the start's own refusal of a pool sender's settings. */
export function checkPoolEnv(env: Record<string, string | undefined>): void {
  evmPoolSendersFromEnv(env);
  solanaPoolSendersFromEnv(env);
}

if (import.meta.main) {
  try {
    checkPoolEnv(process.env);
  } catch (e) {
    console.error(`helper env: ${(e as Error).message}`);
    process.exit(2);
  }
  console.log("helper env: the pool senders' settings are whole");
  process.exit(0);
}
