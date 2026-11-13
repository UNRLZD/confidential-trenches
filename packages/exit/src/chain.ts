// One chain's exit (card exit-with-only-the-words): what the exit command hands each chain it runs, and what each one
// gives back. The command (./cli.ts) reads the 12 words, makes seed64 once and runs every chain the user asks for
// through its ExitChain, one after another: the NEAR vault (./near-out.ts), the Solana pool, Base and Robinhood. A
// chain's ExitChain proves on the device, pays its own fees from a wallet of the 12 words and sends each transaction
// itself to the chain's public RPCs; no server of ours is in its path (scripts/ci/exit-no-server.mjs).
//
// - seed: the 12 words' seed64, the caller's; an ExitChain reads it and never keeps it past its own return (the
//   command zeroes it once every chain has run, on every path).
// - to: the payout address the user typed for this chain: a NEAR account for the vault, a Solana address for the pool,
//   an EVM address for Base and Robinhood. Each chain checks it in its own form before any money moves.
// - rpcs: the chain's two public RPCs, which must agree on every read.
// - say: one line for the user (progress, a fee wallet's address and the amount it is short); never a secret.
export interface ExitCtx { seed: Uint8Array; to: string; rpcs: [string, string]; say: (line: string) => void }

/** What a chain's exit did: every transaction it sent, what reached `to` and what is still in the vault or pool, as decimal base units. */
export interface ExitResult { chain: "near" | "solana" | "base" | "robinhood"; txs: string[]; sent: string; left: string }

export type ExitChain = (ctx: ExitCtx) => Promise<ExitResult>;
