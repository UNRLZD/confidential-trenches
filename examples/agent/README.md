# Agent example

An AI agent or script that is its own Blindfill user: it signs in with its own 12 words, then funds, deposits, buys a token on NEAR, sells it and withdraws, all through `@blindfill/kit`. It drives the signing page in Google Chrome and taps each Confirm only when no amount on it is above `--max`.

The kit is not on npm yet, so run it from a checkout of this repository, with Node 24 or later, pnpm and Google Chrome installed:

```
git clone https://github.com/UNRLZD/confidential-trenches
cd confidential-trenches
pnpm install --frozen-lockfile
node examples/agent/main.mjs run --token <token> --amount <usd> --max <usd> --to <address> [--deposit <usd>]
```

It moves real money on mainnet. Its 12 words and its record of each step stay in the `.blindfill-agent` folder in your home folder.
