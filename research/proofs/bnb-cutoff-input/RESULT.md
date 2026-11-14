# BNB cut-off rule: input (M12 for BNB Chain so far, and 1Click now)

Written by prep lane PR1 on 2026-10-22 at 19:10Z (from `date -u`), for merge note M190 (12) ("a BNB cut-off rule").
This folder holds only the input; team lead writes the rule. Nothing here started, stopped or changed the running count.

**Read: in the first 15 finished hours, 48 confidential withdrawals to BNB Chain (mean 3.2 an hour, median 3; busiest
07:00Z with 11). None since 11:38Z: the last six finished hours (12:00Z-17:00Z) have 0, in both directions, while the
other chains kept flowing. At 19:08Z 1Click refused the refill form for BNB ("Quoting for this pair is not available")
and quoted the return form, so BNB looks closed again for refills.** M161's join condition (the Oct 23 re-check OPEN
again and the 24 h count done) is not met yet; the count ends 2026-10-23 03:00Z.

## 1. The 24 h M12 count (`proofs/m12-bsc`, still running, read-only here)

- Process: running (two pids for `m12-bsc.mjs`, `pgrep -f`); started 2026-10-22 03:17:58Z; window 03:00Z to
  2026-10-23 03:00Z; final pass about 10 min after; hard stop 2026-10-23 03:44:58Z. No RESULT.md or `result.json` yet.
- Last tick read: tick 62 at 18:55:57Z (`results/run.log`); 640 index calls, 0 HTTP 429s, 0 tick errors; 8,011 treasury
  txs seen; 15 hours finished. Figures below are from `results/m12-bsc-2026-10-22T03-17-58-058Z/progress.json`
  (`readAt` 18:55:57.819Z) and `candidates.json`. (The script is a copy of `m12-hood.mjs`, so its log says "hood
  candidates" where it means BNB Chain candidates.)
- BNB Chain = every `bsc` asset 1Click listed at the start (10: BNB, ASTER, USDC, USDT, SWEAT, RHEA, NEAR, EVAA,
  nrUsdt, AURORA).

| Hour (UTC, Oct 22) | 03 | 04 | 05 | 06 | 07 | 08 | 09 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Withdrawals to BNB Chain | 1 | 3 | 4 | 9 | 11 | 3 | 10 | 4 | 3 | 0 | 0 | 0 | 0 | 0 | 0 |
| Candidates (treasury → 64-hex) | 1 | 3 | 4 | 9 | 13 | 3 | 10 | 4 | 3 | 0 | 0 | 0 | 0 | 0 | 0 |
| BNB Chain into the treasury | 0 | 2 | 1 | 6 | 5 | 3 | 4 | 4 | 2 | 0 | 0 | 0 | 0 | 0 | 0 |
| Treasury txs, all chains | 261 | 259 | 382 | 374 | 486 | 494 | 471 | 407 | 529 | 548 | 565 | 618 | 652 | 612 | 812 |

- Totals: 50 candidates, 48 withdrew, 2 did not (both USDT, hour 07:00Z, checked 3 times each), 0 unchecked.
- By token (withdrawals of candidates): USDT 32 of 34, BNB 9 of 9, USDC 5 of 5, NEAR 2 of 2; the other six 0.
- Transfer → withdrawal: p50 4 s, max 11 s (n 48).
- Last BNB Chain candidate out: 11:38:22Z; last one in: 11:46:51Z.
- Other chains in the same six hours 12:00Z-17:00Z, candidates out: Robinhood 5, 13, 7, 7, 10, 8; Base 3, 6, 8, 9, 10,
  15; Solana 22, 30, 56, 23, 19, 21. So the BNB stop is not an index gap.
- For scale, Robinhood's finished 24 h count (`proofs/m12-hood/RESULT.md`): 275 withdrawals, mean 11.46, median 3 an
  hour, three of its hours batch sends.

## 2. 1Click now (`now.mjs`, `results/oneclick-now-2026-10-22T19-08-55-061Z.json`)

Two keyless dry quotes, the shapes of `proofs/bnb-recheck/recheck.mjs` at $100, USDC on NEAR ↔ USDT on BSC, at
19:08:55Z. That folder's daily log was not touched; this is a context read, not the daily re-check.

| Form | HTTP | Answer | correlationId |
|---|---|---|---|
| `out-intents` (refill form, `depositType: INTENTS` → BSC) | 400 | "Quoting for this pair is not available" | `f8904929-2204-4574-a208-00304ac604eb` |
| `back-intents` (return form, BSC → `INTENTS`) | 201 | quoted, 99.869844 USDC out | `751d68a0-b2e4-4eac-a9ad-64d4a9950938` |

`GET /v0/tokens` still lists the same 10 `bsc` assets. History of the refill form (`proofs/bnb-recheck`): CLOSED Oct 20
16:04Z, Oct 20 17:48Z, Oct 21 04:51Z; OPEN Oct 22 03:14Z (16 of 24); refused again at 19:08Z (this read).

## 3. What team lead may want in the rule (facts only)

- When open, BNB's withdrawal crowd is about Robinhood's median (3 an hour) without its batch hours.
- The refill form opened some time after Oct 21 04:51Z (closed then) and quoted at Oct 22 03:14Z; withdrawals flowed
  until 11:38Z; the form was refused at 19:08Z. So 1Click's BNB state can flip within a day, and one daily read can
  miss a close.
- The 24 h count will finish with at least 6 zero hours in it. If team lead wants the count of an open day, this run is not one.
