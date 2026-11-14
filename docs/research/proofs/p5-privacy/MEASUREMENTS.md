# Paper 5 measurements M4, M5, M6, M7, M8, M9, M10, M11, M13

Read 2026-10-20 between 06:23Z and 08:05Z; M11 on 2026-10-21 06:00Z-06:23Z; M7 on 2026-10-21 07:54Z-07:58Z (each run's own `date -u` read is in its results JSON as `dateUReadBeforeRun`).
Keyless endpoints only; no key, `.env` or UNRLZD file was opened; nothing was sent. Scripts: `m4.mjs`, `m5.mjs`, `m6.mjs`,
`m7.mjs`, `m10.mjs`, `m11.mjs` (house style of `m12.mjs`); results in `results/`. M8, M9 and M13 are document reads (no script).
`docs/spec/*` is not edited; the coordinator folds these in.

Headlines:
- **M6:** the vault's fresh recipients almost never buy a pump token: 2 of 160 fresh recipients within 2 h (about 0.7 an hour). A ghost is not hiding among similar buyers.
- **M4:** near-equal in/out pairs at the treasury are the normal shape: about 176 an hour, 48% of all outs. Only 3.7 an hour are between two 64-hex accounts.
- **M5:** about 1,475 an hour pay both a Helius and a Jito tip account; the app's 5,000 + 10,000 shape is about 200 an hour (95% range 61-339).
- **M7:** pooled, the pill's crowd is 136 public shields an hour (median 11 per 5 min). Per chain a 5-minute bucket holds 1 at the median and 28-49% are empty; 75% of intervals hold 3 or more at 30 min on every chain (PM2). The lull has no shield from 03:59Z to 05:38Z.
- **M10:** 37 Solana ghosts are clean. Base: 67 of 67 live ghosts keep a max allowance. NEAR: no DCL registration left; wrap.near and token registrations stay.
- **M11:** the public-data linker ties 177 of 177 P4 ghosts to their float, each by at least two features. P1: no deposit-withdrawal pair is linked through the treasury legs themselves; 2 of 8 are linked by what happened after (an address reused by the user, and a shared counterparty one hop on).
- **M8, M9, M13:** docs are silent on Relay's data flow and retention (UNKNOWN); 1Click status has no origin-address field but carries origin tx hashes; no source shows a passkey provider can or cannot derive PRF.

One finding outside the list: the bridge lulled 2026-10-20 about 03:45Z to 05:45Z. The NEAR treasury fell to about 100 txs an hour (from about 550), and the Solana vault had 3 txs between 04:00 and 05:30Z. Since 06:00Z the vault has had only a handful of txs per 30 minutes (15, 1, 3, 1 in the four half-hours to about 07:50Z). Read from two chains, so it is not an index gap. M12's 24 h means (ended 03:33Z) do not include it.

---

## M6. The crowd a Solana ghost hides in (PM1, T01)

**Question.** Of the fresh addresses the Solana vault pays out, how many buy a pump.fun token soon after, and after what delay?

**Method.** `m6.mjs`. Vault `6tckHFBpiJ8YgYN8FUskvtvTpXQZ55g5LHeo1kvELoDQ`, fee payer `DuSs7rCr7oTLHjM29QQ8NwDViaahTU58qqxaJVyAkgbn`, program
`dahPEoZGXfyV58JqqH85okdHmpN8U2q8owgPUXSCPxe` (all three from `RT:283` E-F1, re-seen in every sampled tx). A payout is a successful tx with the log
`Instruction: FinalizeTransferSol` and that fee payer; the recipient is the largest lamport gain other than vault and fee payer (the M1 rule).
Every third successful vault tx in the window was read. A recipient is **fresh** if the payout is its first tx (no signature before it).
A **buy** is a successful tx, top level or inner, that runs a pump program and raises the recipient's balance of a non-wSOL token; the
first one within 2 h of the payout counts. At most 25 txs per recipient are read (3 recipients hit the cap in run 2, so the buy share is a
lower bound by at most 3 of 314).

**Pump program ids, read from real txs** (my parser flagged them; I read the logs):
- Bonding curve `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`: tx `5RnnVgg9KDC75QkNEdq9pEwGMpBzasV23ioLH4Tc1hzwkwViXuWEf5wnURErQrFJfNfcHdc817d6AJ2GwRbtwAuN` (a Sell via a router), buy tx `57XyhcRqTUDAiRcZMx4xbMtjP8ouYxhY7H48uVnKQcCjXUF2zZ8jDcx6bQQM7DS2ybe3pFhupBTTiTeCNuzJ4pD7` (logs `BuyExactQuoteInV3`), and in run 2 `2xsaqRQTdrEimcXKZaDpxqUkouBEqz5J9332jEZXBpga7sQ8tWapKKodGeF7GMKmZunPp7x25XnK8BqJDoTa6jaD` (`BuyV2`).
- PumpSwap AMM `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA`: tx `bj7gEZkBzy7ZxWV7SzjDhtyeF7ofPJventCHu82qkiYehtk2MFywYcbmhkd52ffawLWrtJTTDtQzZXWLDyjCnJ9` (`BuyExactQuoteIn`, signer `547xsCYT…`) and in run 2 `2VwpJoGGJaQmnXhuUswSTvanPoH4eCYtk9UgSHfWisHCwmaEEfgipV8fyLZP2sEcBbDpJQEUL5ti6rvTHXvCLvUt`.
- They match the ids P4S used (`P4S` volume-account notes). The parser needs `maxSupportedTransactionVersion: 1`; with 0 the node refused some pump txs (-32015).

**Window.** Run 2 (the numbers below): payouts 2026-10-19 20:25:59Z to 2026-10-20 05:25:59Z (9 h), vault slots 458,965,147 to 459,094,572,
observed until 07:25:59Z so every payout has its 2 h. Run began 07:25:59Z at finalized slot 459,146,665. 1,850 successful vault txs in the window, 617 read,
**314 payouts to 302 distinct recipients**. The window includes the lull: the 04:25-05:25Z hour had no payouts. Run 1 (pilot, 149 payouts,
23:27Z-04:27Z, 06:27Z start, slot 459,130,459) is kept as `results/m6-2026-10-20T06-27-21-733Z.json`.

**Numbers (run 2; run 1 in brackets).**
| | All 314 payouts | Fresh recipients (160) |
|---|---|---|
| Share | fresh **51%** [46% of 149] | |
| buy a pump token within 1 min | 4 (1.3%) [3] | 0 [0] |
| within 5 min | 10 (3.2%) [6] | 2 (1.3%) [0] |
| within 30 min | 12 (3.8%) [9] | 2 (1.3%) [0] |
| within 2 h | 16 (5.1%) [9, 6%] | 2 (1.3%, range about 0.3-4.5%) [0 of 69] |

Pooled over both runs: 2 of 229 fresh recipients bought (0.9%). Buyers are mostly established wallets (14 of 16 were not fresh). Of the 16 buyers, 12 used PumpSwap, 4 the curve.
Both fresh buyers are bonding-curve buyers at 119 s and 127 s; one has 439 txs in the 2 h, so it is a bot, not a person.
What the other fresh recipients do: 39 of 69 in run 1 had a later tx in 2 h, mostly one plain system transfer out (checked by reading 14 of them); a few `DepositNative` into another program.

**Delay payout to first pump buy, seconds (JSON the canary runner can draw from).** In `results/m6-2026-10-20T07-25-59-039Z.json`:
`delaySec_allBuyers.draw` and `delaySec_freshBuyers.draw`.
- All buyers, n=16: min 37, p10 38.5, p25 60, median 123, p75 1,306.5, p90 3,341, max 4,587. Draw list: `[37,38,39,39,67,71,77,119,127,266,570,955,2361,3331,3351,4587]`.
- Fresh buyers, n=2: `[119, 127]`. Too few to draw from. **The fresh-buyer delay distribution cannot be built from this vault at this size.**

**Per hour.** Estimated payouts per hour 104.7 (mean of 9 hourly buckets, includes the zero hour; sample count x 3). Fresh-funded pump buyers (2 h rule): about **0.7 an hour**
(2 in 9 h, x 3 for the stride 3 sample: 0.67); within 5 min the same 2. Per hourly bucket: 0 in seven, 1 in the 21:25Z and 22:25Z hours.

**Second provider.** 25 recipients redone on `solana-rpc.publicnode.com`: buy delays equal in 25 of 25; fresh flag equal in 22 of 25. The 3 differences
are publicnode answering "fresh" where mainnet-beta shows older txs; I read those by hand: publicnode returns no history older than about a day. So publicnode
cannot confirm "fresh", only "not fresh"; the fresh flag rests on `api.mainnet-beta.solana.com`. (Run 1 had the same 3 of 25 under the older, stricter comparison.)
Provider calls run 2: mainnet-beta 1,932 (90 x 429, backed off), publicnode 90.

**What it means.**
- PM1 (W): do not size W from a crowd of look-alike buyers: there is none. Within any window up to 2 h, about 0.7 fresh-funded pump buyers an hour appear; in a 5-minute window that is about 0.06. A ghost that buys within seconds of its payout is, on Solana, nearly alone in that behaviour class. What hides it is the payout crowd (about 105 an hour here, 21.5 an hour confidential per M12), only if nothing else in the buy distinguishes it (L6-PUB shapes). Keep W at least as long as the observed delays that matter: payout-to-buy median 123 s, p75 about 22 min.
- T01: draw canary deposit-to-buy delays from `delaySec_allBuyers.draw` (n=16) only as a stand-in; say in the T01 report that the fresh-buyer set was 2. A larger sample needs fresh pump buyers from all funders, not this vault.
- T22 and C50: none from M6.
- Limits: one 9 h window, a lull inside it; stride-3 sample; 25-tx cap; buyers who only buy after 2 h are missed; the pump rule counts any pump program run with a token gain (Jupiter routes through pump pools count).

---

## M4. Treasury shield/unshield pairs (C50 base rate)

**Question.** How often does the confidential treasury `51e8f94d77b5e90dc9852ca6113771e11e8382ce69473a75e313e41665de7cbe` take a transfer in and send one out of near-equal size (within 1%) within 60 s?

**Method.** `m4.mjs`. Every tx naming the treasury on `tx.main.fastnear.com` (keyless), then the `nep245 mt_transfer` events at `intents.near` (each movement once; the dip4 `transfer` events repeat them). In = new owner is the treasury, out = old owner is the treasury; time = the receipt's block time.
Pair = same token, |out - in| <= 1% of in, |dt| <= 60 s, each event used once, closest in time first. Chance level: the same count with every out shifted +10 min and +20 min.

**Window.** 2026-10-19 21:40:00Z to 2026-10-20 03:40:00Z (6 h), blocks 220,712,701 to 220,749,286, 2,943 treasury txs, run read at 08:02Z (`date -u` 08:01:58Z). The window ends before the lull; the longest gap between treasury txs inside it is 108 s. (My first run covered 00:29Z-06:29Z and hit the lull; I dropped it. The first note I wrote called the lull an index hole; the Solana vault shows the same lull, so it is real.)

**Numbers, per hour (mean; hourly min-max).**
- In transfers 372.7 (299-448); out transfers 367 (302-445).
- **Pairs: 176.5 an hour (147-224); 1,059 in 6 h; 48.1% of all outs sit in a pair.**
- By counterparty: both counterparties named (solver accounts such as `solver-multichain-asset.near`, `solver-priv-liq.near`): 102.8 (86-133); the same account on both sides: 70 (55-106); **both 64-hex accounts (per-quote or user accounts): 3.67 (1-6), 22 in 6 h**.
- By token: Solana (`sol.omft.near`) 17.8 an hour, NEAR (`wrap.near`) 5.0, Base 0.67, all other tokens 153.
- Chance level (shifted outs): 10 and 6 pairs in 6 h (1.7 and 1.0 an hour), of which 2 and 1 between two 64-hex accounts. So real pairs are far above chance, and the 64-hex class is about 3.7 against 0.3.
- The first examples are solver pass-through legs: an in of 95,739,744 and an out of 95,739,648 of a USDC token 3.7 s apart, through `solver-multichain-asset.near` and `solver-priv-liq.near`.

**Second source.** 6 random pairs, both txs read again on `rpc.mainnet.near.org` (EXPERIMENTAL_tx_status): all 6 in and 6 out transfers found with equal token and amount.

**What it means.**
- C50: a near-equal in/out pair within a minute is the ordinary shape of the treasury, about every 20 seconds, produced by solver legs. A refill-shaped pair between two 64-hex accounts happens 3.7 an hour. The amount jitter (GHO-28) separates a refill from its deposit only inside that small class; it does not make the treasury quiet. The 1% tolerance is generous: tighten it for T05 and it will thin the solver pairs first.
- PM1-PM3: ND-6's tolerance epsilon is untouched; this is a base rate, not a size distribution.
- T01 and T22: none.
- Limits: 6 h; amounts compared as raw token units, so a cross-asset leg (a different token on each side) is never paired; the lull hours were excluded.

---

## M5. Helius Sender plus Jito tips in one tx (L6-PUB fingerprint)

**Question.** Per hour, how many Solana txs pay both a Helius Sender tip account and a Jito tip account, and how many at the app's 5,000 (Helius) and 10,000 (Jito) lamports (`P4S` tip shape)?

**Tip accounts** (all 18 checked verbatim in the fetched pages, 2026-10-20):
- Helius Sender, 10 accounts, `https://www.helius.dev/docs/sending-transactions/sender`: `4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE`, `D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ`, `9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta`, `5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn`, `2nyhqdwKcJZR2vcqCyrYsaPVdAnFoJjiksCXJ7hfEYgD`, `2q5pghRs6arqVjRvT5gfgWfWcHWmw1ZuCzphgd5KfWGJ`, `wyvPkWjVZz1M8fHQnMMCDTQDbkManefNNhweYk5WkcF`, `3KCKozbAaF75qEU33jtzozcJ29yJuaLJTy2jFdzUY8bT`, `4vieeGHPYPG2MmyPRcYjdiDmmhN3ww7hsFNap8pVN3Ey`, `4TQLFNWK8AovT1gFvda5jfw2oJeRMKEmw7aH6MGBJ3or`. The page gives minimum tips of 5,000 lamports (SWQOS-only) and 1,000,000 (Sender Max).
- Jito, 8 accounts, the `getTipAccounts` example on `https://docs.jito.wtf/lowlatencytxnsend/` (that page says to call `getTipAccounts` for the live list; I did not call the block engine, so a change since the page is possible): `96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5`, `HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe`, `Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY`, `ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49`, `DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh`, `ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt`, `DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL`, `3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT`. Minimum tip 1,000 lamports.

**Method.** `m5.mjs`. `getBlock` (jsonParsed, full transactions, finalized) on 1 slot in 100, random offset. A tx counts when it succeeded and has a System `transfer` to a Helius account and one to a Jito account (top level or inner). Per hour = matches per sampled block x blocks per hour (measured: 4.604 slots a second, not 2.5; the slot time is about 217 ms now; my first two runs assumed 9,000 slots an hour, understated by 1.8x, and I dropped them).

**Window.** Run read 07:26Z (`date -u` 07:25:59Z). Blocks from 2026-10-20 03:25:36Z to 07:25:54Z (4 h), sampled slots 459,080,477 to 459,146,677, finalized slot at start 459,146,683. **663 blocks read, 0 skipped, 609,527 txs** (avg 919 a block). Sample 1 slot in 100, about 1% of the window (so the per-hour figures carry wide ranges). Read on `solana-rpc.publicnode.com`, re-read on `api.mainnet-beta.solana.com`.

**Numbers.**
| Cell | Sampled txs | Per hour | 95% range |
|---|---|---|---|
| Both tips, any amounts | 59 | **1,475** | 1,099-1,851 |
| Helius 5,000 + Jito 10,000 (the app's shape) | 8 | **200** | 61-339 |
| Helius 5,000 + Jito 5,000 | 3 | 75 | 0-160 |
| Helius 10,000 + Jito 10,000 | 0 | 0 (under about 75 at 95%) | |
| Helius 10,000 + Jito 5,000 | 0 | 0 | |

Commonest shapes among the 59: Helius 10,000 + Jito 65,000 (30), Helius 5,000 + Jito 10,000 (8), Helius 5,000 + Jito 2,000 (6), Helius 5,000 + Jito 5,000 (3).

**Second provider.** All 46 sampled blocks that hold a match, re-read on mainnet-beta: 46 of 46 have the same match count, tx signatures and tip amounts.

**What it means.**
- L6-PUB: the two-tip shape is common (about 1,500 an hour), so it is no class marker alone. The exact 5,000 + 10,000 pair is rarer (about 200 an hour); 8 of 59 tipped txs. Together with the compute budget, wSOL ATA and Jupiter shape, it narrows, but the amounts are not unique. A fixed tip pair is a fingerprint worth randomising; the cheapest change is to draw the Jito tip from the 2,000-65,000 range that others use.
- PM1-PM3, T01, T22, C50: none.
- Limits: 4 h on one afternoon (UTC); about 1% of slots; the Jito list from a doc example.

---

## M10. Traces the P4 test ghosts left (T22 rehearsal)

**Question.** After the P4 runs and sweeps, what is left on chain at the ghost addresses, against what teardown should have closed (matrix L8-PUB)?

**Method.** `m10.mjs`. Ghost addresses are the `ghost` fields in `proofs/p4-speed/{solana,base,near}/results/*.json` (public addresses, each checked against its chain's address format; `ghosts.json`, a key file, was never opened). Only the result JSONs were read, not the older `.log` files, so ghosts that exist only in logs are not covered.
- Solana: `getTokenAccountsByOwner` (spl-token and Token-2022), the pump `user_volume_accumulator` PDA under the curve program and under PumpSwap (`getMultipleAccounts`), and the SOL balance. Positive control: `547xsCYT…` (a PumpSwap buyer) shows 2 token accounts and a PumpSwap volume PDA.
- NEAR: `storage_balance_of` on `dclv2.ref-labs.near`, `wrap.near` and the token that run traded. Control: `dclv2.ref-labs.near` on `wrap.near` shows registered (1.25e21); `dclv2` answers the method (`none` for itself).
- Base: `allowance(ghost, ApprovalProxy)` by `eth_call` for both proxies P4B names (v3.1 `0xccc88a9d1b4ed6b0eaba998850414b24f1c315be`, v3.2 `0x5567954cd026cebfe486062cb75848e0f1c12e58`) on the traded token `0x0cbf291ba052174879d90bf781df1a5f2bc5bb07`; ETH balance and nonce.

**Windows (reads).** Base: 2026-10-20 06:49Z (`date -u` 06:49:21Z), latest block 52,844,808, `mainnet.base.org` then `base.drpc.org`. Solana: 06:59Z (`date -u` 06:59:39Z), finalized slot 459,139,400. NEAR: 07:54Z (`date -u` 07:54:39Z), latest block 220,775,132, `near.drpc.org` then `rpc.mainnet.near.org`.

**Numbers.**
| Chain | Ghosts | What teardown should close | Found |
|---|---|---|---|
| Solana | 37 (all live) | token accounts, both volume PDAs, SOL swept | **0 token accounts, 0 volume PDAs under either program, 0 SOL left on all 37**; clean |
| NEAR | 66 (52 live, 14 rehearse) | the DCL registration refunded; wrap.near and token storage stay by design (L8-PUB) | **DCL registered: 0.** wrap.near registered: 45. Token registered: 49 (4 have the token but not wrap). Clean: 17. 0 unread, 0 query errors |
| Base | 87 (67 live, 20 rehearse) | nothing (the max approval and dust stay by design) | **67 of 67 live ghosts hold a max allowance to the v3.1 proxy**; 0 to v3.2; ETH dust on 67, 14,081,613,945,856 wei in total (about 0.0000141 ETH); the 20 rehearse addresses are untouched (nonce 0) |

Token storage was read only for the token each ghost's run named, so "no ghost registered on two tokens" (T22) is not tested here.

**Second provider.** Base: 25 of 25 equal on `base.drpc.org`. NEAR: 12 of 12 equal on `rpc.mainnet.near.org`. Solana: all 37 clean on mainnet-beta; I did not re-read the clean ones on publicnode (it shows no history older than about a day but does show current accounts), so Solana is one provider plus the control. NEAR reads fell back to the second provider after repeated 429 (a few calls, counted in its provider total).

**What it means.**
- T22: the trace list equals L8-PUB for Base and NEAR. Solana is cleaner than the matrix assumes: the sweep (both pump programs, withheld-fee harvest) left nothing at these 37 addresses. The NEAR registrations on `wrap.near` and the token are the public record of each ghost's token (T22 "registrations with no buy are listed": the 4 token-without-wrap ghosts are the case to look at).
- PM1-PM3, T01, C50: none.
- Limits: NEAR ghost accounts were not read with `view_account` (3 reads a ghost; the free RPCs 429 beyond that), so whether the accounts still exist is not measured; 14 NEAR and 20 Base ghosts are rehearse addresses that never held anything.

---

## M11. O-pub linker dry run on P4's live ghosts and P1's legs (T01, T21, T24)

**Question.** Does a linker on public data work on real chains? It must tie each P4 ghost to the float that funded it (positive control). Does it tie any P1 deposit to a P1 withdrawal by anything other than time and amount (negative control)?

**Method.** `m11.mjs`, keyless and read-only. Ground truth comes from the records only. For P4 these are the final `*live*.json` per chain; `-progress`, `recheck`, dry, rehearse and fund files are skipped, and `ghosts.json` was never opened. For P1 it is `runs/2026-10-19T22-53-44-913Z-live.json`.
The records say every ghost was funded straight from its chain's proof float (a pre-fund, or the float paying), never through a confidential leg. The floats were funded one hop up:
- Solana and Base: by P1's out-sol and out-base withdrawals.
- NEAR: first by P1's out-near recipient, then by P1's deposit wallet `951a5eab…` directly.
- Robinhood: by Relay from the Base float.

What the script reads:
- (a) T24, every address that sent value to a ghost or paid its fees.
  - Solana: `getSignaturesForAddress` (whole history), then `getTransaction` on each.
  - Base has no keyless address index. For each ghost, bisection on (balance, nonce) over blocks 52,830,427-52,837,927 (2026-10-19 22:50Z-2026-10-20 03:00Z) finds the blocks where either changed. Each such block is read in full. Token `Transfer` logs to and from all ghosts come from Tenderly's public gateway. State at the head equals state at the window end for all 67 ghosts.
  - NEAR: FastNEAR's account index (receipts, action args, events).
  - Robinhood: every block 93,597,164-93,621,632 (2026-10-20 16:42:30Z-17:25Z) read in full, plus `Transfer` logs.
  - One hop up, the floats' own inflows. The NEAR legs of a float's funding are found the public way. Take the treasury's transfers of that token to 64-hex accounts in the 20 min before the arrival. Then match each receiver's withdraw recipient to the float (`ft_withdraw` msg, or the `WITHDRAW_TO:` memo on Base).
- (b) T01, the deposits. These are every dip4 `transfer` into the confidential treasury `51e8f94d…` from a 64-hex account, in two windows: 2026-10-19 20:40Z-2026-10-20 03:00Z and 2026-10-20 14:30Z-17:30Z.
  - Source: FastNEAR's treasury index, 5,941 treasury txs, none missing from `/v0/transactions`. That gives 1,331 deposits (142.6 an hour).
  - All are priced with 1Click `/v0/tokens` at read time (USD quartiles $50 / $499 / $2,227).
  - Completeness control: both P1 shields, `FtQLHq3Y…` (deposit) and `GTYXNPCX…` (in-sol), are in the set.
  - The rule: for a buy at t, the deposits in [t − W, t] with USD ≥ the buy's debit, at W = 120 s, 1,320 s and 7,200 s.
  - The same rule runs for P1's four withdrawals. There, t is the first NEAR leg and the debit is the record's `inUsd`.
- (c) Features:
  - shared payer: a native sender, or the payer of a tx that delivered the token;
  - fee payer: a ghost-signed action paid for by someone else;
  - shared return recipient: sweeps and leftovers;
  - address reuse (T21): one address with 2 or more buys, or a ghost-to-ghost transfer;
  - memo and referral fields: the Solana memo program, Jupiter referral, NEAR args, EVM calldata strings and embedded app addresses;
  - same-block sells.

  Shared infrastructure is not counted as a link: Helius and Jito tip accounts (m5's lists), a swap's own fee outflows, accounts with ≥ 1,000 indexed txs, and tokens the ghost never used (spam). The ablation removes one feature at a time.
- (d) Scoring against the records:
  - the ghost's float;
  - for T01, P1's deposit shield `FtQLHq3Y…` as the true deposit behind every float a confidential withdrawal funded.
  - NEAR: only the 3 buys before the deposit wallet's first direct transfer to the float (23:55:00Z) have a treasury deposit behind them.

**Window (reads).**
- Run: `date -u` 06:00:14Z on 2026-10-21; the run went 06:00:18Z-06:22:45Z, from an empty cache.
- Heads: Base 52,886,536; Robinhood 94,056,205.
- Calls (429s in brackets):
  - Solana: `api.mainnet-beta` 213 (13).
  - Base: `mainnet.base.org` 2,318 (0), Tenderly 28 (0).
  - Robinhood: official RPC 1,120 (78).
  - NEAR: FastNEAR 511 (2).
  - Second providers 12 each.

**Numbers, P4 ghosts (positive control).** Each feature column counts the ghosts that have that link. Every payer, fee-payer, return and memo link points to the float.
| Chain | Ghosts (records) | Buys on chain | Linked to float | Shared payer | Fee payer | Return recipient | Address reuse (T21) | Memo / referral | Same-block sells | Funder links to anything else |
|---|---|---|---|---|---|---|---|---|---|---|
| Solana | 37 (37) | 42 | **37** | 37 | 31 | 37 | 5 addresses with 2-3 buys each | 0 | 0 | 0 |
| Base | 67 (67) | 67 | **67** | 67 | n/a | 67 | 0 | 24 (sell calldata names the float) | 0 | 0 |
| NEAR | 52 (52) | 49 | **52** | 52 | 4 | 48 | 0 | 0 | 0 | 0 |
| Robinhood | 21 (21) | 21 | **21** | 21 | n/a | 21 | 0 | 0 | 0 | 0 |

Ablation: with any one feature removed, every ghost stays linked; each has at least two independent links to its float. No ghost-to-ghost transfer appears anywhere. The 5 Solana addresses are P4S's reused ghosts on reused tokens.

**Numbers, T01 candidate sets.** Each cell is median / max candidates; the last column is how many sets hold the true deposit at 2 min / 22 min / 2 h.
| Item | n | W = 2 min | W = 22 min | W = 2 h | True deposit in the set |
|---|---|---|---|---|---|
| Solana buys | 42 | 3 / 8 | 31 / 51 | 243 / 260 | 0 / 0 / 42 of 42 |
| Base buys | 67 | 5 / 9 | 44 / 54 | 254 / 258 | 0 / 0 / 66 of 67 |
| NEAR buys | 49 | 3 / 9 | 45 / 52 | 206 / 258 | 0 / 0 / 3 of the 3 with a treasury deposit behind them |
| Robinhood buys | 21 | 4 / 7 | 41 / 61 | 365 / 407 | 0 / 0 / 0 of 21 (the deposit was 18 h earlier) |
| P1 withdrawals | 4 | 1.5 / 2 | 36.5 / 40 | 238 / 255 | 1 / 4 / 4 of 4 |

The ghosts' debits are $1-2, so almost every deposit qualifies. At 2 min some sets have exactly one candidate: 7 Solana buys, 4 Base, 5 NEAR, 2 Robinhood and 1 P1 withdrawal. None of those single candidates is the true deposit. The first buys came 23-38 min after P1's deposit, so the true deposit is never inside 22 min.

**One hop up (T24), read from chain.**
- Solana float `GLWAiWU7…`:
  - Inflows: the Omni vault (P1 out-sol arrival `2c48hnCt…`, 22:55:55Z) and one 11,625-lamport dust sender.
  - Its NEAR legs: 6 candidate per-quote accounts searched, 1 matched (`A4YU9mQE…` treasury → `8e02f3c8…`, `RcBwpfSQ…` `ft_withdraw` to the float).
  - Other accounts in those legs: `824ffeb7…` (21,456 indexed txs) paid 2.03 wNEAR for the native fee, and `60921495…` (21,003) took a 95,350 sol.omft fee. Neither is a collector.
- Base float `0x02151d84…`:
  - First funding: P1 out-base `0x37a15d42…` from 1Click's EOA `0x2cff890f…` (22:57:07Z), fresh before.
  - Its NEAR legs: 2 searched, 1 matched (`HJdGaYSq…` → `13ce500d…` → `EtAWUauy…`).
  - The generic collector `5880ad2b…` took 560,000,000,000 base.omft (5.6e-7 ETH). The confidential collector `2238fd08…` appears in no leg.
- NEAR float `87ea8fb0…`:
  - Inflows: 2.0 N from P1 out-near's recipient `f5ff216d…` at 23:14:05Z (`CQEcKLhq…`), then 7 direct transfers from the deposit wallet `951a5eab…`, 4.9 N from 23:55:00Z.
  - It swept 7 times back to `951a5eab…`, the first (1.649 N, 23:23:38Z) before any direct funding.
  - So the NEAR ghosts link in two hops to P1's deposit wallet, and the treasury is not on that path.
- Robinhood float `0x9d5c87e2…`:
  - 3.362e15 wei from Relay's solver `0x1cd9d560…` (`0x0a26784a…`). Its Base side, `0x4a646687…`, is from the Base float, read on Base.
  - One unlabelled 3.4e-6 ETH inflow from `0x0691bba7…`.

**Other things the chain shows.**
- Base spam: 101 unsolicited token transfers reached all 67 ghosts, from 4 senders.
- Base poisoning: 2 ghosts got a token from `0x0215d1eb…4f52`, a lookalike of the float `0x02151d84…4f52`, a median 10.5 min after their buy. A third-party bot tied those ghosts to the float from public data.
- Base calldata: 47 ghosts' swaps (and 1 on Robinhood) carry router client data `{"Source":"relay","AmountInUSD",…,"RouteID","Timestamp"}`, with the amount and quote time in clear. Each value is unique per swap, so it creates no link, but it hands T01 its amount input.
- Records vs chain: 3 NEAR buys that the records mark failed ("Rate limits exceeded" on the script's RPC) landed on chain: `5ae348de…`, `54586175…` and `c0b098b4…`, all in the 23:17Z run.

**Negative control (P1).**
- Legs: 6 public (deposit and in-sol; out-sol, out-sol-own, out-base, out-near) and 9 private, with no public tx. All 15 pairs of public legs were read; 8 are deposit × withdrawal.
- **Through the legs themselves: 0 of 8.** Nothing links a pair:
  - no shared non-infrastructure account;
  - no shared signing key;
  - no shared memo;
  - no field that names the user, app or funder;
  - no private id in public;
  - no shared block.

  What legs do share is infrastructure:
  - the treasury's own key on all four withdrawals;
  - `824ffeb7…`'s key and `60921495…` on out-sol and out-sol-own;
  - intents.near's constant `deposit` and `withdraw` mint and burn memos.
- **Beyond the legs: 2 of 8.**
  1. in-sol × out-sol-own, address reuse: `BuxPd9HL…` received out-sol-own and then sent in-sol (the user's own choice).
  2. deposit × out-near, a shared counterparty one hop on. out-near's recipient `f5ff216d…` sent its 2.0 N to the P4 NEAR float, which the deposit wallet `951a5eab…` funded 7 times and which swept back to it 7 times. This comes from how the proof moved its money, not from the treasury.
- T01 on the 4 withdrawals: see the table. At 2 min the set is 0-2 deposits; the true deposit is in it for out-sol only (2 candidates).

**Second provider.** 12 sampled facts per chain:
- Solana: 12 of 12 equal on `public.rpc.solanavibestation.com` (native sender or fee payer of a sampled ghost tx).
- Base: 12 of 12 on `base.gateway.tenderly.co` (tx sender).
- NEAR: 12 of 12 on `near.drpc.org` `EXPERIMENTAL_tx_status`. Six are ghost fundings (predecessor → ghost `Transfer`); six are treasury deposits (sender, treasury and amount in the event log).
- Robinhood: 12 of 12 on `robinhood-rpc.publicnode.com` (tx sender or recipient).

**What it means.**
- T24 and the linker: the linker works on real data. Every ghost is tied to its float by its shared payer, and also by its return recipient or fee payer. T24's pass line fails on P4 by design. One hop up, every float's funding is public. For Solana and Base it is a NEAR withdrawal leg from the treasury, with the recipient in clear text. For Robinhood it is Relay from the Base float. For NEAR it is P1's deposit wallet directly.
- T01: with $1-2 debits the amount filter removes almost nothing. The median set is 3-5 at 2 min, 31-45 at 22 min and 206-365 at 2 h. A set of exactly one never pointed at the true deposit.
- T21: the only reuse is P4S's deliberate token reuse on Solana. There are no same-block sells.
- P1: the treasury legs carry nothing that ties a deposit to a withdrawal. Both links come from what the money did next.

**Limits.**
- Coverage:
  - 1Click's origin-chain deposit addresses (Solana, Base and so on) cannot be listed keyless. The candidate sets count only treasury shields: complete for the two windows as far as FastNEAR's index goes, and both P1 shields are in.
  - Base, without an address index: a change that nets to zero inside one block would hide from the bisection.
  - Robinhood is read only inside its window; the nonce check is 21 of 21.
- Method:
  - Deposit USD uses 1Click prices at read time, not at deposit time.
  - Hops go one up and one on; no two-hop linker (for example through Relay's solver) was run.
- Sample sizes: 177 ghosts, 179 buys, 4 P1 withdrawals, 1,331 deposits.

**Verdict.** M11: linker works on real data (positive control caught 177 of 177); P1 links beyond time and amount: 2

---

## M7. Shields into the confidential treasury per 5 minutes (PM2, PM1, PM3)

**Question.** How many public shields reach the confidential treasury `51e8f94d77b5e90dc9852ca6113771e11e8382ce69473a75e313e41665de7cbe` in a 5-minute bucket and in longer intervals, per chain and together? That is the crowd the pill publishes into at its cadence (PRV §5 A, F).

**Method.** `m7.mjs`, keyless and read-only, paced like `m12.mjs` (one FastNEAR request per 1.1 s). Every tx that names the treasury on `tx.main.fastnear.com` in the windows, then their logs.
- A **shield** is M11's definition (`m11.mjs` `treasury()`): a dip4 `transfer` event whose receiver is the treasury and whose sender is not the treasury, one per (event, token) pair. Its time is the block time of the receipt that holds the event.
- Split by asset: `sol.omft.near` (Solana), `base.omft.near` (Base), `wrap.near` (NEAR), `hood.omft.near` (Robinhood), the rest as "other". Split by source shape: `hex64` (the sender is a 64-hex account) or `named` (any other account).
- **Which shape is the pill's crowd: `hex64`.** The pill counts deposits that reached `SUCCESS` into the omnibus (§5 A); on NEAR a deposit is shielded by a per-quote account, which is a 64-hex account (L2-PUB: two public NEAR txs per leg). The check: both P1 shields, the real deposit `FtQLHq3Y…` and `GTYXNPCX…`, are in the set and both come from a 64-hex account. M11 counted this shape only (its 1,331 shields), and M4 shows the `named` senders are solver pass-through accounts (`solver-multichain-asset.near`, `solver-priv-liq.near`), not deposits. The `named` shields are reported below only as the upper bound L1-PUB mentions ("solver legs included"), not as the crowd. All numbers in the tables are `hex64`.
- Buckets are aligned to the window start; only full intervals count. PM2 reads the share of intervals with at least 3 shields (G2 row 21).
- Candidate sets for PM1: shields in a trailing window [t − W, t], t on every minute of the window. PM3: see below.

**Window.** M12's 24 h, **2026-10-19 03:33:10.782Z to 2026-10-20 03:33:10.782Z** (288 buckets), served in full keyless by the FastNEAR index (paged back past 03:31Z; 16,499 txs read, the lull and M11's two windows included; first run 960 FastNEAR calls, 133 pages and 827 tx batches, 2 x 429; `missingFromIndex` 0). The lull is read separately: **2026-10-20 03:30:00Z to 06:00:00Z** (30 buckets). Run: `date -u` 07:54:08Z on 2026-10-21, record `results/m7-2026-10-21T07-54-11-790Z.json` (read 07:54Z to 07:58Z, from a cache of the 07:32Z run's tx reads; that first run is not committed, its stats are identical). 13,279 treasury txs in the main window, the same as M12.

**Controls (the count is right).**
- M12's record (`m12-2026-10-20T03-33-10-782Z.json`, `intoTreasury`), same window, tx-time basis: Solana 430 = 430, Base 273 = 273, NEAR 225 = 225, other + Robinhood 2,340 against 2,341 (M12 had no `hood` class). So M7's 24 h is M12's day.
- M11's two windows: 757 + 574 = **1,331** hex64 shields, equal to M11's 1,331.
- The longest gap between treasury txs in the main window is 108.5 s (as M4).
- 22 shield events sit in receipts whose outcome is a failure, all `named`; none in `hex64`. Malformed events: 0.

**Numbers: 24 h (M12's day), `hex64` shields.** 3,268 in 24 h (136 an hour); `named` shields in the same day: 6,550 (273 an hour; NEAR 1,792, other 4,625, Solana 94, Base 30, Robinhood 9).

Per 5-minute bucket (288):

| Asset (hex64 shields) | Shields | Mean | Median | p10 | p25 | Max | Empty 5-min buckets |
|---|---|---|---|---|---|---|---|
| Solana (`sol.omft.near`) | 430 | 1.49 | 1 | 0 | 0 | 13 | 28.1% |
| Base (`base.omft.near`) | 273 | 0.95 | 1 | 0 | 0 | 6 | 43.4% |
| NEAR (`wrap.near`) | 225 | 0.78 | 1 | 0 | 0 | 6 | 48.6% |
| Robinhood (`hood.omft.near`) | 332 | 1.15 | 1 | 0 | 0 | 5 | 37.2% |
| Other assets | 2008 | 6.97 | 6 | 3 | 4 | 24 | 0.7% |
| **All shields** | 3268 | 11.35 | 11 | 6 | 8 | 30 | 0.0% |

Share of intervals holding at least 1 / 3 / 5 shields (intervals per window: 288, 144, 96, 48, 24):

| Asset | 5 min | 10 min | 15 min | 30 min | 60 min |
|---|---|---|---|---|---|
| Solana (`sol.omft.near`) | 72/17/5% | 92/45/20% | 96/70/40% | 100/92/88% | 100/100/100% |
| Base (`base.omft.near`) | 57/8/1% | 76/31/9% | 90/47/20% | 94/79/54% | 100/96/92% |
| NEAR (`wrap.near`) | 51/6/0% | 72/24/4% | 86/38/12% | 98/83/44% | 100/100/88% |
| Robinhood (`hood.omft.near`) | 63/13/2% | 78/40/15% | 86/62/31% | 96/88/77% | 100/100/100% |
| Other assets | 99/91/74% | 100/100/97% | 100/100/100% | 100/100/100% | 100/100/100% |
| **All shields** | 100/100/96% | 100/100/100% | 100/100/100% | 100/100/100% | 100/100/100% |


**The lull, `hex64` shields.** 111 in 150 min (44 an hour against 136). The lull is two live edges and a dead middle: shields at 03:30Z to 03:59Z and from 05:38Z, **none between 03:59:49Z and 05:38:35Z** (98.8 min with no treasury tx at all in the index). Per 15 minutes: 03:30Z 27, 03:45Z 13, then 04:00Z to 05:30Z 0, 05:30Z 22, 05:45Z 49. The share of live time is 60 of 150 min = 40%, and no interval share can exceed it except by straddling.

Per 5-minute bucket (30):

| Asset (hex64 shields) | Shields | Mean | Median | p10 | p25 | Max | Empty 5-min buckets |
|---|---|---|---|---|---|---|---|
| Solana (`sol.omft.near`) | 10 | 0.33 | 0 | 0 | 0 | 2 | 76.7% |
| Base (`base.omft.near`) | 17 | 0.57 | 0 | 0 | 0 | 4 | 73.3% |
| NEAR (`wrap.near`) | 11 | 0.37 | 0 | 0 | 0 | 3 | 80.0% |
| Robinhood (`hood.omft.near`) | 5 | 0.17 | 0 | 0 | 0 | 2 | 86.7% |
| Other assets | 68 | 2.27 | 0 | 0 | 0 | 15 | 63.3% |
| **All shields** | 111 | 3.70 | 0 | 0 | 0 | 21 | 63.3% |

Share of intervals holding at least 1 / 3 / 5 shields (intervals per window: 30, 15, 10, 5, 2):

| Asset | 5 min | 10 min | 15 min | 30 min | 60 min |
|---|---|---|---|---|---|
| Solana (`sol.omft.near`) | 23/0/0% | 33/13/0% | 40/20/0% | 40/40/40% | 50/50/50% |
| Base (`base.omft.near`) | 27/10/0% | 33/20/13% | 40/20/20% | 40/40/40% | 50/50/50% |
| NEAR (`wrap.near`) | 20/3/0% | 27/13/0% | 40/30/0% | 40/40/40% | 50/50/50% |
| Robinhood (`hood.omft.near`) | 13/0/0% | 20/0/0% | 30/10/0% | 40/20/0% | 50/0/0% |
| Other assets | 37/30/20% | 40/40/33% | 40/40/40% | 40/40/40% | 50/50/50% |
| **All shields** | 37/37/33% | 40/40/40% | 40/40/40% | 40/40/40% | 50/50/50% |


**Second independent read of the dead middle.** The Solana vault `6tckHFBp…` (getSignaturesForAddress on `api.mainnet-beta`, all signatures, counted per 15 min, 2026-10-20): 03:00Z 42, 03:15Z 45, 03:30Z 43, 03:45Z 26, **04:00Z 2, 04:15Z 1, 04:30Z to 05:15Z 0**, 05:30Z 18, 05:45Z 58, 06:00Z 13. The vault stops where the treasury stops, so the gap is the bridge, not the index (it agrees with the lull note at the top). This one read is not scripted in `m7.mjs`.

**Second provider.** 12 sampled hex64 shields per asset, 60 in all, re-read on `near.drpc.org` (`EXPERIMENTAL_tx_status`, then `block` by the receipt's block hash): the dip4 event (sender, receiver, token, amount) and the receipt's block time. **60 of 60 equal** (event and time). The providers answer only for txs younger than 31 to 33 h: a first run sampled across the whole day and 53 of 60 were refused (`near.drpc.org` first, then `rpc.mainnet.near.org`, `HANDLER_ERROR` on the requested hash; the 7 that passed were all after 2026-10-20 00:58Z, the oldest refusal is 2026-10-19 22:19Z). So the final sample is the youngest 29 h that exist: Solana, Robinhood and other come from the last 40 min of M12's window (pools of 13, 17 and 42), Base and NEAR from 03:26Z on: the lull and M11's second window (pools of 48 and 79). The first 23 h of the day rest on FastNEAR alone; what backs them is the exact match with M12's and M11's counts, which are the same index, so not an independent source.

**Proposed defaults (CO decides).**
- **PM2 (publish cadence): 30 minutes per chain.** The shortest interval in which at least 75% of intervals hold 3 or more shields, over the 24 h: Solana 30 min (92% of 30-min intervals; 15 min is 70%), Base 30 min (79%; 15 min 47%), NEAR 30 min (83%; 15 min 38%), Robinhood 30 min (88%; 15 min 62%). Counted together (the pill pools every chain, §5 H item 2) 5 min is enough: 100% of 5-min intervals hold 3 or more and 96% hold 5 or more. **The lull:** no interval up to 60 min reaches 75% on any chain or together (all shields: 40% of the 30-min intervals hold 3; the live share of the window is 40%). A cadence cannot fix it: from 04:00Z to 05:30Z the public count is 0 whatever the interval, and the pill should read below PM4 (amber) then, which is true.
- **PM1 (matching window W): 22 min, from the delays; 3 min is the least that gives a set of 5.** Candidate set = shields in [t − W, t], over the 24 h and all assets: W = 2 min has median 4 (p10 2); **W = 3 min has median 7 (p10 3)**, the smallest W in the grid with a median of at least PM4 = 5; W = 5 min has p10 6; W = 22 min has median 51 (p10 33, min 17); W = 2 h has median 286. M11's T01 sets agree: median 3-5 at 2 min (Solana 3, Base 5, NEAR 3, Robinhood 4, so three chains miss 5), 31-45 at 22 min, 206-365 at 2 h; so among M11's three W only 22 min and 2 h give a median of 5 or more on every chain. M6's delays (all buyers: median 123 s, p75 about 22 min) are what W must cover, and 22 min covers 75% of them. **The lull:** with W up to 30 min the median set is 0 (90 of the 150 min are empty); at W = 1 h the median is 5 (p10 0); at W = 2 h it is 36 (p10 25, only the last 30 min of the lull have a full 2 h behind them).
- **PM3 (size tolerance ε): 10%, with W = 22 min.** M11's records cannot give it: they hold the size of each candidate set, not the amount of each deposit, and the canary debits ($1-2) sit below nearly every deposit (M11: quartiles $50 / $499 / $2,227), so a tolerance never removed a candidate. The read that gives it is the deposit list with amounts, which M7 has, so I computed it from M7's own list as a **proxy**: each hex64 shield is a stand-in deposit, a buy of the same size at the same time; the set is that shield plus the other shields in [t − W, t) within ε of its size (1Click read-time prices; priced share 100%). Median set (share of sets that reach PM4 = 5), 24 h:

  | W | no size filter | ε = 1% | ε = 5% | ε = 10% | ε = 20% |
  |---|---|---|---|---|---|
  | 2 min | 6 (67%) | 1 (0%) | 1 (0%) | 1 (0.2%) | 1 (0.3%) |
  | 22 min | 54 (100%) | 1 (0.7%) | 1 (2.7%) | 2 (11%) | 3 (32%) |
  | 2 h | 290 (100%) | 2 (6%) | 4 (45%) | 7 (71%) | 13 (89%) |

  Reason: ε is the tolerance at which the hint should fire when the crowd that hides the buy is below PM4. At W = 22 min, ε = 10% leaves 89% of size-matched buys with fewer than 5 candidates (the hint is right to fire) and ε = 20% only 68%. If CO picks W = 2 h instead, ε = 5% is the matching value (median 4). In the lull at W = 22 min the median set is 1-2 at every ε. A size match shrinks the set far more than time does: at ε = 20% the median is 3 where the time-only set is 54.

**What it means.**
- PM2: a 5-minute interval holds several shields only when the chains are pooled (median 11, p10 6). Per chain the 5-minute median is 1 and 28-49% of buckets are empty; a per-chain publish needs 30 min. The `named` shields (273 an hour) would triple the count if an observer lets them in, but they are the solver shape, so they make the crowd look bigger to a counter, not to a linker that filters on the shape.
- PM1: a W of 22 min holds a large crowd in a normal hour and an empty one in the lull. The pill's honesty in the lull comes from reading 0 then, not from the size of W.
- Neither number is a design guarantee: both come from one day plus a 2.5 h lull.

**Limits.**
- One day (a Monday-to-Tuesday UTC day, 2026-10-19 03:33Z to 10-20 03:33Z, the same as M12; PRV §9 M12 calls it Sunday-Monday, but 2026-10-19 is a Monday) and one lull. The lull has 60 live minutes in 150, so its interval shares are coarse (30-min intervals: 5; 60-min: 2).
- The count is of shields of every size. The pill counts deposits of at least a size bucket (§5 A); the higher buckets hold fewer (M11: about 75% of shields are $50 or more, 50% are $499 or more, as read-time USD).
- Only treasury shields are counted, not origin-chain deposit addresses (M11 limit). Only public `hex64` senders are the app's shape; the shape is an inference from P1's two shields and from M4/M11, not a label on chain.
- The first 23 h of the day have no second provider (see above); the control is the exact match with M12 and M11, which share the FastNEAR index.
- The trailing-window and PM3 numbers use the crowd's own shields as stand-ins for deposits; real users' sizes and delays can differ. PM3 prices are read-time (2026-10-21), not deposit-time.
- Event time is the receipt's block time; M12 used the tx's block time, so the two differ by a few seconds at bucket edges (the 1 shield of difference above).
- M7's own counts are not independent of M12's and M11's index; the Solana vault read is the only independent source of the lull, one read of one chain.

---

## M8. What Relay's screening sends out, and its retention

**Question.** Relay screens ghost addresses with Chainalysis and HackBounty data (`P4B:251`). What does it send out, and how long does it keep it?

**Method.** Read Relay's screening page, `https://docs.relay.link/security/compliance.md`, and the rest of its docs
(`https://docs.relay.link/llms-full.txt`, 1.08 MB, searched for screening, sanction, retention, privacy). Read
2026-10-20 about 06:45Z, keyless. Relay's own site (`relay.link/privacy`, `/privacy-policy`, `/terms`) answered HTTP 429 to
`curl` and to the fetch tool, so its privacy policy was not read.

**What the docs say.** One line, quoted: "The Relay platform screens transaction addresses using third-party risk data
and an internal blocklist." The rest, in short:
- Two sources: third-party risk and sanctions databases ("including HackBounty and Chainalysis") and an internal blocklist.
- Scope (the product overview in `llms-full.txt`): sender, recipient and fee-recipient addresses, plus the depositing
  wallet on deposit-address flows. A match can block a quote or a fill.
- A block at fill time (`BLOCKED_WALLET`) does not refund by itself; Relay support reviews it. Its error table also lists
  `SANCTIONED_WALLET_ADDRESS` ("The sender or recipient wallet address is sanctioned or blacklisted").
- For a failed request, the request-status API can return the blocked addresses, only to the integrator that owns the
  request and only with `includeAuthenticatedData=true`.

**What the docs do not say.** Whether Relay sends the address to the vendor or checks it against a copy of a list. What
else goes with it. Whether the vendor keeps it. How long Relay keeps quotes, screening results or request logs. The one
retention figure in the docs, "Status entries are retained for 24 hours", belongs to the withdrawal-job status call,
not to screening or quotes. **Retention: UNKNOWN in the docs read.**

**What it means.**
- PM1-PM3: none. Nothing here changes a window or a size tolerance.
- T01 / C50: none.
- T22 / L6-SCR: stays **UNKNOWN (data flow)**. The page proves that every Relay quote address (user, recipient, and so
  on) is screened, so the ghost address and the float address both reach the screening step. Whether that step is a call to a
  third party is not stated. The matrix should keep "may reach an analytics firm" and not state either way.
- Open: Relay's privacy policy is behind a bot wall from this machine. A browser read, or a read from another network, is
  the next step. Asking Relay is out of scope (no vendor outreach).

Sources: https://docs.relay.link/security/compliance.md ; https://docs.relay.link/llms-full.txt (screening paragraph in the
product overview; error table; `blockedAddresses` note) ; all read 2026-10-20.

---

## M9. What 1Click's status call returns at deposit

**Question.** What does `GET /v0/status` give the enclave once a deposit lands (origin address, tx hashes, other fields),
and which must the enclave drop (ND-6: the pill never uses an origin address)?

**Method.** The OpenAPI document (version 0.1.10) that the docs page embeds:
`https://docs.near-intents.org/api-reference/oneclick/check-swap-execution-status.md`, fetched 2026-10-20 about 06:30Z, and the
signature page `.../1click-api/verify-quote-signature.md`. `https://1click.chaindefuser.com/docs/v0/openapi.yaml` answered
HTTP 521 at that time, so the docs mirror of the same schema was the source. No live call (a status call needs a deposit
address and a key; the call is not on the keyless list).

**Request.** `depositAddress` (required) and `depositMemo` (optional). Security: `X-API-Key` or `JWT-auth`.

**Response `GetExecutionStatusResponse`:**
- `correlationId`, `status` (`KNOWN_DEPOSIT_TX`, `PENDING_DEPOSIT`, `INCOMPLETE_DEPOSIT`, `PROCESSING`, `SUCCESS`,
  `REFUNDED`, `FAILED`), `updatedAt`.
- `quoteResponse`: an echo of the quote: `correlationId`, `timestamp`, `signature`, `quoteRequest` (every field the caller
  sent: `dry`, `depositMode`, `swapType`, `slippageTolerance`, `originAsset`, `depositType`, `destinationAsset`, `amount`,
  `refundTo`, `refundType`, `recipient`, `connectedWallets`, `sessionId`, `virtualChainRecipient`,
  `virtualChainRefundRecipient`, `customRecipientMsg`, `recipientType`, `deadline`, `confidentiality`, `referral`,
  `rebates`, `quoteWaitingTimeMs`, `appFees`, `insured`), and `quote` (`depositAddress`, `depositMemo`,
  `chainDepositAddresses`, `amountIn`, `amountInFormatted`, `amountInUsd`, `minAmountIn`, `amountOut`,
  `amountOutFormatted`, `amountOutUsd`, `minAmountOut`, `deadline`, `timeWhenInactive`, `timeEstimate`,
  `virtualChainRecipient`, `virtualChainRefundRecipient`, `customRecipientMsg`, `refundFee`, `withdrawFee`).
- `swapDetails`: `intentHashes[]`, `nearTxHashes[]`, `originChainTxHashes[]` and `destinationChainTxHashes[]` (each
  `{hash, explorerUrl}`), `amountIn` / `amountInFormatted` / `amountInUsd`, `amountOut` / `amountOutFormatted` /
  `amountOutUsd`, `slippage`, `refundedAmount` / `...Formatted` / `...Usd`, `refundReason`, `depositedAmount` /
  `...Formatted` / `...Usd`, `withdrawFee`, `referral`.
- Required by the schema: `correlationId`, `quoteResponse`, `status`, `updatedAt`, `swapDetails` (and inside it the four hash arrays).

**Origin address.** There is **no field named for the sender's address.** The schema gives the origin chain's tx hash and an
explorer URL (`originChainTxHashes`). The address is one lookup away from that hash, on any explorer or RPC. So the
enclave learns the origin address only if it follows a hash or a URL. Two echoed fields can also name an address:
`quoteRequest.refundTo` and `quoteRequest.connectedWallets`, which are whatever the caller put in the quote.
(UNKNOWN: whether the live service fills `connectedWallets` itself. The schema says "Addresses of connected wallets",
written by the caller.)

**What the enclave must drop** (ND-6; keep only what the pill and the money rules use):
- Keep: `status`, `updatedAt`, `swapDetails.amountIn`, `swapDetails.amountInUsd`, `depositedAmount`, `amountOut`,
  `refundedAmount`, `refundReason`, `withdrawFee`, and the stored quote's own signature check (06a rules).
- Drop at the door, never store, never log, never forward: `originChainTxHashes` (hash and `explorerUrl`; this is the
  path to the origin address), `destinationChainTxHashes`, `nearTxHashes`, `intentHashes`, and the whole echoed
  `quoteResponse.quoteRequest` (`refundTo`, `recipient`, `connectedWallets`, `sessionId`, `virtualChainRecipient`,
  `virtualChainRefundRecipient`, `customRecipientMsg`, `referral`, `rebates`, `appFees`). `correlationId` is a trace id for
  support; keep it out of anything the pill or an anchor can see.
- Do not follow `explorerUrl`. A fetch to an explorer is a request that names the deposit tx.

**What it means.**
- PM1-PM3: none; the pill's size bucket comes from `amountIn` / `depositedAmount`, which stay.
- T01: the linker's input is origin-chain deposit txs (public). The enclave never needs the hash to compute N.
- C50 / ND-6: the drop list above is the checkable form of "the pill never uses an origin address". A U test can feed a
  status body that carries every field above and assert that none of the dropped fields survives into storage, the log or
  the anchor.
- Limits: the schema is 0.1.10 as published on the docs page, read once. A live status body was not read.

Sources: https://docs.near-intents.org/api-reference/oneclick/check-swap-execution-status.md ;
https://docs.near-intents.org/integration/distribution-channels/1click-api/verify-quote-signature.md (the signature covers
`{...quoteRequest, ...quoteResponse, timestamp}` of the quote payload; the page says "quote/status payloads" are signed and
shows only the quote check).

---

## M13. Can a passkey provider derive PRF outputs from a synced credential (L12-PASS)?

**Question.** If our seed is derived from a WebAuthn PRF output, and the passkey is synced by Apple or Google, can the
provider's servers (or the provider as an organisation) compute that output?

**Method.** Read the W3C text of the PRF extension, Apple's passkey-sync security pages and PRF API pages, and Google's
passkey-sync post and Android release notes. Read 2026-10-20, keyless. Short answer first.

**Answer.** **The docs do not show that a provider can. They also do not show that it cannot.** Each says sync is end-to-end
encrypted and the provider's servers cannot read the passkey. None says what a synced credential's PRF secret is, where
it sits, or that it is inside the encrypted blob. So L12-PASS stays a call on a vendor claim, not a measurement.

**What the sources say.**
1. W3C WebAuthn Level 3, section 10.1.4 (`https://www.w3.org/TR/webauthn-3/#prf-extension`). The extension "allows a
   Relying Party to evaluate outputs from a pseudo-random function (PRF) associated with a credential". It is "modeled on
   top of the [FIDO-CTAP] hmac-secret extension, but can also be implemented by other means". The PRF is chosen "uniformly
   at random" by the authenticator and associated "with the current credential for the lifetime of the credential". "The
   interface ... and the construction of the PRF by the authenticator, is only abstractly specified." Nothing on synced or
   backed-up credentials in this section. (The glossary says a backed-up credential source "may become present on an
   authenticator other than their generating authenticator", which is the only link, and it is not made in the PRF text.)
2. Apple, `ASAuthorizationPublicKeyCredentialPRFRegistrationOutput`
   (`https://developer.apple.com/documentation/authenticationservices/asauthorizationpublickeycredentialprfregistrationoutput-swift.struct`;
   iOS 18, macOS 15). The keys are "available anywhere the passkey is available for use" and "unique to the passkey". This
   is the strongest statement found: the PRF output follows the passkey to every device it syncs to. It means the PRF secret
   travels with the synced credential (or is derivable from what travels).
3. Apple, passkey security (`https://support.apple.com/en-us/102195`): passkeys "sync across a user's devices using iCloud
   Keychain. iCloud Keychain is end-to-end encrypted with strong cryptographic keys not known to Apple". Platform Security
   (`https://support.apple.com/guide/security/icloud-keychain-security-overview-sec1c89c6f3b/web`): items travel
   "through Apple servers, but are encrypted end-to-end so that Apple and other devices can't read their contents".
   Recovery uses an escrow record Apple holds but "without allowing Apple to read" it (secure-keychain-syncing and escrow pages).
4. Google, "Security of Passkeys in the Google Password Manager" (`https://security.googleblog.com/2022/10/SecurityofPasskeysintheGooglePasswordManager.html`):
   "Passkeys in the Google Password Manager are always end-to-end encrypted: When a passkey is backed up, its private key is
   uploaded only in its encrypted form using an encryption key that is only accessible on the user's own devices". Recovery
   needs the screen lock of another device. This post is from 2022 and says nothing on PRF.
5. Google PRF: no Google page on how Google Password Manager handles PRF was found. The only first-party mention is the
   androidx.credentials release note "Support PRF creation for Android versions 13 and below"
   (`https://developer.android.com/jetpack/androidx/releases/credentials`). Third-party posts say Google Password Manager passkeys
   support PRF and that the output is the same on a second device; those are secondary and were not used.

**What the docs say and do not say, side by side.**
- Say: sync is end-to-end encrypted; the provider's servers cannot read the passkey; PRF output is the same wherever the
  passkey is available (Apple); a recovery escrow exists (Apple) and recovery needs a lock screen secret of another device (Google).
- Do not say: that the PRF secret is inside the end-to-end encrypted blob (it is a reasonable reading, not a statement);
  that no key-wrapping key is held by the provider; that a provider cannot use a signed-in device it controls (its own
  OS, browser or credential manager) to run the PRF for an origin it picks; what a legal order could reach.
- Not asked, but relevant: the PRF output exists in clear in the browser on every device where the user signs in. That is
  the same exposure as the seed on that device (L11-DEV), so a provider with a signed-in device reaches the seed, as DEV does.

**What it means.**
- L12-PASS: keep **L/H** and **UNKNOWN**, with this wording: the documented design says the provider's servers cannot derive
  the output; no document says so for PRF in particular; the provider's own software on a signed-in device can. Do not write
  "the provider cannot derive PRF outputs" anywhere.
- PM1-PM3, T01, T22, C50: none.
- Open: a test, not a read: create a passkey on one device with PRF, sync it, evaluate the same input on a second device,
  and compare. That shows the secret syncs (the docs imply it). It cannot show what the provider can do on its side.

---

## Not run, and what is open

- Relay's privacy policy (M8 retention): `relay.link` answered HTTP 429 to every fetch from this machine. Not read.
- A live 1Click status body (M9): not read; the schema is the docs mirror of OpenAPI 0.1.10 (`1click.chaindefuser.com` answered 521 and a status call needs a key).
- A cross-device PRF test (M13): not run; it needs two devices.
- M6 fresh-buyer delay distribution: n=2, not usable. A usable one needs more fresh pump buyers than this vault gives.
- M5 and M6 are single windows. M6 and M5 first runs that used wrong settings (M5 assumed 9,000 slots an hour; an early M6 and M4 pass hit a lull) were discarded and are not committed.
