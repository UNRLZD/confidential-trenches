# G1 proof 6: the Plan 1 money loop (real money)

**Pass line:** one paste by the owner moves about $8 of the hackathon's NEAR through every Plan 1 money leg. Every leg
arrives, its time from request to arrival is recorded, and every transaction reads back OK on two RPCs per chain.
Whatever is left over is listed and can be recovered from the test seed.

**Status:** dry run only. The live run is the owner's paste and has not been run yet.

## The loop

| # | Leg | Path | Copies |
|---|---|---|---|
| 1 | near-to-sol | the funder's native NEAR -> 1Click (`ORIGIN_CHAIN`) -> SOL on a fresh Solana wallet | P1 `deposit`, live run `p1-private-balance/runs/2026-10-19T22-53-44-913Z-live.json` (22 s quoted, 31.9 s to visible) |
| 2 | buy | SOL -> BONK through Jupiter; the fresh wallet signs alone | P4 Solana "self" mode (`p4-speed/solana/run.mjs`, RESULT.md: fills in 0.43-1.59 s) |
| 3 | sell | BONK -> SOL through Jupiter | the same |
| 4 | hop | Relay: SOL on Solana -> ETH on a fresh Base wallet | new. `relay-fill/RESULT.md` sampled public fills only: Solana -> Base p50 2 s, p95 3 s |
| 5 | base-to-near | the Base wallet's ETH -> 1Click (`ORIGIN_CHAIN`) -> wNEAR under the return id R_{evm,i} on intents.near (`recipientType INTENTS`; HKDF `onetime/return/evm/i`, `keys.mjs oneTimeReturn`) | P1's `in-sol` ORIGIN_CHAIN shape, from Base instead of Solana |

**Wallets:** all three come from one test seed (12 words, BIP-39). The seed lives only in the macOS Keychain, as item
`ct-g1-seed`. `run.mjs --live` makes it on the first live run. A dry run before then uses a throwaway seed in memory.

| Chain | Path | Opens in |
|---|---|---|
| Solana | `m/44'/501'/0'/0'` | Phantom |
| Base | `m/44'/60'/0'/0/0` | MetaMask |
| NEAR | `m/44'/397'/0'` | the intents.near id is the hex of its public key |

`keys.test.mjs` pins the derivation:
- SLIP-10 vector 1;
- the BIP-39 zero-entropy vector, cross-checked against viem's `mnemonicToAccount` for Base.

## What the script checks before it signs

- **1Click quotes:**
  - the ed25519 signature under the pinned manager key. This is the SDK 0.1.26 key, and `oneclick.mjs` ports the SDK's hash;
  - all 17 request fields the signature covers equal the exact body sent, `dry` included, and a field we did not send
    comes back empty (no `customRecipientMsg`, `referral` or virtual-chain recipient rides along);
  - a live request takes only an answer signed as live (`dry` exactly false) that names a `depositAddress`. A dry
    answer's signed bytes leave the deposit address out, so a proxy that turned our request dry could choose it. The
    Verifier's repro (`dryflip.mjs`) passes `checkQuote` at a353c93 and is refused now ("quote dry=true answers our
    live request"). The script never hands on an address the signature does not cover;
  - a fresh timestamp;
  - loss under 3% (leg 1) or 4% (leg 5);
  - `amountIn` no more than asked;
  - leg 1's NEAR amount is refused above 2.5 NEAR (`NEAR_MAX_LEG1`) before any quote and before the key file is read;
  - every price from `/v0/tokens` is checked for age (at most 10 minutes, at most 60 s ahead) at the moment of use,
    and the list is fetched again when it fails (`freshPrices`).

  `oneclick.test.mjs` has one refusal test per rule. On two real quotes (dry and non-dry) the signature verifies, and a
  changed recipient fails it.
- **Jupiter builds (`solana.mjs`):**
  - the quote echoes the mints and amount;
  - min out is at least the slippage floor;
  - the price impact is under 2%;
  - the wallet is the fee payer and the only signer;
  - every tx is simulated before it is sent.
  - The swap simulation runs on both RPCs and uses the lesser landing delta (the conservative choice), while err, the fee and the hop debit must be exactly equal on both.
  - The rent in each token account a swap leaves open in the wallet's name (listed in the run record with its address, mint and lamports) stays the owner's and comes back by closing the account.
- **Relay (`relay.mjs`):**
  - the quote matches our request: chains, currencies, amount, recipient, sender;
  - there is exactly one Solana transaction;
  - only three programs are allowed (compute budget, system transfer from us, Relay's depository);
  - the wallet is the fee payer and the only signer;
  - the order's minimum ETH out is at least our own floor: 95% of the SOL in, priced from 1Click's public price list
    (`/v0/tokens`, refused when older than 10 minutes), never from the Relay quote it bounds;
  - C7: the solver chain is Base, the solver is the pinned `0xf70da978...3dbef`, and the order signature recovers to it;
  - the simulated debit equals the amount plus the fee, to the lamport;
  - the compute-budget price is at most `CU_PRICE_MAX` (1,000,000 micro-lamports, the Jupiter cap) and the limit at
    most 1,400,000;
  - in a dry run the own-wallet quote's error is passed over only when it is Relay's `INSUFFICIENT_FUNDS` answer (HTTP
    400 from `/quote/v2`); any other error stops the run.
- **Read-back on two RPCs per chain:**
  - Solana: api.mainnet-beta and publicnode;
  - Base: mainnet.base.org and publicnode;
  - NEAR: FastNEAR and dRPC. A rate limit (HTTP 429, JSON-RPC -429) is retried after 0.5, 1 and 2 s, then read
    from `rpc.mainnet.near.org` (`near.mjs`); any other error stops the read.

  Every record names the provider that answered, not the one asked. A fallback answer is one source, and two answers
  from one provider never count as two (`near.mjs twoSources`). An arrival counts only when two providers show it.

  A leg is ok only when it arrived and every tx it sent or caused is read back ok from two distinct providers
  (`legok.mjs legOk`): the origin tx, every destination tx, and on leg 5 every NEAR tx 1Click lists. A NEAR tx is
  asked with the sender we know, then `intents.near`. FastNEAR's tx index is asked only when both RPCs answer
  "unknown", and only as a hint: ok comes from the two RPC answers alone. On Base, no receipt within 60 s stops leg 5
  before the deposit is submitted.

  The destination tx read-backs prove only that a successful tx with that hash exists; only the balance arrival, read
  on two RPCs, ties the leg to our own wallet.

## The terminal gate stops accidents only

`--live` runs only when stdin and stdout are both a terminal (`run.mjs` :84-86), and the operator types back leg 1's
NEAR amount, or on `--from base-to-near` the Base balance, before any key is read (`confirmLeg1`, `confirmResume`,
:388-407). This stops an accident: an agent shell, a pipe or a script started by mistake has no terminal and stops
with rc 2, nothing read and nothing sent. It is not a security boundary. Anything that can run a command as the
owner's user can open a pseudo-terminal (`script(1)`, `expect`) and type the amount back, so it gives no protection
against code already running on the Mac. What keeps the funder's money safe from that is the funder key file and the
Keychain, not this gate.

## Stop rule

The first failed leg stops the loop. The script then prints:
- every wallet's balance, read on both RPCs, and the status of the last 1Click deposit address;
- the leg's way back.

A leg that did not arrive stops with "did not arrive". A leg that arrived but is not confirmed on two RPCs stops with
"arrived but not confirmed on two RPCs" and the reasons (`legok.mjs notOkText`). Neither counts as ok.

`--from <leg>` resumes. The proof is `--dry --fail-at <leg>` for each of the five legs (below).

## Dry run

`node run.mjs --dry`, 2026-10-26 03:51Z, at 2cc6995 (the code; this section is the next commit). It used a throwaway
seed, real quotes, and real simulations, and sent nothing. rc 0. The record is `runs/2026-10-26T03-51-28-767Z-dry.json`,
gitignored.

Prices from `/v0/tokens`: NEAR $4.45, SOL $100.08, ETH $2300.81. Loop size: $8.

| Leg | Quote checked | Out (min) | Fee | ETA |
|---|---|---|---|---|
| near-to-sol | 1Click, dry and deposit quotes: the signature verifies, all 17 signed request fields equal what was sent (dry true, then dry false), recipient = this run's Solana wallet | 0.07950 SOL (0.07871) | $0.0437 (0.55%) | 17 s |
| buy | Jupiter: own-wallet build checks; stand-in simulation on both RPCs err null, 47,137 CU | 2,520,964 BONK (2,495,755) | - | - |
| sell | Jupiter: the same; the simulated SOL lands (its own SOL change + the fee + its own token accounts' change); 39,300 CU | 0.07388 SOL (0.07314) | - | - |
| hop | Relay C1-C7 and the CU caps; the table read on both RPCs; the order minimum is +2.32% over our floor; stand-in simulation on both RPCs err null, 13,251 CU | 0.003130 ETH (0.003067) | $0.0376 | 2 s |
| base-to-near | 1Click, dry and deposit quotes: as leg 1, recipient = this run's R_{evm,0} | 1.5852 wNEAR (1.5693) | $0.0029, plus 21,000 gas on Base | 35 s |

The funder's balance was read as 4.1007 / 4.1007 NEAR from free.rpc.fastnear.com and near.drpc.org, the two providers
that answered.

**Stand-ins:** the buy, sell and hop simulations run on other people's funded wallets, because the fresh wallet is
empty in a dry run. A stand-in's balance can move between our read and the simulation. At 22:56Z this happened:
Jupiter returned 6024 when the BONK stand-in dropped from 8,525,168,250 to 8,415,168,250. `solana.mjs standInSim`
now:
- simulates at most 90% of what the stand-in holds;
- tries a fresh stand-in up to 3 times;
- records every try.

`standin.test.mjs` fails at e19f85e and passes after the fix.

**Stop rule:** `node run.mjs --dry --fail-at <leg>`, once for near-to-sol, buy and base-to-near and ten times each for
sell and hop, 2026-10-26 03:51-03:57Z, at 2cc6995. All 23 runs exit rc 1 at their own leg with "forced failure". Each
prints every wallet on two RPCs and that leg's way back:

| --fail-at | Way back printed |
|---|---|
| near-to-sol | NEAR is still on the funder, or 1Click refunds it to the funder (ORIGIN_CHAIN). If it arrived as SOL, `--from buy`. |
| buy | SOL is on the fresh Solana wallet: `--from buy`, or Phantom (m/44'/501'/0'/0'). |
| sell | The memecoin or SOL is on the fresh Solana wallet: `--from sell`, or sell in Phantom. |
| hop | SOL is on the fresh Solana wallet, or Relay refunds a failed fill to it. If ETH reached Base, `--from base-to-near`. |
| base-to-near | ETH is on the fresh Base wallet (MetaMask, m/44'/60'/0'/0/0), or 1Click refunds it there. wNEAR that arrived sits under R_{evm,i}, moved only by its HKDF key from the same 12 words. |

**No secret in the output:** checked over the dry output, the five stop outputs and every `runs/*.json`:
- gitleaks rc 0;
- no run of 12 words;
- no `privateKey`, `secretKey`, `mnemonic` or `seed` field;
- no 64-byte base58 key and no `ed25519:` secret.

## Live run

(the owner's paste: `sh live.sh`; results go here)

Two live runs (`runs/2026-10-26T07-25-51-056Z-live.json`, `runs/2026-10-26T09-53-43-559Z-live.json`, kept on the
team's Mac, not in git) carried legs 1-4 to arrival and stopped at base-to-near: the Base node refused the send before
broadcast ("insufficient funds for gas * price + value: have 6598043834936277 want 6598044273500489"). Nothing was
sent. Both hop arrivals sit on the Base wallet (6,598,043,834,936,277 wei at 19:49Z on both Base RPCs).

### The Base fee fix (card g1-money-fix)

**Cause.** The old reserve was 21,000 x maxFee. Base is an OP Stack chain: the sender also pays an L1 data fee from its
balance (ethereum-optimism/specs @ 21d1ff54 `specs/protocol/exec-engine.md` "L1-Cost fees"), and the pool refuses a tx
whose balance does not cover gas_limit x maxFee + L1 data fee + operator fee at gas_limit (`isthmus/exec-engine.md`
"EVM Fee Semantics" 1, "Transaction Pool Changes"). The refused gap (want - value - 21,000 x 13,000,000) is 438,564,212
wei in run 2 and 459,184,770 in run 1. `eth_call getL1Fee` on the GasPriceOracle `0x42..0F` returns exactly those at
blocks 53109598-53109603 and 53105160-53105164 (`fixtures/base-l1-fee-refusals-2026-10-26.json`).

**Predeploy read** (2026-10-26 19:30Z, `eth_call`, mainnet.base.org and base-rpc.publicnode.com): version 1.6.0;
isFjord, isIsthmus, isJovian true; getOperatorFee(21000) = 0, L1Block operatorFeeScalar and operatorFeeConstant 0;
getL1FeeUpperBound(48) = getL1Fee(the refused tx) = 912,535,738 / 876,074,041 at that moment (a small tx pays the
100-byte floor, `fjord/exec-engine.md`).

**Fix.** `relay.mjs baseFeeReserve`: cost = gasLimit x maxFee + `getL1FeeUpperBound(size of the unsigned tx padded to
its largest nonce, value and address)` + `getOperatorFee(gasLimit)`, each answer one 32-byte word of at most 1e14 wei;
reserve = cost + the L1 fee once more (margin for the L1 price moving before the send). `baseSendGas` refuses value +
cost > have. `run.mjs` base-to-near sends have - reserve (live) and quotes carry - reserve (dry). `--live --from
base-to-near` does not ask for leg 1's NEAR: it loads the Keychain seed (never makes one), reads the Base balance equal
on both RPCs, asks for it typed back, and the leg refuses if the balance changed. `--dry --from base-to-near` carries
the Base balance. The other legs' keeps were checked against the worst case under the code's caps (`keeps.test.mjs`):
the buy keep went from 4,000,000 to 4,200,000 lamports, because after a max-fee buy the sell needs 2,093,440 before its
proceeds land and 1,906,560 was left; hop, buy and the NEAR 0.05 reserve were covered.

**Dry runs** at 038f433 (19:49Z): `node run.mjs --dry --from base-to-near` rc 0 (amount 6,597,769,424,877,661 =
balance - reserve 274,410,058,616 = L2 273,000,000,000 + L1 705,029,308 + operator 0 + margin 705,029,308);
`node run.mjs --dry` rc 0, all five legs; `sh live.sh --dry --from base-to-near` from a clean checkout (no
node_modules) rc 0.
