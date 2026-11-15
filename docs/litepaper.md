# Blindfill v2 lite paper

Private trading on any chain, at the speed of a tap.

14 November 2026 · Blindfill is the engine under [Confidential Trenches](https://confidential.unrealized.trade). This paper describes the v2 design and says, part by part, what runs on mainnet today. Also as a [PDF](litepaper.pdf).

Every number below carries a tag. **Measured** means a recorded run or a read on chain, linked from [performance.md](performance.md) or [proofs.md](proofs.md). **Estimate** means arithmetic on measured parts. **Open** means not yet run.

## In one paragraph

Blindfill puts a pool with no keys on every chain you trade on. Each pool holds money as private notes and pays out only against a proof made on your own device. A buy is proved before you tap and settles in one transaction from a wallet that has never been used. A sell drops the money back into the pool. NEAR Intents moves every dollar that changes chain, and a vault on NEAR with no access key is the cash home. Nobody can take, freeze or change the money: no pool has an admin, an upgrade path or a pause, and we hold no key to any of them.

| | |
|---|---|
| **111,218** compute units | to check a real proof on Solana (measured) |
| **919 to 1,201 bytes** | one private buy on Solana, under the 1,232-byte limit (measured) |
| **8.3 s** | to make a proof on an iPhone, in the background, never at the tap (measured) |
| **1.2 s** | median tap to filled for a Solana buy on a phone, 3.3 s at p95, 5 of 5 filled (measured) |
| **56** | mainnet transactions on record, each read back on two public RPCs ([proofs.md](proofs.md)) |

## 1. The problem

Every trade on a public chain ties a wallet to a history. Anyone with a block explorer can follow a known wallet from its first deposit to every coin it buys, sells and holds. For a trader that is a live feed of their positions, sizes and timing, free to anyone who wants to copy, front-run or hunt them.

The products that hide trades today fix this by asking you to trust someone. One kind splits your trades over wallets it holds the keys to. Another runs a private balance that an operator can read, freeze or hand over. A third is a mixer contract with an upgrade key, so whoever holds that key can change the rules under the money. In each case one party holds your keys, your records or the power to rewrite the contract.

Blindfill's rule is that nobody holds any of the three. The money sits in contracts with no key. Your keys and your records live only on your device, made from 12 words you save. And no contract can be changed after it is deployed, by us or by anyone.

## 2. Why v1 was not enough

v1 kept the private crowd in one place: a vault on NEAR. The coins people want sit on Solana, Base and other chains. To buy one privately, money had to leave the vault, cross to the trading chain through NEAR Intents and land in a fresh wallet before the swap could run.

That crossing is the slow part, and it is public.

- The step that fills a new wallet took **43.3 s** on chain on 1 November 2026 (measured). Since 27 October every 1Click swap runs through NEAR's private shard, which adds a shield and an unshield to each leg; runs on 19 October, before that change, took about 21 s.
- A first buy after a deposit took about **53 s** end to end (measured, the sum of the legs).
- Nothing faster leaves NEAR today. Relay, the fastest bridge we tested, served 59 chains when we read its list, and none of them was NEAR (measured). 1Click has no fast option.
- Every shortcut to a few seconds either linked the deposit to the new wallet on chain or put a money key on our server. Both break the rule.

So v1 could be fast by readying wallets ahead of time, or private, but holding both at once meant holding money in wallets outside the crowd. v2 stops crossing at the tap and puts a pool where the coins are.

## 3. The design

Six parts. The pools hold money. NEAR Intents moves money between chains. Your device holds every key. The helper only carries messages.

| Part | What it does |
|---|---|
| A pool on each trading chain | Holds that chain's money as private notes. Approves every deposit itself, keeps every past root, checks proofs, and releases money only to the wallet a proof names. No admin, no upgrade, no pause. |
| The NEAR vault | The cash home, in USDC, and NEAR's own pool. The same proof design and the same rule: no access key, no owner, no upgrade. It is also the stop that unlinks a move from one chain to another. |
| NEAR Intents | Every dollar that changes chain: deposits from any chain it reaches, moves between pools, exits to any address. |
| Your device | The 12 words and every key made from them, your notes, proofs made ahead of time, one fresh wallet per buy, and a check of every quote against two chain reads before it signs. |
| The helper | Pays network fees, sends transactions it cannot alter, reads chains, serves prices. It holds API keys and a fee key, never a key that moves your money. |
| The kit | `@blindfill/kit`, the one public entry any wallet, terminal, bot or AI agent calls. |

### How a note and a proof work

Every pool runs the same proof design as the NEAR vault: a port of Privacy Pools v1 (0xbow, Apache-2.0, audited) with its admin parts removed. There is no new circuit and no new setup ceremony, so the same proof verifies on NEAR, on Solana and on the EVM contract.

1. **A deposit writes a note.** Your device picks a secret, made from your 12 words, and the pool stores only a fingerprint of the note (its commitment) in a public tree. The amount and the fingerprint are public. Whose it is, is not.
2. **A spend proves membership without pointing.** To spend, your device proves three things at once: it knows the secret behind one of the fingerprints in the tree, that note holds at least the amount being spent, and it has not been spent before. The proof does not say which fingerprint. A spent mark (the nullifier) goes on a public list, so the same note can never pay twice, and nobody can tie the mark back to the deposit.
3. **The proof names where the money goes.** The pool, the receiving wallet, the fee cap and a deadline are bound into the proof. Change any of them and the proof fails. That is why the helper can carry a proof but can never redirect it.
4. **Change comes back as a new note.** A spend of part of a note writes the rest as a fresh note that only your device can open.

The pool approves every deposit itself, in the same call that records it. Privacy Pools v1 has an outside list keeper that approves deposits; we removed that role, so nobody outside can hold a deposit back or wave a bad one through.

### One EVM contract for every EVM chain

The Base and Robinhood Chain pools are the same contract. Another EVM chain takes the same code when it has three things, which Base and Robinhood Chain both pass (measured):

- the standard pairing check at its standard price (EIP-1108), so the proof verifies. On Robinhood Chain it costs 142,137 gas, read on two RPCs;
- EIP-7702, so a sell and its deposit back fit one transaction (without it, a sell takes two);
- a NEAR Intents route, so money can come in and leave.

### The Solana pool

The Solana pool is a port of the NEAR vault's Rust: the same field and tree code, the same scope, label and context, the same withdraw and deposit checks and the same test vectors. Checking a real proof costs 111,218 compute units (measured). Every past root is kept, so no proof goes stale and nobody can make one go stale; on Solana that costs 162,560 lamports per root (measured).

## 4. How money moves

**Deposit.** From a wallet on the same chain, one transaction into the pool. From any other chain, NEAR Intents delivers to a one-time wallet whose key is on your device, and that wallet deposits for you. 1Click quoted 17 to 49 s for these legs and delivered at a median of 2.0 times its quote (measured). Your first proof is made while the deposit travels.

**Buy.** This is the part v2 rebuilt.

1. *Before the tap.* Your device splits what you hold into standard-size chunks and makes a proof for each one. A proof names the pool, a fresh wallet W, a fee cap and a deadline, but no token. It takes 8.3 s on an iPhone, in the background (measured).
2. *At the tap.* W signs one transaction. The pool checks the proof and that W signed, marks the chunk spent and pays W, and in the same transaction W buys the token. The helper adds the fee and sends it. It cannot change a byte without breaking W's signature.
3. *After.* Your device makes the next proof from what is left. Whatever W did not spend waits in W for the sell.

One private buy on Solana is 919 to 1,201 bytes with W as a signer, under the 1,232-byte limit (measured). On Base the gas for one private buy comes to about $0.011 to $0.015 (estimate, at measured gas use and the gas price of the day).

**Sell.** W sells the token and deposits everything back into the pool under a new note, in one transaction it signs itself. No proof is needed. The money is private again the moment it lands. On Base and Robinhood Chain this runs through EIP-7702.

**Move between chains.** A move from the Solana pool to the Base pool goes pool, NEAR Intents, NEAR vault, NEAR Intents, pool. Each NEAR Intents leg is public as a pair, since anyone can read its status, so the stop in the NEAR vault is what keeps your Solana money and your Base money from being tied together. About 50 to 100 s, never at a tap (estimate).

**Out.** A withdrawal goes from any pool to any address, or through NEAR Intents to any chain it reaches: 210 tokens on 38 chains on 1Click's list when we read it on 2 November (measured).

**Out with every server off.** The exit tool (`packages/exit`) brings money home with only the 12 words and public RPCs. It reads the vault's lists from two public NEAR RPCs that must agree byte for byte, rebuilds your notes from public data, makes the proof and submits the withdrawal, with no helper in the path. A CI check refuses any address or helper import of ours inside it.

## 5. What stays private, and what shows

| An onlooker | v1 | v2 |
|---|---|---|
| Can tell which deposit is behind a buy | No (the NEAR vault's crowd) | No (that chain's pool crowd) |
| Can follow a wallet from one trade to the next | No, one wallet per position | No, one wallet per buy |
| Sees a public trail from the vault to each new wallet | Yes, on NEAR | No. The pool pays W inside the buy itself |
| Sees your total balance | No | No |
| Can tie your money on two chains together | Partly, NEAR Intents legs are public pairs | No, moves stop in the NEAR vault |
| Sees each buy's token and size | Yes, from a fresh wallet | Yes, from a fresh wallet, in standard sizes |
| Can match one position's buy and sell | Yes | Yes. The sale then goes back into the pool |
| Sees your deposit | Yes, amount and source | Yes, amount and source |

**Said plainly.** A pool hides you only as well as its crowd is large, and every pool starts empty. Standard sizes make every buy look like many others. A coin's own buy and sell can always be matched, because the swap itself is public on its chain. Timing and amount can hint at a link between a deposit and a buy, which is why wallets are readied ahead and sizes are standard.

### Who can see more than an onlooker

- **The helper** sees the transactions it sends and the network address they came from, never your notes or keys, and never which note a proof spends.
- **NEAR Intents** sees each cross-chain leg (deposits, moves, exits), as it does for every 1Click user.
- **The page host** sees each visitor's IP and which files load. It never sees a wallet, a quote or an order.
- **Nobody** sees which note a proof spends: not us, not the helper, not the pool.

The full table is in [security.md](security.md#who-sees-what).

## 6. Why nobody can take or freeze the money

| Contract | No admin | No upgrade | How anyone checks it |
|---|---|---|---|
| NEAR vault `vault.confidential.unrlzd.near` | No access key, no owner | No deploy and no key to add one: its compiled code imports none of the host calls that add a key or deploy code | Two public RPCs return `keys: []`; `view_code` matches the hash in the deploy record |
| Solana pool `EN1Wb2iWTw7ihNHTNW3SU2DkUCbw7yEEGR7ywWgWn8MF` | No admin account in the program | Upgrade authority empty, read on 14 November 2026 | `getAccountInfo` on the program data account shows no authority |
| Base `0xaa080e74ec99cf5c684548c77ca145edfcf899cf` and Robinhood Chain `0x9306359433127c4f3be426f6faeb00a3c41f66db` | 0xbow's Entrypoint, which held every admin role, removed | No owner, role, upgrade path or pause in the source | Read [contracts/pool-evm/src/](../contracts/pool-evm/src/) |

- **The proof decides where money goes.** It names the pool, the receiving wallet, the fee cap and the deadline. On Solana W must also sign, and its signature covers every account and byte.
- **The helper can only refuse.** If it stops, any other sender, or your device itself, can send the same transaction. If every server stops, the exit tool still works.
- **Keys exist only on your device.** No server holds a key that moves money. CI scans the tree and the full history for secrets on every change.
- **The money never rests inside NEAR Intents.** The DAO behind `intents.near` holds roles that can lock an account or move a balance, so money sits there for one hop at a time and rests in the vault and the pools.
- **One power we can't remove:** the vault holds USDC, and Circle can pause the token or block an account, as for every USDC holder. A payout stopped that way isn't lost. Its receipt fails and the vault books the amount back as a refund note.

### How others compare

Read from each product's public docs and contracts on 2 November 2026.

| Product | Chains | Private trades | Who can change it | When the proof is made |
|---|---|---|---|---|
| Privacy Pools v2 | Ethereum, Base, Robinhood Chain | Yes, one transaction via LI.FI | A 2-of-4 multisig with no delay; one key owns the swap contract | At the tap, 30 to 60 s by its own docs |
| Railgun | Ethereum and others | Yes, through its adapter | A proxy with an admin | At the tap, up to 30 s |
| Veil | Solana | Yes, two steps via Jupiter | A 2-of-2 multisig; can pause | At the tap |
| Privacy Cash | Solana, Base, Robinhood Chain | Through a wallet made on the client | Upgrade authority set | At the tap |
| NEAR Confidential Intents | NEAR's private shard | Yes | Seven approved validators; by its terms the operator keeps trade data and may share it | No proof; trust in the operator |
| **Blindfill v2** | NEAR, Solana, Base, Robinhood Chain | Yes, one transaction | **Nobody** | **Before the tap** |

## 7. Speed, part by part

| Step | Solana | Base | Robinhood Chain | Kind |
|---|---|---|---|---|
| Proof, made before the tap | 8.3 s median on an iPhone, off the tap path | same | same | measured |
| Proof with the prover's own threads | 1.0 s (all threads) and 1.6 s (four) on a desktop | same | same | measured |
| Check the proof on chain | 111,218 CU | 611,391 gas for a real Privacy Pools withdrawal on Ethereum | same contract | measured |
| One private buy fits one transaction | 919 to 1,201 B of 1,232 B | about $0.011 to $0.015 of gas | no L1 fee | measured / estimate |
| Ready-wallet buy, tap to filled | 1.2 s median, 3.3 s p95 (phone) | 0.9 s median, 1.3 s p95 | 1.9 s median, 4.0 s p95 | measured |
| v1 crossing to a fresh wallet | 43.3 s | | | measured |

The v2 buy adds the pool's checks to the same transaction a ready-wallet buy already sends, so it lands in about the same time. Every run behind these numbers is linked from [performance.md](performance.md).

## 8. Live today

Blindfill is designed for any chain NEAR Intents reaches, any asset with a pool on chain, and any app. Because of the hackathon's time, this build integrates four chains: Solana, Base, Robinhood Chain and NEAR.

| Piece | Mainnet address |
|---|---|
| NEAR vault | `vault.confidential.unrlzd.near` |
| Solana pool | `EN1Wb2iWTw7ihNHTNW3SU2DkUCbw7yEEGR7ywWgWn8MF` |
| Base pool | `0xaa080e74ec99cf5c684548c77ca145edfcf899cf` |
| Robinhood Chain pool | `0x9306359433127c4f3be426f6faeb00a3c41f66db` |

- The deploy records, with build hashes and transactions, are in [contracts/vault/deployments/](../contracts/vault/deployments/), [contracts/pool-solana/deployments/](../contracts/pool-solana/deployments/) and [contracts/pool-evm/deployments/](../contracts/pool-evm/deployments/).
- The vault read on 14 November 2026 on two public RPCs: no access key, and the USDC it holds equals what `totals()` says it owes.
- 56 mainnet transactions (14 on NEAR, 28 on Solana, 7 on Base, 7 on Robinhood Chain) are listed in [proofs.md](proofs.md), each read back on two public RPCs by the money gate in CI.
- The research behind this design, 33 measured write-ups and 3 vault reviews, is in [research/](../research/).

Still to come in the app: orders signed in advance show Coming soon in this build, and the kit installs from this repository until it is published to npm.

## 9. For builders

An app reaches all of this through one import, `@blindfill/kit`: deposit, prove, ready the wallets, trade, withdraw, verify. Confidential Trenches uses only that entry, as any outside app would, and `pnpm run check:imports` fails the build on any import past it. The repository's [examples/agent/](../examples/agent/) shows an agent running the whole cycle through the kit.

What carries over from v1 and what is new:

| Area | In v2 |
|---|---|
| NEAR vault contract | Kept, unchanged. Its Rust also seeds the Solana pool. |
| Proof kit and setup files | Kept. The same proof verifies on NEAR, Solana and the EVM contract. |
| 12 words, keys, notes, backup, sign-in, signing page | Kept. Adds the proof queue and one fresh wallet per buy. |
| Kit: quote checks, buy and sell code, deposit calls | Kept. The buy gains the pool step in front; the sell gains the deposit at the end. |
| Helper: relayer, watches, RPC proxy, market data | Kept. Adds senders for Solana and EVM pool transactions. |
| Moving cash from the vault to a one-use account to a wallet | Retired from the buy path; stays for moves between chains. |
| New | The Solana pool program with its pump.fun and PumpSwap steps; one EVM pool contract with its buy step and sell helper for Base and Robinhood Chain. Each further EVM chain is a deploy, an exchange adapter if its main exchange is not Uniswap, and a live check. |

## 10. What is still open

- **Raydium and Meteora routes on Solana** (open). Private Solana buys run through the pump.fun curve and PumpSwap today.
- **A faster proof on the phone** (open). Today's phone prover runs on one thread; the desktop numbers above show what threads give.
- **A review of the cross-chain flow** (open). Pillow Auditors reviewed the NEAR vault, the EVM pool and the Solana pool at commit `46b16ca4` on 7 November 2026 and found 0 Critical, 0 High, 0 Medium, 5 Low and 8 Info. All 5 Lows have fixes on main ([the report and each fix](../research/audits/2026-11-07-pillow/)). The kit, the device checks, the helper, the deployed exchange adapters and the sell delegate were outside that review and are next.
- **The signing page is code you load from a server.** Builds that come out byte for byte the same, a published hash for every file and an outside check narrow that gap; they don't close it. The exit tool needs none of that page.
- **Thin crowds at the start.** Each new chain's pool starts empty and gets better for everyone as deposits grow.

## 11. What comes next

- **More chains on the same contracts.** Each EVM chain with EIP-1108, EIP-7702 and a NEAR Intents route is a deploy, not a new design.
- **Orders signed in advance, live in the app.** A stop and a take-profit signed right after a buy, held by the order sender as bytes, filling at your price or better into your own wallet.
- **The kit on npm,** so any app installs it in one line.
- **A hidden bag.** The bought token kept inside a per-token pool instead of W. It costs about 0.008 SOL per new token on Solana, and its crowd is only that token's holders.
- **One crowd across every chain.** Notes that can spend on any chain. It needs a new circuit, a new setup ceremony and a way to carry roots between chains, which is the v3 project.

The deeper the crowd on every chain, the better everyone's cover gets, all at once.
