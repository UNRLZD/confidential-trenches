Blindfill is the private engine without limit and compromise for every app: wallets, terminals, bots and AI agents plug in and trade as strangers.

<img alt="Confidential Trenches by UNRLZD. Trade confidentially without limit and compromise. Speed: 1.2 s. Chains: any. Keys: self custody. Trades: confidential." src="assets/banner.png" width="100%">

# Confidential Trenches

[![CI](https://github.com/UNRLZD/confidential-trenches/actions/workflows/ci.yml/badge.svg?event=merge_group)](https://github.com/UNRLZD/confidential-trenches/actions/workflows/ci.yml?query=event%3Amerge_group) [![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

Private trading that nobody can rob, not even us

Blindfill sits under any wallet, terminal, trading bot or AI agent, and one import, `@blindfill/kit`, makes its users strangers on chain.
Every chain NEAR Intents reaches can join, with fresh wallets of its own and the same private balance.
We built it so any market with a pool on chain can trade privately, from memecoins to stock tokens. Money can already leave to any address.

[The app](https://confidential.unrealized.trade) | [The vault on NEAR](https://nearblocks.io/address/vault.confidential.unrlzd.near) | [Proofs](docs/proofs.md) | [Research and audits](research/README.md) | [Architecture](docs/architecture.md) | [Security](docs/security.md)

Every claim on this page comes with a command you can run to check it: [docs/judges.md](docs/judges.md).

Blindfill is the engine. Its vault on NEAR has no key, and its wallets live on your device, where each one carries a single trade. Apps plug in through one public entry, `@blindfill/kit`.

Confidential Trenches is the flagship app on Blindfill, the experimental edition of the UNRLZD trading terminal. It calls the same public entry as any outside application would, and it never holds a key.

Built at NEAR HACKATHON, Nov 1-14, 2026.

We designed Blindfill for its full reach: any chain NEAR Intents reaches, any asset with a pool on chain, any app. Because of the hackathon's time limit, this build integrates four chains: Solana, Base, Robinhood Chain and NEAR. Every other chain joins the same way, with fresh wallets of its own and the same private balance.

## Why it stands apart

Private trading today asks you to trust someone with your money or your history, usually an operator who holds the keys and reads every transaction that passes through. We built Blindfill so that nobody holds either.

### Nobody can take the money

The vault has no access key, no owner, no upgrade path and no pause. Ask any NEAR RPC for its keys and you'll get `[]`. Money leaves only for a proof your device makes, and it goes only to the accounts named in that proof.

### No record ties a trade to you

Every buy comes from a wallet that has never been used, paid from a pool that every user shares, and nothing on chain records which deposit paid for which trade. Timing and amount can still hint. That's why the app moves money in standard sizes.

### Private, at trading speed

Your device makes its proofs in the background, so a buy paid from the pool on its own chain doesn't wait on a proof or a bridge. On a phone, a Solana buy from a wallet readied ahead of time, the v1 way, filled in 1.2 s at the median and 3.3 s at p95, tap to filled, over five live runs. The v2 buy, where the pool pays the wallet inside the buy itself, hasn't been timed on mainnet yet.

### Any chain, one balance

Blindfill is built for any chain NEAR Intents reaches and any token with a pool there, all from one private balance. Money comes in from any chain NEAR Intents reaches. This build trades pump.fun and PumpSwap coins on Solana, Uniswap pools on Base and Robinhood Chain, and Rhea pools on NEAR.

### Orders with no key on our side

Orders are in Blindfill's design and not in this build: the app's order screens show Coming soon. In the design, your device signs the stop and the take-profit right after the buy, with the price written into each. A server sends them when the price arrives and can't change a byte, and once one fills, its twin can't land.

### Out with only your 12 words

Switch off every server we run and the exit tool still brings your money home from the NEAR vault and the Solana pool, using your 12 words and public RPCs.

## Try it

### Watch it run

The live app, signed out, read on 2026-11-14:

<img alt="The JUP token page on Solana: chart, holders and trades, and the trade box" src="docs/screenshots/token.png" width="100%">

<img alt="Discover: new, trending, hot and graduating coins, live" src="docs/screenshots/discover.png" width="100%">

<img alt="The JUP token page on a phone" src="docs/screenshots/phone-token.png" width="320">

### For people

You need a phone or a computer, and money in any wallet.

1. Open [confidential.unrealized.trade](https://confidential.unrealized.trade).
2. Sign in with Face ID, a passkey or a wallet you already use.
3. Save your 12 words.
4. Deposit from any wallet, on any chain NEAR Intents reaches.
5. Buy a pump.fun or PumpSwap coin on Solana, a token with a Uniswap pool on Base or Robinhood Chain, or one with a Rhea pool on NEAR. Open the trade on a block explorer: the buyer is a wallet that has never been used.
6. Tap Verify.
7. Withdraw to any address.

### Check it yourself, with no money

Plain reads from two public NEAR RPCs. No account, no key, no install beyond `curl` and `jq`.

```sh
VAULT=vault.confidential.unrlzd.near
USDC=17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1
for RPC in https://rpc.mainnet.fastnear.com https://near.drpc.org; do
  q() { curl -s "$RPC" -H 'content-type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":$1}"; }
  # 1. the vault has no access key
  q "{\"request_type\":\"view_access_key_list\",\"finality\":\"final\",\"account_id\":\"$VAULT\"}" | jq -c .result.keys
  # 2. the code running is the code published here
  q "{\"request_type\":\"view_code\",\"finality\":\"final\",\"account_id\":\"$VAULT\"}" | jq -r .result.hash
  # 3. the vault holds every dollar it owes
  q "{\"request_type\":\"call_function\",\"finality\":\"final\",\"account_id\":\"$VAULT\",\"method_name\":\"totals\",\"args_base64\":\"e30=\"}" | jq -r '.result.result | implode'
  q "{\"request_type\":\"call_function\",\"finality\":\"final\",\"account_id\":\"$USDC\",\"method_name\":\"ft_balance_of\",\"args_base64\":\"$(printf '{"account_id":"%s"}' "$VAULT" | base64)\"}" | jq -r '.result.result | implode'
done
```

| Line | A passing read |
|---|---|
| 1 | `[]` on both RPCs |
| 2 | `C5fk3Fr9XZwSeDbu9Nc6pTMpYrWiKgBXVzJaK2mAzG3u`, the `code_hash` of the reproducible build of commit `e0623bf3` in [contracts/vault/deployments/mainnet-v1.json](contracts/vault/deployments/mainnet-v1.json) |
| 3 | the USDC balance equals what `totals()` says the vault owes |

Read on 2026-11-14 at 22:45Z, both RPCs answered `[]`, `C5fk3Fr9XZwSeDbu9Nc6pTMpYrWiKgBXVzJaK2mAzG3u`, `{"deposited":"11879349","spent":"6403003","returned":"0"}` and `"5476346"`: 11879349 minus 6403003 is 5476346.

### For AI agents and scripts

Node 24 or later and pnpm 10.33.1. Coding agents also read [AGENTS.md](AGENTS.md).

```sh
git clone https://github.com/UNRLZD/confidential-trenches
cd confidential-trenches
pnpm install --frozen-lockfile
pnpm -r --if-present --no-bail run test
```

A passing run exits with 0, and every package's summary reads:

```text
ℹ fail 0
```

The terminal calls only `@blindfill/kit`'s public entry, as any wallet, bot or agent would, and `pnpm run check:imports` fails on any import past it. The kit is installed from this repository as a workspace package; it is not on npm yet.

## Live now

| Piece | Address | Link |
|---|---|---|
| The vault | `vault.confidential.unrlzd.near` | [nearblocks](https://nearblocks.io/address/vault.confidential.unrlzd.near) |
| The signing page, which runs the app inside it | `confidential.unrealized.trade` | [open](https://confidential.unrealized.trade) |
| The app | `ct-app.unrealized.trade` | |
| The helper | `ct-api.unrealized.trade` | |

## Proofs

- **56 mainnet transactions** recorded by the changes that moved money: NEAR 14, Solana 28, Base 7, Robinhood Chain 7. Each links to its explorer in [docs/proofs.md](docs/proofs.md), and `node scripts/ci/money-gate.mjs --all` reads every one back on two public RPCs. 585 earlier transactions on test networks are listed there too.
- **The vault's own state**, read on two public RPCs: no access key, the code hash of its reproducible build, and a USDC balance equal to what it owes ([docs/proofs.md](docs/proofs.md#the-vault-read-on-two-public-near-rpcs)).
- **A live check per change**, in [scripts/live-checks/](scripts/live-checks/), run against the deployed hosts after every deploy.
- **Research proofs** from before the build: 33 measured runs here and 11 more in the private research repository, such as a Privacy Pools withdrawal proof checked by a NEAR contract with its gas measured, proofs made on a phone, a phone-browser Solana trade, and the full money loop with real money. See [research/](research/README.md).
- **The Pillow Auditors review** of the NEAR vault, the EVM pool and the Solana pool (7 Nov 2026): 0 Critical, 0 High, 0 Medium, 5 Low, 8 Info, and every Low fixed on main. The report and the commit that fixes each Low are in [research/audits/2026-11-07-pillow/](research/audits/2026-11-07-pillow/README.md).
- **Audits and reviews** of the vault contract and a pre-audit security scan, in [research/audits/](research/README.md#audits-and-reviews).

## How it works

One private buy in v2, from the money coming in to the money going home. The step numbers match the diagram below, and every time in the last column comes from a run we recorded ([docs/performance.md](docs/performance.md)).

| Step | What you do | What happens underneath | Measured |
|---|---|---|---|
| 1 Deposit | Send money from any wallet | NEAR Intents carries it into the pool on the chain you trade on, or into the vault on NEAR. Your device writes private notes in standard sizes. | 31.9 s from NEAR and 41.9 s from Solana into NEAR Intents |
| 2 Prove | Nothing | Your device proves it owns a note without saying which, and names a brand-new wallet whose key lives only on your device. The proof fixes where the money goes, so the helper carrying it can't redirect a cent. | 8.3 s on an iPhone, in the background |
| 3 Pay | Tap Buy | Your device checks the quote against two chain reads. The new wallet signs one transaction, and in it the pool checks the proof and pays the wallet. | |
| 4 Buy | Nothing | In that same transaction the wallet buys, from a wallet with no history. On NEAR the vault pays the wallet first, then the wallet buys. | v2 buy not timed on mainnet yet; a buy from a wallet readied ahead (v1) took 1.2 s median, 3.3 s p95, on a phone |
| 5 Come back | Sell, or withdraw | A sell puts the money back into the pool as a new note. A withdrawal goes to any address, or through NEAR Intents to another chain. | |

## Performance

Every number below comes from a run we recorded, and each row links to the transactions behind it on a public explorer, so you can check a fill yourself. The "Where, signed by" column says who signed each run: a test script holding its own keys, or the app in a phone browser.

<!-- perf-table:begin (made by scripts/perf-table.mjs from perf/runs; do not edit by hand) -->
| Chain | What | Median / p95 | Filled | Where, signed by | Every transaction |
|---|---|---|---|---|---|
| Solana | Buy | 1.2 s / 3.3 s | 5 of 5 | mainnet, phone browser | [solana-phone-2026-10-26](docs/performance.md#solana-phone-2026-10-26) |
| Solana | Buy | 0.9 s / 1.2 s | 20 of 21 | mainnet, test script | [solana-script-2026-10-19](docs/performance.md#solana-script-2026-10-19) |
| Solana | Sell | 1.4 s / 1.5 s | 5 of 5 | mainnet, phone browser | [solana-phone-2026-10-26](docs/performance.md#solana-phone-2026-10-26) |
| Solana | Sell | 0.8 s / 1.0 s | 20 of 20 | mainnet, test script | [solana-script-2026-10-19](docs/performance.md#solana-script-2026-10-19) |
| Solana | Money in to NEAR Intents | 41.9 s | 1 of 1 | mainnet, test script | [solana-intents-2026-10-19](docs/performance.md#solana-intents-2026-10-19) |
| Solana | Money out to a fresh wallet (NEAR Intents) | 21.1 s / 22.7 s | 2 of 2 | mainnet, test script | [solana-intents-2026-10-19](docs/performance.md#solana-intents-2026-10-19) |
| Solana | Money out to a fresh wallet (NEAR Intents) | 38.9 s / 39.0 s | 2 of 2 | mainnet, test script | [solana-intents-out-2026-10-26](docs/performance.md#solana-intents-out-2026-10-26) |
| Base | Buy | 0.9 s / 1.3 s | 20 of 20 | mainnet, test script | [base-script-2026-10-20](docs/performance.md#base-script-2026-10-20) |
| Base | Sell | 1.2 s / 1.3 s | 20 of 20 | mainnet, test script | [base-script-2026-10-20](docs/performance.md#base-script-2026-10-20) |
| Base | Hop between chains (Relay) | 4.9 s / 5.8 s | 2 of 2 | mainnet, test script | [base-hop-2026-10-26](docs/performance.md#base-hop-2026-10-26) |
| Base | Money out to a fresh wallet (NEAR Intents) | 21.2 s | 1 of 1 | mainnet, test script | [base-intents-2026-10-19](docs/performance.md#base-intents-2026-10-19) |
| Robinhood | Buy | 1.9 s / 4.0 s | 20 of 20 | mainnet, test script | [robinhood-script-2026-10-20](docs/performance.md#robinhood-script-2026-10-20) |
| Robinhood | Sell | 2.0 s / 2.6 s | 20 of 20 | mainnet, test script | [robinhood-script-2026-10-20](docs/performance.md#robinhood-script-2026-10-20) |
| NEAR | Buy | 3.9 s / 4.3 s | 20 of 20 | mainnet, test script | [near-script-2026-10-20](docs/performance.md#near-script-2026-10-20) |
| NEAR | Sell | 3.7 s / 4.2 s | 20 of 20 | mainnet, test script | [near-script-2026-10-20](docs/performance.md#near-script-2026-10-20) |
| NEAR | Money in to NEAR Intents | 31.9 s | 1 of 1 | mainnet, test script | [near-intents-2026-10-19](docs/performance.md#near-intents-2026-10-19) |
| NEAR | Money out to a fresh wallet (NEAR Intents) | 24.4 s | 1 of 1 | mainnet, test script | [near-intents-2026-10-19](docs/performance.md#near-intents-2026-10-19) |
| NEAR | Withdraw proof on a phone | 8.3 s / 8.5 s | 5 of 5 | device, phone browser | [proof-phone-2026-10-26](docs/performance.md#proof-phone-2026-10-26) |
| NEAR | Commitment proof on a phone | 0.6 s / 0.7 s | 5 of 5 | device, phone browser | [proof-phone-2026-10-26](docs/performance.md#proof-phone-2026-10-26) |
| NEAR | Withdraw proof in a desktop browser | 1.8 s / 2.2 s | 6 of 6 | device, test script | [proof-threads-chromium-2026-11-02](docs/performance.md#proof-threads-chromium-2026-11-02) |
| NEAR | Withdraw proof in a desktop browser | 1.3 s / 1.4 s | 6 of 6 | device, test script | [proof-threads-webkit-2026-11-02](docs/performance.md#proof-threads-webkit-2026-11-02) |
| NEAR | Vault withdraw, the vault's own gas | up to 82.420 Tgas | 3 of 3 | testnet, test script | [vault-gas-testnet-2026-10-26](docs/performance.md#vault-gas-testnet-2026-10-26) |
| NEAR | Vault deposit, tree work only | up to 11.900 Tgas | 5 of 5 | testnet, test script | [vault-gas-testnet-2026-10-26](docs/performance.md#vault-gas-testnet-2026-10-26) |
<!-- perf-table:end -->

Medians round to the nearest 0.1 s. A p95 always rounds up.

## Architecture

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/architecture-dark.svg">
  <img alt="How Blindfill and Confidential Trenches fit together: apps call @blindfill/kit; your device holds the keys and notes, proves before the tap and checks every quote; helpers hold no money keys; on chain nothing has a key: the NEAR vault holds the USDC and a pool on Solana, Base and Robinhood Chain pays only the wallet a proof names; a fresh wallet is paid by the pool and buys in one transaction, and a sell goes back into the pool; NEAR Intents moves every dollar that changes chain; the exit tool needs only the 12 words." src="assets/architecture-light.svg" width="640">
</picture>

Every box and arrow is explained in [docs/architecture.md](docs/architecture.md), and every party's view in [docs/security.md](docs/security.md). Blindfill v2 is live on mainnet with a pool that has no keys on each chain you trade on, so a buy on Solana, Base or Robinhood Chain settles in one transaction on its own chain: see the [v2 lite paper](docs/litepaper.md).

## How this differs

We put the same six questions to each kind of private trading product on the market today.

| | Terminals that split trades over managed wallets | Private balances run by an operator | Shielded pools on one chain | Blindfill |
|---|---|---|---|---|
| Who can tie a trade to you | The operator | The operator | Timing and amount | Nobody holds the link. Timing and amount can hint. |
| Who can move or freeze the money | The operator | The operator, or a DAO | An upgrade key, in some | Nobody. The vault has no key. |
| Tokens minutes old | Yes, in public | No, a fixed list | Some | Yes, from a wallet never used |
| Chains to trade on | Several, in public | Many, inside one network | One | Any chain NEAR Intents reaches, from one balance (four in this build) |
| Wait at the tap | None | None | A shielding wait, in some | None when the money is already in that chain's pool. The proof is made before you tap. |
| Stops and limits while you sleep | Held on the operator's keys | Some | Rare | Designed to be signed on your device, with no key on our side; not in this build |

## Who sees what

Nobody holds a record of which deposit paid for which trade. Your 12 words and wallet keys stay on your device, and the vault holds no key at all, so there's no master key for anyone to leak or be ordered to hand over.

| Who | Sees | Never sees |
|---|---|---|
| Anyone on chain | Money going into the vault and the pools, standard-size payouts to new wallets, those wallets trading, withdrawals going out | Which deposit paid for which wallet |
| NEAR Intents | Each move it carries, with its amount and both ends | Which note paid, or whose wallet it is |
| Our helper | Each request it carries, with its time and IP address: quotes, proofs, transactions it sends | Your keys, your 12 words, or which note a proof spends |
| The vault | A valid proof, the accounts it pays and the amount | Which deposit the proof spends |
| You | Everything | |

Two hints remain. On chain, the size and time of a move can suggest a link, and our helper sees each request's IP address and arrival time. Standard sizes narrow the first. The [security page](docs/security.md) goes party by party.

## The parts

| Part | What it does |
|---|---|
| The vault | A NEAR contract that holds everyone's USDC in one pool. Money leaves only for a proof made on the owner's device from their 12 words, and goes only to the accounts that proof names. It ports Privacy Pools v1, whose code is audited and open source, to NEAR, with its admin parts removed: the vault approves every deposit itself. Its balance rests on NEAR beside NEAR Intents, never inside it. |
| Fresh wallets | Brand-new wallets on any chain NEAR Intents reaches, each one used once, all from the same 12 words. Keys never leave the device, and any wallet that imports a private key opens them. |
| Orders signed in advance | Blindfill's design, not in this build. Stops and limit sells are signed on the device with the price written in. A helper sends each one when its price is hit; it fills only at that price or better, into the user's own wallet. When one of a pair fills, the other cancels on its own. |
| The kit | `@blindfill/kit`, one public entry for any app: deposit, prove, ready the wallets, trade, withdraw, verify. The example agent in `examples/agent/` runs a full cycle through it in 292 lines across 4 files. |
| The terminal | The UNRLZD trading terminal, rebuilt on the kit. It calls only the kit's public entry, as any outside app would, and holds no key: a separate signing page on its own address signs every request. |
| Helper servers | Show prices and charts and carry signed messages. They hold API keys and the keys to our own gas and fee accounts, never a key to users' money. |

## What the vault can never do

- Sign anything with a key: it has none, and a read of its access keys returns `[]`.
- Change its code, pause, or change a setting: it has no owner, no upgrade path, no pause and no setter.
- Add a key, redeploy or delete itself: its code calls none of the functions that would.
- Pay any account the owner's proof does not name.
- Leave its balance inside NEAR Intents, where an outside party could freeze it.

## Layout

| Path | What |
|---|---|
| `contracts/vault/` | The vault, a Rust NEAR contract |
| `packages/kit/` | `@blindfill/kit`, the public entry for any app |
| `packages/kit/src/checks/` | The device's checks on every quote before it signs |
| `packages/wallet/` | Keys, notes and proofs on the device |
| `packages/signpage/` | The signing page, on its own address |
| `packages/exit/` | Money out with only the 12 words and public RPCs |
| `apps/terminal/` | The UNRLZD terminal |
| `apps/helper/` | The helper server: API keys and relays, never a money key |
| `docs/` | The architecture and security pages |
| `docs/proofs.md` | Every recorded mainnet transaction, with explorer links |
| `research/` | The research proofs and the audits |
| `scripts/ci/` | CI gates |
| `scripts/live-checks/` | A live check for each change, run after every deploy |

## Checks

| Run | Checks |
|---|---|
| `pnpm run check:imports` | No app reaches past the kit's public entry |
| `pnpm run test:gates` | Every CI gate refuses its planted case |
| `gitleaks dir . --config .gitleaks.toml --redact` | No secret in the tree |
| `node scripts/ci/money-gate.mjs --all` | Every money-path transaction reads back on two public RPCs |

## Prior work

Research and proofs from before Nov 1 are in `UNRLZD/confidential-trenches-proofs`, kept private. Their write-ups are copied into [research/](research/README.md). Blindfill builds on Privacy Pools (0xbow, Apache-2.0) and NEAR Intents.

The UNRLZD trading terminal existed before the hackathon as a separate product. This repository's history starts with the hackathon's first commit, [`88f2d3e`](https://github.com/UNRLZD/confidential-trenches/commit/88f2d3eac1748ad644ec52393277b9161f992b5f) on 2026-11-01 00:00Z, and [everything built since](https://github.com/UNRLZD/confidential-trenches/compare/88f2d3eac1748ad644ec52393277b9161f992b5f...main) is the hackathon's work.

## License

Apache-2.0, see [LICENSE](LICENSE).
