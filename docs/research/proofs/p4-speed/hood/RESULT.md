# P4 speed proof, Robinhood Chain (4663)

Status 2026-10-20 17:21Z: **p95 ≤ 5 s PASS on both sides; the FP-1 median line passes for buys and misses for sells
by 14 ms (§8).** Run 2 (17:04-17:13Z) did 20 of 20 round trips on TORCH, a 10-day-old pool with $1.59M of liquidity,
picked by fixed criteria:
- buys: p50 1,872 / p95 3,953 / max 4,060 ms;
- sells: p50 2,014 / p95 2,516 / max 2,549 ms.

Every tx was re-read on publicnode, and the spend reconciles to the wei. Run 1 (16:45Z, §7) stopped after its token was
rugged. Total spent on both runs and the funding: 0.001353 ETH, $3.31 of the $15 cap (owner's OK fp1-1).

**Pass line (for the live run):** self mode, n ≥ 20 buys and 20 sells on a fresh Pons or Uniswap token, p95
click → filled ≤ 5 s, where filled = the first confirmation (the sequencer's receipt with status 1), and at most $15
spent in all.

| Question | Answer |
|---|---|
| Script | `run.mjs`: P4 Base's self mode (`../base/run.mjs`), adapted. `--dry` (default), `--live`, `--sweep` |
| Aggregator | Relay `POST https://api.relay.link/quote/v2`, keyless. Relay lists the same Router and ApprovalProxy (v3 and v3.2) on 4663 as on Base; every run re-reads `GET /chains` and stops if they differ |
| Token | Picked live: the newest GeckoTerminal pool on `robinhood` from Pons v2 or Uniswap (v2, v3, v4, Pools.trade), quoted in ETH, at most 6 h old, at least $2,000 of liquidity, with a sell in the last hour, whose whole round trip quotes and simulates on both RPCs. `--token` overrides; `--dex` limits the pick to one dex |
| Size | 0.0008 ETH a buy (about $1.95) |
| Filled | First `eth_getTransactionReceipt` with status 1, polled every 100 ms on the official RPC: the soft confirmation, "Sub-second" in the Robinhood docs. `safe` (~10 min) and `finalized` (~16 min) are off the click path |
| Key | New, made by the first dry run: `~/.confidential-trenches/keys/p4-hood-float.json` and `p4-hood-ghost-seed.json` (0600, outside the repo, never printed). Float address **`0x9D5c87e2Ea18F5F2C7Cf509FDced53DE5536AD77`** |

## 1. What changed from Base

- Chain 4663; RPCs `rpc.mainnet.chain.robinhood.com` (reads, sends, receipts) and `robinhood-rpc.publicnode.com`
  (second simulation). Both keyless.
- No Flashblocks and no GasPriceOracle. The L1 data part is inside `gasUsed`, so each gas limit comes from
  `eth_estimateGas` × 1.2. On the click path it runs in parallel with `eth_simulateV1`, so it adds no round trip.
  Third dry run: the buy simulated, but its estimate reverted ~8 s after the quote on a 2-minute-old Uniswap v4
  token. A reverted estimate now gets the same one re-quote as a failed simulation.
- Priority fee 0 (`eth_maxPriorityFeePerGas` = 0); max fee = 3 × base fee; stop above 0.5 gwei.
- Self mode only, as asked. The quote is made before the click by default (`--prequote`, P4 Base §0 rerun): a warm-up
  quote at pre-fund, then a quote held 2 s, so the click starts at the simulation.
- Live safety: a `--cap-usd 15` stop before any run that could take total spend past $15; the token pick runs the same
  quote-and-simulate check as `--dry` before any money moves; a failed send is looked up by hash before it counts as
  failed; a failed run returns its pre-fund at once unless the ghost holds tokens (then `--sweep` sells them).
- `--dry` refuses every send method in code, and each dry record holds `"sends": 0`.

## 2. Dry runs (2026-10-20, all `sends: 0`)

Every tx of one self-mode round trip was built and simulated in order in one `eth_simulateV1` call, on both RPCs:
float → ghost pre-fund (the float has only a 1 ETH balance override; the ghost has 0), buy, approve, sell, then
teardown back to the float. Each tx was signed with a throwaway key for size and timing only.

| Run (record) | Token (dex, age, liquidity) | Buy quote ms | Round trip sim (official / publicnode) | Gas incl. L1 (estimate) | Expected cost a round trip |
|---|---|---|---|---|---|
| 16:13:44Z (`2026-10-20T16-14-22-567Z-dry.json`) | UNALYN `0x83A6…dEA9` (Pons v2, 2 min, $5,672) | 626, 708, 646, 609 | ok 524 ms / ok 458 ms; same token and ETH amounts on both | buy 374,169; approve 46,643; transfers 21,000 | $0.134: price loss 0.0000343 ETH (4.3%) + gas 0.0000208 ETH |
| 16:14:46Z (`…16-15-24-481Z-dry.json`, `--dex uniswap-v4-robinhood`) | EMBER `0x1CBF…29D3` (Uniswap v4, 3 min, $40,285) | 529, 600, 619, 701 | ok 516 / ok 458 | buy 335,953; approve 47,624 | $0.055 |
| 16:18:16Z (`…16-18-54-963Z-dry.json`) | BAI `0xC790…804B` (Uniswap v4, 2 min, $21,076) | 736, 741, 680, 647 | ok 591 / ok 489 | buy: estimate reverted (price moved; see §1); approve 55,136; transfers ~26,100 | $0.075 |
| 16:23:07Z (`…16-23-45-877Z-dry.json`, after the §1 fix) | MUSEPAD `0x78D5…71D2` (Pons v2, 3 min, $10,726) | 672, 879, 627, 793 | ok 545 / ok 381 | buy 366,819; approve 47,023; transfers ~21,430 | $0.208: price loss 0.0000652 ETH + gas 0.0000205 ETH |
| 16:25:13Z (`…16-25-51-811Z-dry.json`) | GNOMON `0xD069…021B` (Pons v2, 2 min, $4,966) | 1091, 930, 1385, 883 | ok 522 / ok 420 | buy 359,473; approve 47,023; transfers ~21,430 | $0.135 |

- The records name the token contract `address` (renamed from `token` before the first commit: gitleaks read `"token": "0x…"` as a generic API key). Values are unchanged.
- Network from this Mac (Vietnam): official RPC p50 325-373 ms, publicnode 228-418 ms; 18-29 blocks seen in 3 s (the
  poll is RTT-bound; the chain makes ~10 blocks a second, chains research R12).
- Base fee 0.0209-0.0215 gwei; priority 0.
- Relay quote time varies: 529-879 ms a buy quote in the first four runs, 883-1,385 ms in the fifth. With `--prequote` the quote is off the click path.
- Click-path step (simulation and gas estimate in parallel, one RPC): 441-628 ms (487-512 ms in the last two runs). Throwaway-key signing 0.4-1.8 ms.
- Relay fees in the quote: relayer service ~$0.0029 a side; Relay's own gas estimate ~$0.031-0.035 a buy (the receipt
  will show the real figure; the simulation's gas at the base fee is ~$0.016-0.019).
- **Projection, buy click → filled from this Mac: ~1.5-1.7 s** (1,471-1,581 ms in the last two runs) (sim and estimate 0.44-0.63 s + send ~0.35 s + one 0.1 s
  block + receipt poll). That is P4 Base's prequote shape (1.29 s p95), well inside 5 s. Not measured until `--live`.
- 20 round trips: about $1.1-4.2 planned, against the $15 cap.

## 3. Not shown by the dry run

- The sequencer's real receipt time and the click → filled distribution: only `--live` measures them.
- Pre-buy sell quotes on a fresh token can mislead (P4 Base §8). The live path quotes each sell after its own buy.
- Whether a same-nonce replacement works with the first-come sequencer (chains research §2.4 item 3).
- The payer check (chains research §5 item 2) is not part of this run.

## 4. What the live run needs (written before the OK; route B was run at 16:43Z, §7)

**ETH on Robinhood for the float `0x9D5c87e2Ea18F5F2C7Cf509FDced53DE5536AD77`: 0.004 ETH (about $9.74 at $2,434.57,
1Click price stamped 16:13:00Z).** The floor is about 0.003 ETH: each run needs 0.0012 ETH in hand, and 20 runs spend
up to about 0.0017 ETH (the fourth dry run's $0.208 a round trip). Spend is capped at $15 by the script. What is left stays in the float for reruns or goes back.

Two ways to get it there (both quoted dry at 16:14-16:18Z):

| Route | Quote | Needs |
|---|---|---|
| A. 1Click from the hackathon funder `951a5eab…fb33` | 2.0681 NEAR (~$10.03 at $4.85) → **0.004083 ETH** on Robinhood (min 0.004042), estimate 19 s; keyless form (+25 bps). Native NEAR to the 64-hex deposit address, as P1's deposit | The owner's paste with the funder key. Note: the plan read the funder at 4.10 N (10:12Z) and counts on it for boots; this takes half |
| B. Relay from the P4 Base float `0x0215…4f52` | 0.004 ETH → 0.003990 ETH on Robinhood, ~1 s, fees ~$0.024. **The Base float holds only 0.003374 ETH** (`mainnet.base.org`, 16:14:42Z), so B can move ~0.0033 ETH, which is above the 0.003 ETH floor | The owner's OK to move the Base float's ETH; the key is on this Mac. No new owner money. The Base float is then empty until refilled |

Recommendation: B. It spends no NEAR from the funder and P4 Base has already passed. A is the fallback if the owner
wants the Base float kept. Neither route is scripted here: B needs a small Relay cross-chain send from the Base float
(Relay `quote/v2` with origin 8453 and destination 4663, one `deposit` step), and A needs the owner's 1Click paste.

Then (Claude, after funding and the OK):

```sh
cd ~/Downloads/confidential-trenches/proofs/p4-speed/hood && node run.mjs --dry && node run.mjs --live --runs 20 2>&1 | tee results/live-$(date +%s).log
```

Afterwards, `node run.mjs --sweep 0x9D5c87e2Ea18F5F2C7Cf509FDced53DE5536AD77 --live` sells any leftover token and
empties every ghost back to the float. Re-read every tx on the second RPC before the result counts, and reconcile the
spend against fees and price loss (tasks/lessons.md).

## 5. Sources (2026-10-20)

- Relay `GET https://api.relay.link/chains` 16:08Z and each dry run (16:13:48Z, 16:14:50Z, 16:17:46Z, 16:23:12Z, 16:25:13Z): chain 4663,
  `tokenSupport: All`, v3 Router `0xb92f…ff4f`, ApprovalProxy `0xccc8…15be`, v3.2 `0x0729…97f7` / `0x5567…2e58`.
- Relay `POST /quote/v2`, GeckoTerminal `GET /api/v2/networks/robinhood/new_pools` (pages 1-2), 1Click
  `GET /v0/tokens` (ETH and NEAR prices) and `POST /v0/quote` (dry, keyless): the times are in each dry record.
- RPCs `rpc.mainnet.chain.robinhood.com`, `robinhood-rpc.publicnode.com` (`eth_chainId` = 4663 checked each run);
  `mainnet.base.org` for the Base float balance.
- Robinhood finality wording: chains research §2.1 (R27, docs.robinhood.com/chain/transaction-finality).

## 6. Money-safety review of run.mjs before the live run (2026-10-20 16:37-16:42Z)

| Check | Found | Fix |
|---|---|---|
| The $15 cap stops a run before the spend can pass it | The check was spent + 2 × the worst run so far, with the worst run starting at $0.50. But one run can lose its whole pre-fund (0.0009 ETH, ~$2.20), so a run starting at $14 could end above $15. A missing ETH price made every $ figure 0 or NaN, and then the cap never fired | The margin is now the most a run can take from the float: its pre-fund plus 100k gas at the 0.5 gwei fee cap. The run stops if the ETH price is not a sane number |
| `--dry` sends nothing | The RPC layer refuses every send method in dry mode. But `--dry --live` ran live, because only `--sweep` beat `--live` | `--dry` now always wins |
| A failed send is looked up by hash | There was one immediate lookup on one RPC, and a lookup timeout counted as "not sent" | It now polls by hash on both RPCs for up to 10 s before calling the send failed |
| Error path returns the money | The pre-fund came back only if the funding wait had finished. A pre-fund that landed late stayed in the ghost, and the loop went on to new ghosts after any failure | The ghost is now drained whenever no teardown happened. The loop stops on a **stuck ghost** (tokens, or more than 0.00001 ETH, left after a failure) and on an **unexpected loss** (a run costing more than 25% of the trade) |
| `--sweep` returns every token and all ETH | It sells every token in the ghost registry (simulated first), moves each ghost's ETH to the float minus that tx's fee, and moves the float only when the target is not the float. OK. Each ghost keeps the unused part of gas × max fee (~0.0000015 ETH) | It now prints every tx hash |
| No unbounded loop or retry storm | RPC retries ≤ 3, and sends are never retried. Receipt wait ≤ 30 s, funding wait ≤ 15 s, one re-quote, a stop after 3 failures in a row, ≤ 8 token candidates. OK | none |
| No key printed or logged | Only key file paths are printed, and the records hold addresses only. OK | none |
| Every tx can be re-read | Only buy and sell hashes were recorded | Pre-fund, approve, teardown and drain hashes are now recorded too |

The gitleaks rename of §2 was also needed for the live records and `ghosts.json`: the field is now `asset`. `recheck.mjs` is new and read-only: it re-reads every tx on the second provider and reconciles the spend.

## 7. Live run (2026-10-20 16:43-16:45Z, under the owner's OK fp1-1)

ETH price $2,441.75, from 1Click `nep141:hood.omft.near` (stamped 16:43:00Z, read 16:43:55Z by the run).

### 7.1 Funding, route B (`fund-relay.mjs`)

How `fund-relay.mjs` builds and checks the deposit:
- **Quote checks.** It takes one Relay `quote/v2` (8453 → 4663, native to native) and checks it before signing:
  - there is exactly one `deposit` step;
  - the target is Relay's v2 depository on Base `0x4cd0…bc31`, re-read from `GET /chains`;
  - `from` is the Base float, and `value` equals the amount;
  - the calldata decodes as `depositNative(Base float, id)`;
  - the recipient is the Robinhood float, and the output is native ETH on 4663;
  - the output is ≥ 98.5% of the amount and the minimum is ≥ 96%.
- **Amount.** It is the balance (both Base RPCs agreed) minus the reserved gas cost and a 0.000002 ETH margin, capped at 0.0034 ETH.
  - The reserved gas cost is `eth_estimateGas` × 1.3 × (3 × base fee + priority) + 2 × the L1 fee.
- **Simulation.** The tx is checked by `eth_estimateGas` on `mainnet.base.org` and by `eth_call` on Tenderly.
- **Send.** One `--dry` (`…16-42-20-207Z-fund-dry.json`), then one `--live` send, never retried.

| Tx | Chain, block | What | Value | Gas used | Fee |
|---|---|---|---|---|---|
| `0x4a6466872c6709c2a83bccb469b98a935830f40fd3d366dc59b51c9f75f205fe` | Base 52,862,630 | Base float → Relay depository | 0.003371874 ETH | 24,824 | 0.000000155 ETH |
| `0x0a26784a636e52b83ed953b43deda4c947ecc313d002e092c6a0f4f3401ab62b` | Robinhood 93,597,691 | Relay solver `0x1cd9…5baf` (on Relay's list for 4663) → float | 0.003362283 ETH | 21,512 | paid by Relay |

- **Arrival.** The ETH was seen on both Robinhood RPCs 2.1 s after the deposit receipt. Relay's status read `success`.
- **Cost.** 0.0000097457 ETH ($0.024): Relay's fee 0.0000095908, plus Base gas 0.000000155.
- **Base float.** It keeps 0.0000024 ETH.
- **Re-read.** Both txs had status 1 on the second provider (Tenderly; publicnode) and on the first.
- **Records.** `…16-43-25-737Z-fund-live-pending.json` (the hash, saved before the send) and `…16-43-28-998Z-fund-live.json`.

### 7.2 What the run did

Run record: `results/2026-10-20T16-45-16-943Z-live.json`. The progress file and log are next to it.
- **Dry run.** `node run.mjs --dry` (16:43:55Z, `…16-44-32-027Z-dry.json`) picked RJO on Uniswap v2. Its whole round trip simulated on both RPCs (sends 0).
- **Token pick.** `--live --runs 20` made its own pick and took the same token:
  - RJO `0x9017…5d19`, Uniswap v2 pool `0x0c46…bb68`, created 16:38:19Z;
  - 6 min old, $10,740 of liquidity, 29 buys and 8 sells in the last hour;
  - its round trip quoted and simulated on both RPCs.
- **Run 1.** The ghost was #1 `0xD08D62c538063f72f6D1b9D85A505471d04FF19B`. Every tx below was re-read on publicnode.

| Step | Tx | Block (time) | Result | Gas used | Fee (ETH) |
|---|---|---|---|---|---|
| Pre-fund, float → ghost, 0.0009 ETH | `0x7078bb98978f07ba3df53ad1bb58e46b1237c75ae3e9e814ad9c51e93bb7774a` | 93,598,559 (16:44:58) | status 1 | 21,000 | 0.000000444 |
| **Buy**, 0.0008 ETH, Relay Router v3 | `0x96844df51931f667b3da9a0b0e7808113d6c991daf6ad4dd45d3267ac6ac886a` | 93,598,616 (16:45:04) | status 1, +159.83 RJO (quote 159.70, min 154.91) | 273,354 | 0.00000609 |
| Approve ApprovalProxy | `0xf36677113dadd760cb71aeb5b54227a07824193388ce397e5176e52879d56ca8` | 93,598,669 (16:45:09) | status 1 | 47,056 | 0.000000995 |
| **Sell**, all 159.83 RJO | `0x280c07702d78bf98b8cdff8558d975da632e75e84d76933be151e75d0f41cc48` | 93,598,718 (16:45:14) | **status 0** (min-out) | 262,032 | 0.00000554 |

- **Buy click → filled: 2,077 ms.** The quote had been held 2.0 s; the simulation and gas estimate took 504 ms, signing 1.6 ms, the send call 416 ms, and the receipt was seen 1,155 ms after the send returned.
- **The reverted sell's receipt came 1,921 ms after its click,** 951 ms after its send.
- **These are two samples, not a distribution.** In both, send → receipt took about 1 s; the dry run's projection assumed ~0.65 s.

### 7.3 Why the sell reverted: the pool was rugged

The pool's own logs, read on the official RPC (archive reads; publicnode refuses them):
- 16:45:13Z, block 93,598,705, 9 s after our buy: tx `0xcd01c19e6e16cac3242e874912fd66654a1e229b19434adf27c003eab2825a1a` from `0xce33…8249` burned the LP. 2.2127 WETH and 453,060 RJO left the pool, and the RJO went to that same address. The pool's WETH went from 2.2133 to 0.00000074.
- 16:45:14Z, block 93,598,718: our sell landed 13 blocks later. It had been quoted 2 s earlier and simulated about 1 s before it landed, apparently against the state before the burn.
- Relay's router reverted it with its min-out error `0x97a6f3b9`: it needed at least 0.000755 ETH, and the pool would have paid 0.0000000308 ETH. The min-out did its job: the revert cost only gas ($0.0135).
- The ghost's 159.83 RJO are worth about 0.00000003 ETH now. The buy's 0.0008 ETH is lost.
- The error path left the ghost's ETH in place, because the ghost holds tokens and the sweep is the step that sells them. The stuck-ghost rule (§6) then stopped the loop before run 2.

### 7.4 Spend, reconciled (`results/2026-10-20T16-45-16-943Z-recheck.json`)

| Item | ETH | USD at $2,441.75 |
|---|---|---|
| Float drop, 0.003362283 → 0.002461839 | 0.000900444 | $2.20 (the script's own `spent`) |
| = fees on Robinhood (4 txs, from the receipts) | 0.000013065 | $0.032 |
| + ETH still in ghost #1 (recoverable) | 0.000087379 | $0.21 |
| + the buy's ETH, now in rugged RJO | 0.000800000 | $1.95 |
| + unexplained | **0** | |
| Funding (Relay fee + Base gas) | 0.000009746 | $0.024 |
| **Real loss so far** (fees + RJO + funding) | 0.000822810 | **$2.01 of the $15 cap** |

Where the money is (16:49Z, publicnode and Tenderly):
- Robinhood float `0x9D5c…AD77`: 0.002461839 ETH ($6.01).
- Ghost #1: 0.000087379 ETH and 159.83 RJO.
- Base float: 0.0000024 ETH.

### 7.5 Open items at 16:50Z (the coordinator then had ghost #1 swept and FP-1 rerun on a fixed-criteria token, §8)

- **`--sweep` was not run.** The rule for this run is to stop and report at a stuck ghost.
  - What it would do: return ghost #1's 0.0000874 ETH. It would also try to sell the RJO, simulated first. If a quote comes back, that costs about $0.01 of gas for about $0.
  - Command: `cd ~/Downloads/confidential-trenches/proofs/p4-speed/hood && node run.mjs --sweep 0x9D5c87e2Ea18F5F2C7Cf509FDced53DE5536AD77 --live`.
- **No verdict.** The proof needs 20 buys and 20 sells; it has 1 and 0.
- **A rerun needs a token decision.** Any token picked only for being fresh can be rugged, and a rug costs one whole trade (~$1.95). Two ways:
  - `--token <addr>` on an older pool with deep liquidity, as P4 Base did with `boar`;
  - or keep the fresh pick and accept the risk.
- **The script's cap counts from each run's own start.** A rerun needs `--cap-usd 12.9`: the $15 less the $2.01 lost so far. The float holds only $6.01, and that bounds any further loss too.
- **The float can fund a rerun.** It needs 0.0012 ETH at the start, and a round trip costs ~$0.06-0.21.
- **Not tried: FP-1's same-nonce replacement.** It is not in the owner's OK (fp1-1).

## 8. Run 2: sweep, a token picked by fixed criteria, 20 of 20 (2026-10-20 16:55-17:21Z)

The coordinator asked for this rerun at ~16:54Z, inside the owner's OK fp1-1. Its terms: total spend ≤ $15, so this run used
`--cap-usd 12.9`; ~$2 a trade; the same stop rules; no same-nonce replacement test.

### 8.1 Sweep of run 1's ghost (16:55Z)

All three txs had status 1 on publicnode. They are in `results/2026-10-20T16-45-16-943Z-recheck.json`, which was re-run with the sweep.

| Tx | What |
|---|---|
| `0x95704578facf66b572b5e4ce506c11f05a4ed423ac20da91c398c0ab80ad364a` | float → ghost #1, a 0.0000076 ETH gas top-up |
| `0x809eb4427ea471ee27adf7778004ad0d56ab3bf0640a9b715f2d28f10bfa84d3` | sold the 159.83 RJO for 0.0000000309 ETH; the gas cost 0.0000057 ETH |
| `0x28ec2360e9600d9df9a0bb2fc934219897351069c3433d3d1a1dd64bd37a2ba9` | ghost #1 → float, 0.0000877 ETH |

**Run 1 reconciled after the sweep.** The float went from 0.003362283 to 0.002541474 ETH, a drop of 0.000820809 ETH. That is:
- fees 0.000019692;
- RJO 0.0008, less 0.0000000309 recovered by the sweep;
- dust 0.0000011 left in ghost #1;
- unexplained 0.

### 8.2 Token pick (`results/2026-10-20T17-03-55-891Z-token-pick.json`)

**Criteria (the coordinator's):**
- a pool on Robinhood whose token is neither ETH nor a stablecoin;
- at least 7 days old and at least $100k of liquidity;
- Relay routes a $2 round trip;
- the deepest pool that meets all of these.

**Pools:** 130, from GeckoTerminal `GET /networks/robinhood/pools` under three sorts, 5 pages each, read 16:56:21Z and 17:00:02Z.

| Pool (by depth) | Liquidity, age | Result |
|---|---|---|
| PONS/USDG v4 | $93.3M, 1.1 d | too young |
| WETH/USDG, USDG/WETH (several) | $3.2-20.5M | ETH or a stablecoin |
| MOW/WETH v4 | $10.35M, 18.0 d | Relay refuses the sell: "Amount is too small to be swapped". Its MOW price looks wrong (the buy quote showed −99.81% impact) |
| GIGATENEV/USDG v4 | $9.8M, 0.15 d | too young |
| U/USDG v4 | $3.1M, 40 d | U is priced $1.0016, a stablecoin |
| NVDA, CRCL, USO, SPY, MSTR (stock tokens) | $1.7-3.1M, 57-95 d | Relay: "Unsupported currency" |
| **TORCH/WETH 0.3%, Uniswap v4, pool `0x1649…7a2d`** | **$1.59M, 9.95 d** | **routes both ways: buy +2.23%, sell −2.31%, 96.6% back** |

**TORCH, token `0x0000…1111`:**
- GeckoTerminal at 17:03:52Z: reserve $1,592,366, pool created 2026-10-10T18:21:48Z, 24 h volume $3.87M, 5,416 buys and 3,679 sells.
- On chain: first mint at block 85,204,501, 2026-10-10T18:21:48Z (tx `0x7eec1e8d…f95e`), read by `eth_getLogs` on the official RPC. The token is 9.95 days old.
- Dry run (`…17-04-33-510Z-dry.json`, sends 0): the round trip simulated on both RPCs at about $0.068.
- The MOW dry run that failed is kept as `…17-02-15-235Z-dry.json`.

### 8.3 Result (`results/2026-10-20T17-13-35-480Z-live.json`, progress file `…17-05-20-135Z-live-progress.json`)

Command: `node run.mjs --live --runs 20 --token 0x0000…1111 --cap-usd 12.9`, run 17:04:47-17:13:35Z, ETH $2,446.41 (1Click,
stamped 17:04:00Z).
- 20 fresh ghosts (#2-#21), self mode, each quote made before the click and held 2.0 s.
- No failures, no re-quotes, no approvals on the click path, no stop rule hit.

| Side | n | click → filled p50 | p95 | max | min | p95 ≤ 5 s | median ≤ 2 s (FP-1) |
|---|---|---|---|---|---|---|---|
| Buy | 20 | **1,872 ms** | **3,953 ms** | 4,060 ms | 1,707 ms | **PASS** | **PASS** (1,924 ms as the mean of the middle two) |
| Sell | 20 | **2,014 ms** | **2,516 ms** | 2,549 ms | 1,615 ms | **PASS** | **MISS by 14 ms** (2,048 ms as the mean of the middle two) |

p50 is the 10th of the 20 sorted values, and p95 the 19th, as in P4 Base.

**Where the time goes.** These are the median steps, buy / sell, measured from the click:

| Step | Buy | Sell |
|---|---|---|
| Simulation and gas estimate done | 531 ms | 523 ms |
| Send call returns (≈ 410-460 ms of RTT from Vietnam) | 946 ms | 987 ms |
| Receipt seen with status 1 | 1,872 ms | 2,014 ms |

- **Send to receipt is ~0.93-1.03 s.** The dry run's projection assumed ~0.65 s (one 0.1 s block plus a poll RTT), and run 1's two samples showed the same ~1 s.
- **The two slow buys are in the send call.** In #4 (3,953 ms) and #19 (4,060 ms), the official RPC's `eth_sendRawTransaction` took 2.37 s and 2.26 s; inclusion after it returned took 0.94 s and 1.33 s.
- **What would cut it:** the sell median misses by 14 ms, and about 3 RTTs of the path are distance (RTT 340-370 ms from this Mac). A sender nearer the sequencer, or a second send RPC raced against the first, would take both off. Neither was measured.

**Check (`results/2026-10-20T17-13-35-480Z-recheck.json`, every hash).**
- All 100 Robinhood txs (20 × pre-fund, buy, approve, sell, teardown) were re-read on publicnode. Each had status 1, the expected from, to and value, and the exact token amount in the buy's and sell's Transfer logs.
- The funding pair was re-read too.
- Each sell's ETH was measured from the ghost's balance at the sell block (official RPC). Where that state still existed (runs 5-20), the per-step balance changes matched the value plus fee of every tx to the wei.
- **The sweep after the run** (`--sweep` to the float) found no tokens in any ghost and sent nothing. Each ghost's ~0.00000115 ETH is below the fee to move it.

### 8.4 Spend, reconciled

Run 2 moved the float from 0.002541474 to 0.002022221 ETH. That is 0.000519253 ETH, the script's own `spent $1.27`. One
part of that change was not ours:
- Tx `0x608e8d47b317f7791838172478c1180c8532cc06c1ed16bdfe539bc39430b3e4` (17:09:51Z, block 93,612,894) sent the float 0.000003409268903795 ETH.
- It came from `0x0691…1d5d`, an address that is not ours (nonce 40, no prefix or suffix shared with any of our addresses). Unsolicited dust; it is ignored.
- It was found by binary-searching the float's balance against its own txs, and re-read on publicnode.
- It is exactly the −0.0000034093 ETH the recheck reports as unexplained. The ghost side balances to 0 wei on all 20 ghosts.

| Item | ETH | USD |
|---|---|---|
| Run 2 spend: 0.000519253 drop + 0.000003409 outside dust | 0.000522662 | $1.28 at $2,446.41 |
| = fees, 100 txs (~$0.041 a round trip) | 0.000333460 | $0.82 |
| + price loss: sells paid 0.000784-0.000813 ETH per 0.0008 ETH bought, ~1.0% a round trip with Relay's and the pool's fees | 0.000166241 | $0.41 |
| + dust left in 20 ghosts | 0.000022962 | $0.06 |
| + unexplained after the outside transfer | **0** | |
| Run 1 and its sweep (§8.1) | 0.000820809 | $2.00 at $2,441.75 |
| Funding (§7.1) | 0.000009746 | $0.02 at $2,441.75 |
| **Total for FP-1** | **0.001353217** | **$3.31 of the $15 cap** ($3.32 at $2,450.11, 1Click 17:20:00Z) |

**Count against the OK.** Across both runs: 21 buys (1 + 20), 21 sells sent (run 1's reverted one + 20), and the sweep's sale of the rugged RJO.

**Where the ETH is (17:20Z):**
- Robinhood float `0x9D5c…AD77`: 0.002022221 ETH (~$4.95), the outside dust included.
- 21 ghosts: 0.0000241 ETH in all, each below its own transfer fee.
- Base float: 0.0000024 ETH.

**Not done:** FP-1's same-nonce replacement try. It is not in the owner's OK.

## 9. FP-1b: gaps, same-nonce replacement and underpriced sends (2026-10-20 18:15-18:16Z, owner OK fp1b-1)

Script `fp1b.mjs` (dry by default; `--live` sends). Every tx is a 0-value transfer from the float to itself, so only
gas moves. CO reviewed the live path before the run: one key (the float), `to` = the float, value 0, chain id 4663,
a hard budget of 8 sends, a fee cap, and a clean-up send if a nonce is left open. The dry run
(`results/fp1b-2026-10-20T18-14-48-160Z-dry.json`) priced the worst case at 8 txs = $0.07 against the $0.50 cap.
Live record: `results/fp1b-2026-10-20T18-15-15-974Z-live.json`. Sends went to the official RPC; every read was made
on the official RPC and publicnode.

| Test | Sent | Answer | What it shows |
|---|---|---|---|
| A. Gap | A1 nonce 23 while the account nonce was 22; A2 the same nonce at 2x fee and a tip | Both refused after about 1.3 s: `nonce too high ... tx: 23 state: 22` (1,328 ms, 1,313 ms) | The sequencer holds a future-nonce tx about 1.3 s, then refuses it. Nothing waits longer |
| A. Fill | A0 nonce 22 | Accepted in 407 ms; block 93,650,798, status 1 on both providers | |
| B. Replacement | B1 nonce 23 at the normal fee, then B2 the same nonce at 2x fee and a tip, sent right after | B1 accepted in 344 ms; B2 refused in 331 ms: `nonce too low ... tx: 23 state: 24` | B1 was already sequenced when B2 arrived. A same-nonce fee bump cannot replace a tx on this chain |
| D. Underpriced | D1 nonce 24, maxFee = half the base fee | Refused at once (302 ms): `max fee per gas less than block base fee` | An underpriced tx is never held; it is refused at submission |

B1 is the same signed tx as A1 (same nonce, fee and gas, so the same hash `0x990fcc85…`): A1's bytes, refused for the
gap, were accepted later once the nonce was free and landed in block 93,650,985 (status 1 on both providers). So a
refused tx's bytes can still land later if anyone resends them while their nonce is free.

**Money.** Two txs landed (A0, B1). Fees from the two receipts (gasUsed × effectiveGasPrice): 22,567 × 20,794,000 +
22,557 × 20,932,000 = 941,421,322,000 wei, exactly the float's balance drop on both providers (0.000000941421322 ETH,
$0.0023 at $2,444.95). The script's own `reconciles: false` counted the shared hash twice; `post()` now counts each
hash once. Nonce after: latest 24 = pending 24 on both providers. The float holds 0.002021279432254448 ETH.

**Verdict: PASS (the assumption is closed).** On Robinhood Chain there is no pending pool to be stuck in. A send is
sequenced in about 0.3-0.4 s or refused at once (underpriced) or after about 1.3 s (a nonce gap). A same-nonce fee bump
never replaces anything. What can still happen is a send whose answer is lost: then the tx is looked up by hash on two
providers, and if it is absent and the account nonce (latest, two providers) still equals its nonce, the ghost sends
a same-nonce 0-value self-transfer to use the nonce, because the lost bytes could otherwise land later. Two more rules
for the adapter: send nonce n+1 only after n is accepted (a pipelined n+1 that arrives first is refused after about
1.3 s), and treat `nonce too low` on a resend as "the first one landed": read its receipt by hash.
