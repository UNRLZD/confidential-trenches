# X1 and X2 from a free, read-only price sample (paper 10 G2 row 18)

Sampled 2026-10-20 11:23:36Z to 13:01:12Z. History read 11:39:04Z. Keyless reads only: no key, no wallet, no transaction.
Script: `sample.mjs` (Node 24, no dependencies). Not CPU-heavy, so it ran without `the build queue`.

**Proposal.** X1 = 150 bps (1.5%) on all three chains. X2 = 90 s, measured as NEAR block time minus the source's own
price time. In the live sample neither value refused a single buy. Over 14 days of on-chain minute prices, X1 = 150 bps
would refuse about 0.005-0.02% of buys on Solana and Base. On NEAR it would refuse about 0.2-0.3% on ordinary days
and 0.6-0.8% when the 14 days include Oct 8, when the NEAR pool briefly printed prices up to 9% off.

## 1. What the papers compare

| Question | Answer from the papers |
|---|---|
| Which price | The chain's native in USD: SOL, ETH on Base, NEAR. The buy debit is the measured native spend x the native price (01 R5, MM I6, 06a buy.14). Sell credits (sell.7, sell.8) and the export-key debit (xk.3) use the same price. The price check never prices a memecoin. |
| Source 1 | 1Click's token price: `GET /v0/tokens`, fields `price` and `priceUpdatedAt` (06a §4.15 "Prices"). |
| Source 2 | On-chain native/USDC pools, read on two RPCs (06a §8 item 23 (a), decided in §8.1 "22, 23: (a) each"; 6c M6 `poolState`). The papers name no pool. |
| Unit | USD per native. The pools quote USDC. In the sample 1Click priced USDC at 0.99989-0.99995, so treating USDC as $1 moves the gap by under 1 bps. |
| Check | buy.5 releases the notes when the pair is "stale or apart (X1, X2; ages on the monotonic clock, source times against NEAR block time)". BUY-06 and ENC-19 say the same. |
| "Stale" measured against | Two clocks. (1) The source's own price time against NEAR block time, read on two RPCs, the lower of the two (06a §5.1; 6c M2 `chainTime`). (2) Ages inside the enclave on the monotonic clock. For 1Click the own time is `priceUpdatedAt`. For a pool read it is the block time of the height read. |
| Cadence | Not stated in any paper. The sample read every source every 5 s. 1Click restamps every 30 s, so a faster poll gains at most a few seconds of age. The pools were read at the same instant, as a buy would read them. |

## 2. Sources, endpoints and rate limits

| Source | Endpoint | Published limit (read 2026-10-20) | This run |
|---|---|---|---|
| 1Click | `https://1click.chaindefuser.com/v0/tokens` | The docs publish no number. The terms (docs.near-intents.org/security-compliance/terms-of-service, §2.8) say limits may be stated "in ... API response headers". Header: `x-ratelimit-limit-unauth: 1200`, reset 60 s. | 12 per min |
| Solana RPC 1 | `https://api.mainnet-beta.solana.com` | solana.com/docs/references/clusters: 100 requests per 10 s per IP; 40 per 10 s per IP for one method | 4 per 10 s |
| Solana RPC 2 | `https://solana-rpc.publicnode.com` | No number on publicnode.com | 4 per 10 s |
| Base RPC 1 | `https://mainnet.base.org` | docs.base.org gives the endpoint and no number | 1 batch per 5 s |
| Base RPC 2 | `https://base.gateway.tenderly.co` (06c §1.3 names it) | No number in Tenderly's docs. Header: `x-tdly-limit: 20` | 1 batch per 5 s |
| NEAR RPC 1 | `https://near.drpc.org` | drpc.org/docs/howitworks/ratelimiting: free tier 120,000 CU per minute per IP (min 50,400); docs.near.org/api/rpc/providers lists ~2,100 CU/s | 4 per 5 s |
| NEAR RPC 2 | `https://nearinner.deltarpc.com` (run 2; 06c names it for sends) | None found | 4 per 5 s |
| History (analysis only) | GeckoTerminal `.../pools/{pool}/ohlcv/minute` | docs.coingecko.com/docs/errors-and-rate-limits: keyless is "IP-based rate limiting", no number | 1 per 13 s, as P3 |

Providers that failed (section 9 items 5-6): `rpc.mainnet.near.org` (run 1) and `base.drpc.org` (tried before run 1).

**Pools chosen** (the deepest native/USDC pool on a venue each adapter trades). GeckoTerminal reads: 11:10:39Z, 11:10:52Z,
11:12:32Z. Owners, mints and token order were checked on chain at ~11:15Z.

| Chain | Primary | Secondary |
|---|---|---|
| Solana | Orca Whirlpool SOL/USDC `Czfq3xZZ…u44zE`, fee 0.04%; $28.9M liquidity, $115.5M 24 h volume | Raydium CLMM SOL/USDC `3ucNos4N…sUxv`, $7.8M |
| Base | Uniswap v3 WETH/USDC 0.05% `0xd0b53d92…f224`, $8.3M | Aerodrome Slipstream WETH/USDC `0xb2cc224c…dc59`, $8.1M, $51.0M volume |
| NEAR | Rhea DCL `17208628…|wrap.near|100`, fee 0.01%; $0.62M liquidity, $4.78M volume | Rhea classic pool 4512 USDC/wNEAR, fee 0.3%, $2.2M |

## 3. Token set

| Set | Solana | Base | NEAR |
|---|---|---|---|
| Native (the rule) | SOL | ETH | NEAR |
| 1Click-listed memecoins (contrast) | WIF (Orca SOL/WIF `D6NdKrKN…`), TRUMP (Raydium CLMM TRUMP/USDC `CRoTdDUM…`) | BRETT (Aerodrome WETH/BRETT `0x4e829f8a…`) | SHITZU (classic 4369), BLACKDRAGON (classic 4276) |
| Fresh trending, not in 1Click (contrast) | EVOLVE (PumpSwap `HNB2hfCs…`; +42% in 1 h at pick), TCG (PumpSwap `9NcS7HT3…`) | TIBBIR (Aerodrome `0x0e4409f7…`) | BATMAN (DCL `batman-4.nearlytrade.near|wrap.near|10000`) |

Trending lists (GeckoTerminal `trending_pools?duration=1h`, read 11:11:19Z-11:11:46Z): 0 of 20 Solana tokens and
0 of 20 Base tokens were in 1Click's list. On NEAR, 5 of the 20 trending pairs had a token in the list (QTC, ZEC,
NBTC), and none was a memecoin. A fresh memecoin has no 1Click price, so the rule cannot price it. Memecoin buys meet
the price check only through the native pair. Their false-refusal rate is the native pair's rate.

## 4. Counts

| | Run 1 | Run 2 | Total |
|---|---|---|---|
| Window | 11:23:36Z-11:36:26Z | 11:36:52Z-13:01:12Z | 97.6 min |
| Cycles (5 s) | 155 | 1,013 | 1,168 |
| Paired samples per chain (1Click and the primary pool in the same cycle) | | | **1,155** (each chain) |
| Distinct 1Click `priceUpdatedAt` values | | | 196 |
| 1Click failures | | | 13 of 1,168 |

Run 1 stopped early: `rpc.mainnet.near.org` answered HTTP 429 to 144 of 155 cycles. Run 2 swapped in DeltaRPC.
The count gate was ≥ 1,000 pairs per chain and ≥ 150 updates in run 2. The tail is not set by a few points: SOL p99
26 bps against max 34. The market was calm. Pool ranges over the window: SOL 77 bps, ETH 85 bps, NEAR 177 bps.
Section 7 covers busy markets with 14 days of history.

## 5. Disagreement, |1Click − pool| / pool (bps)

| Pair | n | p50 | p95 | p99 | max | > 100 bps | > 200 bps |
|---|---|---|---|---|---|---|---|
| SOL vs Orca (primary) | 1,155 | 7.2 | 20.2 | 26.0 | 34.4 | 0 | 0 |
| SOL vs Raydium CLMM | 1,155 | 7.2 | 20.4 | 26.1 | 34.3 | 0 | 0 |
| ETH vs Uniswap v3 (primary) | 1,155 | 5.1 | 16.9 | 21.7 | 30.3 | 0 | 0 |
| ETH vs Aerodrome | 1,155 | 6.2 | 18.7 | 23.7 | 31.7 | 0 | 0 |
| NEAR vs DCL (primary) | 1,155 | 24.7 | 51.5 | 81.4 | 97.5 | 0 | 0 |
| NEAR vs classic 4512 | 1,155 | 15.7 | 48.0 | 69.4 | 75.8 | 0 | 0 |
| WIF (Solana, listed meme) | 1,155 | 8.5 | 21.2 | 34.4 | 49.2 | 0 | 0 |
| TRUMP (Solana, listed meme) | 1,155 | 12.1 | 35.0 | 46.8 | 49.2 | 0 | 0 |
| BRETT (Base, listed meme) | 1,155 | 16.6 | 33.8 | 50.2 | 61.0 | 0 | 0 |
| SHITZU (NEAR, listed meme) | 1,153 | 121.3 | 210.3 | 245.4 | 258.1 | 63% | 7.1% |
| BLACKDRAGON (NEAR, listed meme) | 1,153 | 96.1 | 208.5 | 236.8 | 249.5 | 48% | 5.5% |

Refusal share at lower X1 (primary pair): 25 bps refuses 2.1% on Solana, 0.3% on Base and 48% on NEAR. At 50 bps:
0, 0 and 5.5%. At 75 bps: 0, 0 and 1.7%. At 100 bps: 0 on all three.

Other gaps in the same samples. Between the two pools of one chain: SOL p99 1.6 bps, ETH p99 3.6 bps, NEAR p99 30.6 bps.
Between the two RPCs on the same pool: SOL p99 0.5 bps, ETH p99 0.04 bps, NEAR p99 9 bps.

Fresh trending memecoins have no 1Click price. How far their own pool price moved in 60 s:
EVOLVE p50 303, p99 2,456 bps. TCG p95 322 bps. BATMAN p99 688 bps. TIBBIR p99 66 bps. A source 30-60 s behind would
disagree by that much. Applying X1 per token would refuse most of these buys. The papers do not apply it per token.

## 6. How old 1Click's price is

| Measure | p50 | p95 | p99 | max |
|---|---|---|---|---|
| Step between `priceUpdatedAt` values (s) | 30.0 | 30.3 | 30.4 | 30.5 |
| A new stamp first served, after the stamp (s) | 32.8 | 40.5 | 57.4 | 57.8 |
| Age = NEAR block time (final, lower of 2 RPCs) − `priceUpdatedAt` of the held price (s), 1,161 cycles | 40.0 | 54.7 | 55.2 | **59.3** |
| Same age against this machine's clock (s) | 43.3 | 58.0 | 60.9 | 82.8 |
| Time between successful 1Click reads, monotonic (s) | 5.0 | 5.6 | 9.6 | 44.8 |
| 1Click response time (ms) | 1,170 | 1,733 | 5,319 | 9,628 |
| Time between changes of the price value: SOL / ETH (s) | 90 / 90 | 120 / 90 | 180 / 120 | 180 / 120 |
| Same for NEAR (s) | 180 | 450 | 540 | 540 |

All 199 priced assets share one stamp, refreshed every 30 s. The stamp says when 1Click refreshed its cache. It does
not say when the value was observed. The value changes about every 90 s, and it trails the pools.

**Lag fit.** Compare 1Click's price at time t with the pool at t − k. The k with the smallest median gap is 1Click's
effective lag. SOL: 145 s (median gap 7.2 → 1.9 bps). ETH: 130 s (5.1 → 1.6 bps). NEAR: about 200 s (24.7 → 10.7
bps). After that shift, NEAR keeps an ~11 bps gap. Part of it is rounding: 1Click quotes most prices above $1 to the
cent (68 of 73 such assets at 11:06Z). NEAR $4.69 has a 21 bps step; TRUMP $1.69 has a 59 bps step.

A frozen stamp is real per asset. At 11:55:19Z, 6 of 205 assets (ABG, NOEAR, GNEAR, TESTNEBULA, STJACK on NEAR; FMS
on Base) had price 0 and a stamp frozen at 06:55:30.610Z, five hours old. X2 refuses that case.

Pool read lag (local receive − the read's block time): Solana p99 1.7-1.8 s; Base p99 1.9-2.1 s. NEAR final blocks: p99 3.3 s
on dRPC and 4.7 s on DeltaRPC; max 9.4 s. NEAR final block time ran 2.5 s (p50) behind this machine's clock.

## 7. Busy markets: 14 days of 2- and 3-minute moves

The live window was calm. 1Click trails the pools by 2-3 minutes, so in a busy market the gap is about the pool's own
move over 2-3 minutes. GeckoTerminal 1-minute closes of the three primary pools (Oct 6 11:40Z to Oct 20 11:38Z, quote-token
prices) give that move. `results/history-summary.json` has the full table.

| Share of minutes the pool moved more than X | 100 bps, 2 min | 100 bps, 3 min | 150 bps, 2 min | 150 bps, 3 min | 200 bps, 3 min |
|---|---|---|---|---|---|
| SOL (20,127 windows) | 0.060% | 0.119% | 0.005% | 0.020% | 0 |
| ETH (18,950) | 0.032% | 0.063% | 0.005% | 0.011% | 0.005% |
| NEAR, all 14 days (17,068) | 1.23% | 1.84% | 0.62% | 0.77% | 0.48% |
| NEAR, without Oct 8 (15,796) | 0.56% | 1.08% | 0.19% | 0.31% | 0.11% |

The largest 2-minute moves were SOL 157 bps, ETH 154 bps and NEAR 1,200 bps. NEAR's tail comes from the DCL pool itself.
On Oct 8, 08:33-08:39Z, the pool closed at 5.52, 5.32, 4.86, 5.30, 5.34, 5.32 and 5.22 in consecutive minutes. That
day had 76 of its 1,272 minutes above 150 bps. Two RPCs reading the same pool cannot catch this. X1 refusing then is
the right outcome.

## 8. Proposed values

**X1 = 150 bps, one value for all three chains.**
- Normal buys. The live sample refused 0 of 1,155 per chain. The largest gaps were 34 bps (SOL), 30 bps (ETH) and
  98 bps (NEAR). Modelled over 14 days with 1Click 2-3 min behind: about 0.005-0.02% of buys refused on Solana,
  0.005-0.01% on Base, and on NEAR 0.19-0.31% on ordinary days (0.62-0.77% with Oct 8). At 60 canary trades per chain
  that is an expected 0 on Solana and Base and about 0.1-0.2 on NEAR.
- Bad prices. It refuses a price of 0 or a frozen one, a wrong unit or decimals, and a lagged 1Click price in a move
  over 1.5% in 2-3 minutes. What it can let through is at most 1.5% of the swap. At the top refill tier and the 13:01Z
  1Click prices, that is $1.57 on 1 SOL ($104.41), $1.44 on 0.04 ETH ($2,394.03) and $1.41 on 20 N ($4.69). The notes
  sent cap the debit in any case.
- Lower values. 100 bps fits Solana and Base (0.06-0.12% modelled refusals). On NEAR it would refuse 0.6-1.1% on ordinary
  days, and the live NEAR maximum (98 bps) sat 2 bps under it. If the matrix takes per-chain values, as X11 does,
  Solana and Base can take 100 bps and NEAR 150 bps. At 75 bps, NEAR already refused 1.7% of the calm sample.

**X2 = 90 s, applied to (NEAR block time − the source's own price time).**
- Normal prices. Age in the sample: p99 55.2 s, max 59.3 s, 0 refusals. 1Click restamps every 30 s. A new stamp
  first appeared 33 s (median) to 58 s (max) after its time. At 60 s the margin would be under 1 s. At 90 s it is
  one missed refresh (31 s).
- Stale prices. It refuses a price after about two missed 1Click refreshes, and it refuses frozen stamps (the 6
  zero-price assets above). For pool reads, the block time of the read is never more than 9.4 s behind in the sample,
  so 90 s only catches a stalled RPC.
- Limit. X2 cannot see that 1Click's value is 2-3 min older than its stamp (section 6). X1 catches that when it
  matters. The age on the monotonic clock is the weaker of the two checks, because 1Click's stamp is already 33-58 s
  old when it arrives. One X2 serves both. The NEAR time used should be the last two-RPC final block time plus the
  monotonic time since that read. Then a delayed NEAR read cannot make a price look younger.

## 9. What the papers get wrong or leave open (for the coordinator; no paper was edited)

1. The papers treat `priceUpdatedAt` as the price's own time (ENC-19, buy.5). It is a 30 s cache restamp shared by
   all priced assets. The value trails the pools by 130-200 s. X2 on the stamp catches a stopped cache, not a slow feed.
2. 1Click rounds most prices above $1 to the cent, NEAR's included. NEAR debits and credits carry a rounding error
   of up to ±10.7 bps.
3. 06a §4.15's "Prices" row still shows "[Open-23]". §8.1 decided it as (a).
4. The papers name no pool. On NEAR the deepest pool is thin ($0.62M) and spikes. A suggestion: take the median of
   the DCL fee-100 pool and classic pool 4512 as NEAR's independent price. They differed by p99 31 bps in the sample.
5. 06c §1.3's NEAR re-check provider `rpc.mainnet.near.org` took ~3.2 s per request. It answered HTTP 429 to 144 of
   155 cycles at ≤ 0.8 requests per second. DeltaRPC answered, but slowly (p95 4.2 s, 5 timeouts at 8 s). NEAR's
   "two RPCs" for prices and `chainTime` needs the paid plan (OD-q2) before real users.
6. `base.drpc.org` free refused JSON-RPC batches over 3 ("Batch of more than 3 requests are not allowed on free
   plan"). It then returned "Public endpoint rate limit" after a handful of calls. Tenderly worked: p95 0.5 s, and its
   7 failed cycles were the same 7 in which every provider failed (local network).
7. Sells have no X1 check. sell.7 credits at 1Click's price and sell.8 switches only when it is "down". The papers do
   not say which price credits a sell while the pair is more than X1 apart. A suggestion: treat "stale or more than
   X1 apart" as down for sells and credit at the independent price.

## 10. What the live canary should confirm (MS-12)

1. At every canary buy, sell and export, log both prices, `priceUpdatedAt`, the NEAR time and the gap. All stay
   within X1 and X2 on 60 trades per chain, with 0 refusals on Solana and Base and at most 1 on NEAR.
2. The enclave's own region sees the same 1Click serving delay (33-58 s here, read via a Singapore edge) and the same
   30 s stamp step.
3. The baked NEAR read providers sustain the 5 s price and `chainTime` poll with two answers per cycle.
4. Stub tests (EU-04): a stamp frozen past 90 s is refused; a 2% offset is refused; a 1.4% offset is accepted; moving
   the host clock changes nothing.

## 11. Files

| File | What | Committed |
|---|---|---|
| `sample.mjs` | Sampler (`node sample.mjs`), analysis (`--analyze <jsonl...>`), history (`--history 14`) | yes |
| `results/summary.json` | Every distribution above, from both runs | yes |
| `results/pairs.csv` | One row per cycle and chain: both prices, stamp, NEAR time, age, gap (484 KB) | yes |
| `results/history-summary.json` | 14-day move distributions, top 3 days per chain | yes |
| `results/discovery.json` | Pool choice and trending lists with read times; which trending tokens 1Click lists | yes |
| `results/samples-run1.jsonl`, `samples-run2.jsonl`, `history-candles.json` | Raw reads (3.1 MB together) | no (over 1 MB) |

Rerun: `node sample.mjs --min-pairs 1000 --min-updates 150`, then
`node sample.mjs --analyze results/samples-*.jsonl` and `node sample.mjs --history 14`.
