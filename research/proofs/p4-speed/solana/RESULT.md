# P4 speed, Solana part: result

**Pass line:** a buy and a sell of a fresh pump.fun token (on the curve or just graduated), about $1.50 per trade,
signed with keys we hold. Click → filled is measured 20 times per mode, with buy and sell reported separately.
**Pass: p95 ≤ 5 s.** Two modes are built and measured:

- **float**: the app float pays the SOL, the fees and the rent.
- **self**: the ghost holds its own SOL and signs alone.

**Status 2026-10-20 00:36Z (local 07:36): PASS on mainnet. p95 ≤ 5 s on every mode and side, n ≥ 20 each (3 live
records, 85 trades landed, 84 filled, every fill in 0.43–1.59 s; the worst p95 is 1.58 s, float buy).** One buy failed
on chain and two runs could not be built; all three were traced and fixed (see "Live results"). Every landed tx was
re-read finalized on a second provider. Dry (21:55Z) passed all four shapes before that.

The hackathon is kept fully apart from UNRLZD: no UNRLZD key, wallet or file is used. The float is funded only by P1's
Solana out-leg or by the owner.

## Live results (mainnet, run by AI under plan §11.11, 2026-10-19 23:32Z – 10-20 00:10Z)

**All three records together** (p50/p95 nearest rank; a failed trade counts as infinitely slow):

| Mode, side | Filled / tried | p50 (ms) | p95 (ms) | Max fill (ms) | Pass (p95 ≤ 5 s) |
|---|---|---|---|---|---|
| float buy | 22 / 22 | 856 | 1578 | 1594 | yes |
| float sell | 22 / 22 | 759 | 1197 | 1252 | yes |
| self buy | 20 / 21 | 911 | 1148 | 1148 | yes |
| self sell | 20 / 20 | 773 | 937 | 959 | yes |

Two more runs could not be built, so nothing was sent (#5 and #6 below). In the product the tx is built at quote time,
before the click, so a build failure shows as "no quote" rather than as a slow fill.

### Run 3: the n ≥ 20 rerun (2026-10-20 00:02–00:10Z)

Record `results/live-2026-10-20T00-02-08-517Z.json` (log `live-15p-1792454527.log`), `--runs 15 --usd 1 --pause-ms
10000`, 30 runs, 58 trades, 58 filled. 22 of the 30 runs reused a token (none unused passed the filter at this hour), each
with a fresh ghost. Routes: Pump.fun 11, Pump.fun AMM 18.

| Mode, side | Filled / tried | p50 (ms) | p95 (ms) | Min–max (ms) |
|---|---|---|---|---|
| float buy | 14 / 14 | 807 | 1061 | 590–1061 |
| float sell | 14 / 14 | 736 | 1252 | 434–1252 |
| self buy | 15 / 15 | 911 | 1148 | 693–1148 |
| self sell | 15 / 15 | 774 | 937 | 560–937 |

- **Check:** `recheck.mjs` on publicnode, finalized: 58 ok, 0 failed.
- Steps: Jupiter build p50 71 ms (p95 209); send → `confirmed` p50 538 ms (p95 718); landing 2 slots after the send slot
  (p95 4). Helius Sender answered `http 429` on 23 of 58 sends; Jito or the RPC landed each of them.
- **Fail 3 (#6, float buy, nothing sent):** Jupiter `400 No routes found` for `8kZp6ZxM…pump` at `maxAccounts=40`. The same
  build at 64 returns a 3-hop route (Whirlpool + GoonFi V2 + Pump.fun). **Fix:** when the cap finds no route, the build
  retries once uncapped (`quote.uncapped` in the record). Dry run on the same token: all 4 shapes built uncapped at
  910–1,200 bytes (limit 1,232), and both buys simulate OK.
- **Rent leak found by the cost check:** the run cost 0.02 SOL more than fees plus price loss. On a PumpSwap AMM route
  the program opens a per-user volume account (0.001346 SOL, PDA `user_volume_accumulator` under
  `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA`; read on chain for runs #16 and #17). The script only closed the
  bonding-curve program's one, and the sweep only looked there. **Fix:** the sweep closes the account under both
  programs. PumpSwap has the same `close_user_volume_accumulator` (pump-public-docs `idl/pump_amm.json` @8cda1fa3). The
  AMM `sell` does not list the account in its IDL, so the close stays out of the sell tx (a sell must never fail on
  cleanup). Sweep: 21 txs, all finalized with no error, +0.027552 SOL back to the float.
- **Ghost `Bj3vzUfX…` closed:** its token account held withheld Token-2022 transfer fees (`Custom 35` =
  `AccountHasWithheldTransferFees`). **Fix:** the sweep first harvests withheld fees to the mint (permissionless), then
  closes. Tx `37HPf81d…`, finalized, +0.002931 SOL.
- **For the product:** a ghost's teardown must close volume accounts on both pump programs and harvest withheld fees
  before it closes a Token-2022 account. Otherwise every AMM-routed ghost strands 0.001346 SOL.

### Runs 1 and 2 (2026-10-19 23:32–23:49Z)

Records: `results/live-2026-10-19T23-32-14-314Z.json` (stopped: the keyless public RPC answered 429 storms) and
`results/live-2026-10-19T23-33-50-203Z.json` (rerun with `--pause-ms 10000`; log `live-20p-1792452828.log`).
About $1 a trade, a fresh ghost each run, send = Helius Sender + Jito + RPC at once, all keyless.

| Mode, side | Filled / tried | Click → filled (ms), every fill | Max |
|---|---|---|---|
| float buy | 8 / 8 | 712, 784, 985, 1007, 1098, 1099, 1578, 1594 | 1594 |
| float sell | 8 / 8 | 584, 593, 715, 773, 876, 917, 953, 1197 | 1197 |
| self buy | 5 / 6 | 632, 728, 798, 947, 981; one failed on chain | 981 |
| self sell | 5 / 5 | 581, 587, 728, 818, 959 | 959 |

- **Check:** all 27 landed txs re-read finalized on a second provider (`recheck.mjs`, publicnode): 26 with no error, the
  failed buy with the recorded error. 27 ok, 0 failed.
- Steps (p50): Jupiter `/swap/v2/build` 58–130 ms (one 300 ms), send → `confirmed` 0.42–0.62 s, landing 2 slots after
  the send slot (1–5).
- Helius Sender's keyless limit (1 a second) answered `http 429` on 8 of 27 sends; Jito or the RPC landed each of them.
  That is why the send goes to all three.
- **Fail 1 (#5, self):** `encoding overruns Uint8Array`: the tx was over 1,232 bytes, after the ghost was funded. Jupiter
  routes may use 64 accounts by default (build.md `maxAccounts`, 1–64), and our ATA, close, tip and volume-account
  instructions ride on top. **Fix:** `maxAccounts=40` on every build (`--max-accounts`), and a self-mode run that fails
  after the pre-fund drains the ghost at once (the 0.0175 SOL waited for the sweep this time).
- **Fail 2 (#11, self buy):** on-chain `InstructionError [9, Custom 1]` on a 4-hop route (Whirlpool + Whirlpool +
  GoonFi V2 + Pump.fun AMM) for a $1 buy. The same `maxAccounts` cap keeps routes short (the uncapped retry from Fail 3 runs only when the cap finds no route).
- **Token filter ran dry:** after ~12 runs no unused token passed (2 min–3 h old, ≥ $3k liquidity, ≥ 10 holders, both
  authorities off) at 23:4xZ. **Fix:** reuse a passing token when no unused one is left; the run still gets a fresh ghost
  (key per token *and* run), so each first buy still creates the ghost's token account.
- Runs 1 and 2 alone left p95 over 20 per mode unproven; run 3 closed that.

**Cost (all three runs).** P1 delivered 0.102405 SOL to the float. After the three runs and the sweeps it holds
0.084897 SOL (finalized, read on publicnode and api.mainnet-beta 2026-10-20 00:33Z). Net 0.017508 SOL (~$1.84 at
$104.88) for 85 landed trades, the failed ones, the 4-run stopped attempt and every sweep. Per trade the chain fees were
~31,500 lamports (base 5,000 + priority ~11,500 + tips 15,000, ~$0.003). The rest is the round trip's pool fees and price
moves, ~2% of the $1 traded. Still on chain: the float's two dust token accounts (1 micro-USDC and 1 unit of a Token-2022
token, ~0.004 SOL of rent). They are left as is, because closing them means burning the dust first.

## Run it (owner)

```sh
# 1. Fund the float GLWAiWU726MQPCFGwZjFFGT2qADL39Wj2LJh6sSyBt6u with 0.05–0.1 SOL: either P1's out-to-Solana leg
#    (~0.076 SOL, --to-solana GLWAiWU726MQPCFGwZjFFGT2qADL39Wj2LJh6sSyBt6u) or the owner sends it.
#    The script refuses to start below ~0.032 SOL; the expected spend is ~0.03 SOL, see "Dry results".
# 2. The live run, one paste (20 runs per mode, float and self interleaved, 80 trades, ~10 min):
cd ~/Downloads/confidential-trenches/proofs/p4-speed/solana && npm ci --silent && node run.mjs --live
#    API keys are read only from ~/.confidential-trenches/env (chmod 600; the script refuses any other mode).
#    HELIUS_API_KEY switches RPC and WS to Helius and lifts Sender's 1 rps keyless limit. JUPITER_API_KEY lifts
#    Jupiter's 0.5 RPS keyless limit. Both are empty there today, so every path runs keyless.
# 3. Return everything left (ghost token accounts, volume accumulators, SOL) to any address:
node run.mjs --sweep <ADDR>          # plan + simulate only
node run.mjs --sweep <ADDR> --live   # do it
```

Other modes:

- `node run.mjs` (the same as `--dry`): picks a fresh token, builds the four real txs with our keys, simulates them,
  and prints:
  - the per-instruction shape
  - CU used
  - fees
  - the expected output
  - lamport deltas
  - the pump fee events
  - the build, assemble and sign times

  It writes `results/dry-*.json`. Nothing is signed by a real key (signing is timed on a throwaway key) and nothing is
  sent.
- `node run.mjs --live --rehearse --runs 2`: the live loop with every tx simulated instead of sent. Use it after funding
  to check that the loop passes.
- Flags:
  - `--mode float|self|both`
  - `--runs N`
  - `--usd 1.5` or `--sol X`
  - `--mint M` (pin one token)
  - `--slippage-bps 1000`
  - `--send all|sender|jito|rpc`
  - `--cu-price µL`
- API keys come only from `~/.confidential-trenches/env` (`KEY=value` lines, chmod 600, never printed):
  - `HELIUS_API_KEY`
  - `JUPITER_API_KEY`: sent as the `x-api-key` header [J8]. Pacing follows Jupiter's `x-ratelimit-remaining` /
    `x-ratelimit-reset` headers when they come back [J3], so the run uses whatever the key's tier allows (Free 1 RPS,
    Developer 10 RPS, ...). Without the headers it falls back to a fixed gap: 2.1 s keyless, 1.1 s with a key.
  - Tested with a dummy key: Jupiter answered 401, which shows the header is sent, and the value never appeared in
    the output. A 644 env file is refused.
- Process env (optional, not keys): `SOLANA_RPC_URL`, `SOLANA_WS_URL`.
- Wallet keys: `~/.confidential-trenches/keys/p4-sol-float.json` and `p4-sol-ghost-<mint>.json`, one ghost per token
  (dir 0700, files 0600). They moved there unchanged from the repo's `.keys/`, so the float address is the same. The
  script never prints a key. API key values are scrubbed from all console output and saved JSON.

## "Filled"

- **Buy:** the tx reaches `confirmed`, **and** the ghost's token-account balance is above its pre-trade value in a
  read at `confirmed`.
- **Sell (everything):** the tx reaches `confirmed`, **and** the ghost's token account reads as closed at `confirmed`.
- **The clock starts at the click**: just before the Jupiter quote+build call. It stops when "filled" is true.
- **What is not timed:**
  - Waiting for our own Jupiter rate limiter: keyless is 0.5 RPS per IP, the limiter runs before the click, and in
    production each user calls from their own IP or with a key.
  - Picking a token.
  - In self mode, the float → ghost pre-funding and the ghost → float drain. They stand in for the NEAR Intents
    withdrawal, which happens before the click. Their send → confirmed times are still recorded as `plainTransferConfirm`.
- **How the result is scored:**
  - p50/p95 use the nearest rank.
  - A failed or timed-out trade counts as infinite.
  - "pass" needs ≥ 90% of runs present and p95 ≤ 5000 ms.
  - A failed buy skips its sell.

## Venue path

- **Path:** Jupiter Swap API V2 `GET https://api.jup.ag/swap/v2/build`, keyless.
- **What /build returns:** a quote plus raw instructions in one HTTP call, plus the blockhash and the ALTs. The tx is
  assembled locally as v0.
- **Why /build and not /order:**
  - /build routes through Metis only and charges no Jupiter fee [J1].
  - `/order` would charge 50 bps on tokens under 24 h old [J4], and setting `payer` there restricts routing to Metis
    anyway [J4].
- **Routes seen in dry, on Jupiter's routing:**
  - Curve tokens route `Pump.fun`: `buy_exact_quote_in` / `sell` on `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`.
  - Graduated tokens routed `Pump.fun Amm` for the buy and `Meteora DLMM+Meteora DLMM` for the sell.
  - Pump.fun and Pump.fun AMM are instant-routed. A curve that does not graduate inside the grace period is removed
    from routing [J5]. Live check: a curve token created 2026-04-19 returned `No routes found`.
- **Token pick:**
  - Candidates come from `/tokens/v2/recent` + `/tokens/v2/toptraded/5m` [J7].
  - Filters:
    - launchpad `pump.fun`, not used before
    - liquidity ≥ $3k
    - ≥ 10 holders
    - mint and freeze authority off
    - age 2 min to 3 h
  - The candidates are sorted by 5-minute buys.
  - The token program is read from chain. New pump coins are Token-2022.

## Tx shapes (instruction order as built; printed by every `--dry`)

**Float mode, buy.** One signer: the float, which is the fee payer.

- Jupiter params: `taker=float`, `destinationTokenAccount=ghostTokenATA`.
- Instructions:

```
0 SetComputeUnitLimit   1 SetComputeUnitPrice (Jupiter's veryHigh = 75th pct estimate, capped 1,000,000 µL)
2 ATA CreateIdempotent [payer float, ghostTokenATA, owner ghost, mint, Token-2022]  <- ours: /build doesn't create it
3 ATA CreateIdempotent float wSOL ATA   4 System Transfer float→wSOL   5 SyncNative      (Jupiter setup)
6 ATA CreateIdempotent floatTokenATA                                                    (Jupiter setup)
7 Jupiter swap (30 accounts; pump user = float)
8 CloseAccount float wSOL → float                                                       (Jupiter cleanup)
9 CloseAccount floatTokenATA → float          <- ours: Jupiter creates the float's own token ATA and leaves it empty
10 Transfer float → Helius tip (5,000)   11 Transfer float → Jito tip (10,000)
```

**Float mode, sell (everything).** Two signers. The **float is the fee payer**. The **ghost** signs as the token owner.

- Jupiter params: `taker=ghost`, `payer=float`, `nativeDestinationAccount=float`.
- Instructions:

```
0 SetComputeUnitLimit   1 SetComputeUnitPrice
2 ATA CreateIdempotent [payer float, ghost wSOL ATA, owner ghost]                       (Jupiter setup)
3 Jupiter swap (33 accounts; pump user = ghost; SOL out to the float)
4 CloseAccount ghost wSOL → float             <- Jupiter's cleanup, destination rewritten ghost → float
5 CloseAccount ghostTokenATA → float          <- ours (rent back to the float that paid it)
6 pump close_user_volume_accumulator [ghost, ghost uva, event_authority, pump]  <- ours, only on route "Pump.fun"
7 Transfer ghost → float 1,346,200            <- ours: the uva rent the float paid when the sell created it
8 Transfer float → Helius tip   9 Transfer float → Jito tip
```

- **End state:** the ghost holds 0 lamports and has no accounts.
- **Simulated proof:** PUMPTEST full sell, 21:12Z. The ghost's uva was created and closed in the same tx and the
  ghost's net change was 0.

**Self mode, buy.** One signer: the ghost, which is the fee payer.

- Jupiter params: `taker=ghost`.
- Instructions:

```
0,1 compute budget   2 ATA CreateIdempotent ghost wSOL   3 Transfer ghost→wSOL   4 SyncNative
5 ATA CreateIdempotent ghostTokenATA (rent from the ghost)   6 Jupiter swap (30 accounts)
7 CloseAccount ghost wSOL → ghost   8,9 tips from the ghost
```

**Self mode, sell (everything).** One signer: the ghost.

- Instructions:

```
0,1 compute budget   2 ATA CreateIdempotent ghost wSOL   3 Jupiter swap   4 CloseAccount ghost wSOL → ghost
5 CloseAccount ghostTokenATA → ghost   6 pump close_user_volume_accumulator (route "Pump.fun" only)   7,8 tips
```

- **End state:** the SOL and every rent come back to the ghost.

**Rent and wSOL.** Live `getMinimumBalanceForRentExemption`:

| Account | Size | Rent (lamports) | Who pays | What happens to it |
|---|---|---|---|---|
| ghost token ATA (Token-2022) | 170 bytes | 1,513,840 | the payer | closed on the full sell, rent back to the payer |
| temporary wSOL accounts | | | | open and close inside the same tx; net 0 |
| float's own token ATA (float buy) | | | | Jupiter creates it; we close it in the same tx |

- **Pump volume accumulator (uva):**
  - PDA `["user_volume_accumulator", user]`, 137 bytes, rent 1,346,200 lamports.
  - It is created on a user's first buy or sell [P1].
  - Float mode:
    - The float's uva is created once and kept. `--sweep` closes it.
    - The ghost's uva is created by the sell and closed in the same tx.
  - Self mode: the ghost's uva is created by the buy and closed by the sell.
  - Closing a uva **with recorded volume** also simulates OK: PIKAJEW stand-in GnHVe…, 21:31Z, uva −1,346,200.

**Slippage and priority.**

- `slippageBps=1000` (10%). Fresh pump tokens move several % in seconds (see risks). The /build default is 50 [J1].
- **CU price:** Jupiter's `computeUnitPricePercentile=veryHigh`, which is the 75th percentile [J1]. It is decoded
  from the response and capped at 1,000,000 µL/CU [J2]. Seen: 37,838–87,497 µL/CU.
- **CU limit:** /build returns no CU limit [J2], and a simulation on the click path costs an RPC round trip. The limit
  is therefore fixed by route:

| Route | CU used in dry | Limit set |
|---|---|---|
| `Pump.fun`, buy | 105–109k | 200k |
| `Pump.fun`, sell | 76–90k | 150k |
| any other route (graduated: 2-hop DLMM sell) | 359–362k | 600k |

## Dry results

All txs were built with our real keys, from Jupiter's live /build. Simulation used `simulateTransaction` with
`sigVerify:false` and `replaceRecentBlockhash`. Our float and ghost are unfunded, so in the simulation:

- the payer is a funded system account,
- the sell's "ghost" is a real holder,
- the sell amount is the holder's whole balance (full-sell shape) or the buy-quote amount (partial: no closes).

Trade size is 14.32–14.33M lamports, about $1.50 at SOL $104.7.

| Run (results/) | Token | Shape | Route | Sim | CU used | Build ms | Tx bytes | Signers |
|---|---|---|---|---|---|---|---|---|
| dry-…21-12-52 | PUMPTEST (curve) | float-buy | Pump.fun | OK | 105,806 | 55 | 915 | 1 |
| | | float-sell (full, uva created+closed) | Pump.fun | OK | 77,755 | 58 | 1,002 | 2 |
| | | self-buy | Pump.fun | OK | 83,282 | 55 | 803 | 1 |
| | | self-sell (full) | Pump.fun | OK | 76,175 | 56 | 854 | 1 |
| dry-…21-23-10 | PIKAJEW (curve, default pick) | float-buy | Pump.fun | OK | 108,832 | 119 | 915 | 1 |
| | | float-sell (partial) | Pump.fun | OK | 79,216 | 338 | 1,002 | 2 |
| | | self-buy | Pump.fun | OK | 83,307 | 98 | 803 | 1 |
| | | self-sell (partial) | Pump.fun | OK | 77,915 | 90 | 854 | 1 |
| dry-…21-31-49 | PIKAJEW, holder with a used uva | float-sell (full) | Pump.fun | OK | 90,230 | 62 | 1,002 | 2 |
| | | self-sell (full) | Pump.fun | OK | 88,650 | 56 | 854 | 1 |
| dry-…21-32-21 | JEANPHIL (graduated) | float-buy | Pump.fun Amm | OK | 109,463 | 114 | 821 | 1 |
| | | float-sell (full) | Meteora DLMM ×2 | OK | 358,848 | 112 | 986 | 2 |
| | | self-buy | Pump.fun Amm | OK | 83,938 | 96 | 709 | 1 |
| | | self-sell (full) | Meteora DLMM ×2 | OK | 362,410 | 229 | 855 | 1 |

- **Jupiter quote+build HTTP time:** n=46 across all dry runs today. Min 54, p50 98, p95 178, max 338 ms.
- **Assemble** (decode, add our instructions, compile v0): n=42. p50 3.1 ms, max 19 ms.
- **Sign:** 0.04–0.41 ms.
- **Payer net, first float buy:** −17.26 to −17.33M lamports. That is:
  - the trade,
  - the ghost ATA rent of 1,513,840 (comes back on the sell),
  - the float's uva of 1,346,200 (once),
  - fees and tips.
- **Pump fee:** 1.25% per side, from the simulated `TradeEvent`s: protocol 95 bps + creator 30 bps.
  - "buyback 5000 bps" is half of the protocol fee, not an extra fee: 67,211 = ½ × 134,422.
  - One token (STENKS) showed buyback 0 bps with the same 95 + 30.
- **Round trip at quote time:** 0.58–2.56% on stable quotes. It was −15% once (the price pumped between the two
  quotes).

**Cost per trade at the observed prices:**

| Item | Lamports |
|---|---|
| Base fee | 5,000 per signature |
| Priority (CU limit × price) | ~7,500–10,000 on curve routes; up to ~50,000 on 600k-limit routes |
| Tips (Helius 5,000 + Jito 10,000) | 15,000 |
| **Total** | **about 30–35k (~$0.003) per curve trade** |

**Cost of the whole live run:**

- Tx fees: 80 trades plus 40 fund/drain transfers, about 0.0035 SOL.
- Swap loss: about 2.5–4% × $1.50 × 40 round trips, about 0.02–0.03 SOL.
- Price drift on top.

## Landing paths without a paid key

Every send goes to all three paths in parallel, with `skipPreflight` and `maxRetries:0`. Each tx is rebroadcast every
2 s until it is `confirmed`, for up to 40 s. A blockhash lives ~150 blocks [J1].

| Path | Keyless? | What it is | Tip in our tx | Limits | RTT from here (warm / cold) |
|---|---|---|---|---|---|
| Helius Sender `…/fast?swqos_only=true` [H1][H2] | yes | single staked (SWQoS) path | 5,000 lamports, the SWQoS-only minimum; a priority fee is required | keyless 1 rps (50 TPS with a key); `/ping` warms the connection when idle > 5 s | 71–144 / 301 ms |
| Jito block engine `/api/v1/transactions` [JT1] | yes | forwards to Jito-client leaders; `skip_preflight` is always on | 10,000 lamports, ≈ the landed-tip p50 of 9,967 (tip_floor, 20:53Z); bundle minimum is 1,000 | 1 rps per IP per region | 60–142 / 344 ms |
| Public RPC `api.mainnet-beta.solana.com` [S1] | yes | no stake-weighted QoS | none | 100 req/10 s per IP, 40 per method | 67–78 / 287 ms |

Ruled out:

- **Jupiter `tx.jup.ag`:** needs an API key and a ≥ 0.001 SOL tip [J6].
- **Sender Max:** tip ≥ 0.001 SOL [H1].
- **`/order` + `/execute`:** 50 bps fee on new tokens [J4].

Also checked: junk payloads (random bytes, nothing signed) reached transaction deserialization keyless on Sender,
Jito, the public RPC and tx.jup.ag. That shows each endpoint parses requests keyless. It does **not** show that a real
tx is accepted (see risks).

## Latency budget per step (click → filled)

| Step | p50 | bad case | Basis | Who controls it |
|---|---|---|---|---|
| quote + build (Jupiter /build) | 98 ms | 178 ms (max 338) | measured, n=46 | partly: key and region; could pre-build on hover |
| assemble | 3 ms | 19 ms | measured, n=42 | us |
| sign (ed25519) | < 0.5 ms | < 0.5 ms | measured | us |
| send, first path accepts | ~75 ms | ~350 ms (cold) | RTT measured, 6 per path | us: warm connections, three paths |
| land (sent → in a block) | ~430 ms (2 slots) | ~860 ms (4 slots) | **estimate**; slot 214–219 ms measured | partly: priority fee, tips, SWQoS path |
| confirmed, as seen by us | ~300 ms | ~650 ms | **estimate**; processed→confirmed gap at the RPC was 0–1 slot (measured); WS first, 500 ms poll as backup | no (network votes); RPC/WS choice is ours |
| visible (balance read) | ~75 ms | ~290 ms | RPC RTT measured | us: RPC choice |
| **total, no dropped send** | **≈ 1.0 s** | **≈ 2.4 s** | | |
| one dropped send | +2.0 s | ≈ 4.4 s | rebroadcast interval | us: faster rebroadcast with keys |

**The weakest step is landing.** Every keyless path is thin:

- the public RPC has no SWQoS,
- keyless Sender is one SWQoS path at 1 rps,
- Jito helps only when a Jito-client leader is up.

The budget holds 5 s with one dropped broadcast but not with two. The live run measures this directly: it records
`slotsToLand` and per-step p50/p95.

## Open risks

1. **No live p95 yet.** The landing and confirm times above are estimates. They become numbers only with the owner's
   funded `--live` run.
2. **Keyless limits.**
   - Jupiter: 0.5 RPS keyless [J3] (the limiter runs before the click and is not timed). A key in the env file
     lifts it.
   - Sender: 1 rps [H1]. Jito: 1 rps per IP per region [JT1].
   - The public RPC: getTokenLargestAccounts returns 429 on every try (used only by --dry stand-ins); other methods
     at 40 per 10 s.
   - A 429 on one send path is absorbed by the other two. Production needs a Jupiter key and a Helius key. The
     script reads both from the env file, but the slots are empty today. Helius' keyed limits and cost have not been
     checked here.
3. **Unverified until --live:**
   - Sender and Jito accept a real signed tx keyless, including one that carries both their tips.
   - tx.jup.ag enforces its key on real txs.
4. **Fresh-token behaviour.**
   - Devs dump within minutes: three stand-in dev wallets (DIAMOND, ARENAI, STENKS) went to 0 tokens between two
     reads.
   - Round trips moved +2.7% to −15% between quotes.
   - A dump between quote and landing fails the slippage check (10%). That counts as an infinite time in p95.
5. **Graduated routes.**
   - They use about 360k CU (limit 600k), which raises the priority fee.
   - They leave PumpSwap's volume-accumulator account behind: 1,346,200 lamports, read on chain (§0, rent leak). The
     trade does not close it (a sell must never fail on cleanup); `--sweep` closes it since b5e7eb0.
6. **Pump's uva close.**
   - `close_user_volume_accumulator` has no documented constraints. It simulated OK for a new uva and for a used one.
   - If pump changes it, full sells on the `Pump.fun` route would fail, and the script has no fallback.
   - The pump docs give the uva rent as 0.0018444 SOL [P1]. Live it is 1,346,200 lamports, and the script uses the
     live value.
7. **Privacy.**
   - Float mode links every ghost to the float on chain: the float creates the ghost's ATA, pays its fees, signs its
     sells and receives its SOL.
   - Self mode links a ghost only at funding time. In this proof that is a float → ghost transfer; in production it
     would be a NEAR Intents withdrawal.
8. **Stand-ins.** The dry results use stand-in payers and holders. The deltas and CU are real for that account state.
   Our own accounts start empty, so first-trade rents apply. They are shown above.

## Sources (fetched 2026-10-19; every number above comes from these, a live read, or a simulation)

- [J1] https://developers.jup.ag/docs/api-reference/swap/build.md and `/docs/swap/build/index.md`:
  - base `https://api.jup.ag/swap/v2`
  - "Routing is Metis only. No swap fees are charged by Jupiter."
  - `payer`: "Account that pays transaction fees and rent. Defaults to taker"
  - `destinationTokenAccount` and `nativeDestinationAccount` are mutually exclusive
  - `slippageBps` default 50 (or `rtse`)
  - `computeUnitPricePercentile`: medium 25th, high 50th, veryHigh 75th
  - `blockhashSlotsToExpiry` default 150
  - `tipAmount`
  - response: `blockhashWithMetadata`, `addressesByLookupTableAddress`
- [J2] https://developers.jup.ag/docs/swap/advanced/compute-units.md:
  - "`computeBudgetInstructions` with the compute unit price but not the compute unit limit"
  - decode the price and clamp it to your own maximum
- [J3] https://developers.jup.ag/docs/portal/rate-limits.md (Keyless 0.5 RPS, Free 1, Developer 10; `/execute` 20 RPS
  keyless) and https://developers.jup.ag/docs/portal/migration.md ("Replaces `lite-api.jup.ag` with keyless requests on
  `api.jup.ag` at 0.5 RPS")
- [J4] https://developers.jup.ag/docs/swap/order-and-execute.md and `/docs/swap/index.md`:
  - `/order` fee is "50 bps on tokens less than 24 hours old"; "`/build` has no Jupiter swap fee"
  - `payer` ≠ `taker` restricts routing to Metis
- [J5] https://developers.jup.ag/docs/swap/routing/amm/market-listing.md:
  - Pump.fun and Pump.fun AMM are eligible for instant routing
  - "if the token does not graduate before the grace period ends, the market is removed from routing"
- [J6] https://developers.jup.ag/docs/transaction/submit.md: tx.jup.ag "Requires a Jupiter API key"; tip "Minimum
  1,000,000 lamports (0.001 SOL)"
- [J3, headers] the same rate-limits page, "Rate limit headers": `x-ratelimit-remaining` (signed, ≤ 0 when over),
  `x-ratelimit-current`, `x-ratelimit-reset` ("absolute Unix timestamp, in seconds, at which the oldest request in the
  sliding window ages out"); 60-second sliding window; limits apply "per organisation, not per API key"
- [J8] https://developers.jup.ag/docs/llms.txt index entries for `portal/setup.md` and `portal/api-keys.md`: "API key
  is passed via x-api-key header"; tiers Free (1 RPS), Developer ($25/mo, 10 RPS), Launch ($100/mo, 50 RPS), Pro
  ($500/mo, 150 RPS). `portal/responses.md`: 401 "only when an invalid or unknown API key is sent; a request with no
  x-api-key header is treated as keyless"
- [J7] https://developers.jup.ag/docs/api-reference/tokens/recent.md (`/tokens/v2/recent`; fields `launchpad`, `dev`,
  `audit`, `tokenProgram`)
- [H1] https://www.helius.dev/docs/sending-transactions/sender.md: "Keyless requests are limited to 1 request per
  second"; 50 TPS with a key; Sender Max 0.001 SOL minimum tip
- [H2] https://www.helius.dev/docs/sending-transactions/sender-swqos-only.md:
  - `?swqos_only=true`
  - "0.000005 SOL" minimum tip to a designated tip account
  - priority fee required
  - `/ping` during idle periods > 5 s
- [JT1] https://docs.jito.wtf/lowlatencytxnsend/:
  - `sendTransaction` at `/api/v1/transactions`
  - "always sets skip_preflight=true"
  - "minimum tip of 1000 lamports for bundles"
  - default rate "1 request per second per IP per region"
  - `getTipAccounts`
  - plus a live read of https://bundles.jito.wtf/api/v1/bundles/tip_floor (landed p50 9,967 lamports, 20:53:55Z)
- [S1] https://solana.com/docs/references/clusters: mainnet public RPC 100 requests per 10 s per IP, 40 for a single
  RPC, 40 concurrent connections
- [P1] https://github.com/pump-fun/pump-public-docs (`docs/instructions/BUY.md`, `SELL.md`, `PUMP_PROGRAM_README.md`,
  `idl/pump.json`):
  - uva seeds `["user_volume_accumulator", user]`, "Initialized if needed, paid by `user`", "0.0018444 SOL" (stale)
  - `close_user_volume_accumulator` accounts `user, user_volume_accumulator, event_authority, program`
- Live reads, 2026-10-19:
  - rent: 137 bytes = 1,346,200; 170 bytes = 1,513,840
  - `getRecentPerformanceSamples`: slots 214–219 ms
  - processed→confirmed slot gap: 0–1
  - RTTs per path, as above
  - float balance: 0 at 21:33Z
- Simulations: the `results/dry-*.json` files, including the decoded pump `TradeEvent`s. `dry-…21-54-41` was re-run
  after the env-file and keys-dir change (PIKAJEW, all four full shapes OK: CU 108,831 / 90,228 / 83,309 / 88,650).
