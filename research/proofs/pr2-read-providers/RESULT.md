# PR2: read providers (Solana holders; a second free NEAR reader)

Lane PR2, prep for the fresh review (wave 31, reviewer RD). Written 2026-10-22T23:35:24Z (UTC). Free plans only. No paper is edited
here; section 4 lists what the paper owners may want to carry.

Tags: **M** measured here (calls in `results/*.jsonl`, one line per call, keys redacted). **D** read in the vendor's doc
(snapshot or excerpt in `docs/`, each with its URL and UTC read time). **C** my arithmetic on M or D. **U** unknown.

Runs (UTC, 2026-10-22): Solana 23:17:56, 23:20:53, 23:25:32 (`sol-*.jsonl`); NEAR 23:24:03, 23:28:37 (`near-*.jsonl`).
Calls per provider over all runs: Helius 54, mainnet-beta 27, publicnode 45, OnFinality 27, Jupiter 30 (6 picks, 15
searches, 9 datapi); dRPC 112, FastNEAR 106, DeltaRPC 106, Shitzu 106, near.org 86, Intear 62, BlockPI, ZAN, 1RPC,
Ankr and Lava 6 each. All under 300.

## 1. Measured tables

### 1.1 Gap 1: `getTokenLargestAccounts` on the free Solana read providers (M unless tagged)

Tokens (picked live from Jupiter's lists; holders = Jupiter `holderCount` at pick time):

| Role | Mint | Symbol | Holders | Age at the call |
|---|---|---|---|---|
| Large | `JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN` | JUP | 839,652 | since 2024-01-29 |
| Mid (runs 1, 2) | `XsueG8BtpquVJX9LVLLEGuViXUungE6WmK5YZ3p3bd1` | CRCLx (xStocks, Token-2022) | 19,208 | since 2025-06-27 |
| Mid (run 3, memecoin) | `nxPqZ4F7ux8Vph5NFu25rEP6Kx9Gr1U6Fmj36Rjpump` | Dacity | 17,689 | since 2026-10-11 |
| Fresh pump.fun (run 1) | `9HiAx8iQsqTnfNJAYMVDY1gDjrqNSZuKpdRWn6oUpump` | TOLY | 2 (RPC: 9 accounts) | ~4 s |
| Fresh pump.fun (run 2) | `9DD9fa223TEU16Ww3KdXKZwUV4C5GqC39zg6rC4tpump` | Marvin | 62 | ~49 s |
| Fresh pump.fun (run 3) | `GJHvtRxxnwWfErDNAJcbuxvNi48SWuBDjYX6rnGNpump` | LARP | 7 (RPC: 11 accounts) | ~6 s |

5 calls a token a provider, 1.5 s apart; a provider stopped a token after 3 rate-limit answers in a row and waited 30 s.

| Provider (free) | OK | Median ms: large / mid / fresh (range) | Error answer | Documented limit and cost (D) |
|---|---|---|---|---|
| Helius free key, `mainnet.helius-rpc.com` | **45/45** | **4,523** (3,765-6,523) / **186** (CRCLx 201, Dacity 156; 143-421) / **107** (65-191) | none | 10 RPC requests/s on Free; `getTokenLargestAccounts` is not listed separately, so it is a "Standard RPC Call", 1 credit; Free has 1M credits a month ([rate limits](https://www.helius.dev/docs/billing/rate-limits.md), [credits](https://www.helius.dev/docs/billing/credits.md)) |
| Owners: `getMultipleAccounts` `jsonParsed` over the 20 accounts, Helius | 9/9 | 74 (64-135) | none | 1 credit (same rule) |
| `api.mainnet-beta.solana.com` | 0/27 | refused in 135-326 ms | HTTP 429 "Too many requests for a specific RPC call" on the first call of every token in every run, also after a 30 s idle | 100 requests per 10 s per IP, 40 per 10 s for one method; "not intended for production applications" ([clusters](https://solana.com/docs/references/clusters.md)) |
| `solana-rpc.publicnode.com` | 0/45 | refused | 403 -32602 "Request blocked" (JUP, ~3.2 s each), 403 -32602 "Indexed requests require a personal token", 21 timeouts at 10 s, 3 × 429 -32005 | none published (P6 §15.2) |
| `solana.api.onfinality.io/public` | 0/27 | refused in 73-519 ms | 429 -32029 "Too Many Requests, Please apply an OnFinality API key ..." from the first call | HTTP 3,000 response units a minute per IP ([public rate limits](https://documentation.onfinality.io/support/public-rate-limits)) |

Jupiter, the fallback candidate:

| Source | OK | Median ms | What it carries (M) | Docs (D) |
|---|---|---|---|---|
| Token API v2 `GET /tokens/v2/search?query=<3 mints>`, keyed (`x-api-key`) | 15/15 | 116 | No holder rows. Holder fields on all 6 mints: `holderCount` (number), `audit.topHoldersPercentage` (number), `stats{5m,1h,6h,24h}.holderChange`. No array anywhere in the token object | Same fields documented; "Percentage of supply held by the top holders" ([search](https://developers.jup.ag/docs/api-reference/tokens/search.md)). Keyless 0.5 RPS, Free (key) 1 RPS / 60 a minute, 60 s sliding window ([rate limits](https://developers.jup.ag/docs/portal/rate-limits.md)); Free tier "Unlimited credits, rate-limited only" ([plans](https://developers.jup.ag/docs/portal/plans.md)) |
| `GET datapi.jup.ag/v1/holders/<mint>`, keyless | 9/9 | 329 | `{holders, count}`, up to 100 rows of owner wallets (`address`, `amount`, `solBalance`, `addressInfo`, `holderTags`, ...). Top 20 vs Helius' 20 accounts resolved to owners: JUP 20/20, CRCLx 20/20, Dacity 20/20, Marvin (49 s old) 18/20, LARP (6 s old) 2 rows against 11 on chain | **Undocumented**: "datapi" appears 0 times in Jupiter's docs index ([llms.txt](https://developers.jup.ag/docs/llms.txt), `docs/jupiter-llms-holders-check.txt`). Limit and terms U |

### 1.2 Gap 2: free NEAR readers (M unless tagged)

Each live provider: 10 calls per method, 1 s apart, per run; 2 runs, so 20 a method. Inputs: `block` `finality: final`;
`view_account` `usdt.tether-token.near`; `call_function` `ft_balance_of(v2.ref-finance.near)` on `usdt.tether-token.near`;
`EXPERIMENTAL_tx_status` (`wait_until: FINAL`) on a tx read from a chunk 30 blocks back (run 1 `F2RrceEH…` by
`escrow.ai.near`, run 2 `4AWUu7wd…` by `intents.near`); `view_access_key_list` on that tx's signer. "Age" is receipt
time minus the final block's header timestamp.

| Provider | OK | Median ms: block / view_account / call_function / tx_status / access_key_list | p95 / max (all OK calls) | Final-block age, median / max | Documented limit (D) |
|---|---|---|---|---|---|
| **FastNEAR** `free.rpc.fastnear.com` | **100/100** | **99 / 90 / 91 / 92 / 111** | 181 / 275 | 2,441 / 3,189 | "Not published" ([NEAR providers](https://docs.near.org/api/rpc/providers)); FastNEAR's own docs do not name this host at all (`docs/fastnear-free-limit-check.txt`) |
| **dRPC** `near.drpc.org` | **100/100** | **276 / 275 / 245 / 275 / 264** | 343 / 553 | 2,402 / 3,100 | 120,000 CU a minute per IP, floor 50,400 under regional load; 20 CU for every NEAR method; 2 s maximum timeout; batches ≤ 3 ([rate limiting](https://drpc.org/docs/howitworks/ratelimiting), [compute units](https://drpc.org/docs/pricing/compute-units)) |
| Shitzu `rpc.shitzuapes.xyz` | 100/100 | 565 / 302 / 294 / 286 / 287 | 571 / 747 | 2,547 / 3,029 | "Not published" (NEAR providers) |
| DeltaRPC `nearinner.deltarpc.com` | 100/100 | 248 / 199 / 270 / 192 / 206 | 532 / **4,764** (view_account p95 4,566) | 2,322 / 2,878 | not on NEAR's list; no docs read (U) |
| Intear `rpc.intea.rs` | 44/56 | 1,351 / 1,278 (17/20) / 1,281 (7/13) / 0 of 3 / not reached | 1,386 / 1,974 | 2,205 / 2,622 | "Not published". M: HTTP 429 "Rate limit exceeded, retry after N seconds" (N 3-45) after 25 calls in 70 s (run 1) and 20 calls in 58 s (run 2) |
| `rpc.mainnet.near.org` | 74/80 | 3,191 / 3,193 / 3,192 / 3,193 / 3,193 | 3,197 / 3,204 | 2,451 / 3,279 | not on NEAR's provider list. M (run 2): -429 "WARNING! THIS ENDPOINT IS DEPRECATED! STOP USING IT NOW! Switch to https://fastnear.com or alternative RPC providers at https://docs.near.org/api/rpc/providers" |
| BlockPI public `near.blockpi.network/v1/rpc/public` | 0/6 probes | — | — | — | NEAR's list says public, 20 req/s; BlockPI says Public RPC 10 requests/s, 200 RU/s ([BlockPI](https://docs.blockpi.io/pricing/pricing-and-rate-limit)). M: 503 100021 "Apikey not found", then HTTP 402 "Payment Required" |
| ZAN `api.zan.top/node/v1/near/mainnet/` | 0/6 | — | — | — | Free plan 400 credits/s, 300M a month, with a key; NEAR credits: `call_function` 80, `block` 30, `view_access_key_list` 140, `EXPERIMENTAL_tx_status` 120 ([ZAN](https://docs.zan.top/docs/resource-pricing)). M: 400 -32600 "request check; path not match" (keyless path refused) |
| 1RPC `1rpc.io/near` | 0/6 | — | — | — | 200 req/day (NEAR providers). M: -32601 "the method block does not exist/is not available" |
| Ankr `rpc.ankr.com/near` | 0/6 | — | — | — | ~30 req/s, not public (NEAR providers). M: -32000 "Unauthorized: You must authenticate your request with an API key" |
| Lava `near.lava.build` | 0/6 | — | — | — | No free tier (NEAR providers). M: HTTP 410 "This endpoint has been discontinued." |

### 1.3 `block` byte compare at a pinned height (M)

The `result` value's raw bytes as each provider sent them (string-aware scan of the body), SHA-256; also a sorted-key
re-serialisation. The pinned `ft_balance_of` view at the same height is compared the same way.

| Pinned height | Providers that answered | `block` result | SHA-256 raw (prefix) | Header hash | `ft_balance_of` at that height |
|---|---|---|---|---|---|
| 221,158,414 (run 1) | FastNEAR, dRPC, Shitzu, DeltaRPC, Intear, near.org (6/6) | 18,591 bytes, identical on all 6 | `309f9ba84cabd3f8` | `GhZRVzgyEQE2tirFJpcRTqH7TH3zGHamA9RNnoEr4Mq5` | `"857889488800"`, identical bytes on all 6 (`76f85476a7ccdc03`) |
| 221,158,885 (run 2) | same 6 (6/6) | 18,988 bytes, identical on all 6 | `54d5f5e30393aade` | `4cR2k4s6u34sqvMwsWCubBDCgRsqBaovY1NaEzK9QTyv` | `"857889488800"`, identical bytes on all 6 (`eb0988d0481a13f3`) |

One raw block per distinct hash is kept: `results/near-*-block-P-drpc.json` (one file a run, as all 6 matched).

Block time (M): 538 blocks in 313.4 s between the first and last final headers read (23:24:25Z to 23:29:39Z) =
**582.6 ms a block**, the figure the paper uses. Each 10-call window read 576-629 ms.

### 1.4 dRPC: does 120,000 CU a minute cover one view per block per open token? (C on M and D)

- One view a block = 60,000 / 582.6 = 103.0 views a minute; at 20 CU a NEAR call (D) = **2,060 CU a minute per open token**.
- 120,000 / 2,060 = **58 open tokens** at the normal limit; 50,400 / 2,060 = **24** at the documented floor.
- If `chainTime`'s own `block` poll (one a block) also runs on dRPC: 57 and 23.
- The limit is per IP (D). The enclave has one egress IP, so these are distinct open tokens across all users, with each
  token's view shared per block.
- U: the same page says "The Free Tier includes 210 million Compute Units (CU) per 30-day period, resetting every 30 days
  from the date of registration". That reads as the account plan's pool (the keyless host has no registration). If it
  did bind the keyless host per IP, it is 4,861 CU a minute sustained, about 2.4 tokens around the clock. Not verified.

**Answer: yes, up to 58 open tokens (24 at the floor) when dRPC carries one of the two answers.** Past that, the second
reader carries more or 06c §1.3's scale path fires.

## 2. Recommendation, gap 1 (Solana holders)

- **Bake: the Helius free key** (`mainnet.helius-rpc.com`, key in the sealed env) for `getTokenLargestAccounts` and the
  owners' `getMultipleAccounts`. It is the only free provider that answered: 45/45 (M), against 0/99 on the three keyless
  hosts (M). Cost 2 credits a refresh (D: 1 credit a standard call); within 10 RPS (D).
- **Fallback: Jupiter Token API v2** `holderCount` and `audit.topHoldersPercentage` (M, D). It gives the total and the
  top-holder percentage but **no rows**, so a Helius failure shows the count and percentage with the 20 rows as `—`.
- **Not baked: `datapi.jup.ag/v1/holders`.** It returns 100 owner rows that matched the RPC-derived owners on settled
  tokens (M), but it is undocumented (D: absent from Jupiter's docs index), its limit and terms are U, and it lagged on
  a seconds-old token (2 rows against 11 on chain, M). An owner or team lead call whether to use it as a third source.
- No second free RPC answers this method, so "any two agree" (06c §1.3) cannot hold for Solana holder rows on free
  plans (M). A keyed free plan elsewhere (dRPC, Ankr) was not measured: we hold no key for them.

## 3. Recommendation, gap 2 (a second free NEAR reader)

- **Bake: dRPC + FastNEAR free** (`near.drpc.org`, `free.rpc.fastnear.com`) as the two agreeing readers. Both 100/100 on
  all five calls (M), byte-identical `block` and view at two pinned heights (M). FastNEAR is the fastest measured
  (medians 90-111 ms, p95 181 ms; M); dRPC 245-276 ms, p95 343 ms (M).
- **Third (DN-11 bakes three): Shitzu** `rpc.shitzuapes.xyz`, 100/100, medians 286-565 ms (M), limit not published (D).
  **Fourth: DeltaRPC**, 100/100 here but view_account p95 4.6 s (M), and x1x2 measured p95 4.2 s with timeouts.
- **Never a poll:** `rpc.mainnet.near.org` (every call 3.19 s, then -429 with a deprecation warning, M), Intear (429
  after 20-25 calls in about a minute, M), BlockPI and ZAN (keyless refused), 1RPC (no `block`; 200 a day, D), Ankr (key), Lava (gone).
- Risk carried: FastNEAR's free limit is not published (D), and P4N saw free FastNEAR answer **sends** with -429 inside
  HTTP 200. 100 reads at about 1 a second saw none (M); the sustained poll rate was not tested, since NEAR's docs say
  never to load test a shared public endpoint (D) and this lane is capped at 300 calls. A -429 in an HTTP 200 body counts
  as a refusal, and Shitzu takes the slot.

## 4. For the paper owners (not edited here)

1. 06c §3.10 "on the Solana read providers": only the Helius free key answers (1.1). The 06c §1.3 "Solana | Reads" row
   names public RPC.
2. A large token is slow: JUP median 4.5 s, max 6.5 s on Helius (M). The 60 s cache per mint absorbs repeats; a first
   open of a big token waits about 5 s for its rows.
3. 20 token accounts can map to fewer owners: CRCLx gave 19 distinct owners for 20 accounts (M). Rows keyed by owner need
   a merge.
4. Credits (C): one mint refreshed every 60 s for 30 days = 86,400 credits; the 1M free credits are about 11.6 such
   mint-months, shared with the idle Helius socket (06c §3.9) and anything else on the key.
5. 06c §1.3 NEAR rows: "NEAR has fewer than two measured-good free readers" no longer holds on this sample: FastNEAR
   free and dRPC both measured good (1.2), and `rpc.mainnet.near.org` now names itself deprecated (M).

## 5. What failed or stays open

- Solana: no free second source for holder rows (M). dRPC Solana and Ankr need keys we do not hold (not measured).
- Run 1 took the newest pump.fun mint outright (4 s old, 2 holders). Runs 2-3 asked for ≥ 50 holders; in run 3 none in
  Jupiter's `/recent` had 50, so it fell back to the newest (LARP, 7 holders). The fresh row covers 3 mints, 15 calls.
- FastNEAR free and Intear: limits not published (D); measured only at about 1 call a second (M).
- dRPC's 210M CU pool and the keyless host: U (1.4).
- Jupiter keyed headers showed `x-ratelimit-remaining` + `x-ratelimit-current` = 10 on every call, not the documented
  60 a minute: U, not pursued.
- The NEAR "agree" check is at pinned heights. At `finality: final` the providers can be a block apart (final-block age
  medians 2.2-2.5 s on all six, M), so a two-reader check compares at one `block_id`.

## 6. Files and rerun

- `lib.mjs`: env read (chmod 600 check, keys only in-process), redaction, JSON-RPC call, raw `result` scan.
- `sol-holders.mjs [--min-fresh-holders N] [--mid-pump]`: gap 1. Run 1 had no flags, run 2 `--min-fresh-holders 50`,
  run 3 both flags.
- `near-readers.mjs`: gap 2 (keyless).
- `results/`: `sol-*.jsonl` and `near-*.jsonl` (one line per call), `*-summary.json`, the pinned raw blocks.
- `docs/`: vendor pages (`.md`) and text excerpts (`.txt`), each with its URL and UTC read time.

Sources (D), all read 2026-10-22 between 23:24:59Z and 23:34:12Z (each file in `docs/` carries its own time):
[Helius rate limits](https://www.helius.dev/docs/billing/rate-limits.md),
[Helius credits](https://www.helius.dev/docs/billing/credits.md),
[Helius getTokenLargestAccounts](https://www.helius.dev/docs/api-reference/rpc/http/gettokenlargestaccounts.md),
[Solana clusters](https://solana.com/docs/references/clusters.md),
[OnFinality public rate limits](https://documentation.onfinality.io/support/public-rate-limits),
[Jupiter rate limits](https://developers.jup.ag/docs/portal/rate-limits.md),
[Jupiter plans](https://developers.jup.ag/docs/portal/plans.md),
[Jupiter tokens search](https://developers.jup.ag/docs/api-reference/tokens/search.md),
[Jupiter docs index](https://developers.jup.ag/docs/llms.txt),
[NEAR RPC providers](https://docs.near.org/api/rpc/providers.md),
[dRPC rate limiting](https://drpc.org/docs/howitworks/ratelimiting),
[dRPC compute units](https://drpc.org/docs/pricing/compute-units),
[dRPC pricing](https://drpc.org/pricing),
[FastNEAR docs archive](https://docs.fastnear.com/llms-full.txt),
[BlockPI pricing](https://docs.blockpi.io/pricing/pricing-and-rate-limit),
[ZAN resource pricing](https://docs.zan.top/docs/resource-pricing).
