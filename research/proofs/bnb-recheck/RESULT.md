# BNB daily re-check (1Click)

Status 2026-10-22 03:15Z: **BNB Chain OPENED on 1Click: 16 of 24 dry quotes answered** (the refill and return forms at every size; chain-to-chain only from $1,000). Oct 20 and Oct 21: 0 of 24. team lead's keyed confidential dry quotes agree (all four forms at $0.10). Decision in merge note M161: BNB joins if the Oct 23 read is OPEN again and the 24 h M12 count (`proofs/m12-bsc`) is done.

Earlier, 2026-10-20 16:05Z: **run 1 done. BNB Chain is CLOSED on 1Click: 0 of 24 dry quotes answered.** The coordinator
runs it once a day until Oct 31 (chains research §5 item 5).

## What it checks

`recheck.mjs` makes 24 keyless dry quotes (`dry: true`, no key) on `https://1click.chaindefuser.com/v0/quote`, 1.6 s apart:
- Pairs: USDC on NEAR ↔ BNB (`nep245:v2_1.omni.hot.tg:56_11111111111111111111`), and USDC on NEAR ↔ USDT on BSC
  (`nep245:v2_1.omni.hot.tg:56_2CMMyVTGZkeyNZTSvS5sarzfir6g`).
- Sizes: $5, $100, $1,100 (amounts priced from `GET /v0/tokens` at the run).
- Four public forms each:
  - `out-chain`: `ORIGIN_CHAIN` → `DESTINATION_CHAIN`;
  - `out-intents`: from an `INTENTS` balance, the closest public form to a ghost refill;
  - `back-chain`: chain to chain;
  - `back-intents`: into an `INTENTS` balance, the closest public form to a return.
- Recipients are made up each run: a random EVM address and a random 64-hex NEAR account.

Each run appends one JSON line to `results/bnb-recheck.jsonl`: time, prices, `quoted` of 24, the verdict, the distinct
refusal messages, and every quote's status, message and `correlationId`.

**Pass line (the re-check's job):** a dated line per day. If `out-intents` quotes at $5 or $100, the verdict says
OPEN, and BNB can move to "go with limits" on the Robinhood plan (chains research §5 item 5, §6).

## Run 1 (2026-10-20 16:04:27Z to 16:05:06Z, 24 calls)

| Form | $5 | $100 | $1,100 |
|---|---|---|---|
| out-chain (BNB and USDT) | 400 "Temporary swap limits: minimum swap amount is $1,000" | same | 400 "Quoting for this pair is not available" |
| out-intents (refill form) | 400 "Quoting for this pair is not available" | same | same |
| back-chain | 400 "minimum swap amount is $1,000" | same | 400 "not available" |
| back-intents (return form) | 400 "not available" | same | same |

- BNB and USDT answered the same way in every cell.
- Prices at the run (1Click, `priceUpdatedAt` 16:03:30Z): BNB $733.62, USDT (BSC) $0.999177, USDC (NEAR) $0.99978.
- Same as the chains research read at 13:52-14:12Z (R2, R3, R3b). Nothing has changed today.

## The daily command (coordinator, once a day until Oct 31)

```sh
cd ~/Downloads/confidential-trenches/proofs/bnb-recheck && node recheck.mjs | tail -1
```

It prints one line, for example `… BNB re-check: CLOSED; 0 of 24 quoted; appended to results/bnb-recheck.jsonl`.
About 40 s, keyless, read-only. Commit the appended `results/bnb-recheck.jsonl` with the day's other files.

## Sources

- `GET https://1click.chaindefuser.com/v0/tokens`, read 2026-10-20 16:04:27Z (asset ids, decimals, prices).
- `POST https://1click.chaindefuser.com/v0/quote` (keyless, dry), 24 calls 16:04:27Z to 16:05:06Z.
