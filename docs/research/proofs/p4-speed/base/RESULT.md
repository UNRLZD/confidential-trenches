# P4 speed proof, Base

Status on 2026-10-20 00:56Z: **PASS on all four rows.** First live run (2026-10-19 23:28–23:38Z, 20 runs per mode, 40/40
round trips filled): float mode passed (buy p95 3.1 s, sell p95 3.1 s); self mode sells passed (p95 4.4 s) and buys missed
(p95 7.6 s), all of it in Relay's quote. **Self mode rerun with the quote made before the click (2026-10-20 00:44–00:52Z,
20/20 round trips): buy p95 1.29 s, sell p95 1.25 s.** See §0.

| Question | Answer |
|---|---|
| Aggregator | **Relay** (`POST https://api.relay.link/quote/v2`). Keyless today, recipient ≠ user, covers the fresh tokens tested |
| Filled | First `eth_getTransactionReceipt` with `status 0x1`, polled every 100 ms on `https://mainnet.base.org`. This is a **Flashblocks pre-confirmation**, before the 2 s block seals. The sealed block (`canon`) and the balance at `pending` (`conf`) are recorded too |
| Projected click→filled | Buy ~1.9 s, sell the same shape, from this Mac (Vietnam, 265–370 ms RTT to Base). Under 5 s with room to spare |
| Weakest step | Relay's quote API: 0.5–1.1 s warm, 2.1–2.5 s on a cold connection |
| Token | `boar` `0x0cbf291Ba052174879d90bf781dF1A5F2BC5Bb07` (Clanker v4, Uniswap v4 pool, launched 2026-09-26). Use `--token` for any other |
| Size | 0.0006 ETH per buy (~$1.44 at $2,407) |

## 0. Live result (mainnet, run by Claude under plan §11.11)

Record `results/2026-10-19T23-38-52-673Z-live.json` (log `results/live-20-1792452463.log`). Token `boar`, 0.0006 ETH a buy,
a fresh ghost each run, sim on, send + 100 ms receipt poll on `mainnet.base.org`, from this Mac (Vietnam).

| Mode, side | n | failed | click→filled p50 / p95 (ms) | quote p50 / p95 | sealed block (`canon`) p50 / p95 | Verdict (p95 ≤ 5 s) |
|---|---|---|---|---|---|---|
| float buy | 20 | 0 | **1839 / 3117** | 966 / 2262 | 2539 / 4453 | **PASS** |
| float sell | 20 | 0 | **3004 / 3140** | 2114 / 2256 | 4356 / 4617 | **PASS** |
| self buy | 20 | 0 | **3333 / 7560** | 2233 / 5956 | 3964 / 9096 | **FAIL** |
| self sell | 20 | 0 | **1908 / 4385** | 685 / 2623 | 3054 / 6016 | **PASS** |

**Check.** All 80 buy and sell txs re-read on a second provider (`recheck.mjs`, `base.gateway.tenderly.co`): status 1,
and the token Transfer into the ghost (buy) or out of it (sell). 80 ok, 0 failed.

**The quote is the whole story.** After the quote, every row takes ~0.9 s to the pre-confirmation (sim ~0.3 s,
send ~0.3 s, include ~0.3 s). The quote is slow exactly when Relay sees an address as `user` for the first time:
- slow (2.1–2.2 s p50): self buy (fresh ghost as `user`), float sell (fresh ghost as `user`);
- fast (0.7–1.0 s p50): float buy (the float, quoted thousands of times), self sell (the ghost was quoted at its buy).
- A free test of 8 fresh empty addresses quoted twice (2026-10-19 23:40Z): first quote 0.92–2.45 s (median ~1.18 s),
  second 0.50–1.21 s (median ~0.76 s). A funded fresh ghost is slower still (2.1–2.2 s above), likely because Relay
  then simulates against a real balance (suspect, not verified).
- The self-buy p95 comes from two Relay tails (#18 quote 5.96 s, #19 7.57 s); the other 18 quotes were 2.1–3.4 s.

**Fix for the product (no new parts):** quote once with the ghost as `user` when it is armed or pre-funded (off the
click path, free), and keep a fresh quote while the ticket is open, so the click starts at the simulation. Then every row
is ~0.9 s from this Mac plus the remaining quote refresh. A second aggregator raced against Relay on the click covers
Relay's tail (LI.FI, §1). The rerun below proves it.

**Self mode rerun with the quote before the click (2026-10-20 00:44–00:52Z).** Record
`results/2026-10-20T00-51-59-782Z-live.json` (log `results/live-prequote-1792457062.log`), `--mode self --runs 20 --prequote`
(quote age 2000 ms). Same token, size, send path and Mac as the first run.
- Off the click path, right after the ghost's pre-fund, one Relay quote with the ghost as `user` (the warm-up): p50 2202 /
  p95 3000 ms, max 3270 ms. The slow first quote is now paid where no one waits.
- Then a fresh quote is made and held 2.0 s, standing in for the open ticket. The click starts at the simulation.

| Mode, side | n | failed | click→filled p50 / p95 (ms) | Verdict (p95 ≤ 5 s) |
|---|---|---|---|---|
| self buy | 20 | 0 | **886 / 1294** | **PASS** |
| self sell | 20 | 0 | **1189 / 1250** | **PASS** |

- Buy steps: simulation p50 292 / p95 344 ms, send → pre-confirmation p50 264 / p95 708 ms. 0 re-quotes: no held quote
  failed its simulation.
- **Check:** all 40 txs re-read on Tenderly (`recheck.mjs`): 40 ok, 0 failed.
- Not shown: a ticket open longer than 2 s. The spec refreshes the held quote while the ticket is open (journeys-review
  §7 F8); Relay's quote lifetime was not read.
- **Cost:** the float went from 0.003869 to 0.003391 ETH: **0.000479 ETH (~$1.15 at $2,395.54, CoinGecko 2026-10-20
  00:55Z)** for 20 round trips, the pre-funds and the teardowns, ~$0.057 a round trip. The 20 ghosts keep 0.0000042 ETH
  in all.

**Earlier samples (same night).** `…23-26-18…`: float mode failed 2/2 at the arm, `insufficient funds … have 0` (the
send node checked the sealed head before the top-up was sealed; fixed by waiting for the funding in a sealed block,
b15145f); self mode 2/2 filled (2.9 / 3.2 s buys). `…23-27-18…`: float mode 2/2 filled after the fix.

**Cost.** P1 delivered 0.004975 ETH to the float; after the runs and the sweep it holds 0.003869 ETH (read on Tenderly,
2026-10-19 23:47Z). Spent: **0.001106 ETH (~$2.65 at $2,395.54, CoinGecko 2026-10-20 00:55Z; an earlier version of this line said $3.85 at a
wrong $3,480)** for 46 round trips, 2 failed arms and the sweep: about $0.06 a round trip (Clanker v4 pool fee both ways,
gas paid $0.008–0.010 a side from the receipts (Relay's quote estimated $0.012–0.014), Relay $0.002 a side). 22 self-mode ghosts
keep ~0.00000021 ETH each, below the fee to move it.

**Sweep.** `--sweep 0x02151d84EF543e4EcEF117a1a17A7Eaa9b424f52 --live` (the float itself: the ETH stays there for reruns)
sold the 2 failed-arm ghosts' boar (`0xf3f5460d…`, `0xa0b9f633…`) and moved every float-mode ghost's leftover gas back.

## 1. Aggregator comparison

**Method.** Docs fetched 2026-10-19 19:38Z through each site's `llms.txt` index. Latency was measured live from this Mac on 2026-10-20 with `agg-probe`: 3 calls per token, ETH → token, 0.0006 ETH.
- `boar` = Clanker v4 token.
- `t2` = `0x0991bb70464cae1796f282efb67d276f18189404`, a fresh bonding-curve token.

| Aggregator | Recipient ≠ sender | Fresh memecoins (boar / t2) | Key and free tier | Quote latency, live (ms) |
|---|---|---|---|---|
| **Relay** | Yes: `recipient` in quote/v2. Live: `details.recipient` = ghost, `user` = float | ✓ / ✓ | Keyless works today. Docs: "Starting **October 2, 2026**, `POST /quote/v2` will require a valid API key" (get-quote-v2.md:10, api-keys.md:73). Free self-serve key: 50 quotes/min (api-keys.md:41) | 1906, 669, 484 / 1084, 1047, 708. In `run.mjs --dry`: 2088, 1000, 656, 687 |
| LI.FI | Yes: `toAddress` | ✓ (via Nordstern) / ✓ (via OKX) | Keyless: `ratelimit-limit: 75` per ~2 h window (response headers). 40 runs × 2 quotes does not fit | 755 / 857 (1 call each, to spare the limit) |
| Velora (ParaSwap) | Yes: `receiver` | ✓ (Aerodrome) / ✗ "No routes found with enough liquidity" | Keyless | 1120, 311, 318 / 308, 273, 339 |
| KyberSwap | Yes: `/route/build` requires `sender` and `recipient` (OpenAPI 2.13.0, evm-swaps.md) | Not measured | `x-client-id` keyless with stricter limits; the gateway needs `X-Api-Key` from BD (evm-swaps.md:18, 44–46) | **Blocked here:** HTML 403 page (geo-restriction, VN) |
| 0x | Yes: `recipient` on Swap API and Gasless (swap-and-send.md:9, 20) | Not measured | **API key required.** Free tier ~5 RPS (rate-limits.md:19). Keyless only through x402 per-request USDC payments (llms.txt:20) | Not measured (no key) |
| 1inch | Yes: `receiver` query param (swagger) | Not measured | **API key required** (quick-start:7) | Not measured (no key) |
| Uniswap Trading API | Yes: `recipient` (uni-api.json) | Would cover v4 hooks | **API key required on every request**, issued on request; 6 RPS (faqs:24, 34) | Not measured (no key) |
| Odos | (docs unreachable) | — | — | **Unreachable:** HTTP 530 / Cloudflare 1033 |
| OpenOcean | — | — | — | **Blocked:** Cloudflare challenge page (403) |

**Pick: Relay.**
- It is the only option that works keyless from this host.
- It quoted both fresh tokens.
- Its quote carries a documented and verified `recipient` ≠ `user`.
- Its targets are a fixed, published allowlist (Router and ApprovalProxy), so the script can check calldata it cannot read.

**Costs.** The platform fee is 0.15% on "Minor Swap" (fees.md table). The live quotes showed `relayerService` $0.0022 per side.

**Second choice:**
- **LI.FI** if Relay ever enforces the key and no key is set; its keyless limit is too tight for 40 runs.
- KyberSwap and 0x should be re-measured from the enclave's region with keys before production.

## 2. Transaction shapes

All txs are EIP-1559 type 2 on chain 8453.
- Fees are cached off the click path:
  - `maxPriorityFeePerGas` = 2 × the RPC suggestion, at least 0.001 gwei.
  - `maxFeePerGas` = 3 × base fee + priority.
  - The run aborts above 0.5 gwei (`--max-fee-gwei`).
- Nonces are tracked locally and read off the clock (`warmNonce`).

### Mode `float` (app capital fronts the buy)

| Step | Signer / payer | Tx | Clock |
|---|---|---|---|
| Buy | float | Relay Router `0xb92f…ff4f` (or v3.2 `0x0729…97f7`), `value` = amount. Relay `recipient` = ghost | **click path** |
| Arm | float → ghost | ETH top-up sized to (approve 80k + sell gas × 1.3) × maxFee × 2 + 3 × L1 fee | off the click path, after the fill |
| Arm | ghost | `approve(ApprovalProxy, max)`, only if the on-chain allowance is short (Relay's approve step can lag a fresh approval) | off the click path |
| Sell | ghost | ApprovalProxy `0xccc8…15be` (or v3.2 `0x5567…2e58`). Relay `recipient` = float | **click path** |

**Why a top-up and not a permit.**
- EIP-2612 permits are not universal on fresh tokens.
- Relay's Permit2 path still needs a ghost `approve(Permit2)` tx.
- EIP-7702 delegation would let the float sponsor the ghost's calls, but it adds a delegate contract to audit.

A top-up plus one approve is two cheap txs ($0.0004 + $0.0008), and both stay off the click path. The arm costs about two inclusions; it was measured in the rehearsal and is recorded per run in `--live`.

If the sell is clicked before the arm lands, the script approves on the click path and records it as `T.lateApprove`.

### Mode `self` (the ghost holds its own ETH)

| Step | Signer / payer | Tx | Clock |
|---|---|---|---|
| Pre-fund | float → ghost | amount + 0.00006 ETH. Stands in for the NEAR Intents withdrawal that pre-funds a ghost in production | off the clock |
| Buy | ghost | Relay Router, `recipient` = ghost | **click path** |
| Arm | ghost | `approve(ApprovalProxy, max)` | off the click path |
| Sell | ghost | ApprovalProxy, `recipient` = ghost (ETH back to itself) | **click path** |
| Teardown | ghost → float | whole ETH balance minus its own fee | off the clock |

There is no float co-signer, no top-up and no meta-tx. The ghost pays its own gas.

### Checks before signing

Relay calldata is opaque, so the script never trusts the API for what it signs:
- `chainId` must be 8453.
- `to` must be on the published allowlist; both the v3 and v3.2 pairs are accepted (contract-addresses.md:138–147, switch on 2026-10-26 10:00 ET).
- `from` must be the signer, `value` must equal the amount, and `details.recipient` must be the intended recipient.
- The approve spender must be on the allowlist.

Then **`eth_simulateV1` runs on the `pending` Flashblock** with `traceTransfers`:
- buy: the ghost's token balance rises by at least `minOut`;
- sell: exactly the sold amount leaves, and at least `minOut` ETH reaches the recipient.

A failed simulation re-quotes once, on the clock. Sim is on by default; `--sim off` drops it. The rehearsal showed the sim caught every bad quote before sending (§4).

### What "filled" means on Base

Base serves pre-confirmed receipts:
- docs.base.org Flashblocks: "`eth_getTransactionReceipt` | Returns preconfirmed receipts"; llms-full.txt:14480 "return transaction receipts as soon as a transaction is included in a Flashblock".
- Verified live by `--dry`: the receipt of a tx in the unsealed block 52,829,414 came back while the sealed head was 52,829,413.

So **filled = pre-confirmed receipt with status 1.** The run also records:
- `conf`: the token balance visible at `pending`;
- `canon`: the sealed 2 s block containing the tx.

The pass verdict uses the pre-confirmation. The docs call Flashblock reorgs "rare" (flashblocks:100).

## 3. Dry run (`node run.mjs --dry`, 2026-10-19 22:16Z, `results/2026-10-19T22-16-28-772Z-dry.json`)

| Item | Value |
|---|---|
| RTT to `mainnet.base.org` / `mainnet-sequencer.base.org` | p50 265 ms / 375 ms (from Vietnam) |
| Base fee / priority | 0.005 gwei / 0.002 gwei (maxFee 0.017 gwei) |
| Pending block changes | median every 375 ms. Our 100 ms poll is bound by the 265 ms RTT, so it cannot resolve the documented 200 ms Flashblocks |
| Relay buy quote | 2088 (cold), 1000, 656, 687 ms. 0.0006 ETH → 279,348 boar (min 270,968 at 3%), impact −3.2% |
| Relay sell quote | 853, 1092 ms. Min-out boar → 0.000577 ETH |
| Simulation, float mode | buy 570,886 gas, ghost +279,345 boar ≥ min ✓. Approve 46,333 gas. Sell 759,110 gas, float +0.000575 ETH ≥ min ✓ |
| Simulation, self mode | buy 476,293 gas ✓. Sell 793,508 gas, ghost +0.000577 ETH ✓ |
| One click-path sim | 289 ms (one RPC call) |
| Signing (throwaway key) | 0.6–4 ms |
| Cost per tx | buy $0.0096 (5.6 KB calldata, L1 fee ~$0.00001) · top-up $0.0004 · approve $0.0008 · sell $0.009–0.013 |
| Round trip loss | ~4% of the trade (impact both ways + 0.15% Relay fee each way) ≈ $0.06 on $1.44 |

Dry mode never signs with a real key. Txs are signed with a random throwaway key, only to time signing and price the L1 data.

## 4. Rehearsal of the live code path (anvil fork, throwaway keys)

`node run.mjs --live --rehearse --rpc http://127.0.0.1:8547` runs the same code against `anvil --fork-url <public Base RPC> --chain-id 8453` with a 1 ETH anvil balance. Timings there are meaningless: anvil fetches fork state lazily. What it proved:
- **Float mode:** buy → arm (top-up + approve) → sell completed 4 times. The sell's ETH reached the float. Files: `…21-28-17…`, `…21-30-03…`.
- **Self mode:** pre-fund → buy → approve → sell → teardown completed 3 times. The ETH came back to the float with only dust left. Files: `…21-28-17…`, `…21-32-05…`.
- **`--sweep <addr> --live`:**
  - moved every ghost's ETH and the float's ETH out (dust ≤ 1.3e-7 ETH left);
  - a leftover token whose sell no longer simulated was skipped, not sent.
- **Failures were fork artefacts:**
  - "Return amount is not enough" and `ExecutionFailed()`: Relay quotes mainnet state, but the fork's pools are frozen. The simulation stopped every one of these before signing.
  - HTTP 429 from the free fork RPCs.
- **Bugs found and fixed:**
  - **`--sweep X --live` ran a 20-run live trade** (flag precedence). `--sweep` now wins.
  - anvil's 64 gwei priority suggestion. A fee cap now applies.
  - Relay's approve step lagging a fresh approval. The script now checks the on-chain allowance.
  - Failed sims now get one re-quote.

## 5. Latency budget per step (projection, buy; the sell has the same shape)

| Step | From this Mac | Notes |
|---|---|---|
| Quote (Relay) | 650–1000 ms | **Weakest step.** A cold TLS connection costs 2.1–2.5 s; production keeps the connection warm and pre-quotes on hover |
| Build + check | <1 ms | allowlist / value / recipient checks |
| Simulate | 265–290 ms | one `eth_simulateV1` on `pending`. Optional (`--sim off`) |
| Sign | 1–4 ms | secp256k1, local key |
| Send | ~265 ms | `eth_sendRawTransaction` RTT |
| Include (pre-confirmation) | ≤ 200 ms + propagation | next Flashblock |
| Receipt seen | 100 ms poll + RTT | |
| **Total** | **~1.7–2.0 s** | an enclave in a US region (RTT ~10–30 ms) would cut ~0.7 s |

`--live` records each step for each run: quote, sim, sign, send, incl, conf, canon.

## 6. Live run (run on 2026-10-19 by Claude under plan §11.11; results in §0)

**Funding.** Fund the float `0x02151d84EF543e4EcEF117a1a17A7Eaa9b424f52` on Base with **0.004 ETH (~$10)** from P1's Base out-leg.
- The run checks the balance first.
- 40 round trips lose about $2.5–3.5 (the ~4% round trip loss plus gas).
- The rest comes back with `--sweep`.

```sh
cd ~/Downloads/confidential-trenches/proofs/p4-speed/base && npm ci --silent && node run.mjs --live --runs 20 2>&1 | tee results/live-$(date +%s).log
```

Then return everything left (sells leftovers, empties every ghost, then the float):

```sh
cd ~/Downloads/confidential-trenches/proofs/p4-speed/base && node run.mjs --sweep "$(jq -r .address ~/.confidential-trenches/keys/p1-base.json 2>/dev/null || jq -r .address ../../../.keys/p1-base.json)" --live
```

**How the run behaves:**
- It runs float mode, then self mode, 20 buy+sell runs each. Each run uses a fresh ghost: the worst case, first buy of a new token.
- It stops a mode after 3 failures in a row.
- It writes `results/<ts>-live.json` with every step time, plus p50 and p95 click→filled per mode and side, judged against p95 ≤ 5 s.
- An optional Relay key goes in `~/.confidential-trenches/env` as `RELAY_API_KEY=…`. The script reads only that line and never prints it.

## 7. Open risks

1. **Relay key enforcement.** The docs say quote/v2 needs a key from 2026-10-02; keyless still answered on 2026-10-20. If it starts returning 401, add a free self-serve key (dashboard.relay.link) to `~/.confidential-trenches/env`.
2. **Relay sees the float↔ghost link.** Every quote names `user` = float and `recipient` = ghost, and Relay screens addresses with Chainalysis and HackBounty data (compliance.md:9–15).
   - For the confidentiality claim, a third-party API learning the pairing is a leak.
   - In production, quote from the enclave with a self-run router, or accept Relay as a trusted party and say so.
3. **v3.2 switch on 2026-10-26.** Approvals do not carry over (contract-addresses.md:147). The arm checks the allowance for whatever spender the live quote names, so it re-approves once.
4. **Distance.** RTT from Vietnam is 265–375 ms, and it appears 3–4 times in the budget. The production number depends on where the enclave runs.
5. **Float-mode top-up leftovers.** Each ghost keeps ~$0.05–0.10 of unused gas until a sweep (rehearsal: 0.000020–0.000034 ETH). In production, size the top-up from the simulated gas, or batch the sweeps.
6. **Self mode's real cost is the pre-fund.** The NEAR Intents withdrawal that funds a ghost happens before the click and is not measured here. It sets how quickly a brand-new ghost can trade.
7. **Flashblock pre-confirmation reorgs** are "rare" per the docs. A product UI should show "filled" on pre-confirmation and settle on `canon`.
8. `--send sync` (`eth_sendRawTransactionSync`) is wired but **unverified**: it is not in the Base docs read. The default is send + poll.

## 8. A never-bought Clanker v4 token: can a buyer exit? (2026-10-20 02:45Z, run by Claude under plan §11.11)

Why: the coverage paper (Q4) saw Relay sell quotes of about -99.9% on 5 of 7 fresh Clanker v4 tokens, four of them
returning the identical 0.000000977653702068 ETH, and called the sell side doubtful.

**Read-only first (02:41-02:44Z).** The same sell on token `0x130e6782…` today: Relay again 977,653,702,068 wei (-99.90%).
LI.FI (OKX route) for the same amount: 979,107,676,967 wei. Two aggregators agree, so it is not a Relay bug. Fresh
Clanker v4 tokens with no buys returned the same fingerprint (`0x165629fa…` -99.82%, `0xc9a66fec…` -99.83%).
Explanation (inference): every Clanker v4 pool starts at the same price with tokens only. A sell quoted before anyone
has bought has almost no ETH to take, and identical pools give identical numbers.

**Live, self mode, 1 round trip of 0.0002 ETH** on `0xC9A66Fec31B5Acdf6EdE9b85A2913799d8cfeb07` (KII, Clanker v4,
launched ~46 min before, sell quote -99.83% before our buy). Record `results/2026-10-20T02-45-28-154Z-live.json`
(dry run before it: `results/2026-10-20T02-44-23-706Z-dry.json`).

| Side | Tx | Click → filled | Quote | Result |
|---|---|---|---|---|
| Buy | `0x262c3bbc…` (block 52,837,484) | 923 ms | 1,998,472 KII, impact -1.16% | got 1,998,444 KII |
| Sell (quoted after the buy) | `0x2da4297b…` (block 52,837,489) | 1,166 ms | 0.000194664 ETH, impact -1.23% | all sold, 0 KII left |

- **A buyer can exit.** Once our buy put ETH in the pool, the sell quote was normal (-1.23%) and filled. The -99.9%
  quotes were sells quoted before any buy.
- **The dry run misleads here.** It simulated buy then sell in one `eth_simulateV1` call, but with the sell route quoted
  before the buy; that sell paid 0.000001066 ETH. The live path quotes the sell after the fill, from real state. So
  does the product (J5: the sell quote comes from the state after G's buy).
- **Product rule for a token nobody has bought:** never show a pre-buy sell quote as the exit price; the position's value
  comes from the pool state after G's own buy.
- **Check:** both receipts status 1 on `base.drpc.org` (not the send RPC); the ghost holds 0 KII.
- **Money:** float 0.00339050 → 0.00337441 ETH: **0.00001609 ETH (~$0.04 at $2,392.67, the dry run's price)**; the
  ghost keeps 0.00000021 ETH of dust.
