# M12 for Robinhood Chain, 24 h (paper 5 method)

Status 2026-10-21T16:13Z: **done.** The 24 h run finished; the result is below.

**Pass line:** an hourly count of confidential withdrawals to Robinhood for 24 h, with the busiest and the quietest hour.

## Result (final, written 2026-10-21T16:13Z from `results/m12-hood-2026-10-20T16-01-12-576Z/result.json`)

**275 confidential withdrawals to Robinhood in 24 h** (2026-10-20T16:00Z to 2026-10-21T16:00Z):
mean 11.46 an hour, median 3. **Busiest hour 10-21 12:00Z with 101; quietest
10-20 20:00Z with 1.**

- Candidates (treasury transfers of a Robinhood token to a 64-hex account): 284. Checked 284,
  withdrew 275, did not withdraw 9, unchecked 0.
- By token (withdrawals of candidates): USDG 6 of 14, ETH 269 of 270.
- Transfer to withdrawal: p50 4 s, max 19 s (n 275).
- Robinhood into the treasury (returns and shields): 162.
- Other chains' candidates out, for scale: other 2236, near 217, solana 530, base 112, tron 30.
- Run: 93 ticks, 1584 index calls, 48 HTTP 429s, 1 tick errors; 0 txs found only by the final pass.

| Hour (UTC) | Withdrawals | Candidates | Treasury txs |
|---|---|---|---|
| 10-20 16:00Z | 6 | 6 | 718 |
| 10-20 17:00Z | 45 | 45 | 674 |
| 10-20 18:00Z | 7 | 7 | 513 |
| 10-20 19:00Z | 8 | 8 | 557 |
| 10-20 20:00Z | 1 | 2 | 602 |
| 10-20 21:00Z | 3 | 4 | 504 |
| 10-20 22:00Z | 1 | 5 | 558 |
| 10-20 23:00Z | 1 | 1 | 446 |
| 10-21 00:00Z | 48 | 50 | 503 |
| 10-21 01:00Z | 3 | 3 | 458 |
| 10-21 02:00Z | 3 | 3 | 315 |
| 10-21 03:00Z | 2 | 2 | 346 |
| 10-21 04:00Z | 3 | 3 | 389 |
| 10-21 05:00Z | 3 | 3 | 365 |
| 10-21 06:00Z | 5 | 5 | 381 |
| 10-21 07:00Z | 3 | 3 | 459 |
| 10-21 08:00Z | 3 | 3 | 517 |
| 10-21 09:00Z | 4 | 4 | 345 |
| 10-21 10:00Z | 3 | 3 | 501 |
| 10-21 11:00Z | 2 | 2 | 521 |
| 10-21 12:00Z | 101 | 101 | 894 |
| 10-21 13:00Z | 2 | 3 | 653 |
| 10-21 14:00Z | 4 | 4 | 717 |
| 10-21 15:00Z | 14 | 14 | 858 |


**team lead reading (2026-10-21 16:14Z, from `candidates.json`).** Three hours are batch sends, not a crowd: 12:00Z has 101
withdrawals to 101 distinct accounts, every amount 0.000555-0.000556 ETH; 00:00Z has 48, 47 of them about 0.000556 ETH;
17:00Z has 45, 38 of them exactly 0.00102 ETH. Without those three hours: 81 in 21 h, 3.9 an hour. The hourly median, 3,
is the crowd a ghost funded in a typical hour hides in. All 284 candidates were checked (no sample).

## What runs

`m12-hood.mjs` is paper 5's `proofs/p5-privacy/m12.mjs` method, run forward over a full day:
- **Window:** 2026-10-20 16:00:00Z to 2026-10-21 16:00:00Z (24 whole UTC hours, from the start of the hour it started in).
- **Every 15 min** it pages the keyless FastNEAR tx index for txs that name the confidential treasury
  `51e8f94d…de7cbe`, back to the last tx it saw (10 min overlap, deduped by hash). A sleep of this Mac or a slow index
  only delays a tick; the next tick pages back further.
- **Candidates:** in those txs' logs, every dip4 `transfer` from the treasury to a 64-hex account, per token and hour.
  Robinhood = every `hood` asset 1Click listed at the start (read 16:01:13Z from `GET /v0/tokens`): ETH
  `nep141:hood.omft.near`, USDG `nep141:hood-0x5fc5…d168.omft.near`, WETH, USDe, PONS, CASHCAT. **1Click lists no USDC on
  Robinhood**, so USDC is not in the count. Transfers into the treasury from 64-hex accounts (returns and shields) are
  counted too.
- **Each Robinhood candidate is checked, not sampled** (paper 5 sampled 30 per chain): 10 min or more after the
  transfer, the receiver's own txs are read. A hit is a dip4 `ft_withdraw` (or `mt_withdraw` / `native_withdraw` /
  `nft_withdraw`) of the same token by that account. Misses are re-checked at 20 and 30 min and once at the end.
- **At the end** the whole window is paged again; any tx the forward pass missed is read and counted (`backfilled`).
- Solana, Base, NEAR and Tron transfers out of the treasury are counted as candidates only, for scale.
- About 13 index calls per tick at 1 per 1.1 s; backs off on 429 (3 s doubling to 60 s).

First two ticks (16:01Z, 16:16Z): 156 treasury txs; 2 Robinhood ETH candidates; the first checked one withdrew
(`ft_withdraw` to `hood.omft.near`, 3 s after the treasury transfer). The process is reading as designed.

## How to read the result

Files in `results/m12-hood-2026-10-20T16-01-12-576Z/`:
- `progress.json`: rewritten every tick; counts only finished hours.
- `result.json`: written once at the end. **The pass line is `m12Hood.withdrawalsPerHour`**: `hours` (24 counts, hour 0 =
  16:00Z Oct 20), `total`, `perHourMean`, `median`, `max` with `busiestHourUTC`, `min` with `quietestHourUTC`.
- Also in `result.json`:
  - `m12Hood.bySymbol`: candidates and withdrawals per token (ETH, USDG, …).
  - `checked`, `notWithdrawn`, `unchecked`: how many candidates were read; `unchecked` should be 0.
  - `withdrawDelaySec`: transfer to withdrawal, p50 and max.
  - `intoTreasuryPerHour`: Robinhood returns and shields.
  - `treasuryTxsPerHour`: the index's own count. An hour far below its neighbours means a lull or an index gap. The
    FD-S-15 read saw 2 treasury txs in 07:00-08:00Z on Oct 20, so check this row before quoting the quietest hour.
  - `backfilled`: txs only the final pass found; a large number means the index lagged during the day.
  - `otherChainsCandidatesOut`: Solana, Base, NEAR and Tron for scale (candidates, not checked).
  - `candidates`: every Robinhood candidate (receiver cut to 8 characters).
- `results/run-first.log` has one line a tick; the run's last lines start with `DONE.` and `result:`.

Check it any time, no PID needed: `tail -1 results/run-first.log` shows the last tick (one line every 15 min,
with the UTC time); `progress.json` holds the finished hours so far. A tick older than 30 min means the process stopped.

When the log's last lines say `DONE.` (from about 16:10Z on Oct 21), write the result into this file and commit it:

```sh
cd ~/Downloads/confidential-trenches/proofs/m12-hood && tail -2 results/run-first.log && node write-result.mjs
```

`write-result.mjs` puts a "Result (final)" section (totals, busiest and quietest hour, the 24-hour table) above
"What runs" and changes the status line. It exits 1 without writing if `result.json` is not there yet.

If the process died (no `DONE.` and no recent tick), resume it in place:
`nohup node m12-hood.mjs --resume results/m12-hood-2026-10-20T16-01-12-576Z >> results/run-first.log 2>&1 &`.

Commit `RESULT.md`, `result.json` and `progress.json`. The log (`*.log` is ignored), `seen.txt`, `candidates.json` and
`state.json` stay local.

## Sources

- `https://tx.main.fastnear.com/v0` (`account`, `transactions`), keyless, from 2026-10-20 16:01:13Z.
- `GET https://1click.chaindefuser.com/v0/tokens`, read 2026-10-20 16:01:13Z (the `hood` asset list in `result.json`).
- Method: `proofs/p5-privacy/m12.mjs`; the 6 h sample it replaces: chains research §5.1 (about 3.5 an hour, last 4 h).
