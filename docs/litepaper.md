# Blindfill v2 lite paper

Private trading on any chain, at the speed of a tap.

14 November 2026 · Blindfill is the engine under [Confidential Trenches](https://confidential.unrealized.trade). This paper describes the v2 design and says, part by part, what runs on mainnet today.

## In one paragraph

Blindfill puts a pool with no keys on every chain you trade on. Each pool holds money as private notes and pays out only against a proof made on your own device. A buy is proved before you tap and settles in one transaction from a wallet that has never been used. A sell drops the money back into the pool. NEAR Intents moves every dollar that changes chain, and a vault on NEAR with no access key is the cash home. Nobody can take, freeze or change the money: no pool has an admin, an upgrade path or a pause, and we hold no key to any of them.

## 1. The problem

Every trade on a public chain ties a wallet to a history. Private trading products today fix that by asking you to trust someone: a terminal that splits your trades over wallets it controls, or a private balance an operator runs and can freeze. Either way, one party holds your keys or your records.

Blindfill's rule is that nobody holds either. The money sits in contracts with no key. Your keys and your records live only on your device, made from 12 words you save.

## 2. Why v1 was not enough

v1 kept the private crowd in one place: a vault on NEAR. The coins people want sit on Solana, Base and other chains. To buy one privately, money had to leave the vault, cross to the trading chain through NEAR Intents and land in a fresh wallet before the swap could run.

That crossing is the slow part, and it is public. We measured the step that fills a new wallet at 43.3 s on chain (1 Nov 2026). A first buy after a deposit took about 53 s end to end. Every shortcut to a few seconds either linked the deposit to the new wallet or put a money key on our server. So v2 stops crossing at the tap and puts a pool where the coins are.

## 3. The design

Six parts. The pools hold money. NEAR Intents moves money between chains. Your device holds every key. The helper only carries messages.

| Part | What it does |
|---|---|
| A pool on each trading chain | Holds that chain's money as private notes. Approves every deposit itself, keeps every past root, checks proofs, and releases money only to the wallet a proof names. No admin, no upgrade, no pause. |
| The NEAR vault | The cash home, in USDC. The same proof design and the same rule: no access key, no owner, no upgrade. |
| NEAR Intents | Every dollar that changes chain: deposits from any chain it reaches, moves between pools, exits to any address. |
| Your device | The 12 words and every key made from them, your notes, proofs made ahead of time, one fresh wallet per buy, and a check of every quote against two chain reads before it signs. |
| The helper | Pays network fees, sends transactions it cannot alter, reads chains, serves prices. It holds API keys and a fee key, never a key that moves your money. |
| The kit | `@blindfill/kit`, the one public entry any wallet, terminal, bot or AI agent calls. |

Every pool runs the same proof design as the NEAR vault, a port of Privacy Pools v1 (0xbow, Apache-2.0, audited) with its admin parts removed. There is no new circuit and no new setup ceremony.

### One EVM contract for every EVM chain

The Base and Robinhood Chain pools are the same contract. Another EVM chain takes the same code when it has three things: the standard pairing check at its standard price (EIP-1108), so the proof verifies; EIP-7702, so a sell and its deposit back fit one transaction; and a NEAR Intents route, so money can come in and leave. On Robinhood Chain the pairing check costs 142,137 gas, read on two RPCs.

## 4. How money moves

**Deposit.** Money comes in from any chain NEAR Intents reaches and lands as a private note your device writes and keeps.

**Buy.** Before you tap, your device splits what you hold into standard-size chunks and makes a proof for each one. A proof names the pool, a fresh wallet, a fee cap and a deadline, but no token. It takes 8.3 s on an iPhone, in the background. At the tap, the fresh wallet signs one transaction: the pool checks the proof and the wallet's signature, marks the chunk spent and pays the wallet, and in the same transaction the wallet buys. The helper adds the fee and sends it, and it cannot change a byte without breaking the signature.

**Sell.** The wallet sells the token and deposits everything back into the pool under a new note, in one transaction it signs itself. The money is private again the moment it lands. On Base and Robinhood Chain this runs through EIP-7702.

**Move between chains.** NEAR Intents carries money from one pool to another, with the NEAR vault as the stop that breaks the link between them.

**Out.** A withdrawal goes to any address on any chain NEAR Intents reaches. If every server we run is switched off, the exit tool still brings the money home with only the 12 words and public RPCs.

## 5. What nobody can do

- Sign for a pool or the vault. The NEAR vault returns `[]` when any NEAR RPC is asked for its access keys. The Solana pool's program has no upgrade authority. The EVM pool's source has no owner, no role, no upgrade and no pause.
- Change the code or pause a pool. None has an upgrade path or a pause, and none has an owner who could call a setter.
- Pay an account the owner's proof does not name.
- Hold the money inside NEAR Intents, where an outside party could freeze it. The resting balance stays in the vault and the pools.

## 6. Who sees what

Nobody holds the record of which deposit paid for which trade. The pools see a valid proof and the wallet it pays. NEAR Intents sees each move it carries. Our helper sees each request's time and IP address, never a key or which note a proof spends.

Two hints remain, and we say so. On chain, the size and time of a move can suggest a link: that is why buys come in standard sizes and wallets are readied before you tap. And each chain's pool has its own crowd, which starts empty, so a new chain gives thinner cover until deposits grow.

## 7. Numbers

Measured means a recorded run or a read on chain. Estimate means arithmetic on measured parts.

| What | Number | Kind |
|---|---|---|
| Checking a real proof on Solana | 111,218 compute units | measured |
| One private buy on Solana | 919 to 1,201 bytes, under the 1,232-byte limit | measured |
| Making a proof on an iPhone | 8.3 s, in the background | measured |
| Solana buy on a phone, tap to filled | 1.2 s median, 3.3 s p95, 5 of 5 filled | measured |
| v1 crossing to a fresh wallet | 43.3 s | measured |
| Gas for one private buy on Base | $0.011 to $0.015 | estimate |

Every run behind these is linked from [performance.md](performance.md).

## 8. Live today

Blindfill is designed for any chain NEAR Intents reaches, any asset with a pool on chain, and any app. Because of the hackathon's time, this build integrates four chains: Solana, Base, Robinhood Chain and NEAR.

| Piece | Mainnet address |
|---|---|
| NEAR vault | `vault.confidential.unrlzd.near` |
| Solana pool | `EN1Wb2iWTw7ihNHTNW3SU2DkUCbw7yEEGR7ywWgWn8MF` |
| Base pool | `0xaa080e74ec99cf5c684548c77ca145edfcf899cf` |
| Robinhood Chain pool | `0x9306359433127c4f3be426f6faeb00a3c41f66db` |

The deploy records, with build hashes and transactions, are in [contracts/vault/deployments/](../contracts/vault/deployments/), [contracts/pool-solana/deployments/](../contracts/pool-solana/deployments/) and [contracts/pool-evm/deployments/](../contracts/pool-evm/deployments/).

Still to come in the app: orders signed in advance show Coming soon in this build, and the kit installs from this repository until it is published to npm.

## 9. For builders

An app reaches all of this through one import, `@blindfill/kit`: deposit, prove, ready the wallets, trade, withdraw, verify. Confidential Trenches uses only that entry, as any outside app would, and `pnpm run check:imports` fails on any import past it. The repository's [examples/agent/](../examples/agent/) shows an agent running the whole cycle through the kit.

## 10. What comes next

More chains on the same contracts, each one a deploy rather than a new design. Orders signed in advance, live in the app. The kit on npm. And a deeper crowd on every chain as deposits grow, which is the one thing that makes everyone's cover better at once.
