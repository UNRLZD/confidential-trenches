# P8: model check of the waiting-withdrawal alarm and its legs (merge note M134 (6))

Lane MC. An executable model of these rules, fuzzed with fast-check over random action sequences on the four chains:
- 06a §4.13-§4.18, with every ret., cnv., far., wdr., refill. and solv. row that moves money here;
- signer rules 1-3;
- 04 I1, I7, I8, X7, X8, X23, X24;
- merge notes M125, M128-M147, M149, M151, M152 and M158.

Sources: rules at f94b41b, M135's rules from d111469 (the papers that carry it), and M136 from its note (e5cb49f)
together with lane NE's readings. Line numbers below are at d111469.

- `model.ts` (784 lines) is a pure state machine. It takes an injected anchor clock and injected leg outcomes, and holds
  the four chains as data (dead-verdict delays, wrapped native, nonce order). The build can reuse it as the property
  test for this logic.
- `props.ts` (445 lines) holds the properties (fifteen since M138), the oracle, the fixed regressions and the runner:
  `node props.ts [runs] [seed]`.
  - `FIX=wait,live,final,level` turns on the four fixes below.
  - `FIX=m135` puts back the superseded M135 re-quote (all waits quoted at once against one Available), as a check
    that P10 can fail.
  - `FIX=wait,live,finalnative,level` swaps fix 3 for its variant, and `onepull` adds one line to it (see "Fix 3
    variant").
  - `FIX=perwait,live,finalnative,onepull,level,endfinal,boundf` is M138's set (see "M138").
  - `FIX=nochain,live,finalnative,onepull,level,endfinal,boundf` is M140's set. M141 (b) adds `endbuy`, M140 (1)'s buy
    half, and `tx.final` is per chain since M143.
  - `FIX=nochain,live,finalnative,onepull,level,endfinal,endbuy,boundf,refillcash` is M145's set (see "M145").
  - `FIX=nochain,live,finalnative,onepull,level,endfinal,endbuy,boundf,refillcash,landpull,neardead,relandowe,retfinal,refinal`
    is M147's set, PR-04's v1.38 set (see "M147").
  - The same with `gpull,fateoracle,x24long` added is M151's set, the one this round runs for PR-04 (see "M151").
  - `FIX=...,sealed` puts back the papers at f645c4a: `tx.final` on Base and Robinhood at 1 anchor (see "M143").
  - `FIX=...,pullonly` puts back CO's first correction to M147 (1): `landpull` counts coming pulls only, not a coming
    full return (see "M147").
  - `FOCUS=1` runs a sweep of G's key alone, and `RIF=1` a sweep from M145's state (returns in flight above L).
- `mutants.ts` (115 lines) is the mutation run, outside PR-04: rule mutations (a fault in the current rules) and
  pre-fix mutations (a fix dropped or replaced), each of which must make its check fail (`node mutants.ts [runs] [seed]`).
- fast-check **4.10.2**, published 2026-09-19T19:34:54Z (`npm view fast-check time --json`), pinned exactly. It is the only
  dependency. Node 24.12.0 runs the TypeScript directly (type stripping).

## Runs

Each run had 100,000 sequences of 1-60 actions (`size: 'max'`, 29.8 actions on average) and went through
`scripts/heavy.sh`. In all, 500,000 sequences and 14.88 M actions, each sweep taking 25-27 s. Each failing property
was then shrunk by a second fast-check pass over the same generator, and by hand to drop the one trailing no-op
action fast-check left.

| Run | Seed | Actions | Sequences with a wait / a notice / wind-down | Failing sequences |
|---|---|---|---|---|
| Papers as written | 20261021 | 2,979,468 | 62,834 / 48,327 / 38,138 | P1 743, P5 38, P6 90, P8 1, P9 1 |
| Papers as written | 4 | 2,971,775 | 62,909 / 48,462 / 38,001 | P1 769, P4 1, P5 39, P6 91, P9 1 |
| The four fixes on | 20261021 | 2,979,468 | 62,836 / 48,515 / 38,138 | none |
| The four fixes on | 4 | 2,971,775 | 62,912 / 48,631 / 38,001 | none |
| M135's re-quote put back | 20261021 | 2,979,468 | 62,834 / 48,325 / 38,138 | the paper failures + P10 508, P3 2,714 |

## Properties (200,000 sequences each way)

| # | Property | Papers as written | With the fixes |
|---|---|---|---|
| P1 | Pages when short: a `funds_wait` within X24 + 2 anchors (except while an owner call is in flight) | **FAIL** (1,512) | PASS (fix 1) |
| P2 | Pages only when short | PASS | PASS |
| P3 | Waits end | PASS | PASS |
| P4 | Books: B (solv.1, wrapped native 1:1) equals the ledger, less only a moved leg; L likewise | **FAIL** (1, Solana) | PASS (fix 3) |
| P5 | Payout bound: payout ≤ omnibus USDC − L − D at the signature | **FAIL** (77) | PASS (fix 2) |
| P6 | One signer: one live tx per (ghost, key); one key per payout record (as first defined, 7378733; now split, below) | **FAIL** (181, all four chains) | PASS (fix 3) |
| P7 | No double pay (across far.20's re-type too) | PASS | PASS |
| P8 | Pulls: exactly one pull open on G at a record's end | **FAIL** (1) | PASS (fix 3) |
| P9 | No stranded asset: no Available ≥ X7 without a K or `u` planned, two anchors running | **FAIL** (2) | PASS (fix 4) |
| P10 | No starvation: two waits that Available covers together are not both left waiting (M136) | PASS | PASS |

P10 under M135's re-quote fails in 508 sequences. Shrunk (12 actions):
`buy(g=0) ; leg(i=0,o=land) ; leg(i=0,o=success,fee=1) ; wd(463) ; wd(46) ; wd(46) ; tick(6) ; wd(417) ; tick(14) ;
leg(i=0,o=expire) ; tick(1) ; callE(5)` ends with waits of 46 + 46 left under Available 508. M136 (c) is therefore
needed, and P10 sees the difference.

## Failures (papers as written), each checked by hand against the text

How to read the sequences:
- Amounts are model units (1 unit = $0.01; X7 = 10, omnibus USDC starts at 400, L at 1,600).
- `g` picks among the ghosts in the named state, i mod count. Ghosts 0-2 are Solana, 3-5 Base, 6-8 Robinhood and
  9-11 NEAR, each chain having two WARM and then one POSITION.
- `leg(i)` picks the i-th open leg, i mod count.

### 1. P1: the alarm never pages while fresh legs keep the gap covered (fix 1, `FIX=wait`)

Shrunk (seed 20261021): `wd(20) ; exp(g=0,full=true) ; wd(381) ; tick(2) ; image ; tick(1) ; tick(20)` → short
since anchor 1, no `funds_wait` by anchor 23.
1. The first payout's W holds 20 in Reserved, leaving Available at 380.
2. Ghost 2's full return ($0.40) is sent at 0.5 and never arrives.
3. The payout of 381 waits from 0.5. It is truly short by 1 from anchor 1, but the gap reads −39.
4. The return image at 2.5 sends eight WARM full returns. Each is a fresh chain counted to anchor 22, so the first
   active anchor is 23 and the notice comes at 24.

Two hand-built cases show the same thing:
- A stream of four stuck pulls, each sent before the last one leaves On the way, pages at anchor 79 (≈ 39 min).
- A carry (an R refunded at 15.5, then cnv.1's K stuck) pages at anchor 37. The K is a new chain: an R refund is not
  on the inheritance list.

With fix 1, both page at anchor 22.
- **Lines broken:**
  - 06a §4.16 l. 1487-1488: "every stuck leg … leaves the gap within X24 of its chain's first send, and the alert
    pages". That is true per leg but not per wait.
  - l. 1492-1494: "X24 runs per leg chain".
  - 04 X24 l. 1232 and WDR-10 l. 379.
- **Fix:** X24 also runs from the waiting period's start: a leg counts On the way only until X24 after the earlier
  of its chain's start and the start of the oldest unbroken wait.

### 2. P5: the owner payout signs from stale anchor values (fix 2, `FIX=live`)

Shrunk: `call ; leg(i=0,o=success) ; image ; tick(1) ; sell(g=0,full=false,wrap=false,p=20) ; sweep` → payout 18,800
> live omnibus USDC − L − D = 18,780.
1. The owner's capital call lands 20,000.
2. Anchor 1 stores USDC 20,400 and L 1,600.
3. A partial sell then credits 20 of notes.
4. pay.3 re-reads the bound "from the latest anchor's values" and signs 18,800, so the sell's 20 of notes is backed
   by no USDC.
- **Lines broken:** 06a §4.18 l. 1648 (pay.3 reads the latest anchor's values); pay.3 l. 1658; 04 I8 l. 181 ("every
  note alive at the payout is backed by USDC alone").
- **Fix:** pay.3 reads omnibus USDC, L and D live in the log step that signs.

### 3. P6, P8, P4: signer rule 2 frees G when a tx lands, but a landed tx can be reorged and land again (fix 3, `FIX=final`)

- **P6.** Shrunk (seed 20261021, ghost 3 on Base):
  `buy(g=2) ; leg(i=0,o=land) ; exp(g=1,full=true) ; leg(i=0,o=reorg)` → ghost 3 has 2 owners.
  1. The buy's ret.1 pull lands on two providers, so G is free (rule 2).
  2. A full export opens the full return (ghost.12), and its tx signs.
  3. The pull's landed tx is reorged out and is live again, so two txs are live on one key.

  Seen on all four chains. On Base, Robinhood and NEAR the nonce only decides which tx lands first.
- **P8.** Shrunk: `sell(g=0) ; wind ; sell(g=0) ; leg(i=0,o=land) ; sell(g=0) ; leg(i=2,o=land) ; leg(i=0,o=reorg) ;
  tick(1,m=0)` → ghost 2 ends a record with 2 pulls open.
  1. Three sells run on Solana ghost 2, and the pulls land in turn.
  2. The first pull reorgs while the third is live.
  3. The second one's R' then arrives, and that record's end finds two open pulls.
- **P4.** Shrunk (seed 4; Solana only, because there the nonce rule cannot hold the later tx back):
  `wd(20) ; buy(g=0) ; dep(c=0,a=5) ; sell(g=1,full=false,wrap=false,p=20) ; leg(i=13,o=land) ;
  sell(g=0,full=true,wrap=false,p=20) ; leg(i=6,o=reorg) ; dep(c=0,a=5) ; wd(20) ; leg(i=18,o=land) ; tick(2,m=0)`
  → B 2,740 vs ledger 2,850.
  1. Ghost 0's pull (110) lands, and a full sell's full return signs for G's native at that time (60).
  2. The pull reorgs, so G holds 170 again.
  3. The full return lands and arrives, and G goes RETIRED with 110 native on it. That native is out of B (solv.1
     counts no RETIRED ghost, l. 1366), and nothing sends it home if the reorged pull goes `dead`: ret.14's pull end
     needs POSITION.
- **Lines broken:**
  - Signer rule 2, 06a l. 947-950: "until that tx has landed on two providers (ret.7) … a POSITION ghost is free
    again after a pull".
  - Rule 3, l. 961.
  - 04 I4 l. 177: "no second tx for a ghost key until the first can no longer land".
  - ret.1 l. 1187, ret.7 l. 1193, ret.14 l. 1200, sell.2 l. 1248, ghost.13 l. 1087, solv.1 l. 1366, 04 I1 l. 174.
- **Fix:** G's key lock (signer rule 3, I4) holds from a tx's signature until that tx is `tx.final` on two providers
  (the test xk.2 already uses, l. 1301) or A4 `dead`, not until it lands.
  - Cost: a sell right after a pull waits for finality: ≈ 6.8 s on Solana. The per-chain waits are under "Fix 3
    variant".

### 4. P9: a price rise lifts omnibus dust to X7 and nothing converts it (fix 4, `FIX=level`)

Shrunk: `dep(c=3,a=7) ; leg(i=0,o=refund) ; price(c=3,pct=15) ; price(c=3,pct=24) ; tick(2)` → omni:near stranded
at anchors 1-2.
1. A NEAR deposit of 0.07 USD is refunded into the omnibus, below X7, so cnv.1 makes no K.
2. The price rises 43%, lifting it to 10.01 ≥ X7.
3. No landing follows, so it sits.
- **Lines broken:** 06a l. 1468-1469 ("when it lands … until a later landing lifts it to X7"); cnv.1 l. 1577 (the
  trigger is a landing at the omnibus, but a level read at each anchor at E).
- **Fix:** cnv.1 at the omnibus is a level condition read at every anchor, as at E.

## Fix 3 variant: `finalnative` (CO, after 7378733)

Fix 3 makes every tx on G hold G's key until `tx.final`, so a sell right after a record-end pull waits for that
finality. On Solana that is ≈ 6.8 s, against the click → filled ≤ 2 s KPI.

The variant keeps signer rule 2 for trades: a sell, fire or export takes G once the pull has landed on two providers,
as now. Only a record that reads G's native for an amount waits for every tx on G to be `tx.final` or A4 `dead`, and
then re-reads. These are a pull (pullable, its unwrap, its transfer), a full return (its amount, ret.4) and xk.3.
- A reorged landed tx is live again and blocks only those native-reading records.
- The nonce rule stays on Base, Robinhood and NEAR.

P6 is split into three checks, and one floor check is added:
- **P6a:** never two live txs on G that move its native out. A reorged tx counts as live until it is final or `dead`.
- **P6b:** every native read for an amount happens when no other tx on G is live or landed-but-not-final.
- **P6c:** one key per payout record.
- **NF:** G's native is never below 0, even once every live transfer lands. In that worst case a POSITION ghost keeps
  its floor (X23, the sell reserve that pays a sell's fee, 04 l. 1231), or all it holds when that is less.

P1-P5 and P7-P10 are unchanged: the papers' counts at both seeds match the runs above exactly.

### The runs

Two kinds of run were made, each through `scripts/heavy.sh`:
- **Main:** seeds 20261021 and 4, 200,000 sequences and 5.95 M actions per column.
- **Focus** (`FOCUS=1`): seed 20261021, 100,000 sequences and 2.0 M actions. It drives sells, fires, exports and buys
  on four ghosts, with leg outcomes weighted to landings and reorgs.

Coverage of the window that matters: under `finalnative`, the focus run had 6,419 trades that ran while a pull on G was
landed but not final. In 1,013 sequences that pull was then reorged. The main sweep has about 35 such sequences per
100,000.

| Property | Papers main / focus | `final` main / focus | `finalnative` main / focus | `finalnative` + `onepull` main / focus |
|---|---|---|---|---|
| P1 | FAIL 1,512 / PASS | PASS / PASS | PASS / PASS | PASS / PASS |
| P2, P3, P6c, NF, P7, P10 | PASS / PASS | PASS / PASS | PASS / PASS | PASS / PASS |
| P4 | FAIL 1 / FAIL 15 | PASS / PASS | PASS / PASS | PASS / PASS |
| P5 | FAIL 77 / PASS | PASS / PASS | PASS / PASS | PASS / PASS |
| P6a | FAIL 137 / FAIL 6,356 | PASS / PASS | PASS / PASS | PASS / PASS |
| P6b | FAIL 7,003 / FAIL 37,594 | PASS / PASS | PASS / PASS | PASS / PASS |
| P8 | FAIL 1 / FAIL 14 | PASS / PASS | PASS / **FAIL 7** | PASS / PASS |
| P9 | FAIL 2 / PASS | PASS / PASS | PASS / PASS | PASS / PASS |

Shrunk sequences (hand-minimised, each replayed):
- **Papers, P6a:** `buy(g=2) ; leg(i=0,o=land) ; exp(g=1,full=true) ; leg(i=0,o=reorg)` → ghost 3 (Base) has 2 live
  native-out txs. This is failure 3 above.
- **Papers, P6b:** `sell(g=0) ; leg(i=0,o=land) ; sell(g=0)` → the second record's pull reads ghost 2's native while the
  first pull is landed and not final (signer rule 2, 06a l. 947-950; ret.1 l. 1187).
- **`finalnative`, P8** (focus): `sell(g=0) ; leg(i=0,o=land) ; sell(g=0) ; tick(2) ; leg(i=1,o=land) ; sell(g=0) ;
  leg(i=1,o=reorg) ; leg(i=0,o=refund)` → ghost 2 (Solana) ends a record with 2 pulls open.
  1. A sell's record-end pull is opened while the previous pull is landed and not final, so it waits unsigned.
  2. The previous pull's tx then reorgs.
  3. The first pull's refund then ends a record, and ret.1 finds two pulls open: the reorged one and the waiting one.

  This breaks only the count. Both endings were followed by hand:
  - The reorged tx re-lands: it moves its 20, and then the waiting pull moves 20.
  - The reorged tx goes `dead`: the waiting pull moves 40, its own 20 plus the reorged 20.

  Either way G ends at its floor and each unit goes home once. P4, P6a, P6b and NF hold throughout. The letter of
  ret.1 l. 1187 ("exactly one pull") is still broken.
- **Fix for it (`onepull`):** a reorg of G's landed tx cancels any pull on G that has not yet signed (as ret.13 (a)),
  and the reorged tx's end re-runs ret.1. With it, all 13 checks pass in both sweeps.

### Verdict

`finalnative` with `onepull` is as safe as `final` on every property here. Without `onepull` it fails only P8's
count, in the case above, and it is as safe as `final` on money.

The model's limits on this comparison:
- Trades are atomic and final at once (reading 8), so the variant's wait on a trade's own tx is not exercised. The
  record-end pull does wait for that tx's finality in the rule; the trade-reorg rows (buy.20, sell.12) are outside
  the model.
- An unwrap's own reorg is not modelled. Both variants wait on it alike, so the comparison is not biased by it.
- A reorged landed tx is read as blocking no new trade, from the variant's "blocks only those native-reading records".
  Under that reading more interleavings are possible than under the papers' sell.2 reading.

### Added wait per chain

The added wait is landing on two providers → `tx.final`, from the 6c facts at e5cb49f.

| Chain | `tx.final` after landing | `final`: a trade right after a pull | `finalnative`: a trade | `finalnative`: the next pull, full return or xk.3 |
|---|---|---|---|---|
| Solana | `finalized` ≈ 6.8 s after `confirmed`: 29-32 slots at 218 ms (01 l. 166, 09 l. 150; 6c l. 441) | + ≈ 6.8 s | 0 | ≈ 6.8 s after G's last tx, off the click path |
| Base | the sealed 2 s block: the receipt is pre-confirmed first (6c l. 601-607). Sealed p50 2.5 s vs filled p50 1.8 s, float buys (P4-BASE l. 24) | + ≈ 0.7 s p50, ≤ one 2 s block | 0 | the same, off the click path |
| Robinhood | an L2 block on two providers, 0.1 s blocks (6c l. 638-642); its time is not measured (09 l. 150) | + ≈ 0.1 s (one block) | 0 | the same, off the click path |
| NEAR | `final` p50 ≈ 5.0 s vs the `optimistic` fill p50 ≈ 3.8 s (P4-NEAR l. 4-5; 6c l. 861) | + ≈ 1.2 s p50 | 0 | the same, off the click path |

## M138 (CO, after R10 at 2fb7299)

Sources: the papers at 2fb7299 and merge note M138 (docs/spec/11-merge-notes.md at 7e0a894). Line numbers in this
section are at 2fb7299. Amounts are in cents.

### What the model gains

1. **`FIX=perwait`** (M138 (2)) replaces `wait`. X24 runs from the earlier of the leg's chain start and the start of
   the paying account's oldest payout still waiting. When that payout is paid or released, the next oldest one's start
   applies, so one long period no longer holds the start.
2. **Full sells and full exports are no longer atomic** (M138 (1)). Their emptying tx follows the reorg rule (06a l.
   987-999):
   - it lands: the tokens leave G, a sell's proceeds reach G and the sell is credited (the `confirmed` fill);
   - it can be reorged before `tx.final`: the tokens come back, and G is held as for any reorged tx (signer rule 3);
   - it can then land again, or go `dead`, and then the credit is recorded against P and netted from P's next sell
     (SEL-11). A re-land after the tokens have gone fails.
   - Papers: ghost.12 runs at the landing, so G goes RETURNING and ret.13 (a) cancels its queue.
   - `FIX=endfinal`: ghost.12 runs when the emptying tx is `tx.final`, and only if G holds no tokens then. Until then G
     stays POSITION.
   - A sell, fire or export on G with no tokens ends with no tx and no charge (in both sets).
3. **`FIX=boundf`** (M138 (4)): the payout bound also subtracts every open F and `u` from omnibus USDC before its
   source debit.
4. **New checks.**
   - **P11, no position trapped:** a ghost holding tokens is POSITION or EXPORTED, unless its emptying tx is still live
     (sent, or reorged and not yet `dead`).
   - **P12, I8 at the payout:** after each owner payout, omnibus USDC, less every leg from it that has not yet debited,
     is at least the notes alive then. Notes alive are L, less the W legs open at the omnibus, plus deposits that have
     landed but are not yet credited.
   - P1 and P2 use the per-payout oracle (see "How the oracle judges short").
5. **Two fixed regressions** run after every sweep:
   - **stream** (R10): a $4 wait drains the omnibus, then come 30 overlapping $1 waits. Each is paid one anchor after
     it starts by the $1 pull of a sell made at its start. Expected: no notice, and no check fails.
   - **bound** (R10, refill.11): `call ; leg(0,success) ; refill(c=0) ; image ; tick(1) ; sweep`. A refill F is open
     at the sweep. Expected: P12 holds.

### The runs

Each run had 100,000 sequences and went through `scripts/heavy.sh`, 14 runs and 1.4 M sequences in all:
- main sweeps: 2.98 M actions (seed 20261021) and 2.97 M (seed 4);
- focus sweeps: 2.00 M actions per seed.

The papers' set is `FIX=wait,live,finalnative,onepull,level`, which was M137 at 17c7a72. M138's set is
`FIX=perwait,live,finalnative,onepull,level,endfinal,boundf`. The leave-one-out runs drop one M138 fix at seed
20261021 (`wait` in place of `perwait`).

| Check | Papers main 20261021 / 4 | Papers focus 20261021 / 4 | M138, all four runs | `wait` for `perwait` main / focus | no `endfinal` main / focus | no `boundf` main / focus |
|---|---|---|---|---|---|---|
| P1, P3-P10, P6a-P6c, NF | PASS | PASS | PASS | PASS | PASS | PASS |
| P2 | **FAIL 3 / 1** | PASS / PASS | PASS | **FAIL 3** / PASS | PASS | PASS |
| P11 | **FAIL 74 / 66** | **FAIL 191 / 175** | PASS | PASS | **FAIL 74 / 191** | PASS |
| P12 | **FAIL 66 / 69** | PASS / PASS | PASS | PASS | PASS | **FAIL 65** / PASS |
| stream | **FAIL** (a notice from anchor 22) | **FAIL** | PASS (0 notices) | **FAIL** | PASS | PASS |
| bound | **FAIL** (18,800 paid, 1,300 left, 1,600 alive) | **FAIL** | PASS | PASS | PASS | **FAIL** |

Shrunk sequences (hand-minimised, each replayed under both sets; it fails with the papers' set and passes with M138's):
- **P2:** `wd(401) ; tick(10) ; wind ; tick(7) ; leg(0,land) ; wd(20) ; callE(401) ; tick(6) ; tick(1,m=0)` is R10's
  stream in small. The $4.01 wait from 0.5 and the $0.20 wait from 17.5 overlap, so `wait` keeps X24's start at 0.5.
  From 20.5 no leg counts, and a notice is open from 22 to 24 while money that arrives within the $0.20 wait's own
  X24 covers it. At seed 4: `callE(129) ; wd(272) ; wd(129) ; tick(8) ; wd(129) ; wind ; leg(2,land) ; tick(15) ;
  tick(1,m=0)`.
- **P11:** `sell(g=0,full=true) ; leg(0,land) ; leg(0,reorg) ; tick(3) ; leg(0,dead)` leaves ghost 2 (Solana)
  RETURNING with its 2 token lots back on it. No row can sell or export them, and the credit's netting has no next sell.
  At seed 4 the same happens with `exp(g=0,full=true)`.
- **P12:** `call ; leg(0,success) ; image ; wind ; tick(1) ; sweep` is the `u` half of M138 (4). The sweep pays
  18,800 while far.21's `u` of the same USDC is open; once the `u` debits, omnibus USDC is −18,800 against 1,600 of
  notes alive. The bound regression is the F half.

### Verdict

- **Each fix is necessary.** Without `perwait` the stream and P2 fail; without `endfinal`, P11; without `boundf`, P12
  and the bound case. Each is the papers' failure of the same kind, with the same shrunk case.
- **Together they are sufficient.** M138's set passes all 15 checks and both regressions in all four sweeps.
- `perwait` costs no page that P1 asks for. P1 reads each payout's fate, and it passes under both clocks: every payout
  still waiting at its own start + X24 is the oldest one or younger, so no leg counts for it.
- **PR-04 ran** (until M140) `FIX=perwait,live,finalnative,onepull,level,endfinal,boundf`, main and focus sweeps, seeds 20261021
  and 4, 100,000 sequences each, with both regressions.

### What the model shows about M138's text

1. **M138 (2)'s last sentence is too strong.** "A stream of overlapping waits that are each paid in time never pages"
   fails under M138's own rule in 661 of 100,000 sequences (seed 20261021), judged by fate alone. Shrunk (10 actions):
   `wd(20) ; wd(145) ; sell(g=0,p=20) ; tick(6) ; wd(236) ; tick(18) ; sell(g=2,p=20) ; sell(g=5,p=20) ; dep(c=0,a=5) ;
   leg(5,land)`.
   - The first sell's pull, sent at 0.5, never moves, so it stops counting at 20.5.
   - The $2.36 wait is then uncovered, and the alarm pages by 24.
   - A deposit sent at 24 then pays it within its own start + X24.

   The page is right: no money on the way covered the wait. The sentence holds only for waits that money already on
   the way covers in time, and P2 checks it in that form. Suggested wording: "...that money on the way covers within
   X24 never pages".
2. **Both halves of M138 (4) are needed.** The fuzz finds the `u` case in wind-down, and the regression is the F case.
   This holds as long as the sweep may run in wind-down, which pay.1's "Return image only" allows (reading 14).
3. **No gap was found in the reorg rule** for the emptying tx. A re-land with another outcome is reversed and re-run
   (l. 994-996). The tokens that come back on a POSITION ghost can be sold again, and that sell nets the owed credit.

## M140 (CO, after R11 at f4a5676)

Sources: the papers at f4a5676, merge note M140 (docs/spec/11-merge-notes.md at f5444dc), and R11's report and case 1.
Line numbers in this section are at f4a5676. Amounts are in cents.

### What the model gains

1. **`FIX=nochain`** (M140 (2)) replaces `perwait`. A leg counts On the way until its arrival, `dead`, INCIDENT or
   close, or until X24 after the start of the paying account's oldest payout still waiting, read at each anchor. There
   is no chain start, no inheritance and no boot clause: under `nochain` the model never reads a leg's chain.
2. **P2's oracle** (M140 (3)) no longer shares any clock with the alarm. A page is false while every waiting payout
   will be paid by its own start + X24 from the money there at that read: Available, plus the legs on the way whose
   USDC really reaches the paying account in time.
   - Payouts are paid oldest first, so the i-th payout needs the first i amounts by its own deadline.
   - A payout still waiting past its own deadline is short.
   - R11's case 1 is a third fixed regression (`case1`).
3. **P5 and P6b are regression checks.** Under `live` and `finalnative` the model's guard is the check itself, so
   neither can fail there.
   - Every run replays one fixed case of each pre-fix rule with that fix off: P5 without `live` (failure 2) and P6b
     without `finalnative` (failure 3). Each must fail, or the run exits 1.
   - The output says so on both lines.
   - The pre-fix sweep (`live` and `finalnative` off) fails both checks.
4. **P6c and P7 read a ledger**, not the records' states. For each payout, the model records:
   - its W legs' debits less refunds, per account;
   - every account it ever left;
   - what the user received: the W's amountIn at success, or the notes back at a refund.

   P6c: a payout leaves at most one account, at most once, and exactly once if it is paid. P7: the user receives it at
   most once, and exactly once if it is paid.
5. **Buys are no longer atomic** (M140 (1)). A buy puts G in BUSY, holds P's notes and sends its tx. That tx:
   - lands as a fill (ghost.8 at once, in both rule sets) or as a revert (buy.15: the notes go back, fee 0);
   - can be reorged before `tx.final`, with no money action (buy.20);
   - can then land again (buy.25), with the same outcome or the other one. For the other one, the reorg rule reverses
     the recorded money and runs the new outcome's row on G's state then;
   - can go `dead`: buy.16 sends a Solana G back to WARM, buy.17 sends G home, and buy.24 gives the debit back to P.
   - Papers: ghost.9 runs at the revert's landing, and no row covers a fill re-landed as a revert.
   - **`FIX=endbuy`**: ghost.9 and ghost.15 run at the buy record's end (`tx.final` or `dead`), and only if G holds no
     token then. `endfinal` stays M138's rule for sells and exports, so the papers' set keeps its meaning. M140 needs
     both.
   - **P11 gains its mirror half**: no ghost is left BUSY, or POSITION with no token (its floor stranded), once no
     trade record on it is open.
   - A fork that drops a filled buy also drops a landed emptying tx that spent its tokens.
6. **`mutants.ts`** is the mutation run, outside PR-04. Each row takes M140's set, injects one mutation (a fix
   dropped or swapped, or `mut`, a fault in `model.ts`) and must make its check fail.

### The runs

Each run had 100,000 sequences and went through `scripts/heavy.sh`: 16 sweeps (1.6 M sequences) and the mutation
run. Main sweeps had 2.98 M actions at seed 20261021 and 2.97 M at seed 4; focus sweeps had 2.00 M at each seed.
- **Papers** (f4a5676): `FIX=perwait,live,finalnative,onepull,level,endfinal,boundf`.
- **M140**: `FIX=nochain,live,finalnative,onepull,level,endfinal,endbuy,boundf`.
- **Pre-fix**: M140 without `live` and `finalnative`, the run in which P5 and P6b must fail.
- **Leave-one-out** at seed 20261021: `perwait` in place of `nochain`, and M140 without `endbuy`.

Each cell is a count of failing sequences. Where a cell shows two counts, they are seed 20261021 / seed 4.

| Check | Papers main | Papers focus | M140, all four | Pre-fix main | Pre-fix focus | `perwait` for `nochain`, main / focus | no `endbuy`, main / focus |
|---|---|---|---|---|---|---|---|
| P1, P3, P4, P6c, P7, P9, P10 | PASS | PASS | PASS | PASS | PASS | PASS | PASS |
| P2 | **157 / 165** | PASS | PASS | PASS | PASS | **159** / PASS | PASS |
| P5 | PASS | PASS | PASS | **17 / 19** | PASS | PASS | PASS |
| P6a | PASS | PASS | PASS | **132 / 140** | **5,296 / 5,395** | PASS | PASS |
| P6b | PASS | PASS | PASS | **4,410 / 4,486** | **34,588 / 34,578** | PASS | PASS |
| NF | PASS | PASS | PASS | PASS | **6 / 3** | PASS | PASS |
| P8 | PASS | PASS | PASS | **1** / PASS | **13 / 5** | PASS | PASS |
| P11 | **48 / 59** | **398 / 377** | PASS | PASS | PASS | PASS | **48 / 398** |
| P12 | PASS | PASS | PASS | **5 / 7** | PASS | PASS | PASS |
| stream, bound | PASS | PASS | PASS | PASS | PASS | PASS | PASS |
| case1 | **FAIL** (a notice at 22) | **FAIL** | PASS | PASS | PASS | **FAIL** | PASS |

- In the pre-fix run, P12's failures are P5's own case: a payout signed from stale values leaves notes unbacked.
- Notices fall from 49,424 to 48,201 sequences at seed 20261021, and from 49,487 to 48,251 at seed 4.

Shrunk sequences, hand-minimised; each one fails under the papers' set and passes under M140's:
- **P2** (seed 20261021): `wd(30) ; image ; tick(14) ; leg(1,land) ; wd(616) ; tick(4,m=0) ; leg(10,land) ; wd(355) ;
  tick(5,m=0) ; leg(1,land) ; tick(1,m=0)`.
  - The return image's full returns are sent at 0.5.
  - A $3.55 wait from 18.5 is 1 cent short of Available, and those returns cover it.
  - Under `perwait`, the returns stop counting at 20.5, their chain's X24, and the alarm notifies at 22.
  - One return arrives at 24.01, long before the wait's own deadline, 38.5. This is R11's case 1 from the fuzz.
- **P2** (seed 4): `wd(401) ; wind ; boot ; tick(13) ; wd(20) ; tick(10) ; leg(0,land) ; tick(1,m=0)`.
  - The boot clause restarts every chain at anchor 1.
  - A $0.20 wait from 13.5 is paged at 22.
  - The `u` covering it arrives at 24.01, before its deadline at 33.5.
  - M140 drops the boot clause too.
- **P11** (buys):
  - `buy(g=0) ; leg(0,failed) ; leg(0,reorg) ; leg(0,land)` leaves ghost 0 RETURNING with 2 token lots. ghost.9 ran
    at the revert, and no row moves G back.
  - The mirror case `buy(g=0) ; leg(0,land) ; leg(0,reorg) ; leg(0,failed) ; tick(2)` leaves ghost 0 POSITION with
    no token and no trade open, so its floor is stranded.
- **case1** (R11): a notice at anchor 22 under `perwait`, none under `nochain`.

### Mutation run (`mutants.ts`, seed 20261021, 100,000 main and 100,000 focus sequences per row)

Each mutation is M140's set with one change. Every row's check fails, and every shrunk case passes under M140.

| Check | Mutation | Failing, main / focus | Shrunk (hand-minimised) |
|---|---|---|---|
| P1 | X24 per leg chain only (M134; no `nochain`) | 7,594 / 2 | `wd(177) ; wd(224) ; tick(2) ; image ; tick(20)`: payout 1 from 0.5 still waits at anchor 22, with no `funds_wait` |
| P2 | `perwait` for `nochain` | 159 / 0 | the papers' case above |
| P3 | `noquote`: the anchor does not re-quote | 1,327 / 0 | `wd(20) ; wd(145) ; tick(2) ; wd(236) ; tick(18) ; leg(0,expire) ; tick(1)`: a wait of 236 sits with Available 255 |
| P4 | `bnowrap`: B leaves out G's wrapped native | 25,811 / 45,103 | `sell(g=1,wrap=true,p=20) ; tick(1)`: B 2,960 vs ledger 2,980 |
| P5 | no `live` | 18 / 0 | failure 2's case |
| P6a | no `finalnative` | 132 / 5,296 | `wd(20) ; buy(g=0) ; leg(1,land) ; leg(1,reorg)`: 2 live native-out txs on ghost 0 |
| P6b | no `finalnative` | 4,410 / 34,588 | `buy(g=0) ; leg(0,land)`: the BUY-40 pull reads G's native while the buy's tx is not final |
| P6c | `twokeys`: far.20 re-types a payout in flight, so the exit key signs it again | 16 / 0 | `wd(20) ; wind ; callE(40) ; sell(g=0,p=20) ; exp(g=1,full=true) ; wd(20) ; leg(24,land) ; leg(0,land)`: payout 0 left E and the omnibus |
| NF | `nofloor`: a pull takes G's floor | 52,035 / 85,193 | `exp(g=0)`: ghost 2 keeps 0, below its floor |
| P7 | `refundpaid`: a refunded W stays open | 184 / 277 | `wd(20) ; leg(0,land) ; leg(0,refund) ; leg(0,success)`: the user receives payout 0 twice |
| P8 | `nopenop`: ret.1 opens a pull while one is open | 471 / 8,333 | `sell(g=0) ; leg(0,land) ; sell(g=0) ; tick(1,m=0)`: 2 pulls open at a record's end |
| P9 | `nocnv`: no convert planned at the omnibus | 5,291 / 4,223 | `dep(c=0,a=10) ; leg(0,refund) ; tick(2)`: omnibus SOL stranded |
| P10 | `m135`: M135's all-at-once re-quote | 482 / 0 | `wd(322) ; wd(79) ; wd(79) ; tick(20) ; wd(243) ; leg(0,expire) ; tick(1)`: 79 + 79 starve under Available 400 |
| P11 | no `endbuy` | 48 / 398 | the mirror case above |
| P11 | no `endfinal` | 68 / 134 | `sell(g=0,full=true) ; leg(0,land) ; leg(0,reorg) ; tick(3) ; leg(0,dead)` (M138) |
| P12 | no `boundf` | 64 / 0 | `call ; leg(0,success) ; image ; wind ; tick(1) ; sweep` (M138) |
| stream | `wait` for `nochain` | fixed case | a notice at 22 |
| case1 | `perwait` for `nochain` | fixed case | a notice at 22 |
| bound | no `boundf` | fixed case | 18,800 paid, 1,300 left, 1,600 alive |

No check is left that no mutation can fail.

### Verdict

- **PR-04 ran** (until M145) `FIX=nochain,live,finalnative,onepull,level,endfinal,endbuy,boundf`: main and focus sweeps, seeds
  20261021 and 4, 100,000 sequences each. Then three fixed regressions (stream, bound, case1) and the two pre-fix
  cases. All of them PASS.
- **13 of the 15 checks can fail under that set**, each by a one-line mutation of the model.
- **P5 and P6b cannot fail under it**, because their guard is the check. Each run replays one fixed case of each
  pre-fix rule without that fix, and that case must fail; in the pre-fix sweep both checks fail.
- **Both new fixes are needed.** Without `nochain`, P2 and case1 fail; without `endbuy`, P11 fails. M140's set passes
  everything in all four sweeps.

### What the model shows about M140's text

1. **M140 (1) leaves a dead revert stranded on a BUSY ghost.**
   - Since ghost.9 now waits for the record's end, a revert that is reorged and then goes `dead` (buy.24) finds G still
     BUSY. buy.24 names ghost.15, which needs POSITION, and ghost.9 lists only buy.15, buy.17 and buy.18. Read
     literally, no row moves G, and its floor is stranded.
   - With that literal reading the model fails P11 in 16 of 30,000 focus sequences. Shrunk:
     `buy(g=0) ; leg(0,failed) ; leg(0,reorg) ; tick(3) ; leg(0,dead)`.
   - The model sends G home here (reading 15). Suggested wording: buy.24 runs ghost.9 when G is BUSY and ghost.15 when
     it is POSITION, each once G holds no token.
   - Under the papers at f4a5676 this never arose, because ghost.9 ran at the revert's landing.
2. **M140 (2) holds as written.** With `nochain`, P2 on each payout's own fate passes in 400,000 sequences, and so does
   P1, which pages for every payout not paid by its own start + X24. The seed-4 case shows that the boot clause made
   false pages too.
3. **M140 (4) agrees with the model.** The model's bound never held the payout itself, because its amount is read
   before its leg exists.
4. **Not modelled:** buy.13 (HELD), buy.18 (NEAR's registration-only case) and fees on buys.

## M143 (CO, after R12 at f645c4a)

Sources: merge note M143 (docs/spec/11-merge-notes.md at 5541b19), R12's report with its scratch model of the two
late reorgs, and proofs/evm-safe-lag (3b37d0f). Line numbers in this section are at f645c4a. Amounts are in cents.

### What the model gains

1. **`tx.final` per chain** (M143 (1), (8)). The single `FINAL = 1` is gone. `tx.final` is now the point at which a
   landed tx can no longer change: the model reorgs a landed tx before it, never after. Every rule that waits for
   `tx.final` reads its chain's value:
   - the wait of a pull, a full return and xk.3 for every other tx on G (signer rule 3, `finalnative`);
   - ghost.9, ghost.12 and ghost.15 at the record's end (`endfinal`, `endbuy`);
   - the reorg rule's end, and xk.2.

   | Chain | `tx.final`, anchors after landing | A4 `dead`, anchors after the send | Source |
   |---|---|---|---|
   | Solana | 1 | 3 (unchanged) | `finalized` ≈ 6.8 s after `confirmed` (6c l. 441); `dead` past lastValidBlockHeight (6c A4, l. 97) |
   | Base | 5 | 5 | the tx's block at `safe` on two providers; the slower provider's `safe` lag was 64-126 s (median 98 s), and 126 s rounds up to 5 |
   | Robinhood | 28 | 28 | the same; 493-821 s (median 646 s), and 821 s rounds up to 28 |
   | NEAR | 1 | 1 | `final` ≈ 1.2 s after `optimistic` (P4-NEAR l. 4-5; 6c l. 861); `dead` is a same-nonce tx final |

   - The Base and Robinhood lags come from one 5-minute sample (proofs/evm-safe-lag). Each value is that sample's
     maximum, not a long-run bound.
   - Solana's `dead` stays 3 anchors: M143 (8) drops only the stored Base and Robinhood values (2 and 20). This is a
     reading.
   - Robinhood's 28 anchors exceed X24's 20 on purpose. A pull on a Robinhood ghost waits up to 14 minutes for the last
     tx on G to reach `safe`, and the alarm must still keep its promise.
   - **`FIX=sealed`** puts back the papers at f645c4a. There the rules read `tx.final` on Base at the sealed block and on
     Robinhood at an L2 block, 1 anchor (6c PF-05 l. 506, l. 607, 642-645), while the chain can still reorg the tx
     until 5 or 28 anchors. xk.2 already waited for `safe` on Base (06a l. 1325), and `sealed` keeps that. A4 `dead` is
     the same in both, because A4 already read `safe`.
   - A trade record (the emptying tx of a full sell or export, or a buy's tx) ends at the rules' `tx.final`. Its tx can
     be reorged until its chain's value, which is later only under `sealed`.

2. **R12's two late reorgs are fixed regressions** (`lateSell` and `lateBuy` in props.ts). Every run replays each one
   twice. Under the run's set it must pass; under `sealed` it must fail. Otherwise the run exits 1.
   - **lateSell**, on ghost 5 (Base): `sell(g=1,full=true,p=20) ; land ; tick(2) ; reorg ; tick(3) ; dead ; tick(1)`.

     | Step | `sealed` (the papers at f645c4a) | The set (`tx.final` at 5 anchors) |
     |---|---|---|
     | The sell lands at 0.5 | tokens 2 → 0, native 40 → 60, 20 of notes credited | the same |
     | tick(2) | `tx.final` at 1.5: the record ends, ghost.12 sends G home, and the full return signs for 60 | not final: G stays POSITION |
     | reorg at 2.5 | 2 token lots back on a RETURNING ghost, native 60 → 40 (NF: the signed return of 60 exceeds it) | the tokens are back on a POSITION ghost |
     | `dead` at 5.5 | the credit of 20 is owed to the pool (SEL-11), and the tokens are trapped: **P11** | the credit is owed, and the tokens can be sold again |

   - **lateBuy**, on ghost 3 (Base): `buy(g=2) ; failed ; tick(2) ; reorg ; land ; tick(1)`.

     | Step | `sealed` | The set |
     |---|---|---|
     | The buy is sent at 0.5 | 150 of notes held, G BUSY | the same |
     | It reverts at 0.5 | the notes go back | the same |
     | tick(2) | `tx.final` at 1.5: ghost.9 sends G home, and the full return signs for 300 | not final: G stays BUSY |
     | Reorged at 2.5, and re-landed as a fill | 2 token lots on a RETURNING ghost, native 150, 150 of notes debited again: **P11** (NF: the return of 300 exceeds 150) | ghost.8: G is POSITION with its tokens, and the BUY-40 pull waits for the buy's `tx.final` |

3. **P12 is I8's user outcome** (M143 (4)). The old P12 compared the payout with the bound's own terms on one
   snapshot, which `live` and `boundf` made an identity (R12 finding 4). P12 now reads only the legs' amounts and the
   paying account's balance, never L, D or the bound:
   - **At each debit:** a W, F or `u` leg that lands must find its paying account holding its amount. In the model an
     account that is short cannot debit, and the leg stays open.
   - **In any debit order:** while a W, F or `u` leg is open from an account in an asset, the legs open from it before
     their source debit (W, F, `u`, K, `s` and the owner payout) sum to at most its balance. Otherwise some order of
     landings leaves a W, F or `u` short, and the enclave does not choose that order. M138 (4) already reasons this
     way: an F or `u` may debit after the payout.
   - The debit clause alone failed in none of 200,000 sequences under either P12 mutation below, because the bad order
     needs a sweep and then two chosen landings. The order clause is the same outcome over every order, and the fuzz
     reaches it.
   - The bound regression gains a W for every note that is open at the payout, and its debits: the payout, then the F,
     then the W. Without `boundf`, the W finds 1,300 for its 1,600.

4. **P6a is its user outcome** (M143 (4)): no native on G is spent twice (G's native and wrapped native never go below 0
   as its txs land), and no native is left on a RETIRED ghost once no tx on G that could move it out is live.
   - NF's first clause already reads "never below 0", so NF covers the first half. It does not cover the second, so P6a
     stays its own check and is not folded into NF.
   - The old P6a (two live native-out txs on G) restated signer rule 3, and it failed only without `finalnative`.
     Without `finalnative` the new P6a failed in none of 200,000 sequences (P6b failed in 40,663, P8 in 16 and NF in
     6), so that row is gone from `mutants.ts`.

5. **P1 drops the owner-call exemption** (M143 (7)). P1 still passes in all six sweeps of the set, so there is no
   sequence for CO to decide on.

6. **The stream regression alternates the Solana and NEAR ghosts** (2 and 11). Its sells' pulls must be sent at once.
   On Base and Robinhood the next pull on a ghost now waits for the last one's `safe`, so it would not be on the way.

7. **`mutants.ts` sorts its rows into two kinds.** A **rule** row is a fault in the papers' current rules. A
   **pre-fix** row drops a FIX flag or puts back a rule that a fix replaced (`perwait`, `m135`, `sealed`). Only rule
   rows count a check as one that can fail under the set. The run prints the count.

### The runs

Each run had 100,000 sequences and went through `scripts/heavy.sh`: 12 sweeps (1.2 M sequences) and the mutation run.
- **The set** is `FIX=nochain,live,finalnative,onepull,level,endfinal,endbuy,boundf`, with `tx.final` per chain.
- **The papers at f645c4a** are the same set with `sealed`.
- Seed 143 is new. Main sweeps had 2.98 M actions (seed 20261021), 2.97 M (4) and 2.97 M (143); focus sweeps had
  2.00 M at each seed.

Each cell counts failing sequences at seeds 20261021 / 4 / 143.

| Check | The set, main | The set, focus | Papers at f645c4a, main | Papers at f645c4a, focus |
|---|---|---|---|---|
| P1, P2, P3, P5, P6b, P6c, P7, P9, P10, P12 | PASS | PASS | PASS | PASS |
| P4 | PASS | PASS | **1** / PASS / **2** | **20 / 27 / 26** |
| P6a | PASS | PASS | **1** / PASS / **2** | **38 / 42 / 32** |
| NF | PASS | PASS | **62 / 52 / 50** | **540 / 529 / 529** |
| P8 | PASS | PASS | PASS | **1 / 1 / 3** |
| P11 | PASS | PASS | **14 / 22 / 17** | **56 / 50 / 46** |
| lateSell, lateBuy | PASS | PASS | **FAIL** (P11, NF) | **FAIL** |
| stream, bound, case1 | PASS | PASS | PASS | PASS |
| P5 and P6b pre-fix cases | fail, as they must | fail, as they must | fail, as they must | fail, as they must |

- Notices under the set: 48,224 / 48,263 / 48,440 sequences in the main sweeps (M140's runs at the first two seeds:
  48,201 / 48,251).
- Coverage of the new window, under the set at seed 20261021: a reorg on Base or Robinhood at least 1 anchor after its
  tx landed, which is after the papers' `tx.final`, hit 457 txs in the main sweep (B 104, T 203, full returns 98, pulls
  52) and 5,786 in the focus sweep (B 1,368, T 1,008, full returns 650, pulls 2,760). Every check passes in all of them.

Shrunk sequences of the papers at f645c4a (seed 20261021, replayed):
- **P11:** `exp(g=5,full=true) ; leg(0,land) ; tick(2) ; leg(0,reorg) ; tick(3) ; leg(0,dead) ; tick(1)`. Ghost 5
  (Base) is RETURNING with 2 token lots: R12's sell case, for an export. At seed 143 the same happens on ghost 8
  (Robinhood), reorged 6 anchors after landing and `dead` at 28. In focus: a buy's revert, `tick(2)`, a reorg and a
  re-land as a fill leave ghost 3 RETURNING with the tokens (R12's mirror).
- **P8** (focus): `wd(50) ; sell(g=1) ; sell(g=0) ; leg(4,land) ; tick(1) ; sell(g=1) ; leg(3,land) ; leg(1,reorg) ;
  leg(3,reorg) ; sell(g=1)`. A pull on ghost 5 (Base) lands at 0.5 and is `tx.final` for the rules at 1.5, so the next
  sell's pull signs and lands. Both are then reorged, the first one 1 anchor after landing. `onepull` cancels only an
  unsigned pull, so the next record ends with 2 pulls open. Under the set the second pull waits for the first's `safe`.
- **NF:** `sell(g=1,full=true) ; leg(0,land) ; tick(2) ; leg(0,reorg)`. The full return signed for 60 while ghost 5
  holds 40 after the reorg.
- **P6a and P4:** `sell(g=1,full=true) ; leg(0,land) ; tick(2) ; leg(1,land) ; leg(0,reorg) ; leg(1,success) ;
  tick(1)`. The full return has landed with the sell's proceeds when the sell is reorged, so ghost 5's native is −20
  (P6a). Once the return arrives, G is RETIRED, and at anchor 3 B is 20 above the ledger (P4). These two rest partly
  on simplification 1 below: on Base, a reorg that drops the sell drops the later return with it.

### Mutation run (`mutants.ts`, seed 20261021, 100,000 main and 100,000 focus sequences per row)

| Check | Kind | Mutation | Main | Focus | Also failing | Shrunk (main unless main is 0) → the check's message |
|---|---|---|---|---|---|---|
| P1 | rule | `pend3`: the pending period is three completed anchors, not two | 19,220 | 2 |  | `wind ; wd(a=20) ; tick(n=22) ; xk(g=0)` → payout 0 from 0.5 still waits at anchor 22, no funds_wait |
| P1 | pre-fix | X24 per leg chain only (M134: no `nochain`) | 10,069 | 2 | P2 157 | `wd(a=401) ; tick(n=1) ; sell(g=0,full=false,wrap=false,p=20) ; tick(n=19) ; tick(n=2)` → payout 0 from 0.5 still waits at anchor 22, no funds_wait |
| P2 | rule | `nootw`: the gap leaves out the money On the way | 728 | 59 |  | `wind ; wd(a=20) ; tick(n=3) ; leg(i=0,o=land,fee=0) ; tick(n=1,m=0) ; leg(i=0,o=land,fee=0)` → funds_wait open while covered for 3 anchors at 4 |
| P2 | pre-fix | `perwait` for `nochain` (the papers at f4a5676) | 157 | 0 |  | `wd(a=30) ; image ; tick(n=14) ; leg(i=1,o=land,fee=0) ; wd(a=616) ; tick(n=4,m=0) ; leg(i=10,o=land,fee=0) ; wd(a=355) ; tick(n=5,m=0) ; leg(i=1,o=land,fee=0) ; tick(n=1,m=0) ; leg(i=0,o=land,fee=0)` → funds_wait open while covered for 3 anchors at 24 |
| P3 | rule | `noquote`: the anchor does not re-quote waiting payouts | 1,327 | 0 | P1 343, P10 140 | `wd(a=20) ; wd(a=145) ; tick(n=2) ; wd(a=236) ; tick(n=18) ; leg(i=0,o=expire,fee=0) ; tick(n=1) ; exp(g=0,full=false)` → anchor 21: a wait of 236 sits with Available 255 |
| P4 | rule | `bnowrap`: solv.1's B leaves out G's wrapped native | 25,798 | 45,278 |  | `sell(g=1,full=false,wrap=true,p=20) ; tick(n=1) ; price(c=0,pct=0)` → anchor 1: B 2960.00 vs ledger 2980.00 − mover 0.00 |
| P5 | pre-fix | no `live`: pay.3 signs from the anchor's values | 18 | 0 |  | `call ; leg(i=0,o=success,fee=0) ; image ; tick(n=1) ; sell(g=0,full=false,wrap=false,p=20) ; sweep ; tick(n=1)` → P5 t=1: payout 18800 > live omnibus USDC − L − D = 18780.00 |
| P6a | rule | `nounwrap`: a full return sends G's native without unwrapping its wrapped native first (B-7, N-11) | 108 | 0 | P4 104 | `sell(g=3,full=true,wrap=true,p=20) ; leg(i=0,o=land,fee=0) ; tick(n=2) ; leg(i=0,o=land,fee=0) ; leg(i=0,o=success,fee=0) ; tick(n=1)` → P6a t=2: ghost 11 is RETIRED with 0 native and 20 wrapped on it |
| P6b | pre-fix | no `finalnative`: signer rule 2 as written before M137 | 4,469 | 36,194 | P8 16, NF 6 | `buy(g=0) ; leg(i=0,o=land,fee=0) ; callE(a=5)` → P6b t=0: ghost 0 native read while tx #0 (B, deb) is not final |
| P6c | rule | `twokeys`: far.20 re-types a payout already in flight, so the exit key signs it again | 15 | 0 | P3 72 | `wd(a=20) ; wind ; callE(a=40) ; sell(g=0,full=false,wrap=false,p=20) ; exp(g=1,full=true) ; wd(a=20) ; leg(i=24,o=land,fee=0) ; leg(i=0,o=land,fee=0) ; xk(g=0)` → P6c t=0: payout 0 left E and omni, net 2 times |
| NF | rule | `nofloor`: a pull takes G's floor too | 51,813 | 84,954 |  | `exp(g=0,full=false) ; wd(a=20)` → NF t=0: ghost 2 keeps 0 < its floor once every live tx lands |
| P7 | rule | `refundpaid`: a refunded W stays open, so it can still pay | 185 | 277 | P4 1570, P6c 272 | `wd(a=20) ; leg(i=0,o=land,fee=0) ; leg(i=0,o=refund,fee=0) ; leg(i=0,o=success,fee=0) ; tick(n=1)` → P7 t=0: the user received payout 0 2 times (done) |
| P8 | rule | `nopenop`: ret.1 opens a pull while one is open | 473 | 9,095 |  | `sell(g=0,full=false,wrap=false,p=20) ; leg(i=0,o=land,fee=0) ; sell(g=0,full=false,wrap=false,p=20) ; tick(n=1,m=0)` → P8 t=1: ghost 2 ends a record with 2 pulls open |
| P9 | rule | `nocnv`: cnv.1 plans no convert at the omnibus | 5,274 | 4,085 |  | `dep(c=0,a=10) ; leg(i=0,o=refund,fee=0) ; tick(n=2) ; exp(g=0,full=false)` → omni:sol stranded at anchors 1-2 |
| P10 | rule | `hol`: the re-quote stops at the first waiting payout it cannot pay | 366 | 0 | P3 3031 | `wd(a=401) ; wind ; wd(a=20) ; wd(a=20) ; leg(i=0,o=land,fee=0) ; tick(n=1,m=0) ; tick(n=1) ; down` → anchor 2: waits 1 and 2 (20 + 20) starve under Available 400 |
| P10 | pre-fix | `m135`: M135's all-at-once re-quote | 479 | 0 | P3 2560 | `wd(a=322) ; wd(a=79) ; wd(a=79) ; tick(n=20) ; wd(a=243) ; leg(i=0,o=expire,fee=0) ; tick(n=1) ; sell(g=0,full=false,wrap=false,p=20)` → anchor 21: waits 1 and 2 (79 + 79) starve under Available 400 |
| P11 | rule | `noreland8`: a revert re-landed as a fill does not run ghost.8 (G stays BUSY) | 32 | 339 |  | `buy(g=0) ; leg(i=0,o=failed,fee=0) ; leg(i=0,o=reorg,fee=0) ; leg(i=0,o=land,fee=0)` → P11 t=0: ghost 0 is BUSY with 2 token lots on it |
| P11 | pre-fix | `sealed`: tx.final on Base and Robinhood at 1 anchor (the papers at f645c4a) | 14 | 56 | NF 602, P4 21, P6a 39, P8 1 | `exp(g=5,full=true) ; leg(i=0,o=land,fee=0) ; tick(n=2) ; leg(i=0,o=reorg,fee=0) ; tick(n=3) ; leg(i=0,o=dead,fee=0) ; tick(n=1)` → P11 t=5: ghost 5 is RETURNING with 2 token lots on it |
| P11 | pre-fix | no `endbuy`: ghost.9 at the revert, no row for the mirror (the papers at f4a5676) | 60 | 417 |  | `buy(g=0) ; leg(i=0,o=land,fee=0) ; leg(i=0,o=reorg,fee=0) ; leg(i=0,o=failed,fee=0) ; tick(n=2)` → P11 t=2: ghost 0 is POSITION with no token and no trade open: its floor is stranded |
| P11 | pre-fix | no `endfinal`: ghost.12 at the emptying landing (the papers at 2fb7299) | 78 | 130 |  | `sell(g=0,full=true,wrap=false,p=20) ; leg(i=0,o=land,fee=0) ; leg(i=0,o=reorg,fee=0) ; tick(n=3) ; leg(i=0,o=dead,fee=0) ; tick(n=1)` → P11 t=3: ghost 2 is RETURNING with 2 token lots on it |
| P12 | rule | `payres`: Reserved leaves out the owner payout | 39 | 0 |  | `down ; buy(g=0) ; down ; wd(a=20) ; exp(g=0,full=true) ; call ; dep(c=0,a=5) ; buy(g=0) ; leg(i=15,o=success,fee=0) ; wd(a=287) ; image ; tick(n=1) ; sweep ; drill ; drill ; down` → P12 t=1: omni USDC: open legs W 20 + W 287 + pay 19094 + u 500 + u 500 > balance 20400: a W, F or u that lands last finds it short |
| P12 | pre-fix | no `boundf`: the payout bound keeps open F and `u` | 47 | 0 |  | `call ; leg(i=0,o=success,fee=0) ; image ; wind ; tick(n=1) ; sweep ; wd(a=20)` → P12 t=1: omni USDC: open legs u 20400 + pay 18800 > balance 20400: a W, F or u that lands last finds it short |

The regressions, each replayed under the rule a fix replaced:
- stream fails under `wait` for `nochain` (M137's period clock): 1 notices; funds_wait open while covered for 3 anchors at 24
- case1 fails under `perwait` for `nochain`: 1 notices
- bound fails under no `boundf`: 0 notices; P12 t=1: omni USDC: open legs F 300 + W 1600 + pay 18800 > balance 20400: a W, F or u that lands last finds it short
- lateSell fails under `sealed`: 0 notices; NF t=2: ghost 5 native 40, -20 once every live tx lands; P11 t=5: ghost 5 is RETURNING with 2 token lots on it
- lateBuy fails under `sealed`: 0 notices; NF t=2: ghost 3 native 300, -150 once every live tx lands; P11 t=2: ghost 3 is RETURNING with 2 token lots on it

### The count

**13 of 15 checks can fail under the set.** A rule mutation fails each of P1, P2, P3, P4, P6a, P6c, NF, P7, P8, P9, P10, P11 and P12. **P5 and P6b fail only under a pre-fix row** (no `live`, no `finalnative`), so they run as regressions of the pre-fix rules and are counted as such.

### What the model shows about M143's text

1. **M143 (1) holds.** With `tx.final` per chain the set passes every check in all six sweeps, and both late reorgs.
   Under the papers at f645c4a, P11 fails at every seed, as R12 found, and so do NF and P8 (and P4 and P6a, see above).
2. **Robinhood's 28 anchors keep the alarm's promise.** P1 and P2 pass with pulls that wait up to 28 anchors for
   `safe`. Such a pull is not on the way while it waits, so a wait that only it would cover pages within X24 plus the
   two-anchor pending period, and no page is false.
3. **M143 (7) needs no decision.** P1 passes without the owner-call exemption.
4. **M143 (5) agrees with reading 15.** A revert that quote.10 refunded, re-landed as a fill, debits P's notes again;
   what the notes do not cover is owed by P. That is the model's `take`, and M143 (5) records the same amount against
   P and nets it from P's next sell.
5. **Finding: refill.2 can send an F that an open W then finds short.** P12's order clause fails under the set in a
   hand-built case, not in the fuzz (it needs returns in flight above L):
   `buy(g=0) ×8 ; land each fill ; tick(28) ; land the six pulls sent ; wd(200) ; refill(c=0) ; land F ; land W`.
   - Eight buys lower L to 400 (8 × 150 of notes), and six BUY-40 pulls put 660 in flight.
   - `wd(200)` opens a W: Available is 200 of the omnibus's 400.
   - refill.2 reads spendable = Available + returns in flight − L = 200 + 660 − 400 = 460 ≥ 300 (06a l. 1150), so an
     F of 300 is sent although Available is 200.
   - The F lands first and leaves 100, and the W then finds 100 for its 200.
   - Every other leg is sized by Available. refill.2 alone can spend USDC that Reserved holds for an open W, F or `u`
     while returns in flight exceed L. The rules are unchanged here; CO decides (one reading: refill.2 also needs
     Available ≥ amount).
6. **M144 (ed3dbf0, the owner's OD-f1-2) changes nothing here.** It adds a display level, `tx.marked`, at the sealed
   block on Base and Robinhood, and no rule waits for it. `tx.final`, which every money rule reads, stays M143 (1)'s, as
   modelled. The model has no display.

### Simplifications the model still makes (review targets; the current list is in "M147", with "M151"'s changes)

1. **Reorgs are per tx.** A reorg drops the one tx it names; a filled buy's reorg also drops the landed emptying tx
   that spent its tokens. A deeper reorg that drops several of G's txs at once is not one event. On Base, Robinhood and
   NEAR, nonce order holds back a later tx while an earlier one is reorged, but a later tx that has already landed
   stays landed. Every joint outcome is still reachable by separate events. Under `sealed` this gives states a chain
   cannot reach (P4 and P6a above).
2. **Partial sells, fires and partial exports are atomic** (reading 8): their own txs and reorg rows (sell.12) are not
   modelled. Their record-end pull is sent at once, while on Base and Robinhood it would first wait 5 or 28 anchors for
   the sell's own `tx.final`. Waits that those pulls would cover therefore see money on the way sooner in the model.
3. **An arrival ends a leg's reorg window.** After 1Click reports `SUCCESS`, a pull's or full return's landed tx is never
   reorged; 1Click is read as crediting only what is final for it. The fuzz can report `SUCCESS` before `tx.final`.
4. **Legs between accounts and 1Click** (K, `u`, `s`, D, W, F, P and the owner payout) never reorg; reorgs on their
   source chains are 1Click's.
5. **An unwrap's own tx never reorgs** (§8.15 row 10 (a) declares this limit).
6. **The finality values are fixed** at one sample's maximum, rounded up to whole anchors. There is no distribution of
   lags and no lag beyond the sample; an L1 reorg past a batch (A4's accepted residual) is not modelled. Solana's
   `dead` (3) was not re-measured, and Solana's and NEAR's `tx.final` take a whole anchor although they take seconds.
7. **A native-out tx that lands for more than G holds** drives G's native below 0 (P6a and NF flag it); on chain it
   would fail.
8. **Debit order is free.** Legs from one account land in any order. If the omnibus's transfers land in signing order,
   P12's order clause is stricter than the chain.
9. **P12's debit clause only sees the landings a sequence generates.** A leg never landed in a sequence is judged only
   by the order clause.
10. **P6a's RETIRED clause counts any native above 0.** The model writes ret.4's dust off when it retires G, so nothing
    else is left there by design.
11. **Buys:** fees are 0; buy.13 (HELD) and buy.18 (NEAR's registration-only case) are not modelled.
12. **Time:** anchors are integers, and events fall at x.5; a leg moved between an anchor's two status reads counts 0
    (reading 2).
13. **Prices:** one number per chain; 1Click delivers `amountIn` × (1 − 0-4%).
14. **The return image** is modelled only as far as P5 and P12 need (reading 14).
15. **G's floor** is one number for X23 + chainReserve + locked rent.
16. **The stream regression** uses only the Solana and NEAR ghosts.
17. **`sealed`** models f645c4a only in the level of `tx.final` and in xk.2's Base parenthesis. f645c4a's other
    differences from M143 (buy.25's refund reversal, the reorg rule's ghost.9 token read) are not flags of their own.
18. **The owner's capital call** is never On the way, so the gap never counts it. P1 no longer exempts it.

## M145 (CO, after MC's refill case at 525bc78)

Source: merge note M145 (docs/spec/11-merge-notes.md at 6f7f189), which takes the finding in "M143" above. Amounts are in
cents.

### What the model gains

1. **`FIX=refillcash`** (M145 (1)). refill.2's spendable is min(Available, Available + returns in flight − L), so an F
   never exceeds the omnibus's Available USDC. Returns in flight can lower spendable, never raise it above Available.
   PR-04's set is now `FIX=nochain,live,finalnative,onepull,level,endfinal,endbuy,boundf,refillcash`.
2. **The refill case is a fixed regression** (`refillCase` in props.ts). It starts from `RIF_STATE`:
   `buy(g=0) ×8 ; leg(i=0..7,land) ; tick(28) ; leg(i=2..7,land)`. Eight fills lower L from 1,600 to 400. The six
   BUY-40 pulls sent from the Solana, Base and NEAR ghosts have landed and are on their way home, 660 in all. The two
   Robinhood buys are not yet `tx.final`, so their pulls are not sent. The omnibus holds 400, all Available. Then:
   `wd(200) ; refill(c=0) ; land the F ; land the W`.
   - Without `refillcash`, refill.2 reads 200 + 660 − 400 = 460 ≥ 300 and sends an F of 300. **P12** fails: first at
     the refill, the open W of 200 and F of 300 exceed the balance of 400 (the order clause). When the W lands after
     the F, it finds the omnibus holding 100 for its 200 (the debit clause). NF is not involved.
   - With `refillcash`, spendable is min(200, 460) = 200 < 300, so no F is sent. The W lands, and the omnibus keeps 200.
   - Every run replays the case both ways. It exits 1 unless the case passes under the run's set and fails without
     `refillcash`.
3. **The fuzz reaches the state from one fixed start.** The main and focus generators did not reach it in 600,000
   sequences under M143's set. `RIF=1` starts every sequence from `RIF_STATE` and then draws 1-40 actions from the
   main mix. fast-check shrinks only the random part. Without `refillcash`, P12 fails in about 1.1% of those
   sequences, shrunk to `RIF_STATE ; wd(a=101) ; refill(c=0)` and one trailing no-op. The plain sweeps still never
   build this state, so for them the regression is the guard.
4. **`mutants.ts` runs every row on all three generators** (main, focus and RIF). It gains two P12 rows:
   - `refillbal` (rule): refill.2 reads the omnibus's USDC balance, not its Available. Two refills in a row then both
     send, 600 of Fs against 400.
   - no `refillcash` (pre-fix): refill.2 as written before M145.
   - The `refill` case joins the regressions it replays.

### The runs

Each run had 100,000 sequences and went through `scripts/heavy.sh`: 12 sweeps (1.2 M sequences) and the mutation run.

| Run | Seed | Actions | Notices | Result |
|---|---|---|---|---|
| M145's set, main | 20261021 / 4 / 143 | 2,979,468 / 2,971,775 / 2,973,563 | 48,224 / 48,263 / 48,440 | all 15 checks PASS |
| M145's set, focus | 20261021 / 4 / 143 | 2,003,508 / 1,997,935 / 1,995,823 | 2 / 0 / 3 | all 15 checks PASS |
| M145's set, RIF | 20261021 / 4 / 143 | 4,303,508 / 4,297,935 / 4,295,823 | 7,868 / 7,982 / 7,860 | all 15 checks PASS |
| M143's set (no `refillcash`), RIF | 20261021 / 4 / 143 | the same | 8,031 / 8,174 / 8,027 | **P12 1,145 / 1,180 / 1,126**; every other check PASS |

- Under M145's set, every run passes all six regressions: stream, bound, case1, lateSell, lateBuy and refill. lateSell
  and lateBuy still fail under `sealed`, and refill fails without `refillcash`, as they must. The P5 and P6b pre-fix
  cases fail, as they must.
- The main and focus sweeps' counts (actions, waits, notices, wind-down) equal M143's runs at all three seeds. This
  fits the plain generators never building the state.
- Under M143's set the RIF runs exit 1, as they must: P12, and the refill regression.

### Mutation run (`mutants.ts`, seed 20261021, 100,000 sequences per generator per row)

| Check | Kind | Mutation | Main | Focus | RIF | Also failing | Shrunk (the first generator that fails) → the check's message |
|---|---|---|---|---|---|---|---|
| P1 | rule | `pend3`: the pending period is three completed anchors, not two | 19,220 | 2 | 6,522 |  | `wind ; wd(a=20) ; tick(n=22) ; xk(g=0)` → payout 0 from 0.5 still waits at anchor 22, no funds_wait |
| P1 | pre-fix | X24 per leg chain only (M134: no `nochain`) | 10,069 | 2 | 2,052 | P2 525 | `wd(a=401) ; tick(n=1) ; sell(g=0,full=false,wrap=false,p=20) ; tick(n=19) ; tick(n=2)` → payout 0 from 0.5 still waits at anchor 22, no funds_wait |
| P2 | rule | `nootw`: the gap leaves out the money On the way | 728 | 59 | 1,271 |  | `wind ; wd(a=20) ; tick(n=3) ; leg(i=0,o=land,fee=0) ; tick(n=1,m=0) ; leg(i=0,o=land,fee=0)` → funds_wait open while covered for 3 anchors at 4 |
| P2 | pre-fix | `perwait` for `nochain` (the papers at f4a5676) | 157 | 0 | 368 |  | `wd(a=30) ; image ; tick(n=14) ; leg(i=1,o=land,fee=0) ; wd(a=616) ; tick(n=4,m=0) ; leg(i=10,o=land,fee=0) ; wd(a=355) ; tick(n=5,m=0) ; leg(i=1,o=land,fee=0) ; tick(n=1,m=0) ; leg(i=0,o=land,fee=0)` → funds_wait open while covered for 3 anchors at 24 |
| P3 | rule | `noquote`: the anchor does not re-quote waiting payouts | 1,327 | 0 | 107 | P1 406, P10 141 | `wd(a=20) ; wd(a=145) ; tick(n=2) ; wd(a=236) ; tick(n=18) ; leg(i=0,o=expire,fee=0) ; tick(n=1) ; exp(g=0,full=false)` → anchor 21: a wait of 236 sits with Available 255 |
| P4 | rule | `bnowrap`: solv.1's B leaves out G's wrapped native | 25,798 | 45,278 | 17,999 |  | `sell(g=1,full=false,wrap=true,p=20) ; tick(n=1) ; price(c=0,pct=0)` → anchor 1: B 2960.00 vs ledger 2980.00 − mover 0.00 |
| P5 | pre-fix | no `live`: pay.3 signs from the anchor's values | 18 | 0 | 497 | P12 46 | `call ; leg(i=0,o=success,fee=0) ; image ; tick(n=1) ; sell(g=0,full=false,wrap=false,p=20) ; sweep ; tick(n=1)` → P5 t=1: payout 18800 > live omnibus USDC − L − D = 18780.00 |
| P6a | rule | `nounwrap`: a full return sends G's native without unwrapping its wrapped native first (B-7, N-11) | 108 | 0 | 8 | P4 112 | `sell(g=3,full=true,wrap=true,p=20) ; leg(i=0,o=land,fee=0) ; tick(n=2) ; leg(i=0,o=land,fee=0) ; leg(i=0,o=success,fee=0) ; tick(n=1)` → P6a t=2: ghost 11 is RETIRED with 0 native and 20 wrapped on it |
| P6b | pre-fix | no `finalnative`: signer rule 2 as written before M137 | 4,469 | 36,194 | 100,000 | P8 16, NF 6 | `buy(g=0) ; leg(i=0,o=land,fee=0) ; callE(a=5)` → P6b t=0: ghost 0 native read while tx #0 (B, deb) is not final |
| P6c | rule | `twokeys`: far.20 re-types a payout already in flight, so the exit key signs it again | 15 | 0 | 0 | P3 107, P12 1 | `wd(a=20) ; wind ; callE(a=40) ; sell(g=0,full=false,wrap=false,p=20) ; exp(g=1,full=true) ; wd(a=20) ; leg(i=24,o=land,fee=0) ; leg(i=0,o=land,fee=0) ; xk(g=0)` → P6c t=0: payout 0 left E and omni, net 2 times |
| NF | rule | `nofloor`: a pull takes G's floor too | 51,813 | 84,954 | 100,000 |  | `exp(g=0,full=false) ; wd(a=20)` → NF t=0: ghost 2 keeps 0 < its floor once every live tx lands |
| P7 | rule | `refundpaid`: a refunded W stays open, so it can still pay | 185 | 277 | 8 | P4 1662, P6c 274 | `wd(a=20) ; leg(i=0,o=land,fee=0) ; leg(i=0,o=refund,fee=0) ; leg(i=0,o=success,fee=0) ; tick(n=1)` → P7 t=0: the user received payout 0 2 times (done) |
| P8 | rule | `nopenop`: ret.1 opens a pull while one is open | 473 | 9,095 | 9,832 |  | `sell(g=0,full=false,wrap=false,p=20) ; leg(i=0,o=land,fee=0) ; sell(g=0,full=false,wrap=false,p=20) ; tick(n=1,m=0)` → P8 t=1: ghost 2 ends a record with 2 pulls open |
| P9 | rule | `nocnv`: cnv.1 plans no convert at the omnibus | 5,274 | 4,085 | 15,592 |  | `dep(c=0,a=10) ; leg(i=0,o=refund,fee=0) ; tick(n=2) ; exp(g=0,full=false)` → omni:sol stranded at anchors 1-2 |
| P10 | rule | `hol`: the re-quote stops at the first waiting payout it cannot pay | 366 | 0 | 8 | P3 3282 | `wd(a=401) ; wind ; wd(a=20) ; wd(a=20) ; leg(i=0,o=land,fee=0) ; tick(n=1,m=0) ; tick(n=1) ; down` → anchor 2: waits 1 and 2 (20 + 20) starve under Available 400 |
| P10 | pre-fix | `m135`: M135's all-at-once re-quote | 479 | 0 | 18 | P3 2735 | `wd(a=322) ; wd(a=79) ; wd(a=79) ; tick(n=20) ; wd(a=243) ; leg(i=0,o=expire,fee=0) ; tick(n=1) ; sell(g=0,full=false,wrap=false,p=20)` → anchor 21: waits 1 and 2 (79 + 79) starve under Available 400 |
| P11 | rule | `noreland8`: a revert re-landed as a fill does not run ghost.8 (G stays BUSY) | 32 | 339 | 0 |  | `buy(g=0) ; leg(i=0,o=failed,fee=0) ; leg(i=0,o=reorg,fee=0) ; leg(i=0,o=land,fee=0)` → P11 t=0: ghost 0 is BUSY with 2 token lots on it |
| P11 | pre-fix | `sealed`: tx.final on Base and Robinhood at 1 anchor (the papers at f645c4a) | 14 | 56 | 0 | NF 606, P4 40, P6a 39, P8 1 | `exp(g=5,full=true) ; leg(i=0,o=land,fee=0) ; tick(n=2) ; leg(i=0,o=reorg,fee=0) ; tick(n=3) ; leg(i=0,o=dead,fee=0) ; tick(n=1)` → P11 t=5: ghost 5 is RETURNING with 2 token lots on it |
| P11 | pre-fix | no `endbuy`: ghost.9 at the revert, no row for the mirror (the papers at f4a5676) | 60 | 417 | 0 |  | `buy(g=0) ; leg(i=0,o=land,fee=0) ; leg(i=0,o=reorg,fee=0) ; leg(i=0,o=failed,fee=0) ; tick(n=2)` → P11 t=2: ghost 0 is POSITION with no token and no trade open: its floor is stranded |
| P11 | pre-fix | no `endfinal`: ghost.12 at the emptying landing (the papers at 2fb7299) | 78 | 130 | 2 |  | `sell(g=0,full=true,wrap=false,p=20) ; leg(i=0,o=land,fee=0) ; leg(i=0,o=reorg,fee=0) ; tick(n=3) ; leg(i=0,o=dead,fee=0) ; tick(n=1)` → P11 t=3: ghost 2 is RETURNING with 2 token lots on it |
| P12 | rule | `payres`: Reserved leaves out the owner payout | 39 | 0 | 446 |  | `down ; buy(g=0) ; down ; wd(a=20) ; exp(g=0,full=true) ; call ; dep(c=0,a=5) ; buy(g=0) ; leg(i=15,o=success,fee=0) ; wd(a=287) ; image ; tick(n=1) ; sweep ; drill ; drill ; down` → P12 t=1: omni USDC: open legs W 20 + W 287 + pay 19094 + u 500 + u 500 > balance 20400: a W, F or u that lands last finds it short |
| P12 | pre-fix | no `boundf`: the payout bound keeps open F and `u` | 47 | 0 | 491 |  | `call ; leg(i=0,o=success,fee=0) ; image ; wind ; tick(n=1) ; sweep ; wd(a=20)` → P12 t=1: omni USDC: open legs u 20400 + pay 18800 > balance 20400: a W, F or u that lands last finds it short |
| P12 | rule | `refillbal`: refill.2 reads the omnibus's USDC balance, not its Available | 0 | 0 | 5,118 |  | `RIF_STATE ; refill(c=0) ; refill(c=0) ; wd(a=20)` → P12 t=28: omni USDC: open legs F 300 + F 300 > balance 400: a W, F or u that lands last finds it short |
| P12 | pre-fix | no `refillcash`: refill.2 as written before M145 | 0 | 0 | 1,145 |  | `RIF_STATE ; wd(a=101) ; refill(c=0) ; sell(g=0,full=false,wrap=false,p=20)` → P12 t=28: omni USDC: open legs W 101 + F 300 > balance 400: a W, F or u that lands last finds it short |

- In the RIF column, no `finalnative` and `nofloor` fail every sequence, because `RIF_STATE` itself fails under them:
  P6b (ghost 0's native is read while its buy's tx is not final) and NF (its pulls take the floor).

The regressions, each replayed under the rule a fix replaced:
- stream fails under `wait` for `nochain` (M137's period clock): 1 notices; funds_wait open while covered for 3 anchors at 24
- case1 fails under `perwait` for `nochain`: 1 notices
- bound fails under no `boundf`: 0 notices; P12 t=1: omni USDC: open legs F 300 + W 1600 + pay 18800 > balance 20400: a W, F or u that lands last finds it short
- lateSell fails under `sealed`: 0 notices; NF t=2: ghost 5 native 40, -20 once every live tx lands; P11 t=5: ghost 5 is RETURNING with 2 token lots on it
- lateBuy fails under `sealed`: 0 notices; NF t=2: ghost 3 native 300, -150 once every live tx lands; P11 t=2: ghost 3 is RETURNING with 2 token lots on it
- refill fails under no `refillcash`: 0 notices; P12 t=28: omni USDC: open legs W 200 + F 300 > balance 400: a W, F or u that lands last finds it short

### The count

**13 of 15 checks can fail under the set** (M145's, with `refillcash`). A rule mutation fails each of P1, P2, P3, P4, P6a, P6c, NF, P7, P8, P9, P10, P11 and P12; P12 now has two, `payres` and `refillbal`. **P5 and P6b fail only under a pre-fix row** (no `live`, no `finalnative`), so they run as regressions of the pre-fix rules and are counted as such. The count is M143's: `refillcash` adds a rule and a regression, not a check.

### Simplifications this adds (review targets)

1. **`RIF_STATE` is one fixed state**: one L, one set of returns in flight, all on Solana, Base and NEAR. The RIF sweeps
   explore only what follows it.
2. **A refill is always 300** ($3), one F to a ghost on the chain the action names, as in M136's model of refill.2.
3. **Returns in flight** are the pulls and full returns that have landed and not yet arrived (`deb`), valued at the
   read's price, as for the drill's bound.

## M147 (CO, after R13 at a977374)

Sources: merge note M147 (docs/spec/11-merge-notes.md at 6b089f0), R13's report and its scratch cases basepage.ts,
relandpull.ts and p2fate.ts, and lane NJ's papers (6e4ab00: 06a v1.38, 6c v1.23), which say what the model now does.
Line numbers are at 6e4ab00. Amounts are in cents.

### What the model gains

Five flags, one per item of M147 that changes the model. The set adds all five:
`FIX=nochain,live,finalnative,onepull,level,endfinal,endbuy,boundf,refillcash,landpull,neardead,relandowe,retfinal,refinal`.
Two changes are the chains' own behaviour and hold in every run, with or without the flags: NEAR's nonce rule (2) and a
reorg after 1Click's report (4).

1. **`landpull`** (M147 (1) as CO corrected and extended it during this round, now M149 (1), which replaces M147 (1)'s
   first three sentences). M147 (1) said "from its open (ret.1)"; lane NJ showed that ret.1 opens the pull only at the
   record's end, after every tx the record landed on G is `tx.final`, so "from its open" misses R13's case, where the
   buy's wait for `safe` comes before the open. The rule modelled is M149 (1)'s: when a record's last tx on G has landed
   on two providers and the record waits only for its txs to be `tx.final`, the leg its end will open counts On the way
   at once. A partial pull (ret.1) counts at G's pullable read at that landing, when G is POSITION, no other op on G is
   queued or open, and pullable is at least X8. A full return (ghost.9, ghost.12, ghost.15) counts at G's native plus
   wrapped native read at that landing, when that is at least X8; below it ret.4 retires G with no leg and nothing
   counts. The read fixes its amount, and the gap values it as every leg, at the anchor's price (the model has one price
   per chain). It is the same leg once its record's end opens it, and from its send it counts at its `amountIn`. It
   leaves by the exits every leg has: its cancel (ret.13), close, `dead`, its measured arrival, or X24 after X24's start.
   A reorg does not end it (06a §4.16).
   - **Pulls.** In the model a buy's BUY-40 pull already opened at the fill's landing and waited unsigned for the buy's
     `tx.final` (5 anchors on Base, 28 on Robinhood) and then signer rule 3, so the leg is there to count. The flag
     counts it (at `pa`), and keeps it through a reorg of its own buy: ret.13 (d) cancels only pulls the text has
     opened, and the text opens this one only at the buy's end. A later reorg of another tx on G still cancels it
     (ret.13 (d)); a sell on G cancels it and pulls at its own end (ret.13 (a)); a full return cancels it (ret.13 (b)).
     Partial sells, fires and partial exports are atomic (reading 8): landed and final at once, so their pull opens at
     their landing and waits only for signer rule 3.
   - **Full returns** (CO's extension, same flag). Under `endfinal` and `endbuy` the full return a record's end opens
     also waits for that record's tx to be `tx.final`: ghost.12's after a full sell or export, buyEnd's (ghost.9,
     ghost.15) after a buy's revert. From the landing of the emptying tx or of the reverting buy, while G's state lets
     that end open it, the T or B leg stands for it. It is the same leg once ghost.12 or buyEnd opens it (`of`), unsigned
     or its unwrap live. A reverted buy re-landed as a fill ends it (its record now opens a pull, which counts as a coming
     pull). `pullonly` puts back CO's first correction (coming pulls only), to show the extension is needed.
   - **The wind-down trigger** (06a v1.39 l. 1636). In wind-down a coming leg's destination is E (ret.5). The
     trigger's gap is the alert's gap at E, so it counts sent R' (On the way) and a coming record-end leg's R' from its
     record's landing. The trigger's own sum is its R' returns not yet sent (ghost.18's), and never a record-end full
     return, so no R' counts twice (model.ts l. 404-406: `pre` takes only full returns to E with no `of`). An earlier
     state of this round (9897fb2) ran the other way, a gap without coming legs and every unsent full return to E in
     `pre`, so in the landing-to-`tx.final` window the trigger opened WARM returns for money a coming leg already
     covered; it is corrected here. No send is sized by a coming leg.
   - **P2's oracle** (`covered()`) is worded as the code reads it: a page is false when, at that read, Available plus
     the legs On the way whose USDC really reaches the paying account by each waiting payout's own start + X24 covers
     every waiting payout, oldest first. Its On the way is M149's in every run, coming pulls and full returns included
     whatever `landpull` and `pullonly` say, so without them the oracle sees the false page that the alarm makes. A
     coming full return's fate is that of the full return its record's end opened.
   - **M149's addendum, checked against the model** (CO, this round; the papers will state it). Line numbers are
     model.ts's at this commit.
     - (a) The landing read holds the landed tx's effect. A partial sell's or fire's proceeds are on G (l. 292-293)
       before its end's ret.1 reads pullable (l. 296, 263, 266); a buy's fill has debited G (l. 330) before BUY-40's
       pull reads it (l. 337, 266); a full sell's emptying tx has put its proceeds on G before `pa` is set (l. 304); a
       revert's read is at l. 330. The model already did this. ret.1 reads again at the final level when it opens the
       leg: in the model that is the read before the send, once every tx on G is final (signer rule 3 under
       `finalnative`, l. 238-239), with ret.4 for a full return (l. 241) and ret.13 (c) for a pull (l. 244). From this
       round the leg counts at that read (l. 249); until then it counts at the landing read (l. 155-162).
     - (b) A coming leg leaves when its record's end opens no leg. A T or B leg stands for a full return only until its
       record ends (l. 156; the end at l. 527 and 530), so when ghost.12 or buyEnd opens nothing there (G not
       POSITION, or tokens on G: l. 298, 352) it leaves at that end. ret.1 opens no pull while an op is queued (l.
       263), and a queued op that takes G cancels an unsigned pull (l. 279, 354). At the final-level read ret.13 (c)
       cancels a pull below X7 (l. 244) and ret.4 writes G off (l. 241). The model already did this, with **one
       difference, changed this round**: it skipped that read while 1Click was down (trySend returned first), so such
       a leg kept counting until 1Click was back or X24 ended it. ret.1's read is a chain read, so it now runs while
       1Click is down (l. 235, 249-250), in every run. No fixed case shows the change. In the model G's native at a
       record's end is its landing read again (a reorg in between is undone by the re-land, or the record ends
       `dead`), so only a price move changes the read, and the gap already values every coming leg at each read's
       price (a full return only while that is at least X7, l. 155, 160).
   - **basePage** is R13's basepage.ts as a fixed regression: a Base buy fills at 0.5, and its record waits for the
     buy's `safe` (5 anchors) before its end opens the BUY-40 pull of 110; a $5 withdrawal against Available $4 waits
     from 0.5; the pull signs at 6 and arrives at 6.5, inside the wait's own deadline (20.5). Under the papers before
     M147 (no `landpull`) a notice goes at anchor 2, and P2 fails (`funds_wait` open while covered for 3 anchors at 4).
     Under `landpull`: no notice, and no check fails.
   - **hoodFull** is the Robinhood full-sell case M149 (1) names, in basePage's form: ghost 8's full sell lands at 0.5
     for 200, and its record waits for the sell's `safe` (28 anchors) before ghost.12 opens the full return of 240; a $5
     withdrawal against Available $4 waits from 10.5, and only that full return covers it; it signs at 29 and arrives at
     29.5, inside the wait's deadline (30.5). With `pullonly`, and without `landpull`, a notice goes at anchor 12 and P2
     fails (`funds_wait` open while covered for 3 anchors at 14). Under the full rule: no notice, no check fails, and the
     payout is paid at anchor 30.
2. **`neardead`** (M147 (2); 6c A4 v1.23). NEAR is no longer in the nonce-order guard (model.ts `nonceBars`, which
   replaces the three copies at the old l. 234, 255 and 347). Chain truth on NEAR: a later tx on G's key lands while an
   earlier one is reorged, and a tx whose nonce the key has passed never lands. The model keeps each signature's place
   in the key's order (`nk`); a partial sell, fire or export, which is atomic (reading 8), is landed and final at once.
   - The papers before M147: such a tx has no same-nonce tx that can go final, so it is `dead` only at 6c §5.4's
     horizon (X14, about 14 h; 1,680 anchors).
   - `neardead`: (b), the key's nonce at final past the tx while it is absent, makes it `dead` at the next anchor.
   - **nearDead** is the fixed NEAR case. Ghost 11's full sell A lands at 0.5 (20 credited) and is reorged; a partial
     sell of 100 on the same key runs, and its end opens a pull that waits for A; at anchor 1 A is `dead` (b), its 20
     recorded against P (sell.14); the pull signs for 100, lands at 1.5 and is final at 2.5; the export key then goes
     through (xk.2), its debit 40 of native plus the 20 recorded against P. Without `neardead`: A stays reorged, the pull
     waits unsigned, and xk.2 refuses.
3. **`relandowe`** (M147 (3); buy.25, SEL-11). A settled revert re-landed as a fill leaves L unchanged. The fill's debit
   less buy.15's fee (0 in the model) is recorded against P. It is netted from P's next sell on G (credit, as SEL-11's
   excess already was), or taken by xk.3's debit, which now adds every amount recorded against P for txs on G
   (sell.14's excess and buy.25's). What no sell nets the pool carries. A later revert or `dead` of that buy voids the
   claim, and what a sell had already netted goes back to P as notes. Without the flag the model's old `take` runs: P's
   notes are debited again and L falls.
   - **relandOwe** is R13's finding 3 as a fixed case, on Solana ghost 0: buy 150, revert (150 of change back to P),
     reorg, re-land as a fill, then a partial sell of 100. Under the set: L 1,600 after the re-land and after the sell,
     150 recorded against P, of which the sell nets 100 (50 left). The old `take`: L 1,450 after the re-land, 1,550
     after the sell, nothing recorded.
   - **P4 and P12 with that amount.** Both pass in all nine runs of the set, so there is no sequence for CO to decide.
     solv.1's B and L leave the amount recorded against P out (I1 has no such term), and the model's ledger does too,
     so P4 compares like with like; P12 reads legs and balances, which the amount does not move. P4's rule row
     (`bnowrap`) and both of P12's (`payres`, `refillbal`) still fail under the set (see the mutation table).
4. **`retfinal`** (M147 (4); ret.8, ret.9, ghost.13 at l. 1115, 1226-1227). Chain truth: a ghost leg's landed tx can be
   reorged after 1Click's `SUCCESS` or `REFUNDED`, until its `tx.final` (M143's simplification 3 is gone). A leg that has
   arrived waits in a new state, `arr`: its USDC (or refunded native) is in the paying account and counts there, it is
   out of In flight and out of On the way, and its tx can still reorg. A reorg puts the native back on G, and what 1Click
   paid stays where it landed (the system holds both; 1Click's loss). A re-land restores the arrived state.
   - The papers before M147: DONE, and so ghost.13, at the report. A full return's G is RETIRED, and a reorg then puts
     native on it that no row sends (ghost.14 refuses to sign, solv.1 leaves it out of B); a pull's G gets native back
     with no ret.1.
   - `retfinal`: DONE and ghost.13 at the later of the report and the transfer's `tx.final`. A transfer reorged before
     then runs ret.14 at its `dead` verdict, as any reorged ghost leg: CLOSED_UNFUNDED, the native back on G, a fresh full
     return at once (or ret.1 for a pull). The leg is never INCIDENT (M149 (2)): B counts the native back on G as G's and
     the USDC 1Click credited in the paying account's balance, each once, as the model does (P4 passes). The owner's
     alert, a §5 `INCIDENT` record (kind `tx.reorged`), is not modelled.
   - **P6a's second half is now "a RETIRED ghost never holds native or wrapped native"**, with no exemption while a tx on
     G is live (M147 (4): "a RETIRED G therefore never has native come back").
   - **retReorg** is a fixed regression: the return image sends Base ghost 3's full return of 300 at 0.5; it lands and
     arrives at 0.5 (300 USDC at the omnibus), is reorged at 2.5 and is `dead` at 5.5. Without `retfinal`: G RETIRED with
     300 native (P6a), and B 300 below the ledger at anchor 3 (P4). With it: ret.14 opens a fresh full return at 5.5,
     which lands and arrives at 6.5 and ends at its `safe`, G RETIRED with 0.
5. **`refinal`** (M147 (7); ret.13 (d), ret.14). When a landed tx on G that a reorg made live again is `tx.final` again,
   ret.1 runs on G at that anchor.
   - **P11 gains an end clause**, the outcome M147 (7) names: at the end of a sequence, a POSITION ghost whose txs are all
     final (or `dead`) and that has no op open or queued holds pullable below X8. It fits P11's user outcome (nothing
     stranded on a ghost: its tokens, its floor, now the native above its floor), so it is folded into P11 and the
     count of checks stays 15. Finality is read at the last anchor, where the rules read it; a pull open or one that
     has taken the native ("done") leaves nothing to flag.
   - **relandPull** is R13's relandpull.ts: a sell's pull of 100 on Solana ghost 2 lands and is reorged; a second sell
     runs, and its end opens no pull (the reorged pull is an op on G); the pull re-lands and is final at anchor 2.
     Without `refinal`, G ends with 140 against a floor of 40 and no pull (P11). With it, ret.1 sends 100 home.
6. **A model fix found by P11's end clause** (no flag; the text already had it). A refused export key (xk.3's
   `insufficient`) ends its record RELEASED, and ret.1 runs on G: ret.1 lists export-key records "in any end state", and
   ret.13 (a) has cancelled G's unsigned pull when that record took G. The model ran no ret.1 there. The RIF sweep found
   it (shrunk: `RIF_STATE ; wd(a=251) ; xk(g=6)`: Robinhood ghost 6's BUY-40 pull of 110 is cancelled by the export key,
   which P cannot pay, 149 against 150, and G keeps the 110).
7. **`mutants.ts`** runs the set with the five flags, adds a P11 rule row (`nosellpull`: a partial sell's, fire's or
   export's end opens no pull) and four pre-fix rows (no `landpull` and `pullonly` for P2, no `retfinal` for P6a, no
   `refinal` for P11), and replays the six cases without their flags (hoodFull also with `pullonly`).

### The runs

Each run had 100,000 sequences and went through `scripts/heavy.sh`: 18 sweeps (1.8 M sequences) and the mutation run.
"M145's set" here is the current model without M147's five flags: the chain truths of (2) and (4) hold in it too, so its
notice counts differ a little from M145's runs. The set's 9 sweeps and the mutation run are on the final code: ret.1's
read while 1Click is down, and the trigger as 06a v1.39 l. 1636 reads it (item 1). They match, count for count and
shrunk case for shrunk case, the runs made before each of this round's three code changes (that read; 9897fb2's
trigger gap without coming legs; its correction). M145's set's 9 sweeps are from 9897fb2's code.

| Run | Seed | Actions | Notices | Result |
|---|---|---|---|---|
| M147's set, main | 20261021 / 4 / 143 | 2,979,468 / 2,971,775 / 2,973,563 | 47,783 / 47,860 / 48,016 | all 15 checks PASS |
| M147's set, focus | 20261021 / 4 / 143 | 2,003,508 / 1,997,935 / 1,995,823 | 2 / 0 / 3 | all 15 checks PASS |
| M147's set, RIF | 20261021 / 4 / 143 | 4,303,508 / 4,297,935 / 4,295,823 | 7,765 / 7,866 / 7,779 | all 15 checks PASS |
| M145's set, main | 20261021 / 4 / 143 | the same | 48,226 / 48,263 / 48,448 | **P2 5 / 2 / 8, P4 38 / 38 / 35, P6a 48 / 57 / 50, P11 4 / 2 / 3** |
| M145's set, focus | 20261021 / 4 / 143 | the same | 2 / 0 / 3 | **P4 86 / 83 / 99, P6a 172 / 188 / 172, P11 105 / 102 / 99** |
| M145's set, RIF | 20261021 / 4 / 143 | the same | 7,854 / 7,978 / 7,864 | **P11 17 / 18 / 11** |

- Under M147's set every run passes all twelve regressions: stream, bound, case1, lateSell, lateBuy and refill, and
  M147's basePage, hoodFull, nearDead, relandOwe, retReorg and relandPull. Each of M147's cases fails without its own
  flag, and hoodFull also with `pullonly`; lateSell and lateBuy fail under `sealed`, refill without `refillcash`, and the
  P5 and P6b pre-fix cases fail, as they must.
- **P1 and P2 pass in all nine runs of the set**, at every seed and generator.
- Under M145's set every run exits 1, and every failure has its fix in M147's set. Each shrunk case below (seed
  20261021) passes once the named flag alone is added, and passes under the set:
  - P2, main, `landpull`: `buy(g=10) ; wd(a=401) ; leg(i=0,o=land,fee=0) ; tick(n=6) ; leg(i=0,o=land,fee=0) ;
    tick(n=1,m=0) ; tick(n=1)` → funds_wait open while covered for 3 anchors at 4. This is basePage's state, built by
    the fuzz: Base ghost 3's buy fills, and its BUY-40 pull of 110 covers a wait of $4.01. It also passes under
    `pullonly`, so it is the pull half of the rule.
  - P4, main, `retfinal`: `wind ; wd(a=301) ; leg(i=14,o=land,fee=0) ; sell(g=0,full=false,wrap=false,p=20) ;
    tick(n=1,m=0) ; leg(i=25,o=reorg,fee=0) ; tick(n=1) ; leg(i=0,o=land,fee=0)` → anchor 2: B 2980.00 vs ledger
    3280.00 − mover 0.00 (a full return reorged after its SUCCESS, its G already RETIRED). Focus's: `image ;
    leg(i=6,o=land,fee=0) ; leg(i=6,o=refund,fee=0) ; leg(i=6,o=reorg,fee=0) ; tick(n=1)` → anchor 1: B 2960.00 vs
    ledger 3260.00, the same after REFUNDED.
  - P6a, main, `retfinal`: `dep(c=0,a=5) ; image ; wd(a=20) ; wind ; leg(i=26,o=land,fee=0) ; tick(n=1,m=0) ;
    leg(i=4,o=reorg,fee=0) ; wd(a=20)` → P6a t=1: ghost 4 is RETIRED with 300 native and 0 wrapped on it.
  - P11, main, `retfinal`: `sell(g=0,full=false,wrap=false,p=20) ; leg(i=0,o=land,fee=0) ; leg(i=0,o=success,fee=0) ;
    leg(i=0,o=reorg,fee=0) ; tick(n=3) ; leg(i=0,o=dead,fee=0)` → P11 t=3: ghost 2 ends POSITION with pullable 20, every
    tx on it final and no pull open (the pull is `dead` after its record was DONE, so no row runs). RIF's 30-action case
    is the same after REFUNDED (ghost 9, pullable 110).
  - P11, focus, `refinal`: `sell(g=0,full=false,wrap=false,p=20) ; leg(i=0,o=land,fee=0) ;
    sell(g=0,full=false,wrap=false,p=20) ; leg(i=0,o=reorg,fee=0) ; leg(i=0,o=land,fee=0) ; tick(n=2) ;
    leg(i=0,o=land,fee=0)` → P11 t=2: ghost 2 ends POSITION with pullable 20 and no pull (relandPull's state).
  - No shrunk case is a `neardead` or `relandowe` state. The checks cannot see what those two change: without
    `neardead` the passed NEAR tx stays live until the 14 h horizon, which P11's end clause leaves out (simplification
    21), and the old `take` moves P's notes and the ledger's L together, so P4 sees no gap. Their regressions (nearDead,
    relandOwe) are their guards, and both fail without their flags.

### Mutation run (`mutants.ts`, seed 20261021, 100,000 sequences per generator per row)

| Check | Kind | Mutation | Main | Focus | RIF | Also failing | Shrunk (the first generator that fails) → the check's message |
|---|---|---|---|---|---|---|---|
| P1 | rule | `pend3`: the pending period is three completed anchors, not two | 20,294 | 2 | 6,579 |  | `wind ; wd(a=20) ; tick(n=22) ; xk(g=0)` → payout 0 from 0.5 still waits at anchor 22, no funds_wait |
| P1 | pre-fix | X24 per leg chain only (M134: no `nochain`) | 10,071 | 2 | 2,049 | P2 530 | `wd(a=401) ; tick(n=1) ; sell(g=0,full=false,wrap=false,p=20) ; tick(n=19) ; tick(n=2)` → payout 0 from 0.5 still waits at anchor 22, no funds_wait |
| P2 | rule | `nootw`: the gap leaves out the money On the way | 725 | 59 | 1,279 |  | `wind ; wd(a=20) ; tick(n=3) ; leg(i=0,o=land,fee=0) ; tick(n=1,m=0) ; leg(i=0,o=land,fee=0)` → funds_wait open while covered for 3 anchors at 4 |
| P2 | pre-fix | `perwait` for `nochain` (the papers at f4a5676) | 162 | 0 | 368 |  | `image ; tick(n=14) ; wd(a=346) ; tick(n=4) ; leg(i=0,o=land,fee=0) ; wd(a=355) ; tick(n=5,m=0) ; leg(i=0,o=land,fee=0) ; tick(n=1,m=0) ; leg(i=0,o=land,fee=0)` → funds_wait open while covered for 3 anchors at 24 |
| P2 | pre-fix | no `landpull`: a coming record-end leg counts only from its broadcast (the papers before M147) | 5 | 0 | 0 |  | `buy(g=10) ; wd(a=401) ; leg(i=0,o=land,fee=0) ; tick(n=6) ; leg(i=0,o=land,fee=0) ; tick(n=1,m=0) ; tick(n=1)` → funds_wait open while covered for 3 anchors at 4 |
| P2 | pre-fix | `pullonly`: coming pulls only, not a coming full return (CO's first correction to M147 (1)) | 5 | 0 | 0 |  | `buy(g=10) ; wd(a=401) ; leg(i=0,o=failed,fee=0) ; tick(n=6) ; leg(i=0,o=land,fee=0) ; tick(n=1,m=0) ; tick(n=1)` → funds_wait open while covered for 3 anchors at 4 |
| P3 | rule | `noquote`: the anchor does not re-quote waiting payouts | 1,322 | 0 | 101 | P1 401, P10 141 | `wd(a=20) ; wd(a=145) ; tick(n=2) ; wd(a=236) ; tick(n=18) ; leg(i=0,o=expire,fee=0) ; tick(n=1) ; exp(g=0,full=false)` → anchor 21: a wait of 236 sits with Available 255 |
| P4 | rule | `bnowrap`: solv.1's B leaves out G's wrapped native | 25,799 | 45,296 | 17,997 |  | `sell(g=1,full=false,wrap=true,p=20) ; tick(n=1) ; price(c=0,pct=0)` → anchor 1: B 2960.00 vs ledger 2980.00 − mover 0.00 |
| P5 | pre-fix | no `live`: pay.3 signs from the anchor's values | 17 | 0 | 504 | P12 45 | `call ; leg(i=0,o=success,fee=0) ; image ; tick(n=1) ; sell(g=0,full=false,wrap=false,p=20) ; sweep ; tick(n=1)` → P5 t=1: payout 18800 > live omnibus USDC − L − D = 18780.00 |
| P6a | rule | `nounwrap`: a full return sends G's native without unwrapping its wrapped native first (B-7, N-11) | 98 | 0 | 9 | P4 107 | `sell(g=3,full=true,wrap=true,p=20) ; leg(i=0,o=land,fee=0) ; tick(n=2) ; leg(i=0,o=land,fee=0) ; leg(i=0,o=success,fee=0) ; tick(n=2)` → P6a t=4: ghost 11 is RETIRED with 0 native and 20 wrapped on it |
| P6a | pre-fix | no `retfinal`: ghost.13 at SUCCESS or REFUNDED, before the transfer is final (the papers at a977374) | 48 | 172 | 0 | P4 124, P11 104 | `dep(c=0,a=5) ; image ; wd(a=20) ; wind ; leg(i=26,o=land,fee=0) ; tick(n=1,m=0) ; leg(i=4,o=reorg,fee=0) ; wd(a=20)` → P6a t=1: ghost 4 is RETIRED with 300 native and 0 wrapped on it |
| P6b | pre-fix | no `finalnative`: signer rule 2 as written before M137 | 6,106 | 35,960 | 100,000 | P8 14, NF 2, P11 2 | `buy(g=0) ; leg(i=0,o=land,fee=0) ; price(c=0,pct=0)` → P6b t=0: ghost 0 native read while tx #0 (B, deb) is not final |
| P6c | rule | `twokeys`: far.20 re-types a payout already in flight, so the exit key signs it again | 16 | 0 | 0 | P3 108, P12 1 | `wd(a=20) ; wind ; callE(a=40) ; sell(g=0,full=false,wrap=false,p=20) ; exp(g=1,full=true) ; wd(a=20) ; leg(i=24,o=land,fee=0) ; leg(i=0,o=land,fee=0) ; xk(g=0)` → P6c t=0: payout 0 left E and omni, net 2 times |
| NF | rule | `nofloor`: a pull takes G's floor too | 52,253 | 84,951 | 100,000 | P11 226,010 | `exp(g=0,full=false) ; wd(a=20)` → NF t=0: ghost 2 keeps 0 < its floor once every live tx lands |
| P7 | rule | `refundpaid`: a refunded W stays open, so it can still pay | 187 | 271 | 7 | P4 1,631, P6c 269 | `wd(a=20) ; leg(i=0,o=land,fee=0) ; leg(i=0,o=refund,fee=0) ; leg(i=0,o=success,fee=0) ; tick(n=1)` → P7 t=0: the user received payout 0 2 times (done) |
| P8 | rule | `nopenop`: ret.1 opens a pull while one is open | 539 | 7,834 | 9,996 |  | `sell(g=0,full=false,wrap=false,p=20) ; leg(i=0,o=land,fee=0) ; sell(g=0,full=false,wrap=false,p=20) ; tick(n=2,m=0) ; leg(i=0,o=land,fee=0)` → P8 t=2: ghost 2 ends a record with 2 pulls open |
| P9 | rule | `nocnv`: cnv.1 plans no convert at the omnibus | 5,269 | 4,045 | 15,534 |  | `dep(c=0,a=10) ; leg(i=0,o=refund,fee=0) ; tick(n=2) ; exp(g=0,full=false)` → omni:sol stranded at anchors 1-2 |
| P10 | rule | `hol`: the re-quote stops at the first waiting payout it cannot pay | 365 | 0 | 8 | P3 3,271 | `wd(a=401) ; wind ; wd(a=20) ; wd(a=20) ; leg(i=0,o=land,fee=0) ; tick(n=1,m=0) ; tick(n=1) ; down` → anchor 2: waits 1 and 2 (20 + 20) starve under Available 400 |
| P10 | pre-fix | `m135`: M135's all-at-once re-quote | 483 | 0 | 18 | P3 2,725 | `wd(a=322) ; wd(a=79) ; wd(a=79) ; tick(n=20) ; wd(a=243) ; leg(i=0,o=expire,fee=0) ; tick(n=1) ; sell(g=0,full=false,wrap=false,p=20)` → anchor 21: waits 1 and 2 (79 + 79) starve under Available 400 |
| P11 | rule | `noreland8`: a revert re-landed as a fill does not run ghost.8 (G stays BUSY) | 32 | 332 | 0 |  | `buy(g=0) ; leg(i=0,o=failed,fee=0) ; leg(i=0,o=reorg,fee=0) ; leg(i=0,o=land,fee=0)` → P11 t=0: ghost 0 is BUSY with 2 token lots on it |
| P11 | pre-fix | `sealed`: tx.final on Base and Robinhood at 1 anchor (the papers at f645c4a) | 17 | 61 | 34 | NF 594, P6a 167, P4 138, P8 4 | `exp(g=5,full=true) ; leg(i=0,o=land,fee=0) ; tick(n=2) ; leg(i=0,o=reorg,fee=0) ; tick(n=3) ; leg(i=0,o=dead,fee=0) ; tick(n=1)` → P11 t=5: ghost 5 is RETURNING with 2 token lots on it |
| P11 | pre-fix | no `endbuy`: ghost.9 at the revert, no row for the mirror (the papers at f4a5676) | 59 | 406 | 0 |  | `buy(g=0) ; leg(i=0,o=land,fee=0) ; leg(i=0,o=reorg,fee=0) ; leg(i=0,o=failed,fee=0) ; tick(n=2)` → P11 t=2: ghost 0 is POSITION with no token and no trade open: its floor is stranded |
| P11 | pre-fix | no `endfinal`: ghost.12 at the emptying landing (the papers at 2fb7299) | 77 | 130 | 2 |  | `sell(g=0,full=true,wrap=false,p=20) ; leg(i=0,o=land,fee=0) ; leg(i=0,o=reorg,fee=0) ; tick(n=3) ; leg(i=0,o=dead,fee=0) ; tick(n=1)` → P11 t=3: ghost 2 is RETURNING with 2 token lots on it |
| P11 | rule | `nosellpull`: a partial sell's, fire's or export's end opens no pull (ret.1) | 39,528 | 82,691 | 39,311 |  | `sell(g=0,full=false,wrap=false,p=20) ; wd(a=20)` → P11 t=0: ghost 2 ends POSITION with pullable 20 (20.00 ≥ X8), every tx on it final and no pull open |
| P11 | pre-fix | no `refinal`: no ret.1 when a reorged tx on G is final again (the model until M147) | 0 | 56 | 3 |  | `sell(g=0,full=false,wrap=false,p=20) ; leg(i=0,o=land,fee=0) ; sell(g=0,full=false,wrap=false,p=20) ; leg(i=0,o=reorg,fee=0) ; leg(i=0,o=land,fee=0) ; tick(n=2) ; leg(i=0,o=land,fee=0)` → P11 t=2: ghost 2 ends POSITION with pullable 20 (20.00 ≥ X8), every tx on it final and no pull open |
| P12 | rule | `payres`: Reserved leaves out the owner payout | 37 | 0 | 443 |  | `down ; buy(g=0) ; down ; wd(a=20) ; exp(g=0,full=true) ; call ; dep(c=0,a=5) ; buy(g=0) ; leg(i=15,o=success,fee=0) ; wd(a=287) ; image ; tick(n=1) ; sweep ; drill ; drill ; down` → P12 t=1: omni USDC: open legs W 20 + W 287 + pay 19094 + u 500 + u 500 > balance 20400: a W, F or u that lands last finds it short |
| P12 | pre-fix | no `boundf`: the payout bound keeps open F and `u` | 47 | 0 | 490 |  | `call ; leg(i=0,o=success,fee=0) ; image ; wind ; tick(n=1) ; sweep ; wd(a=20)` → P12 t=1: omni USDC: open legs u 20400 + pay 18800 > balance 20400: a W, F or u that lands last finds it short |
| P12 | rule | `refillbal`: refill.2 reads the omnibus's USDC balance, not its Available | 0 | 0 | 5,123 |  | `RIF_STATE ; refill(c=0) ; refill(c=0) ; wd(a=20)` → P12 t=28: omni USDC: open legs F 300 + F 300 > balance 400: a W, F or u that lands last finds it short |
| P12 | pre-fix | no `refillcash`: refill.2 as written before M145 | 0 | 0 | 1,144 |  | `RIF_STATE ; wd(a=101) ; refill(c=0) ; sell(g=0,full=false,wrap=false,p=20)` → P12 t=28: omni USDC: open legs W 101 + F 300 > balance 400: a W, F or u that lands last finds it short |

- New rows this round: P2 no `landpull` and `pullonly` (pre-fix), P6a no `retfinal` (pre-fix), P11 `nosellpull`
  (rule) and P11 no `refinal` (pre-fix). P2's two new rows shrink to the two kinds of coming leg: no `landpull` to
  basePage's shape (a fill's BUY-40 pull), `pullonly` to a reverted buy's coming full return on Base.
- In the RIF column, no `finalnative` and `nofloor` fail every sequence, because `RIF_STATE` itself fails under them,
  as in M145's run.
- The run exits 0: every row and every case is caught.

The regressions, each replayed under the rule a fix replaced (M147's cases without their own flag):
- stream fails under `wait` for `nochain` (M137's period clock): 1 notices; funds_wait open while covered for 3 anchors at 24
- case1 fails under `perwait` for `nochain`: 1 notices
- bound fails under no `boundf`: 0 notices; P12 t=1: omni USDC: open legs F 300 + W 1600 + pay 18800 > balance 20400: a W, F or u that lands last finds it short
- lateSell fails under `sealed`: 0 notices; NF t=2: ghost 5 native 40, -20 once every live tx lands; P11 t=5: ghost 5 is RETURNING with 2 token lots on it
- lateBuy fails under `sealed`: 0 notices; NF t=2: ghost 3 native 300, -150 once every live tx lands; P11 t=2: ghost 3 is RETURNING with 2 token lots on it
- refill fails under no `refillcash`: 0 notices; P12 t=28: omni USDC: open legs W 200 + F 300 > balance 400: a W, F or u that lands last finds it short
- basePage fails under no `landpull`: a notice at anchor 2; funds_wait open while covered for 3 anchors at 4
- hoodFull fails under no `landpull`: a notice at anchor 12; funds_wait open while covered for 3 anchors at 14
- hoodFull fails under `pullonly`: a notice at anchor 12; funds_wait open while covered for 3 anchors at 14
- nearDead fails under no `neardead`: A is reorg, not `dead`; the pull is pre; ghost 11 is POSITION: xk.2 refused the export key
- relandOwe fails under no `relandowe`: L 1450 after the re-land, 1550 after the sell; 0 recorded against P (want 1600, 1600, 50)
- retReorg fails under no `retfinal`: anchor 3: B 2960.00 vs ledger 3260.00 − mover 0.00; P6a t=2: ghost 3 is RETIRED with 300 native and 0 wrapped on it; ghost 3 is RETIRED with 300 native
- relandPull fails under no `refinal`: P11 t=3: ghost 2 ends POSITION with pullable 100 (100.00 ≥ X8), every tx on it final and no pull open

### The count

**13 of 15 checks can fail under the set** (M147's, with `landpull`, `neardead`, `relandowe`, `retfinal` and
`refinal`). A rule mutation fails each of P1, P2, P3, P4, P6a, P6c, NF, P7, P8, P9, P10, P11 and P12; P11 now has two
(`noreland8`, `nosellpull`), and the end clause folded into P11 adds no check. **P5 and P6b fail only under a pre-fix
row** (no `live`, no `finalnative`), so they run as regressions of the pre-fix rules, as before. M147's five flags add
four pre-fix rows and one rule row, and six fixed cases; the count stays M145's.

### What the model shows about M147's text

1. **CO's question, plainly.** basePage pages under the papers before M147: a notice at anchor 2, and P2 fails
   (`funds_wait` open while covered for 3 anchors at 4). Under `landpull` it does not page, and no check fails. hoodFull
   pages with coming pulls only (`pullonly`) and without `landpull`: a notice at anchor 12, and P2 fails at 14. Under the
   full rule it does not page, and the payout is paid at anchor 30. **P1 and P2 pass in all nine runs of the set**, at
   seeds 20261021, 4 and 143, on every generator.
2. **The fuzz builds both coming legs' states.** Without M147's flags, P2 fails in the main sweeps (5, 2 and 8 of
   100,000), shrunk to basePage's shape. In the mutation run P2's row with `pullonly` fails 5 of 100,000 main sequences
   too, shrunk to a Base buy's revert whose coming full return (300) covers a wait of $4.01 and arrives in time: the
   extension's case, found by the fuzz.
3. **On Robinhood a coming leg can wait 28 anchors, longer than X24 (20).** It counts only until X24 after the oldest
   wait's start, and the wait then pages within the pending period, so P1 holds (all nine runs). hoodFull's wait starts
   at 10.5 so that the full return (29.5) arrives inside it.
4. **M143's finding 2 is withdrawn.** It said a wait that only a pull waiting for `safe` would cover pages within X24 + 2
   anchors and "no page is false". That held only because the oracle, like the alarm, did not count the waiting pull.
   Counted from its record's landing in both (M147 (1)), the page is false when that pull arrives in time.
5. **M143's finding 4 is withdrawn.** It said M143 (5) agreed with the model's `take`, which lowered L at a re-landed
   revert. M147 (3) leaves L unchanged and records the debit against P (relandOwe).
6. **No finding against M147's or M149's text.** Every check passes under the set. M149 (1)-(3) and CO's addendum
   match the model after two changes this round (the trigger's own sum, ret.1's read while 1Click is down; item 1),
   and the one other model fix (item 6, ret.1 after a refused export key) was the model's omission: the papers already had
   that row.

### Simplifications the model still makes (review targets)

The full list as of M147; items 1-18 carry M143's list forward, with M147's changes.

1. **Reorgs are per tx.** A reorg drops the one tx it names; a filled buy's reorg also drops the landed emptying tx that
   spent its tokens. A deeper reorg that drops several of G's txs at once is not one event. On Base and Robinhood nonce
   order holds a later tx back while an earlier one is reorged; on NEAR (the default Monotonic nonce mode, M149 (3); no
   tx we sign opts into Strict) a later tx lands and the earlier one never does.
   A later tx that has already landed stays landed. Every joint outcome is still reachable by separate events.
2. **Partial sells, fires and partial exports are atomic** (reading 8): their tx is landed and final at once, and their
   own reorg rows (sell.12) are not modelled. On NEAR such a tx passes every earlier nonce on G's key at once. Their
   record-end pull opens at once and waits only for signer rule 3, while on Base and Robinhood the text's pull would
   first wait 5 or 28 anchors for the sell's own `tx.final`. Under `landpull` the gap counts that pull from the sell's
   landing in both, so the alarm sees the same money; only the pull's send, and so its arrival, comes sooner in the
   model. The `tx.final` wait before a record's end is exercised through buys (basePage), full sells and exports
   (hoodFull) and reverted buys, which are not atomic.
3. **A re-land after an arrival restores the arrived state** (M147 (4)). The model does not follow the deposit address
   that 1Click has already settled: a second deposit to it is 1Click's, and the system keeps what 1Click paid.
4. **Legs between accounts and 1Click** (K, `u`, `s`, D, W, F, P and the owner payout) never reorg; reorgs on their
   source chains are 1Click's.
5. **An unwrap's own tx never reorgs** (§8.15 row 10 (a) declares this limit).
6. **The finality values are fixed** at one sample's maximum, rounded up to whole anchors. There is no distribution of
   lags and no lag beyond the sample; an L1 reorg past a batch (A4's accepted residual) is not modelled. Solana's
   `dead` (3) was not re-measured, and Solana's and NEAR's `tx.final` take a whole anchor although they take seconds.
   NEAR's horizon (c) is 1,680 anchors (86,400 blocks, about 14 h), and NEAR `dead` (b) is read at the first anchor
   after the later nonce is final.
7. **A native-out tx that lands for more than G holds** drives G's native below 0 (P6a and NF flag it); on chain it
   would fail.
8. **Debit order is free.** Legs from one account land in any order. If the omnibus's transfers land in signing order,
   P12's order clause is stricter than the chain.
9. **P12's debit clause only sees the landings a sequence generates.** A leg never landed in a sequence is judged only
   by the order clause.
10. **P6a's RETIRED clause counts any native above 0, at every step.** The model writes ret.4's dust off when it retires
    G, so nothing else is left there by design.
11. **Buys:** fees are 0, so the amount recorded against P at a re-landed revert is the whole fill debit; buy.13 (HELD),
    buy.18 (NEAR's registration-only case) and buy.21 (Base's approve) are not modelled.
12. **Time:** anchors are integers, and events fall at x.5; a leg moved between an anchor's two status reads counts 0
    (reading 2). The rules read finality and run record ends at anchors.
13. **Prices:** one number per chain; 1Click delivers `amountIn` × (1 − 0-4%).
14. **The return image** is modelled only as far as P5 and P12 need (reading 14).
15. **G's floor** is one number for X23 + chainReserve + locked rent; pullable is native + wrapped − that floor, with
    no cost bounds.
16. **The stream regression** uses only the Solana and NEAR ghosts.
17. **`sealed`** models f645c4a only in the level of `tx.final` and in xk.2's Base parenthesis.
18. **The owner's capital call** is never On the way, so the gap never counts it.
19. **The owner's alert** for a transfer that 1Click credited and that then went `dead` (M147 (4), M149 (2): a §5
    `INCIDENT` record, not a leg state) is not modelled; the model's only channel is `funds_wait`.
20. **The amount recorded against P** is kept per ghost (`owe`) and netted from the next credit on that ghost (the model
    has one user, P) or taken whole by xk.3. What no sell nets stays on the ghost when it retires: the pool carries it.
    Neither B nor L counts it (solv.1 has no such term), so P4 compares like with like.
21. **P11's end clause reads only the end of a sequence**, at the last anchor's finality, and only for a ghost whose
    txs are all final. A tx that can never end (a NEAR tx whose nonce the key has passed, before `neardead`, until the
    14 h horizon) is outside it, so for item (2) the nearDead regression is the guard, not the fuzz.
22. **`landpull` is defined only with `nochain`.** Under the pre-fix chain clocks (`wait`, `perwait`, no `nochain`) a
    coming leg has no chain start and does not count. A coming full return is defined only under `endfinal` (full sells,
    exports) and `endbuy` (reverts); without them the papers open it at the landing.
23. **The fuzz rarely builds a coming leg that alone covers a wait.** P2's rows without `landpull` and with `pullonly`
    fail 5 of 100,000 main sequences each, and none in the focus and RIF sweeps, so basePage and hoodFull are the
    rule's guards.
24. **A coming leg's amount is G's read at its record's landing** (pullable for a pull, native + wrapped native for a
    full return) until ret.1's read at the final level, then that read until its send. If native reaches G before the send (a dead leg's native, which re-runs ret.1 but
    finds the pull open), the gap counts less than the leg will carry: the alarm can only page early. If native leaves G
    before the send (a full return's G debited by a landing between), the gap counts more than it will carry; the fuzz
    found no case where that kept a page back (P1).
25. **A full return opened other than at a record's end** (the return image, the wind-down trigger, ret.14's fresh one
    after `dead`) counts from its send only, as before M147; CO's rule names record ends. Under `sealed`, a T reorged
    after the rules' `tx.final` stands again for a full return that its end already opened, so that money can count
    twice; `sealed` is a pre-fix put-back only.

## M151 (CO, after R14 at 4f0dab6)

Sources: merge note M151 (docs/spec/11-merge-notes.md at dd1bad8, with 2436ceb's change to (1)), R14's report, and
CO's two decisions during this round. The first is now M152 (02816b8): `x24long` is 32 anchors, and lane NM's reading
stands (06a v1.41 §4.16 l. 1534-1548, §8.22 row 7 (a), at eb51ed7). The second is option (c) on MC's P11 case (a note in
the next merge note): no buy is signed on a POSITION G (ghost.6 takes only a WARM ghost, 06a l. 1108; "Nothing else
picks a POSITION ghost", §4.16 l. 1499). Model line numbers are model.ts's at this commit. Amounts are in cents.

### What the model gains

Three flags, one per item of M151 that changes the model. The set adds all three:
`FIX=nochain,live,finalnative,onepull,level,endfinal,endbuy,boundf,refillcash,landpull,neardead,relandowe,retfinal,refinal,gpull,fateoracle,x24long`.
Three changes are chain truth or rules the papers already had, and hold in every run, with or without the flags: no trade
is atomic (1), and ret.1 runs at a full sell's end and at a failed sell's end (5).

1. **No trade is atomic** (reading 8; chain truth). A partial sell, fire or partial export is now a tx like the others:
   it lands, can be reorged (sell.12), re-land or go `dead`, and is `tx.final` at its chain's lag (Solana 1, Base 5,
   Robinhood 28, NEAR 1 anchors). Its record ends then and runs ret.1 (l. 585-589). Its lots are read at each landing,
   so a partial sell never empties G (l. 353).
   - **ret.1 opens no pull while another trade record on G is open** (`recOpen`, l. 260, 316): ret.1's "no other op on
     G queued or open" (06a l. 1219). So a buy's BUY-40 pull now opens at the buy record's end (l. 590-594), not at the
     fill's landing, as ret.1 reads.
   - **Buys stay on WARM ghosts.** An earlier state of this round also signed a buy on a POSITION G, read from R14's
     reverse-order example (a buy that spends G's native after a sell landed on G). The focus sweep then found P11 (seed
     143: 1 of 100,000 with the three flags, 4 without): `buy(g=2,pos=false) ; tick(n=1) ; tick(n=2) ;
     leg(i=0,o=land,fee=0) ; tick(n=2) ; buy(g=1,pos=true) ; leg(i=0,o=reorg,fee=0) ; leg(i=0,o=dead,fee=0) ;
     leg(i=0,o=land,fee=0) ; tick(n=1)` → P11 t=5: Base ghost 3 is RETURNING with 2 token lots. The first buy's fill is
     reorged and `dead`, ghost.15 sends G home while the second buy is live, and its fill then lands. No paper row covers
     that state, because the papers never make it: CO's option (c) removed the buy on a POSITION G from the model. The
     fixed case for R14's reverse order went with it; pullReorg (below) takes the over-count side on a path the papers
     allow.
2. **`gpull`** (M151 (1) with 2436ceb, and NM's reading, M152 (2)). G's coming partial pull (`gComing`, l. 185-204):
   while G is POSITION and a T or B on G has landed and its record has not ended (a reorg does not end it), or G's pull
   is open and not yet broadcast, the pull counts once, at G's pullable read at the latest landing on G (`gp`, read
   again at every landing on G, l. 359, 395, 484, and at ret.1's reads, l. 299-300, 319), less what G's txs signed and
   not landed can spend from G's native, if that is at least X8. In the model that is a pull's or full return's amount
   and a reorged buy's amount (reading 17); a sell's, fire's or export's fee cap and a buy's Base approve fee cap are 0
   (fees are 0). A record whose end opens no pull passes the count on (the count holds while any landed record on G is
   open); it leaves at the last record's end with no pull, at its cancel (ret.13), at its broadcast (from then on it
   counts as a sent leg, at its `amountIn`) or at an exit of §4.16. From the landing of a record whose end will send G
   home (`homeLeg`, l. 169-174) the coming full return counts (M149 (1)) and G's partial pull counts no more (l. 198),
   so the two never count for G at once. Without `gpull`, M149's and M150's rule per record runs (`partLeg`, l.
   175-176): the papers at v1.40.
3. **`fateoracle`** (M151 (1), last sentence). P2's oracle credits every landed record's money by its fate, not by the
   rule's own On the way set (see "How the oracle judges short"). The old oracle stays, without the flag, and two
   oracle rows in mutants.ts show the difference.
4. **`x24long`** (M151 (4) as M152 (1) corrects it). X24 is 32 anchors (16 min: 821 s + 43 s + 60 s = 924 s, rounded up
   to the minute), one switch (l. 10-13). P1's deadline and the oracle's use it too.
5. **Two model fixes found by the sweeps** (no flag; ret.1 runs at a sell record's end "in any end state" with G still
   POSITION, 06a l. 1219). Atomic partial sells (before this round) could not build either state. Each was the model's
   omission, not M151's.
   - (i) An emptying sell's or export's record end now also runs ret.1, after ghost.12 (l. 587-588). Shrunk (P11, 1 of
     100,000 main sequences at seed 20261021, with and without the three flags): `sell(g=0,full=false,wrap=false,p=20) ;
     sell(g=10,full=false,wrap=false,p=20) ; wind ; sell(g=6,full=true,wrap=false,p=20) ; wd(a=20) ; tick(n=15) ;
     leg(i=12,o=land,fee=0) ; tick(n=13) ; exp(g=9,full=false) ; leg(i=11,o=land,fee=0) ; leg(i=14,o=reorg,fee=0) ;
     leg(i=14,o=dead,fee=0) ; tick(n=15) ; tick(n=14) ; wd(a=20)` → P11 t=57: Robinhood ghost 8 ends POSITION with
     pullable 20 and no pull. Its partial sell lands, its full sell lands and takes the last lot, and the partial is then
     reorged and `dead`, so a lot comes back; at the full sell's end ghost.12 finds that lot and opens no full return.
   - (ii) A sell whose tx lands and fails because its lots are gone now ends its record and runs ret.1, as a `dead` one
     already did (l. 354-356). Shrunk (P11, 1 of 100,000 main sequences at seed 143 without the three flags):
     `sell(g=1,full=false,wrap=false,p=20) ; sell(g=0,full=false,wrap=false,p=20) ;
     leg(i=13,o=land,fee=0) ; leg(i=9,o=reorg,fee=0) ; sell(g=0,full=true,wrap=false,p=20) ; leg(i=1,o=land,fee=0) ;
     dep(c=0,a=5) ; tick(n=2) ; dep(c=0,a=5) ; leg(i=21,o=land,fee=0) ; leg(i=0,o=land,fee=0)` → P11 t=2: Solana ghost 2
     ends POSITION with pullable 20 and no pull (the partial sell re-lands after the full sell signed for both lots, so
     the full sell fails).
6. **The harness.** Every fixed case that sells now lands the sell's tx itself (stream, case1, nearDead, relandOwe,
   relandPull, the P5 case). The P6b case of the pre-fix rule is re-cut, since its old shape needed an atomic sell:
   Solana ghost 2's pull lands and is reorged, a second sell lands, the pull lands again, and the second sell's end opens
   a pull that reads G's native while the first pull is not yet final again (simplification 31).
7. **`mutants.ts`** runs the set with the three flags. No `gpull` has no fuzz row: the fuzz never built a false page from
   overlapping records that outlasts P2's slack (0 of 100,000 on each generator at seed 20261021, on this commit's
   code). Its guards are M151's three cases replayed without it and the two oracle rows. pullReorg also runs under a
   rule mutation (`nospend`: G's coming pull not lowered by what G's txs signed and not landed can spend).

### M151 (2) and (3), checked against the model

- **(2) `settled` counts A4 `dead`.** The model already does: a `dead` tx's leg is closed, `notFinal` leaves closed legs
  out (l. 245), `live` has no closed state (l. 247), and `unsettled` is live or not final (l. 248). xk.2 refuses only
  while a tx on G is unsettled (l. 663), and signer rule 3 waits the same way (l. 288). No change.
- **(3) B reads ghost native at the landed level.** The model already does: solv.1's B (`Bpaper`, l. 227) takes G's
  native and wrapped native as they stand, a ghost leg's landing debits G's native (l. 484), and from then the leg counts
  in B at its amount (l. 230). Before the landing the native counts, after it the leg, never both (07 IN-81 (z)). No
  change. P4 compares B with the ledger at every anchor and passes in every run of the set.

### The fixed regressions

Each passes under the set and fails without each flag it names (props.ts's main loop, and mutants.ts).
- **r14Base** is R14's Base case with its amounts: Base ghost 3 (given 9,780 native) buys 5,040 at 0, which fills at
  0.5 and leaves 5,000 pullable; a $4 withdrawal drains the omnibus at 0.5; a $10 partial sell of the same ghost signs
  once the fill has landed and lands at 2.5 (pullable 6,000); a $50 withdrawal waits from 2.5 with Available 0. The buy is
  final at 5.5 and its end opens no pull (the sell's record is open); the sell is final at 7.5, and its end sends the
  $60 pull at anchor 8, which arrives at 8.5. Without `gpull` the sell is never counted (the buy's record was open at its
  landing) and the buy's leg leaves at its end: a notice at anchor 8 (R14: 7; the model runs record ends after the
  anchor's gap read). Under the set: no notice, no check fails, and the $50 payout is paid.
- **r14Hood** is the same on Robinhood ghost 6 (`tx.final` 28 anchors): the buy's end at 29, the sell's at 31, the pull
  arriving at 31.5. Without `gpull`: a notice at anchor 31. Without `x24long`: a notice at anchor 24, since the coming
  pull leaves at 2.5 + 20 (M151 (4)'s case). Under the set: no notice.
- **pullReorg** takes both sides of R14's finding on a path the papers allow. Solana ghost 2 (POSITION, 40 native) sells
  200 at 0.5; its end at anchor 2 sends the $2 pull P1, which lands at 2.5 and is reorged (On the way still). A partial
  sell of 100 signs (a reorged landed tx holds no sell) and lands at 2.5; on Base and Robinhood nonce order would hold
  it until P1 lands again. A $3 withdrawal waits from 2.5 with Available 0. P1 lands again and arrives at 3.5; the sell's
  end at 4 opens the $1 pull, which signs at 5 (P1 final) and arrives at 5.5. Without `gpull` the sell is not counted (P1,
  reorged, is an op on G at the sell's landing): a notice at anchor 4, for money that arrives in time. Under `nospend`
  (gpull without M151 (1)'s subtraction) G's coming pull is 300, P1's 200 counted twice: an over-count at anchor 3 (On
  the way 500, 300 arrives). Under the set: On the way 300 at anchor 3, no notice, no over-count, and the $3 payout is
  paid.
- **The oracle rows**: R14's Robinhood case with the sell landing 5 anchors after the fill (a false page long enough for
  P2's 2-anchor slack). Without `gpull`, P2 fails under the fate oracle and passes under the old oracle, as R14 said:
  the old oracle credited only the rule's own On the way set.

### The runs

Each run had 100,000 sequences and went through `scripts/heavy.sh`: 18 sweeps (1.8 M sequences) and the mutation run, all
on this commit's code. "M147's set" here is the set without M151's three flags. No trade is atomic in it too, and both
model fixes hold in it (items 1 and 5), so its notice counts differ from M147's runs. The generators are M147's (the
action counts match).

| Run | Seed | Actions | Notices | Result |
|---|---|---|---|---|
| M151's set, main | 20261021 / 4 / 143 | 2,979,468 / 2,971,775 / 2,973,563 | 45,468 / 45,440 / 45,500 | all 15 checks PASS |
| M151's set, focus | 20261021 / 4 / 143 | 2,003,508 / 1,997,935 / 1,995,823 | 0 / 0 / 0 | all 15 checks PASS |
| M151's set, RIF | 20261021 / 4 / 143 | 4,303,508 / 4,297,935 / 4,295,823 | 3,923 / 3,882 / 3,886 | all 15 checks PASS |
| M147's set, main | 20261021 / 4 / 143 | the same | 48,705 / 48,732 / 48,843 | all 15 checks PASS; **r14Base, r14Hood, pullReorg FAIL** |
| M147's set, focus | 20261021 / 4 / 143 | the same | 2 / 0 / 3 | all 15 checks PASS; **r14Base, r14Hood, pullReorg FAIL** |
| M147's set, RIF | 20261021 / 4 / 143 | the same | 5,661 / 5,719 / 5,619 | all 15 checks PASS; **r14Base, r14Hood, pullReorg FAIL** |

- Under M151's set every run passes all fifteen regressions: stream (41 of 43 payouts done, 0 notices), bound, case1,
  lateSell, lateBuy, refill, M147's six (basePage, hoodFull, nearDead, relandOwe, retReorg, relandPull) and M151's three
  (r14Base, r14Hood, pullReorg). Each of M151's cases fails without each flag it names, every earlier case fails under
  the rule it guards, and the P5 and P6b pre-fix cases fail, as they must (P6b's re-cut case: "P6b t=4: ghost 2 native
  read while tx #1 (pull, deb) is not final").
- **P1 and P2 pass in all eighteen runs**, at every seed and generator, with and without M151's flags.
- Under M147's set every run exits 1 only because M151's three cases fail: r14Base pages at anchor 8, pullReorg at 4 and
  r14Hood at 24 (X24's 20 anchors drop the coming pull before it arrives at 31.5). Its twelve earlier cases pass in
  every run (stream: 29 of 31 payouts done, 0 notices).
- M151's set pages fewer sequences: 3,237 to 3,343 fewer main ones, 1,733 to 1,837 fewer RIF ones, and no focus one (2
  and 3 before). Nearly all of that is `x24long` (a leg counts 12 anchors longer before X24's exit): the set without
  `gpull` (fate oracle on) at seed 20261021 pages 45,473 main, 0 focus and 3,923 RIF sequences, 5 main ones more than
  the set, and P1 and P2 pass in all three. P1 passes in every run of the set, so none of the pages it drops was one P1
  asks for.
- The fuzz alone does not tell `gpull` from the rule per record: no run builds a false page from overlapping records
  that outlasts P2's slack, so P2 passes without `gpull` under either oracle. The three fixed cases and the oracle rows
  do (see "The fixed regressions" and the mutation run).

### Mutation run (`mutants.ts`, seed 20261021, 100,000 sequences per generator per row)

| Check | Kind | Mutation | Main | Focus | RIF | Also failing | Shrunk (the first generator that fails) → the check's message |
|---|---|---|---|---|---|---|---|
| P1 | rule | `pend3`: the pending period is three completed anchors, not two | 15,146 | 0 | 3,183 |  | `wd(a=368) ; wd(a=33) ; wind ; tick(n=11) ; tick(n=23) ; xk(g=0)` → payout 1 from 0.5 still waits at anchor 34, no funds_wait |
| P1 | pre-fix | X24 per leg chain only (M134: no `nochain`) | 8,459 | 0 | 1,285 | P2 422 | `wd(a=177) ; wd(a=224) ; tick(n=14) ; image ; tick(n=20) ; down` → payout 1 from 0.5 still waits at anchor 34, no funds_wait |
| P2 | rule | `nootw`: the gap leaves out the money On the way | 1,130 | 46 | 1,009 |  | `wind ; wd(a=20) ; tick(n=3) ; leg(i=0,o=land,fee=0) ; tick(n=1,m=0) ; leg(i=0,o=land,fee=0)` → funds_wait open while covered for 3 anchors at 4 |
| P2 | pre-fix | `perwait` for `nochain` (the papers at f4a5676) | 207 | 0 | 215 |  | `sell(g=5,full=false,wrap=false,p=20) ; leg(i=0,o=land,fee=0) ; wd(a=401) ; tick(n=6) ; leg(i=0,o=land,fee=0) ; tick(n=1,m=0) ; sell(g=0,full=false,wrap=false,p=20)` → funds_wait open while covered for 3 anchors at 4 |
| P2 | pre-fix | no `landpull`: a coming record-end leg counts only from its broadcast (the papers before M147) | 15 | 0 | 0 |  | `sell(g=5,full=false,wrap=false,p=20) ; leg(i=0,o=land,fee=0) ; wd(a=401) ; tick(n=6) ; leg(i=0,o=land,fee=0) ; tick(n=1,m=0) ; sell(g=0,full=false,wrap=false,p=20)` → funds_wait open while covered for 3 anchors at 4 |
| P2 | pre-fix | `pullonly`: coming pulls only, not a coming full return (CO's first correction to M147 (1)) | 10 | 0 | 0 |  | `sell(g=5,full=true,wrap=false,p=20) ; leg(i=0,o=land,fee=0) ; wd(a=401) ; tick(n=6) ; leg(i=0,o=land,fee=0) ; tick(n=1,m=0) ; sell(g=0,full=false,wrap=false,p=20)` → funds_wait open while covered for 3 anchors at 4 |
| P3 | rule | `noquote`: the anchor does not re-quote waiting payouts | 1,253 | 0 | 60 | P10 128, P1 310 | `sell(g=0,full=false,wrap=false,p=20) ; dep(c=0,a=5) ; exp(g=1,full=false) ; wd(a=401) ; dep(c=0,a=5) ; leg(i=7,o=land,fee=0) ; buy(g=0) ; dep(c=0,a=5) ; tick(n=1) ; wd(a=20) ; tick(n=19) ; leg(i=11,o=expire,fee=0) ; tick(n=1) ; leg(i=0,o=land,fee=0)` → anchor 21: a wait of 20 sits with Available 405 |
| P4 | rule | `bnowrap`: solv.1's B leaves out G's wrapped native | 5,633 | 16,494 | 1,368 |  | `sell(g=1,full=false,wrap=true,p=20) ; leg(i=0,o=land,fee=0) ; tick(n=1) ; price(c=0,pct=0)` → anchor 1: B 2960.00 vs ledger 2980.00 − mover 0.00 |
| P5 | pre-fix | no `live`: pay.3 signs from the anchor's values | 9 | 0 | 339 | P12 10 | `exp(g=0,full=false) ; sell(g=1,full=false,wrap=false,p=20) ; image ; wd(a=20) ; dep(c=0,a=5) ; call ; leg(i=12,o=success,fee=0) ; tick(n=1) ; dep(c=0,a=5) ; sweep ; tick(n=1)` → P5 t=1: payout 18794 > live omnibus USDC − L − D = 18789.90 |
| P6a | rule | `nounwrap`: a full return sends G's native without unwrapping its wrapped native first (B-7, N-11) | 90 | 1 | 8 | P4 98 | `sell(g=3,full=true,wrap=true,p=20) ; leg(i=0,o=land,fee=0) ; tick(n=2) ; leg(i=0,o=land,fee=0) ; leg(i=0,o=success,fee=0) ; tick(n=2)` → P6a t=4: ghost 11 is RETIRED with 0 native and 20 wrapped on it |
| P6a | pre-fix | no `retfinal`: ghost.13 at SUCCESS or REFUNDED, before the transfer is final (the papers at a977374) | 43 | 168 | 0 | P4 121, P11 10 | `exp(g=0,full=false) ; sell(g=10,full=false,wrap=false,p=20) ; wind ; wd(a=20) ; leg(i=30,o=land,fee=0) ; sell(g=1,full=false,wrap=false,p=20) ; tick(n=1,m=0) ; leg(i=21,o=reorg,fee=0) ; leg(i=0,o=land,fee=0)` → P6a t=1: ghost 7 is RETIRED with 300 native and 0 wrapped on it |
| P6b | pre-fix | no `finalnative`: signer rule 2 as written before M137 | 1 | 33 | 3 |  | `xk(g=1) ; buy(g=2) ; leg(i=0,o=land,fee=0) ; sell(g=5,full=false,wrap=false,p=20) ; leg(i=0,o=reorg,fee=0) ; leg(i=0,o=failed,fee=0) ; tick(n=6) ; price(c=0,pct=0)` → P6b t=6: ghost 3 native read while tx #1 (T, sent) is not final |
| P6c | rule | `twokeys`: far.20 re-types a payout already in flight, so the exit key signs it again | 13 | 0 | 2 | P3 76, P12 2 | `wd(a=20) ; call ; leg(i=21,o=success,fee=0) ; drill ; callE(a=20) ; leg(i=0,o=land,fee=0) ; sell(g=0,full=false,wrap=false,p=20) ; wind ; tick(n=1) ; leg(i=29,o=land,fee=0) ; tick(n=1)` → P6c t=1: payout 0 left omni and E, net 2 times |
| NF | rule | `nofloor`: a pull takes G's floor too | 13,109 | 14,744 | 100,000 | P11 226,229 | `sell(g=0,full=false,wrap=false,p=20) ; leg(i=0,o=land,fee=0) ; tick(n=2) ; xk(g=0)` → NF t=2: ghost 2 keeps 0 < its floor once every live tx lands |
| P7 | rule | `refundpaid`: a refunded W stays open, so it can still pay | 172 | 269 | 4 | P4 1,556, P6c 253 | `wd(a=20) ; leg(i=0,o=land,fee=0) ; leg(i=0,o=refund,fee=0) ; leg(i=0,o=refund,fee=0) ; leg(i=0,o=land,fee=0)` → P7 t=0: the user received payout 0 2 times (leg) |
| P8 | rule | `nopenop`: ret.1 opens a pull while one is open | 54 | 548 | 189 |  | `buy(g=0) ; leg(i=0,o=land,fee=0) ; leg(i=0,o=reorg,fee=0) ; leg(i=0,o=land,fee=0) ; tick(n=2) ; leg(i=0,o=land,fee=0)` → P8 t=2: ghost 0 ends a record with 2 pulls open |
| P9 | rule | `nocnv`: cnv.1 plans no convert at the omnibus | 5,062 | 526 | 15,588 |  | `dep(c=0,a=10) ; leg(i=0,o=refund,fee=0) ; tick(n=2) ; exp(g=0,full=false)` → omni:sol stranded at anchors 1-2 |
| P10 | rule | `hol`: the re-quote stops at the first waiting payout it cannot pay | 305 | 0 | 3 | P3 2,848 | `wd(a=401) ; wind ; wd(a=20) ; wd(a=20) ; leg(i=0,o=land,fee=0) ; tick(n=1,m=0) ; tick(n=1) ; down` → anchor 2: waits 1 and 2 (20 + 20) starve under Available 400 |
| P10 | pre-fix | `m135`: M135's all-at-once re-quote | 436 | 0 | 3 | P3 2,476 | `wd(a=322) ; wd(a=79) ; wd(a=79) ; tick(n=20) ; wd(a=243) ; leg(i=0,o=expire,fee=0) ; tick(n=1) ; sell(g=0,full=false,wrap=false,p=20)` → anchor 21: waits 1 and 2 (79 + 79) starve under Available 400 |
| P11 | rule | `noreland8`: a revert re-landed as a fill does not run ghost.8 (G stays BUSY) | 23 | 340 | 0 |  | `buy(g=0) ; leg(i=0,o=failed,fee=0) ; leg(i=0,o=reorg,fee=0) ; leg(i=0,o=land,fee=0)` → P11 t=0: ghost 0 is BUSY with 2 token lots on it |
| P11 | pre-fix | `sealed`: tx.final on Base and Robinhood at 1 anchor (the papers at f645c4a) | 12 | 67 | 34 | NF 1,659, P4 112, P6a 348 | `sell(g=5,full=true,wrap=false,p=20) ; leg(i=0,o=land,fee=0) ; tick(n=2) ; leg(i=0,o=reorg,fee=0) ; tick(n=3) ; leg(i=0,o=dead,fee=0) ; dep(c=0,a=5)` → P11 t=5: ghost 5 is RETURNING with 2 token lots on it |
| P11 | pre-fix | no `endbuy`: ghost.9 at the revert, no row for the mirror (the papers at f4a5676) | 45 | 411 | 0 | P2 6 | `buy(g=0) ; leg(i=0,o=failed,fee=0) ; leg(i=0,o=reorg,fee=0) ; leg(i=0,o=land,fee=0)` → P11 t=0: ghost 0 is RETURNING with 2 token lots on it |
| P11 | pre-fix | no `endfinal`: ghost.12 at the emptying landing (the papers at 2fb7299) | 65 | 149 | 1 | P2 2 | `sell(g=0,full=true,wrap=false,p=20) ; leg(i=0,o=land,fee=0) ; leg(i=0,o=reorg,fee=0) ; tick(n=3) ; leg(i=0,o=dead,fee=0) ; dep(c=0,a=5)` → P11 t=3: ghost 2 is RETURNING with 2 token lots on it |
| P11 | rule | `nosellpull`: a partial sell's, fire's or export's end opens no pull (ret.1) | 2,219 | 4,091 | 1,267 |  | `sell(g=0,full=false,wrap=false,p=20) ; leg(i=0,o=land,fee=0) ; tick(n=2) ; xk(g=1)` → P11 t=2: ghost 2 ends POSITION with pullable 20 (20.00 ≥ X8), every tx on it final and no pull open |
| P11 | pre-fix | no `refinal`: no ret.1 when a reorged tx on G is final again (the model until M147) | 0 | 1 | 0 |  | `sell(g=0,full=false,wrap=false,p=20) ; buy(g=0) ; leg(i=0,o=land,fee=0) ; tick(n=2) ; sell(g=0,full=false,wrap=false,p=20) ; leg(i=3,o=land,fee=0) ; leg(i=5,o=land,fee=0) ; leg(i=1,o=reorg,fee=0) ; tick(n=2) ; leg(i=1,o=land,fee=0) ; tick(n=2) ; sell(g=1,full=false,wrap=false,p=20)` → P11 t=6: ghost 2 ends POSITION with pullable 20 (20.00 ≥ X8), every tx on it final and no pull open |
| P12 | rule | `payres`: Reserved leaves out the owner payout | 37 | 0 | 445 |  | `call ; leg(i=0,o=success,fee=0) ; image ; wd(a=56) ; wd(a=554) ; tick(n=1) ; sweep ; wd(a=491) ; drill ; tick(n=1)` → P12 t=1: omni USDC: open legs W 56 + W 554 + pay 18800 + W 491 + u 500 > balance 20400: a W, F or u that lands last finds it short |
| P12 | pre-fix | no `boundf`: the payout bound keeps open F and `u` | 45 | 0 | 568 |  | `call ; leg(i=0,o=success,fee=0) ; image ; wind ; tick(n=1) ; sweep ; wd(a=20)` → P12 t=1: omni USDC: open legs u 20400 + pay 18800 > balance 20400: a W, F or u that lands last finds it short |
| P12 | rule | `refillbal`: refill.2 reads the omnibus's USDC balance, not its Available | 0 | 0 | 5,208 |  | `RIF_STATE ; refill(c=0) ; refill(c=0) ; wd(a=20)` → P12 t=28: omni USDC: open legs F 300 + F 300 > balance 400: a W, F or u that lands last finds it short |
| P12 | pre-fix | no `refillcash`: refill.2 as written before M145 | 0 | 0 | 1,426 |  | `RIF_STATE ; wd(a=101) ; refill(c=0) ; leg(i=0,o=land,fee=0)` → P12 t=28: omni USDC: open legs W 101 + F 300 > balance 400: a W, F or u that lands last finds it short |

- No new fuzz row this round. No `gpull`'s guards are r14Base, r14Hood and pullReorg replayed without it, pullReorg
  under the rule mutation `nospend` (M151 (1)'s subtraction dropped) and the two oracle rows; `x24long`'s is r14Hood
  replayed without it, and `fateoracle`'s the oracle rows. The set without `gpull` passes P1 and P2 in 100,000
  sequences per generator (seed 20261021; "The runs").
- Rows that need a partial sell's money count fewer sequences than in M147's run, since that money now moves only at
  its tx's landing (a `leg` action): `nosellpull` 2,219 main (39,528 then), `bnowrap` 5,633 (25,799), `nofloor` 13,109
  (52,253). Every row is still caught.
- In the RIF column only `nofloor` fails every sequence, because `RIF_STATE` itself fails under it. Under no
  `finalnative` it no longer does (3 of 100,000; 100,000 in M147's run).
- No `refinal` is caught by focus only (1 of 100,000), shrunk to relandPull's shape around a buy on another ghost.
- The run exits 0: every row and every case is caught.

The regressions, each replayed under the rule a fix replaced (M151's cases without each flag they name):
- stream fails under `wait` for `nochain` (M137's period clock): 1 notices; funds_wait open while covered for 3 anchors at 4
- case1 fails under `perwait` for `nochain`: 1 notices
- bound fails under no `boundf`: 0 notices; P12 t=1: omni USDC: open legs F 300 + W 1600 + pay 18800 > balance 20400: a W, F or u that lands last finds it short
- lateSell fails under `sealed`: 0 notices; NF t=2: ghost 5 native 40, -20 once every live tx lands; P11 t=5: ghost 5 is RETURNING with 2 token lots on it
- lateBuy fails under `sealed`: 0 notices; NF t=2: ghost 3 native 300, -150 once every live tx lands; P11 t=2: ghost 3 is RETURNING with 2 token lots on it
- refill fails under no `refillcash`: 0 notices; P12 t=28: omni USDC: open legs W 200 + F 300 > balance 400: a W, F or u that lands last finds it short
- basePage fails under no `landpull`: a notice at anchor 2; funds_wait open while covered for 3 anchors at 4
- hoodFull fails under no `landpull`: a notice at anchor 12; funds_wait open while covered for 3 anchors at 14
- hoodFull fails under `pullonly`: a notice at anchor 12; funds_wait open while covered for 3 anchors at 14
- nearDead fails under no `neardead`: A is reorg, not `dead`; the pull is undefined; ghost 11 is POSITION: xk.2 refused the export key
- relandOwe fails under no `relandowe`: L 1450 after the re-land, 1550 after the sell; 0 recorded against P (want 1600, 1600, 50)
- retReorg fails under no `retfinal`: anchor 3: B 2960.00 vs ledger 3260.00 − mover 0.00; P6a t=2: ghost 3 is RETIRED with 300 native and 0 wrapped on it; ghost 3 is RETIRED with 300 native
- relandPull fails under no `refinal`: P11 t=7: ghost 2 ends POSITION with pullable 100 (100.00 ≥ X8), every tx on it final and no pull open
- r14Base fails under no `gpull`: a notice at anchor 8
- r14Hood fails under no `gpull`: a notice at anchor 31
- r14Hood fails under no `x24long`: a notice at anchor 24
- pullReorg fails under no `gpull`: a notice at anchor 4
- pullReorg fails under the rule mutation `nospend` (G's coming pull is not lowered by what G's txs signed and not landed can spend: over-count at anchor 3: On the way 500)
- r14Hood with the sell landing 5 anchors after the fill, without `gpull`: P2 fails under the fate oracle (funds_wait
  open while covered for 3 anchors at 33) and passes under the old oracle, as each must.

### The count

**13 of 15 checks can fail under the set** (M151's, with `gpull`, `fateoracle` and `x24long`). A rule mutation fails each
of P1, P2, P3, P4, P6a, P6c, NF, P7, P8, P9, P10, P11 and P12. **P5 and P6b fail only under a pre-fix row** (no `live`,
no `finalnative`), so they run as regressions of the pre-fix rules, as before. M151 adds three fixed cases, one rule
mutation on a case (`nospend`) and two oracle rows, and no fuzz row; the count stays M147's.

### What the model shows about M151's text

1. **R14's finding, plainly.** Under the papers at v1.40 (no `gpull`) r14Base and r14Hood page for a pull that arrives
   in time: notices at anchors 8 and 31, for pulls arriving at 8.5 and 31.5. Under `gpull` neither pages, on Robinhood
   only with `x24long` too (without it, a notice at 24: the count leaves at 2.5 + 20 anchors). pullReorg pages at 4
   without `gpull`, and counts P1's 200 twice without M151 (1)'s subtraction. **P1 and P2 pass in all eighteen runs.**
2. **The fate oracle sees what the old one could not.** With the sell landing 5 anchors after the fill, the rule per
   record's false page outlasts P2's slack: P2 fails under the fate oracle and passes under the old one (the oracle
   rows). R14 was right that the old oracle's P2 could not see it.
3. **The papers never make a buy on a POSITION G.** That was the round's one stop (item 1): M151's model half had read
   one from R14's reverse-order example, and its P11 case has no paper row because the state cannot happen. CO took
   option (c), and a note in the next merge note will say so. M151 (1)'s subtraction stays for what can be signed on a
   POSITION G and not yet landed: a sell's, fire's or export's fee cap, and a buy record's own Base approve (buy.21) fee
   cap after its fill; in the model, a reorged pull's, full return's or buy's amount (reading 17).
4. **M151 (2) and (3) match the model with no change** (see above).
5. **Two model omissions, not text findings** (item 5). ret.1 runs at a sell record's end "in any end state" (06a l.
   1219), so an emptying sell whose lot came back, and a sell that lands and fails, both end with ret.1 in the papers
   already. Atomic partial sells kept the model from reaching either state.
6. **One review target in M151 (1)'s leave list** (simplification 30): an end that opens no pull because a reorged pull
   on G is open is not in the list. The count reads low there, never high. No check fails.
7. **No finding against M151's or M152's text** otherwise. Every check passes under the set in every run, every fixed
   case passes under it, and each fails without each flag it names.

### Simplifications the model still makes (review targets)

The list in "M147" stands, with these changes:
- **Item 2 is gone.** No trade is atomic (item 1 above). The `tx.final` wait before a record's end is now exercised
  through partial sells, fires and partial exports too (r14Base, r14Hood, pullReorg).
- Item 22 covers `gpull` too: G's coming pull is defined only with `nochain`.
- Item 24 held for G's coming pull too until round 7: M151 (1) read it again only at a landing on G, so a reorg on G
  between two landings (a sell's proceeds taken back) left the count at the last read. Resolved by M158 (3): a reorg
  of a tx on G reads it again, and a `dead` verdict moves no money on G (the reorg already did).
26. **Lots.** A partial sell, fire or export takes 1 lot while G holds more than 1, else none, so it never empties G; an
    emptying one takes every lot it signed for, and fails if they are gone. A buy adds 2 lots.
27. **G's coming pull also counts while G's pull is open and not yet broadcast**, though M151 (1) names landed records.
    It is the same leg ("the same leg once ret.1 opens it"), at ret.1's read, so the count does not change.
28. **The subtraction (M151 (1)) takes amounts only**: fees are 0 in the model (item 11), so every fee cap is 0.
29. **The checks see a double count only through its effect.** P1 fails when a count keeps a page back, and pullReorg
    reports each anchor whose On the way exceeds what arrives after it. That NM's reading never counts G's partial pull
    and full return at once is by construction (l. 198).
30. **When a reorged pull blocks the last record's end**: no longer a simplification. M158 (2) adds the case to M151
    (1)'s list, and the model's behaviour is the text's rule (reading 18).
31. **A pull whose landed tx is gone in a reorg blocks a new pull only while it is reorged**: gone in round 7. `openOp`
    follows ret.1 (M158 (4)): such a pull blocks a new one until that tx ends, `tx.final` again or A4 `dead` (06a l.
    1219), even after it lands again.

## Round 7: M158 (CO, after MC round 6 at 5e1a478)

Sources: merge note M158 (docs/spec/11-merge-notes.md at a1d11f8) and CO's round-7 brief. Model line numbers are
model.ts's at this commit. The set is round 6's (M151's).

### What changed

1. **M158 (4): `openOp` follows ret.1** (`pullOp`, l. 259-260). A pull whose landed tx is gone in a reorg is an op on G
   until that tx ends, `tx.final` again or A4 `dead`, also after it lands again (06a l. 1219). Until round 7 it stopped
   blocking once it landed again (simplification 31, now gone). Its end runs ret.1 again (`refinal`), as before.
2. **M158 (3): G's pullable is read again at each reorg of a tx on G** (`reread` at a trade's, a buy's and a ghost
   leg's reorg, l. 365, 406, 554), as well as at each landing. A reorged tx's spend now comes off once (reading 17,
   resolved), and item 24's stale read for G's coming pull is gone with it.
3. **M158 (2)** needs no model change. The model already let G's coming pull leave at an end that a reorged pull
   blocks; that is now the text's rule (reading 18; simplification 30 gone).
4. **P8 counts open pulls with ret.1's op on G** (`pullOp`, l. 764). See the finding below.
5. **The harness.** The P6b pre-fix case is re-cut again, since its round-6 shape needed the window (1) closes: Base
   ghost 3's buy fills and a partial sell on it signs; the fill is reorged and lands again as a revert, so G holds no
   token; the buy's end at its `tx.final` (anchor 6) sends G home, and the full return reads G's native while the
   sell's tx is still live ("P6b t=6: ghost 3 native read while tx #1 (T, sent) is not final"). pullReorg now passes
   through M158 (2)'s case: the sell's end at 4 opens no pull (P1, landed again at 3.5, is final only at 4.5), and P1's
   end at 5 opens the $1 pull, which signs at once and arrives at 5.5, as before. Under the set it still passes, and it
   still fails without `gpull` (a notice at 4) and under `nospend` (an over-count at 3).

### Finding for CO: P8 counted open pulls by the round-6 op on G

With (1) in the model and P8 unchanged, P8 fails on a path the papers allow. The round-6 P6b case, replayed under the
set: `sell(g=0,full=false,wrap=false,p=20) ; leg(i=0,o=land,fee=0) ; tick(n=2) ; leg(i=0,o=land,fee=0) ;
sell(g=0,full=false,wrap=false,p=20) ; leg(i=0,o=reorg,fee=0) ; leg(i=1,o=land,fee=0) ; tick(n=1) ;
leg(i=0,o=land,fee=0) ; tick(n=1)` → "P8 t=4: ghost 2 ends a record with 0 pulls open". Solana ghost 2's pull P1 lands
at 2.5, is reorged, and lands again at 3.5; the second sell's end at 4 finds P1 still an op on G (final at 4.5), so
ret.1 opens no pull, as M158 (4) says. P8 counted a pull as open only while `pre`, `unwrap`, `sent` or `reorg`, the
round-6 op on G, so it saw none. Reading 11 defines P8's open pull as ret.1's op on G, so P8 now counts with the same
`pullOp`: P1 is the one pull open, and its end at 5 runs ret.1 again, which takes the second sell's money home. Nothing
is stranded (P11 passes, and the no-`refinal` row's case, relandPull, still fails P11). The change is in the check,
not in the rule. The `nopenop` row (ret.1 opens a pull while one is open) still fails P8.

### The runs

Each sweep had 100,000 sequences at seeds 20261021, 4 and 143 (round 6's), through `scripts/heavy.sh`: `FIX=<set> node
props.ts 100000 <seed>`, with `FOCUS=1` or `RIF=1` for those generators. "M147's set" is the set without `gpull`,
`fateoracle` and `x24long`. Action counts match round 6 in every run. Notices are round 6 → round 7.

| Run | Seed | Actions | Notices (round 6 → round 7) | Result |
|---|---|---|---|---|
| M151's set, main | 20261021 / 4 / 143 | 2,979,468 / 2,971,775 / 2,973,563 | 45,468 → 45,470 / 45,440 → 45,440 / 45,500 → 45,504 | all 15 checks PASS, all 15 cases PASS |
| M151's set, focus | 20261021 / 4 / 143 | 2,003,508 / 1,997,935 / 1,995,823 | 0 / 0 / 0 (no change) | all 15 checks PASS, all 15 cases PASS |
| M151's set, RIF | 20261021 / 4 / 143 | 4,303,508 / 4,297,935 / 4,295,823 | 3,923 → 3,923 / 3,882 → 3,883 / 3,886 → 3,886 | all 15 checks PASS, all 15 cases PASS |
| M147's set, main | 20261021 / 4 / 143 | the same | 48,705 / 48,732 / 48,843 (no change) | all 15 checks PASS; **r14Base, r14Hood, pullReorg FAIL** |
| M147's set, focus | 20261021 / 4 / 143 | the same | 2 / 0 / 3 (no change) | all 15 checks PASS; **r14Base, r14Hood, pullReorg FAIL** |
| M147's set, RIF | 20261021 / 4 / 143 | the same | 5,661 / 5,719 / 5,619 (no change) | all 15 checks PASS; **r14Base, r14Hood, pullReorg FAIL** |

- **No check moved.** Every check passes in all 18 runs, as in round 6. Under the set all fifteen fixed cases pass, and
  each fails without each flag it names; the P5 and P6b pre-fix cases fail, as they must. Under M147's set the run
  exits 1 only on M151's three cases, at the anchors of round 6 (r14Base 8, r14Hood 24, pullReorg 4).
- **`gpull`'s three cases still fail without the flag** (M158 (3) asked): r14Base and pullReorg page at anchors 8 and 4,
  r14Hood at 31 (24 without `x24long` too), as in round 6. M158 (3) changes only G's coming pull's read, which the rule
  per record does not use.
- **Notices moved by 7 sequences in all**, all under the set: main +2 and +4 (seeds 20261021 and 143), RIF +1 (seed
  4). M147's set did not move, so they come with `gpull`: G's coming pull now leaves the count at an end that a
  re-landed pull blocks (M158 (2), reachable since (1)), and is read again after a reorg (M158 (3), a sell's proceeds
  taken back); either can lower it. P1 and P2 pass in every run, so no needed page was lost and no false page outlasts
  P2's slack.

### Mutation run (`mutants.ts`, seed 777, 20,000 sequences per generator per row)

CO's round-6 re-run used this seed and size, so the two compare row by row. It ran in two chunks of checks (`node
mutants.ts 20000 777 P1,P2,P3,P4,P5,P6a,P6b,P6c,NF` and `node mutants.ts 20000 777 P7,P8,P9,P10,P11,P12,<the cases>,oracle`),
which is the same as one run: each row runs alone.

| Check | Kind | Mutation | Main | Focus | RIF | Also failing | Shrunk (the first generator that fails) → the check's message |
|---|---|---|---|---|---|---|---|
| P1 | rule | `pend3`: the pending period is three completed anchors, not two | 3,066 | 0 | 639 |  | `wind ; wd(a=20) ; tick(n=16) ; tick(n=18) ; xk(g=0)` → payout 0 from 0.5 still waits at anchor 34, no funds_wait |
| P1 | pre-fix | X24 per leg chain only (M134: no `nochain`) | 1,759 | 0 | 262 | P2 76 | `wd(a=401) ; tick(n=1) ; wind ; tick(n=20) ; tick(n=13) ; wd(a=20)` → payout 0 from 0.5 still waits at anchor 34, no funds_wait |
| P2 | rule | `nootw`: the gap leaves out the money On the way | 225 | 6 | 192 |  | `wind ; wd(a=20) ; leg(i=0,o=land,fee=0) ; tick(n=3) ; tick(n=1,m=0) ; exp(g=0,full=false)` → funds_wait open while covered for 3 anchors at 4 |
| P2 | pre-fix | `perwait` for `nochain` (the papers at f4a5676) | 32 | 0 | 44 |  | `image ; wd(a=320) ; tick(n=12) ; wd(a=81) ; tick(n=23) ; leg(i=0,o=land,fee=0) ; tick(n=1,m=0)` → funds_wait open while covered for 3 anchors at 36 |
| P2 | pre-fix | no `landpull`: a coming record-end leg counts only from its broadcast (the papers before M147) | 3 | 0 | 0 |  | `buy(g=2) ; leg(i=0,o=land,fee=0) ; wd(a=401) ; tick(n=6) ; leg(i=0,o=land,fee=0) ; tick(n=1,m=0) ; down` → funds_wait open while covered for 3 anchors at 4 |
| P2 | pre-fix | `pullonly`: coming pulls only, not a coming full return (CO's first correction to M147 (1)) | 3 | 0 | 0 |  | `buy(g=2) ; leg(i=0,o=failed,fee=0) ; wd(a=401) ; tick(n=6) ; leg(i=0,o=land,fee=0) ; tick(n=1,m=0) ; down` → funds_wait open while covered for 3 anchors at 4 |
| P3 | rule | `noquote`: the anchor does not re-quote waiting payouts | 254 | 0 | 7 | P1 59, P10 22 | `wd(a=230) ; wd(a=171) ; tick(n=9) ; tick(n=11) ; leg(i=0,o=expire,fee=0) ; tick(n=1) ; sell(g=0,full=false,wrap=false,p=20)` → anchor 21: a wait of 171 sits with Available 400 |
| P4 | rule | `bnowrap`: solv.1's B leaves out G's wrapped native | 1,082 | 3,220 | 308 |  | `sell(g=1,full=false,wrap=true,p=20) ; leg(i=0,o=land,fee=0) ; tick(n=1) ; sell(g=0,full=false,wrap=false,p=20)` → anchor 1: B 2960.00 vs ledger 2980.00 − mover 0.00 |
| P5 | pre-fix | no `live`: pay.3 signs from the anchor's values | 2 | 0 | 52 | P12 2 | `call ; leg(i=0,o=success,fee=0) ; tick(n=1) ; dep(c=0,a=5) ; image ; sweep ; refill(c=0)` → P5 t=1: payout 18800 > live omnibus USDC − L − D = 18794.95 |
| P6a | rule | `nounwrap`: a full return sends G's native without unwrapping its wrapped native first (B-7, N-11) | 16 | 0 | 0 | P4 16 | `sell(g=1,full=true,wrap=true,p=20) ; leg(i=0,o=land,fee=0) ; tick(n=6) ; leg(i=0,o=land,fee=0) ; tick(n=6,m=0) ; wd(a=20)` → P6a t=12: ghost 5 is RETIRED with 0 native and 20 wrapped on it |
| P6a | pre-fix | no `retfinal`: ghost.13 at SUCCESS or REFUNDED, before the transfer is final (the papers at a977374) | 11 | 34 | 0 | P4 28, P11 2 | `wind ; wd(a=20) ; leg(i=6,o=land,fee=0) ; tick(n=1,m=0) ; leg(i=6,o=reorg,fee=0) ; sell(g=0,full=false,wrap=false,p=20)` → P6a t=1: ghost 7 is RETIRED with 300 native and 0 wrapped on it |
| P6b | pre-fix | no `finalnative`: signer rule 2 as written before M137 | 0 | 5 | 2 |  | `buy(g=2) ; tick(n=1) ; tick(n=1) ; leg(i=0,o=land,fee=0) ; sell(g=1,full=false,wrap=false,p=20) ; leg(i=0,o=reorg,fee=0) ; tick(n=3) ; leg(i=0,o=dead,fee=0) ; leg(i=0,o=land,fee=0)` → P6b t=5: ghost 3 native read while tx #1 (T, sent) is not final |
| P6c | rule | `twokeys`: far.20 re-types a payout already in flight, so the exit key signs it again | 1 | 0 | 2 | P3 11 | `call ; wd(a=20) ; callE(a=20) ; sell(g=0,full=false,wrap=false,p=20) ; leg(i=1,o=land,fee=0) ; wd(a=20) ; wind ; tick(n=1) ; leg(i=13,o=land,fee=0) ; tick(n=1)` → P6c t=1: payout 0 left omni and E, net 2 times |
| NF | rule | `nofloor`: a pull takes G's floor too | 2,642 | 2,877 | 20,000 | P11 45,572 | `wd(a=72) ; wd(a=469) ; wd(a=602) ; wd(a=378) ; xk(g=0) ; xk(g=0)` → NF t=0: ghost 5 keeps 0 < its floor once every live tx lands |
| P7 | rule | `refundpaid`: a refunded W stays open, so it can still pay | 44 | 52 | 0 | P4 339, P6c 53 | `wd(a=20) ; leg(i=0,o=land,fee=0) ; leg(i=0,o=refund,fee=0) ; leg(i=0,o=refund,fee=0) ; leg(i=0,o=land,fee=0)` → P7 t=0: the user received payout 0 2 times (leg) |
| P8 | rule | `nopenop`: ret.1 opens a pull while one is open | 6 | 101 | 32 |  | `sell(g=0,full=false,wrap=false,p=20) ; leg(i=0,o=land,fee=0) ; leg(i=0,o=reorg,fee=0) ; leg(i=0,o=land,fee=0) ; tick(n=2) ; leg(i=0,o=land,fee=0)` → P8 t=2: ghost 2 ends a record with 2 pulls open |
| P9 | rule | `nocnv`: cnv.1 plans no convert at the omnibus | 1,000 | 112 | 3,148 |  | `dep(c=0,a=10) ; leg(i=0,o=refund,fee=0) ; tick(n=2) ; leg(i=0,o=land,fee=0)` → omni:sol stranded at anchors 1-2 |
| P10 | rule | `hol`: the re-quote stops at the first waiting payout it cannot pay | 57 | 0 | 0 | P3 568 | `wd(a=401) ; wind ; wd(a=20) ; wd(a=20) ; callE(a=40) ; tick(n=1) ; sell(g=0,full=false,wrap=false,p=20)` → anchor 1: waits 1 and 2 (20 + 20) starve under Available 40 |
| P10 | pre-fix | `m135`: M135's all-at-once re-quote | 65 | 0 | 2 | P3 455 | `wind ; wd(a=20) ; wd(a=187) ; wd(a=94) ; leg(i=1,o=land,fee=0) ; tick(n=2,m=0) ; down` → anchor 2: waits 0 and 1 (20 + 187) starve under Available 300 |
| P11 | rule | `noreland8`: a revert re-landed as a fill does not run ghost.8 (G stays BUSY) | 7 | 62 | 0 |  | `buy(g=0) ; leg(i=0,o=failed,fee=0) ; leg(i=0,o=reorg,fee=0) ; leg(i=0,o=land,fee=0) ; tick(n=1)` → P11 t=0: ghost 0 is BUSY with 2 token lots on it |
| P11 | pre-fix | `sealed`: tx.final on Base and Robinhood at 1 anchor (the papers at f645c4a) | 2 | 4 | 7 | NF 292, P4 30, P6a 67 | `buy(g=0) ; xk(g=0) ; sell(g=4,full=true,wrap=false,p=20) ; wd(a=20) ; sell(g=11,full=false,wrap=false,p=20) ; dep(c=0,a=5) ; wd(a=20) ; tick(n=15) ; dep(c=0,a=5) ; buy(g=0) ; dep(c=0,a=5) ; leg(i=10,o=land,fee=0) ; wd(a=20) ; exp(g=0,full=false) ; tick(n=10) ; leg(i=13,o=reorg,fee=0) ; tick(n=3) ; leg(i=13,o=dead,fee=0) ; leg(i=0,o=land,fee=0)` → P11 t=28: ghost 8 is RETURNING with 2 token lots on it |
| P11 | pre-fix | no `endbuy`: ghost.9 at the revert, no row for the mirror (the papers at f4a5676) | 7 | 77 | 0 | P2 2 | `buy(g=0) ; leg(i=0,o=failed,fee=0) ; leg(i=0,o=reorg,fee=0) ; leg(i=0,o=land,fee=0) ; tick(n=1)` → P11 t=0: ghost 0 is RETURNING with 2 token lots on it |
| P11 | pre-fix | no `endfinal`: ghost.12 at the emptying landing (the papers at 2fb7299) | 11 | 32 | 1 | P2 1 | `sell(g=0,full=true,wrap=false,p=20) ; tick(n=3) ; leg(i=0,o=land,fee=0) ; leg(i=0,o=reorg,fee=0) ; leg(i=0,o=dead,fee=0) ; leg(i=0,o=land,fee=0)` → P11 t=3: ghost 2 is RETURNING with 2 token lots on it |
| P11 | rule | `nosellpull`: a partial sell's, fire's or export's end opens no pull (ret.1) | 433 | 802 | 241 |  | `sell(g=0,full=false,wrap=false,p=20) ; leg(i=0,o=land,fee=0) ; tick(n=2) ; leg(i=0,o=land,fee=0)` → P11 t=2: ghost 2 ends POSITION with pullable 20 (20.00 ≥ X8), every tx on it final and no pull open |
| P11 | pre-fix | no `refinal`: no ret.1 when a reorged tx on G is final again (the model until M147) | 0 | 0 | 0 |  | not found by the fuzz; its sure catch is relandPull (below) |
| P12 | rule | `payres`: Reserved leaves out the owner payout | 5 | 0 | 83 |  | `call ; leg(i=0,o=success,fee=0) ; tick(n=1) ; image ; sweep ; wind ; xk(g=0)` → P12 t=1: omni USDC: open legs pay 18800 + u 20400 > balance 20400: a W, F or u that lands last finds it short |
| P12 | pre-fix | no `boundf`: the payout bound keeps open F and `u` | 4 | 0 | 136 |  | `sell(g=0,full=false,wrap=false,p=20) ; wd(a=20) ; call ; image ; wind ; leg(i=2,o=success,fee=0) ; tick(n=1) ; sweep ; leg(i=0,o=land,fee=0)` → P12 t=1: omni USDC: open legs W 20 + u 380 + u 20000 + pay 18800 > balance 20400: a W, F or u that lands last finds it short |
| P12 | rule | `refillbal`: refill.2 reads the omnibus's USDC balance, not its Available | 0 | 0 | 1,056 |  | `RIF_STATE ; refill(c=0) ; refill(c=0) ; wd(a=20)` → P12 t=28: omni USDC: open legs F 300 + F 300 > balance 400: a W, F or u that lands last finds it short |
| P12 | pre-fix | no `refillcash`: refill.2 as written before M145 | 0 | 0 | 302 |  | `RIF_STATE ; wd(a=101) ; refill(c=0) ; tick(n=1)` → P12 t=28: omni USDC: open legs W 101 + F 300 > balance 400: a W, F or u that lands last finds it short |

- **28 of 29 fuzz rows are caught**, and every fixed case and both oracle rows behave as they must. The one row the
  fuzz does not find is the pre-fix no-`refinal` row, as in CO's seed-777 run (round 6 at seed 20261021: focus 1 of
  100,000). **Its sure catch is relandPull**, which fails P11 without `refinal` in every run (below).
- Against CO's seed-777 run no row changed status. Against round 6's own run (seed 20261021, 100,000) only no-`refinal`
  did, from 1 focus hit to none, which is the seed. The rule rows still fail each of P1, P2, P3, P4, P6a, P6c, NF, P7,
  P8, P9, P10, P11 and P12: **13 of 15 checks can fail under the set**. P5 and P6b fail only under pre-fix rows (P6b's
  row: 0 main, 5 focus, 2 RIF).
- The regressions replay as in round 6: stream, case1, bound, lateSell, lateBuy, refill, basePage, hoodFull (twice),
  nearDead, relandOwe, retReorg, relandPull ("P11 t=7: ghost 2 ends POSITION with pullable 100"), r14Base (anchor 8),
  r14Hood (31; 24 without `x24long`), pullReorg (anchor 4; under `nospend` an over-count at 3, On the way 500), and the
  oracle rows (P2 fails under the fate oracle at 33, passes under the old one).

### Simplifications after round 7

- 30 and 31 are gone (reading 18; item 1 above). Item 24's bullet for G's coming pull is resolved (item 2 above).
- No new simplification.

## How the oracle judges "short"

The enclave cannot know a leg's fate, but the model can. P2's oracle is worded as the code reads it (M147 (1)): a page
is false when, at that read, Available plus the money On the way that really reaches the paying account by each
waiting payout's own start + X24 covers every waiting payout, oldest first. Since M151 (`fateoracle`, in the set) that
money is:
- Available USDC at the paying account;
- every leg On the way from its send at that read, by its own arrival;
- every landed record's money, by its fate. A ghost holds it at that read when a T or B on it has landed and its record
  has not ended, or the pull or full return that record's end opened is not yet broadcast. It counts what that ghost's
  later pulls and full returns (those not On the way at the read) deliver to the paying account by the payout's
  deadline, at most what the ghost held at the read: its pullable, or its native plus wrapped native when a full return
  carries it, each less its own pulls and full returns signed and not landed (On the way already).

The rule under test (which legs the alarm counts, and from when) no longer enters the oracle. R14 (finding 1) showed why:
the old oracle credited only the rule's own On the way set, so a coming leg the rule forgot was forgotten by the oracle
too. The old oracle runs without `fateoracle` and in mutants.ts's oracle rows (see "M151"). Its money is:
- Available USDC at the paying account;
- the legs On the way at that read (M147's set as CO corrected and extended it: a leg from its send, and a coming
  record-end pull or full return from its record's landing, whatever `landpull` and `pullonly` say) whose USDC really
  reaches that account by that payout's deadline. Their fate takes the place of the alarm's X24 exit. A coming full
  return stands as its full sell's, export's or reverted buy's tx until the record's end opens it, and its fate is that
  of the full return that end opened. Under `gpull` G's coming pull's fate is G's next pull not On the way at the read.

Payouts are paid oldest first, so the i-th one needs the first i amounts by its own deadline. A payout still waiting
past its own deadline is never covered.

A leg is valued at the lower of what it delivered and its value at that read (its `amountIn`; under the old oracle a
coming leg's read at its record's landing, a pull's pullable, a full return's native + wrapped native; under the fate
oracle a ghost's money at most what it held at the read; each at that read's price), so a later price rise never covers
a payout in hindsight. No leg chain and no alarm clock enters the oracle.

The oracle is not each payout's fate alone, which 07 PR-04 and M140 (3) said before M147. R13's p2fate.ts judged P2 that
way and failed 408 of 100,000 sequences (8 once owner calls and deposits were left out), every shrunk case an artefact of
that oracle: money no leg of ours was carrying (an owner call, a user's deposit) or a W that never executed paid the
wait in time.

Until M140, a leg counted only until X24 after the earlier of its money's first send and the oldest waiting payout's
start. That was the alarm's own clock under `perwait`, so P2 could not see R11's false page (R11 finding 2).
- P1 (since M138) judges each payout by its own fate. A payout still waiting at two reads at or after its start + X24
  needs a `funds_wait` open at the second read. Both reads must be at the same paying account, with 1Click up. Until
  M143 an owner call in flight also exempted the read; M143 (7) drops that. A boot releases every wait (wdr.12, far.19;
  M133 (a)). Before M138, P1 needed a `funds_wait`
  within X24 + 2 anchors of the first short anchor of a waiting period.
- P2 allows a `funds_wait` to stay open over at most 2 anchors while the read is covered. This leaves room for the
  moved leg of M135 (2).

## Readings picked (where the text is ambiguous, the reading safest for money)

1. **Time.** Anchors are integer times (X9 = 30 s), and events fall between them. X24 = 20 anchors (10 min), or 32
   under `x24long` (16 min: M151 (4) as CO corrected it). The pending period is 2 completed anchors, and every anchor
   counts (06a v1.40 l. 1595-1598, M135 (2)). X7 = X8 = $0.10 on every chain (04 X7, X8; Solana's lamport floor folded
   in). G's floor is one number for X23 + chainReserve + locked rent (ret.1, v1.40 l. 1219; §4.18 item 3, l. 1701).
2. **Moved legs.** A leg that moves to `SUCCESS` between an anchor's two status reads lands after the balance read. It
   counts 0 On the way and in B, so the gap reads high for that anchor (M135 (2)). This is the worst order for B.
3. **A reorg.** A landed ghost tx gone in a reorg is live again and can land again (signer rule 2, 06a v1.40 l. 956,
   says it is never retried on that record, not that it is gone). The leg stays On the way: the leave list (l.
   1518-1521: arrival, `dead`, INCIDENT, close, cancel (ret.13), X24; for a coming record-end leg also its record's end
   with no leg, l. 1539-1541) does not name a reorg, and both passages now say so ("A reorg does not end it").
4. **Reserved** is read from the log (M136 (d)): W, W', F, K, K', `u`, `s` and an owner payout, each before its source
   debit. A leg or payout that reads Available for itself leaves itself out. A payout in WAITING_FUNDS holds nothing
   (M136 (b), NE). far.20's first `u` is set by Available (NE).
5. **Re-quote at each anchor**: oldest wait first, one at a time, each reading Available after the previous one's quote
   (M136 (c)), wdr.5 at the omnibus and far.13's pay order at E. While 1Click is down a waiting payout stays waiting.
   wdr.4's "1Click down → RELEASED" is read as the first attempt only, which keeps the wait in the alarm.
6. **The owner payout bound** uses the whole omnibus USDC (M136 (e)), less L, D and every open F and `u` (§4.18, 06a
   v1.40 l. 1708). pay.3 reads it again live in the log step that signs (omnibus USDC by one balance read, L, D and the
   open F and `u` from the log; l. 1734, M137 (2), M138 (4)), and every set since M137 runs that as `live`. Only the
   pre-fix row without `live` signs from the latest anchor's values, which is failure 2 and P5's regression.
7. **Normal-mode K at far.20.** A K planned at the omnibus before far.20 runs on: its cnv.* rows still apply, and
   wind-down only stops new omnibus converts (cnv.1, 06a v1.40 l. 1648). Its Reserved keeps far.21 from sending the
   same funds.
   cnv.6 re-plans are sent at the next anchor (its backoff).
8. **No trade is atomic** (since M151's round 6). Every sell's, fire's and export's tx, partial or full, and every buy's
   tx lands, can be reorged (sell.12) until it is `tx.final`, can re-land and can go `dead`, and its record ends at
   `tx.final` or `dead`. Until M151 partial sells, fires and partial exports were one step each, landed and final at
   once; the emptying tx of a full sell or export (since M138) and every buy's tx (since M140) were not. Pulls and full
   returns carry live txs, unwraps (EVM, NEAR; never Solana, MN M102), dead verdicts, reorgs and re-lands. Chain data:
   - dead verdict after Solana 3, Base 5, Robinhood 28 and NEAR 1 anchors (Base 2 and Robinhood 20 until M143);
   - a landed tx is `tx.final`, and can no longer be reorged, after Solana 1, Base 5, Robinhood 28 and NEAR 1 anchors
     (1 on every chain until M143), and xk.2 refuses while one is not final;
   - on Base and Robinhood a later tx on G's key cannot land before an earlier reorged one (nonce order); Solana has
     no nonce. NEAR takes any higher nonce (nearcore `verify_nonce`), so a later tx lands while an earlier one is
     reorged, and a tx whose nonce the key has passed never lands (M147 (2); until M147 NEAR was read like Base);
   - a ghost leg's tx can be reorged after 1Click's `SUCCESS` or `REFUNDED` until it is `tx.final` (M147 (4); until
     M147 an arrival ended its reorg window).
9. **P3 "waits end".** No wait outlives a boot's first anchor. No wait sits at a completed anchor (1Click up) with
   Available USDC covering it.
10. **P6 "one signer".** Per ghost, the owners are a full return not yet ended, plus every pull with a live tx: its
    unwrap, its transfer before landing, or a landed tx that was reorged and is not yet `dead`. Per payout record, one
    key signs: the omnibus key before far.20's re-type, the exit key after, never both.
11. **P8 "exactly one pull"** means exactly one pull is open on G after the end, counted as ret.1 counts an op on G
    (`pullOp`, shared with `openOp`): a pull whose tx has not landed, and a pull whose landed tx is gone in a reorg
    until that tx ends, `tx.final` again or A4 `dead`, even when it has landed again (M158 (4), since round 7). A landed
    pull that no reorg touched is not open.
12. **P9.** A convert or `u` counts as planned while it is PLANNED. One already submitted is in Reserved, so it is
    already out of Available.
13. **Fees.** 1Click delivers `amountIn` × (1 − 0-4%) (the return's 4% loss guard). The gap counts `amountIn` at the
    anchor's 1Click price, as the text says.
14. **The return image** is modelled only as far as P5 and P12 need: refills stop, WARM ghosts go home by ghost.18,
    and the daily sweep (pay.1-pay.4) may run at any time after the image starts, in wind-down too (pay.1 says "Return
    image only", and far.20 does not stop it).
15. **Buys** (M140). P's notes for a buy are held when it is sent. The fill keeps them, and a revert gives them back
    (fees are 0 in the model). A buy that never lands gives them back too: buy.16 sends a Solana G back to WARM, and
    buy.17 sends G home on the other chains. buy.24 gives a reorged buy's debit back to P.
    - A fill re-landed after a settled revert leaves L unchanged: the fill's debit less buy.15's fee (0 here) is
      recorded against P, netted from P's next sell on G (SEL-11) or taken by xk.3's debit; what no sell covers the
      pool carries (M147 (3), buy.25). Until M147 the model debited P's notes again, lowering L (R13 finding 3).
    - A fork that drops a filled buy also drops a landed emptying tx that spent its tokens, because those tokens came
      from the buy.
    - A revert that is reorged and then goes `dead` leaves G BUSY. The model sends it home (ghost.9); M140's text has
      no row for it (see "M140").
16. **The payout ledger** (P6c, P7). At a refund the user gets the notes back, and the model counts that as receiving
    the payout's value. So a W that is refunded and then also succeeds counts as received twice.
17. **G's coming pull less a reorged tx** (`gpull`, M151 (1)): resolved by M158 (3) in round 7. G's pullable is read
    again at each landing and at each reorg of a tx on G (`reread`), so a pull, full return or buy whose landed tx is
    gone in a reorg comes off the read once: the read after its reorg holds its amount, and the subtraction takes it.
    Until round 7 the read was only at landings, and when the reorged tx's own landing was the latest read, its spend
    came off twice (the count read low).
18. **A record's end that a reorged pull blocks** (M158 (2), simplification 30 until round 7). A pull on G whose landed
    tx is gone in a reorg is an op on G until that tx ends, so a record's end then opens no pull, and G's coming pull
    leaves the count at that end until the pull is `tx.final` again or A4 `dead` and ret.1 runs again (ret.13 (d),
    ret.14). M151 (1)'s list of why an end opens no pull now names this case. The count reads low there, so the alarm
    can page sooner, never later. pullReorg passes through it (see "Round 7").
