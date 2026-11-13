# The exit tool

Money out of Blindfill with only your 12 words and public RPCs. No server of ours is in its path, so it still works
with every one of them switched off.

## Run it

From a checkout of this repository, with Node 24 or later and pnpm:

```sh
pnpm install --frozen-lockfile
node packages/exit/src/bin.ts
```

It runs on mainnet. It asks, in this order:

1. Where each chain pays out: a NEAR account (such as `you.near`) for the vault, a Solana address for the Solana pool.
2. Your 12 words, at a hidden prompt. Nothing you type there is shown, and the words are never taken from the command
   line or the environment.

To run some chains only, name them: `node packages/exit/src/bin.ts --chains near` or `--chains solana`.

## What it does

For each chain it reads your notes on two public RPCs that must agree byte for byte, proves each withdrawal on your
machine with the setup files checked against their pinned sha256, and sends every transaction itself.

- **NEAR vault.** Each note leaves through its own one-use account, which pays its own gas. Before a note's
  withdrawal, if that account holds too little NEAR, the tool prints the account and the amount to send, then waits
  until it arrives. When the note is out, the account is closed and what is left of its NEAR goes to your NEAR account
  too.
- **Solana pool.** Each note is released whole to its own fresh wallet, then sent on from there to your Solana
  address. The fees are paid by the standard Solana wallet of your 12 words (path `m/44'/501'/0'/0'`, the address a
  usual Solana wallet shows for them): if it holds too little SOL, the tool prints its address and the amount, then
  waits. Each release pays that wallet's costs back to it.

A chain that stops says why and which transactions it sent; run the tool again and it goes on from where the chain
stopped.

## For other apps

Each chain is one `ExitChain` (`src/chain.ts`): it takes the seed, the payout address, the chain's two RPCs and a line
writer, and returns the transactions it sent and what reached the payout address.
