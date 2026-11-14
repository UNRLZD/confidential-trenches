# G1 proof 4: exits signed in advance (DRAFT)

Card g1-presigned-exits. Paper rows: TN-02, SB-01, WM-04 and §2.6 in docs/plan1/wallet.md at e0fc533 (:540-575,
:744, :814-822), facts F17-F22 (:1097-1102); markets T2 in docs/plan1/markets.md at db751d2 (:2109), pass line
`twin-sol: one landed, twin BlockhashNotFound`.

## W1: Solana devnet (passed 2026-10-31 10:10:17Z at b1fb9f7)

**Pass line for this leg:** a sell signed in advance fires later from a sender that holds no key; its twin on the
same durable nonce is refused by preflight (BlockhashNotFound) and, sent with skipPreflight, has a null status on both
RPCs 150+ slots after the nonce advanced, with W's lamports unchanged; every tx read back on two devnet RPCs.

**Result: passed.** Run `runs/2026-10-31T10-10-17-757Z.json` (code b1fb9f7, tree cf67ea2, clean), 10:10:17-10:13:51Z, rc 0,
`twin-sol: one landed, twin BlockhashNotFound` with every verdict term true:
- **RPCs:** api.devnet.solana.com (Solana Foundation) and https://solana-devnet.api.onfinality.io/public (OnFinality,
  its own nodes). Tatum's anonymous gateway was replaced at b1fb9f7 after it fell to 5 requests a minute.
- **Funding:** F mtVR7N9JKAiCes3GhdEU5cVfNGL5NwTygGS371ByZ7e paid W 8JXsWp5vFPn7bcfvE6g6yfG7t5MxfqrHMUaV73uikf7p
  (m/44'/501'/0'/0' of the run's throwaway code) 200,000,000 lamports:
  KrkYwZe7qt3AuuBuaoFkEsKdmPKEeSGah91yhvPGMaoFtjks8dMmz6uaKiEwpYLCQNNFDPxmF2T4v287U5Yp2dy, slot 517100135.
- **Device and sender:** setup made the mints, token accounts, pool and nonce account
  F1kbcvUpSRcDcdnyN15mFC78Yh7sQN943ovikpYXihne (account 2 of the code), simulated both exits unsigned, then signed
  them. After M moved the price, the sender (no key) sent the TP
  4kLwTmqVWTkrcKiWmbFzPRU1pKWmAdosNWHDGgKuo2RWD4jdKjBso4SUZXp3hB7pE7qM8aHqh1RpGb4Uqeys4jde: slot 517100350, fee 5206.
- **The twin:** the SL 381VPAY2a361SCapzfaoATuo9UFhnM4VMfmzp8wvjk3JTGx1DFUFDqXCr4QK1G7CoEJ5pYRHeXsLGm6oUhTyvP7C was refused
  at preflight with `Blockhash not found` (slot 517100383). Sent with skipPreflight (slot 517100385), it has no status
  and no transaction on either RPC, and it paid no fee.
- **F's accounting:** F 200,005,000 before, 191,416,354 after: spent 8,588,646 = fees 115,206 (17 landed txs,
  meta.fee the same on both RPCs) + named rent 8,473,440 (sell, buy and pool mints 1,066,800 each, swap account
  2,296,160, two pool reserves 1,488,440 each, the orchestrator's own reads capped at each account's rent).
  Unexplained: 0. W, M and the nonce account end at 0; the run's words file was removed.
- **Read back:** the lead re-read all 17 txs at finalized on both RPCs at 10:16Z (slot, fee and err the same on both
  and as recorded), the twin's null status and transaction, and the balances. The team lead re-read the same at 10:19Z.
- **OnFinality's day budget** (its x-ratelimit-remaining-day header): 994 at 10:10:10Z, 882 at 10:16:14Z.

Two runs earlier that day stopped before setup and are kept as they were:
- `runs/2026-10-31T09-10-48-468Z.json` (code 2b95b52): the funding landed (5vSRwt..., slot 517085193), but Tatum
  answered its read back with HTTP 429 until call() gave up, and readBack took that one error as final. The sweep
  returned W to F (5T7FPk...). F was short exactly the two 5,000-lamport fees; the run counted only one, so 5,000
  showed as unexplained. Fixed at f77b9fb (a thrown read is retried until the timeout; a fee is taken from every RPC
  that has one), with R429 and F1-F3 red before and green after.
- `runs/2026-10-31T09-33-50-115Z.json` (code 1e91a59): the funding tx 46jh8e... was sent once and dropped; it never
  landed (no status, blockhash long expired). F stayed whole (unexplained 0). Fixed at 2d15fcd (the same signed bytes
  are sent again while the tx has no status, and "expired" is read from the block height), with RB1, RB2 and X5b red
  before and green after.

Two test faults found on 2026-10-31 by the hand-off box job, both in tests, neither in the code:
- `base/lock.test.mjs` BL1 and BL2 failed on the box: the test put its scratch HOME under `tmpdir()`, which is /tmp
  there, and gave its child no TMPDIR, so the secret folder's temp-folder refusal fired before the lock check. The
  child now gets a TMPDIR beside its HOME (0c6b8b1); red with `TMPDIR=/tmp` on the Mac, green with it and without.
- The order of the two refusals (card g1pe-tmp-refusal): the temp-folder refusal runs first, the lock check after,
  because a secret folder under a temp folder is never safe, whatever the lock says (takeRunLock checks the folder
  before it reads a lock; secret-dir.mjs states it). The split between the machines was the temp set, not the order:
  with tmpdir() alone, a HOME under /tmp passed on the Mac (TMPDIR is /var/folders/...), so the lock's message won
  there. The secret folder now refuses tmpdir(), /tmp, /var/tmp and /usr/tmp alike. S4b, base BL3 and Solana L4 plant both
  conditions: red before, green after. The tests' scratch HOMEs moved out of every temp folder (scratch-root.mjs).
- `rescue.test.mjs` W2/W2b failed now and then (once on the Mac, once on the box): a test false alarm. Its check that a
  refusal never quotes the words counted any single word of the run's random code, and "file", "above", "regular",
  "over" and "hold" are BIP-39 words that the refusals' own text uses. The check now follows the product's rule (the
  whole code, or three of its words in a row) with W0 pinning both cases (3668d01); red with a fixed code holding
  "above", green with it and at random.

Gaps in the mutant lists, found the same day:
- Eight find texts were stale after round 2's own changes (the v1/v2 words-file fields and chain check, keepWords
  passing chain, and the slot check copied into ownRent), so those mutants could never run: Solana RS6, RS7, RS25,
  AC9 and AC10, and Base H1, H23 and H24. Base H1 came back BAD in the hand-off box job. All eight now match their
  current code (2f31543). New SH10 checks that every find of both lists is in its target exactly once: red at 544545e,
  naming the eight, and green after.
- ownRent's minContextSlot check had no test and no mutant. A14 (5bfcc76) has each mint answered first from before
  the sweep's last slot, as a 165-byte account. With the check removed the run names 1733040 lamports of rent it does
  not hold (rc 1). With it, every mint is counted at its 82-byte rent and unexplained is 0. Mutant AC13 drops the check.
- Base CS1 (the orchestrator skips its code check) came back TIMEOUT, not red. With the check gone, the run goes on
  against an RPC nothing listens on. At code.test's 30 s limit it gets SIGTERM, which it handles by trying to sweep,
  and spawnSync waits for it to exit. code.test, nokey.test and shard.test SH8 now stop a timed-out child with SIGKILL.
  Run alone on the Mac with CS1's cut applied by hand, code.test now goes red in 151 s (C1-C5 fail). Green at the tip.
- Base DL1 survived: it is equivalent under an honest device. It checks W's dust against the device's reported bound
  instead of the run's own limit. device.mjs refuses any bound over the --max-bound the orchestrator gives it (DL4,
  red by H13), and a W it never names gets bound 0 under the mutant, so every bound the orchestrator sees is at most
  the limit. The mutant can only be as strict or stricter. The two differ only if device.mjs ignores its own limit.
  The orchestrator reads the device's answer only from the stdout of a child it starts from its own clean,
  committed folder, so no recorded answer can be planted without editing device.mjs. The orchestrator's own check
  stays as defence against a broken device.

Before that, on 2026-10-26: run `runs/2026-10-26T04-19-38-272Z.json` stopped at the devnet airdrop to W, before any
transaction: `requestAirdrop` on api.devnet.solana.com answered `-32603 Internal error` (2 SOL, 04:19:43Z), then
`HTTP 429` on five retries (1 SOL each, 04:20:00Z to 04:23:21Z). Per the brief no other faucet was used and no account
was created anywhere. Nothing was signed or sent on any chain.

Later runs, still before any transaction:
- `runs/2026-10-26T04-28-50-736Z.json` stopped on a bug in its own wait loop (`BALANCE_EVERY_MS is not defined`),
  fixed since.
- The next run's W (4NKxtTYF…) was funded 1 SOL by hand at 08:45Z, but the run could not see it. Tatum's devnet gateway refuses
  `getBalance` on the anonymous plan (-16401), so W's balance read failed. Its words lived only in its memory, so that
  1 SOL on 4NKxtTYF… is stranded. W's lamports are now read with `getAccountInfo` on both providers.
- The run from 09:02Z, on the code before W8's fixes, was never funded. It was stopped at 12:00Z, and its W
  4MG1KPWZjw8RKJ6dSk3FfmhropDVQzbP95rNs9R85z3h is retired.
- `runs/2026-10-26T12-00-43-092Z.json` (code 1080f77): W Fw2anY2ik4CApPfsKk3VhNT2KW2fq2xzYApQqno7qUzG got 5 SOL
  from faucet.solana.com and the run saw it on both providers after 307 s. Setup landed the mints, token accounts,
  pool and nonce account. At signing, both exits simulated `{InstructionError:[2,{Custom:24}]}` ("The provided token
  program does not match the token program expected by the swap"), so the device refused to sign and nothing was
  sent with the exits. Devnet's SwapsVeCi… is an older build: its Swap takes 10 accounts, with the token program at
  index 9, not 8e0ed0a's 14. A keyless simulation against that run's pool (sigVerify off, 12:08Z) gave Custom 24 for
  14 accounts, success for 10, and Custom 16 (ExceededSlippage) for 10 accounts with a min out the pool cannot pay.
  Fw2an… still holds 4931484280 lamports (getAccountInfo, finalized, slot 515327443, 12:13Z). Its words died with its
  run, as designed, so that test coin is stranded.

<!-- numbers:begin -->
Not generated this round: the Solana mutants list (346) was not run whole, so results.mjs has no whole-list output to
generate this block from (card g1pe-mutants-full). The round-2 mutant ids run on 2026-10-31 and each one's result are
listed below. The hand-typed numbers further down are stale until then.
<!-- numbers:end -->

The hand-off box job g1pe-handoff (code b2ee59d, <build box>, 10:22:48-11:27:43Z, heavy rc 0):
- Suite: 377 tests, 375 pass, 2 fail (base BL1 and BL2: the lock test's TMPDIR, fixed 0c6b8b1).
- Solana tier 1, 32 ids, all red (32 expected red, 0 not as expected): Q6 Q7 Q8 Q9 Q10 Q11 Q12 LK1 LK2 LK3 LK4 LK5
  CH1 CH2 NR1 NR2 AC7 SG1 FO1 FO2 PA1 PA2 LG1 LG2 SH1 SO1 SM1 SM2 SM3 SM4 SM5 SM6.
- Base, the whole list of 98: 93 red, plus five that were not.
  - H1, H23 and H24: stale find texts, fixed at 2f31543, re-run in g1pe-tip.
  - CS1: TIMEOUT, its root cause fixed at 35031bd, re-run in g1pe-tip.
  - DL1: survived, equivalent under an honest device (above).
- Solana tier 2, not reached: the job was stopped while tier 2 ran its baseline (11:27:36Z, the team lead's call), so no tier-2 mutant
  ran. All 84 go to card g1pe-mutants-full: AC1 AC2 AC3 AC4 AC5 AC6 AC8 AC9 AC10 AC11 AC12 AF1 AF2 BL1 BL2 BL3 BL4
  BL5 BL6 BL7 CL1 CL2 CL3 CL4 CL5 CL6 CL7 CS1 CS2 CS3 CS4 CS5 CS6 CS7 CS8 DV1 DV2 FN9 FN10 FN11 LJ10 LJ11 LJ12 LJ13
  LJ14 LJ15 LJ16 NC1 NM1 RS23 RS23b RS24 RS24b RS25 RS26 RZ1 RZ2 RZ3 RZ4 RZ5 RZ6 RZ7 RZ8 RZ9 RZ10 RZ11 RZ12 RZ13 RZ14
  SD1 SD2 SD3 SD4 SD5 SD6 SD7 SD8 TK1 TK2 TK3 TK4 TK5 TK6 TK7. AC13, new at 5bfcc76, runs in g1pe-tip.

Card g1pe-mutants-full (2026-10-31), the tier-2 ids on the box, one job at a time:
- Box job g1pe-mutants-a (code 663c23f, <build box>, 15:22:54-16:10:04Z, heavy rc 0): the 13 leftover scratch folders
  in ~/.cache/g1pe-tests (g1pe-tmp-refusal's stopped job, 14:54-14:55Z) removed, 0 after; suite 384 tests, 384 pass;
  mutants baseline green. With another job on the box (load 4) a mutant took about 2 min, not 48 s, so the run hit its
  45-min limit (rc 124) after 23 of its 42 ids. Red (22): FN9 FN10 FN11 LJ10 LJ11 CS1 CS2 CS3 CS4 CS5 CS6 CS7 CS8 BL1
  BL2 BL3 BL4 BL5 BL7 DV1 DV2 CL1. Survived (1): BL6.
- BL6 (runEnv drops the env mark) survived because SH9 read runEnv() inside the run, where the outer run's own mark is
  already in process.env. SH9 now reads it with the mark taken out (a93c4d1): with BL6's cut in a marked copy, SH9
  passes at 663c23f and fails at a93c4d1. BL6's re-run on the box is still to come.
- SH10 steps aside inside a mutants run (SH6's marker check), since a cut removes its own find text; SH11 shows it:
  red at 454d8ad (R01 found 0 times), green at 663c23f. SH10 still runs in every plain suite run.
- Not run yet (61): AC1-AC6, AC8-AC12, AF1, AF2, CL2-CL7, TK1-TK7, NM1, NC1, LJ12-LJ16, RS23, RS23b, RS24, RS24b, RS25,
  RS26, RZ1-RZ14, SD1-SD8. Box job g1pe-mutants-b waited 30 min for a slot (3 slots in use) and was stopped at the due.
- The numbers block stays ungenerated: results.mjs counts only the whole list at one code state (a run of ids never
  counts, RZ9), and the list is 354 by the run's own header.

**What is ready and proven offline** (`node --test`, 189/189 at 64fdf77 for the whole folder including `base/`):
- `pair.mjs` builds the TP/SL twins and refuses any pair that breaks the rules: ix 0 AdvanceNonceAccount (data
  `04000000`) on a writable nonce account with W signing (F17, F19); recent blockhash = the stored nonce (F18); both
  twins on the same nonce account and value; only W signs and pays; exactly 3 instructions (nonce, compute-unit
  price, swap); the swap program is SPL Token Swap and every swap account is the pool's; the output is W's own token
  account; `min_out = amount x trigger x (1 - slippage)` rounded up, so a fill is never under the user's price minus
  the user's own slippage (§2.6, wallet.md :545-547).
  Each of 53 refusals has its own test and goes red on its own under mutation (`pair.refusals.test.mjs`,
  `mutants.mjs`: 134 mutants, 127 red, 7 survivors each covered by another check or unreachable from the signed bytes);
  bad inputs never build; a changed byte after signing is refused; the pair file is parsed as hostile input (size
  bound, exact fields, full re-check of the signed bytes).
- `orchestrator.mjs` makes the throwaway 12-word code in memory, passes it to `device.mjs` on a stdin pipe only (child
  env is PATH alone, argv carries no secret), checks that each child exited, checks the pair file and every output for
  every encoding of the code, seed and keys, and runs gitleaks on the pair file before the sender reads it.
- `sender.mjs` gets no seed and makes no key: it watches the pool price, simulates both exits, sends the due one, then
  the twin with and without preflight, waits 150+ finalized slots on both RPCs, and reads the twin's status, W's
  lamports and the nonce on both. Its twin verdict needs the preflight refusal in BlockhashNotFound words with no
  signature back, a null status and no transaction on both RPCs, and W's lamports present and unchanged.
- `device.mjs` refuses to sign when a trigger is already met at signing. It writes no pair unless, at signing, the TP
  fails only on its min out (`{InstructionError:[2,{Custom:16}]}`, SPL Token Swap's ExceededSlippage) and the SL
  passes. The run exits 0 and prints the T2 pass line only when every verdict term is true. These checks are proven
  offline only: the 09:02Z run uses the code from before them, and its record is checked by hand against the same
  terms.

**Live reads that did succeed (2026-10-26T04:19:38Z, in the run record):**

| Read | Solana Foundation (api.devnet.solana.com) | Tatum (solana-devnet.gateway.tatum.io) |
|---|---|---|
| getGenesisHash | EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG (devnet) | same |
| getVersion | solana-core 4.4.0-beta.1, feature-set 3993424257 | solana-core 4.4.0-beta.0, feature-set 1855282951 |
| SPL Token Swap SwapsVeCiPHMUAtzQWZw7RjsKjgCjhwU55QGu4U1Szw | executable, owner BPFLoaderUpgradeab1e | executable, owner BPFLoaderUpgradeab1e |

The program's programdata (44Kn5tKxjrBHCwkTbvtvZVSUDYRLCTNnBJja2V1pmbXE, 403,165 bytes, last deployed at devnet slot
139567548) holds no production fee-owner key string, so a zero-fee test pool should initialize; the device simulates
both signed exits before it writes the pair file, which would catch a wrong account layout.

**The second keyless provider, from its own docs** (fetched 2026-10-26T04:22-04:23Z):
- https://docs.tatum.io/reference/rpc-solana, line 301 of the served HTML:
  `<p>Base URL: <code>https://solana-devnet.gateway.tatum.io</code></p>` (also :145 in the endpoint grid).
- https://docs.tatum.io/docs/gateway-limits, line 269: the `### Solana` method table has an `Anonymous` column next
  to Free, PayGo and Business.
- https://docs.tatum.io/changelog/anonymous-and-free-api-key-limits, line 92: `Anonymous users are limited to 10,000
  credits per month`.
- Live: it answered with no key and the header `x-ttm-plan: anonymous`.

Other providers tried on 2026-10-26: dRPC (`chain is not available on free plan`), Ankr (`must authenticate ... API
key`), Helius (401), Alchemy demo (429), PublicNode (404), OnFinality public (genesis ok, then `-32029 Too Many
Requests`). devnet.rpcpool.com returned the same rate-limit headers as api.devnet.solana.com, so it is not counted as
a second provider.

**Not covered by this leg:** a twin that lands and fails on execution still uses the nonce and pays the fee (F20,
SB-01's second half). It needs its own pair and was not in the W1 brief.

**Partial take-profit: not modelled here.** The paper's default is a TP selling 50 % and an SL selling 100 %, plus a
stop for the other half on a second nonce account, signed at the start (wallet.md at e0fc533, §2.6 :584-587; WM-09
:749, 2,113,280 lamports of rent for the two accounts). This folder builds one pair on one nonce account, with both
twins selling the same amount, and `exits.mjs` refuses to classify twins that sell different amounts. TN-02 (:820)
reads "pre-signed exits fire later from the order sender with the app closed; the twin is refused", and it passes
"as SB-01, SB-02 on a public network". SB-01 (:814), the Solana row, has no remainder stop, so the Solana leg of
TN-02 does not need it. SB-02 (:815), "EVM twins at nonce N; N+1 remainder stop", does, so the Base Sepolia leg
does. For Solana the build must still add: the second nonce account and its rent; twins of different sizes; the
remainder stop, signed with the pair; and an open check over both nonces. If the TP filled, the remainder stop is
armed. If the SL filled, the remainder stop can never fill, so the device closes its nonce account instead of
letting a send fail and pay the fee (F20). Our reading, not in the paper: the sender must hold the remainder stop
until the pair's nonce has advanced. Otherwise, in a fall, the remainder stop can land first and leave the 100 % SL
short of tokens, and that SL then fails and burns the pair.

**Local copy of devnet: passed** (`runs/local/2026-10-26T15-46-35-972Z.json`, code 5d49e4c, 15:46-15:49Z on the build box,
`BUILD_QUEUE=1 scripts/the build queue local-proof4 -- ... node local-run.mjs`, local-run rc 0):
- **Validator:** solana-test-validator 4.3.2 at http://127.0.0.1:8899, genesis
  Hs6FLq8Gsm4uSbxUks97e3WYN5j9JiQpzmoiVgWnzQWk (not mainnet-beta's, testnet's or devnet's). It runs devnet's
  SwapsVeCi..., cloned: the programdata's program bytes have sha256 a86de91ddb85c872... (403,120 bytes) here and on
  api.devnet.solana.com.
- **Funding:** F got its shortfall from the local faucet (200,005,000 lamports). F paid W
  CtBnkquDV2JeKJY9QwPFEACBBfypvKauyMnmrxA5asMv 200,000,000 lamports
  (5ugnZtkZywZeSvquuWuc8PiRs6PgAXfUv2Dmtt8Pxu7EdNEGiSKfCzjGYNx3frJVkdaTsafja98CZH9EULNzUBse, slot 36).
- **Device and sender:** the device signed the TP/SL pair on nonce account 6QGuoUCeZ18hjNShdJqg8egTLKZwYXEMYBnAECN7CLu
  (account 2 of the run's code) and exited. The sender, holding no key, saw the price between the triggers and sent
  nothing. After M moved the price over the take-profit, it sent the TP
  4YTxwr7cUDhactMHSxzXV5aAiEWnvifQKRN5HN7CvvnGJoY1Pf4sDYMUQBZFH1UefXGG2FP1XHF9rD4pwJsebiUB (slot 121, fee 5206).
- **The twin:** the SL JJ4VCopYpW2MtMH9nwdakw8eKkdspw82m8njsoqmX5MA9wqimmNiBZuovrEjrC69Jt5Pj3DVWAvbYrx7sjTfDmG was refused
  at preflight with `Blockhash not found`. Sent with skipPreflight, it still had a null status at slot 343, and it paid
  no fee.
- **Verdict:** `twin-sol: one landed, twin BlockhashNotFound`, every term true.
- **Sweep and words:** the sweep returned the nonce account (1,447,680), M (49,990,000) and W (124,637,154) to F, each
  read back as landed. The run's words file was then removed (`wordsFile.kept: false`).
- **One RPC only:** each "on both RPCs" read here is on the one local RPC. That is what this row cannot show; the public
  devnet run below shows it.

**Funding:** every run is paid by the devnet funder F (`funder.mjs`), a devnet test key in a 0600 file outside every
repo. F pays each fresh W exactly NEED_LAMPORTS, and every exit path sweeps W, M and the nonce account back to F
(W11), so a run strands nothing. F's devnet address is mtVR7N9JKAiCes3GhdEU5cVfNGL5NwTygGS371ByZ7e.
1. Done: proof 4 on a local copy of devnet (above).
2. Done: the public devnet run, 2026-10-31 10:10:17Z at b1fb9f7 (the W1 result above).

**No run strands coin when its process dies (`rescue.mjs`).** Fw2an... lost its 4.93 SOL because its words lived only
in that run's memory. Now, before F's transfer to W is sent, the run's 12 words go to a 0600 file beside F's (same
folder checks as `funder.mjs`). The file is removed only once the sweep's txs landed on both RPCs. A failed sweep, a
crash or a kill -9 leaves the file, and the record and the last line name it. `node orchestrator.mjs --rescue`
(`--local` for the local copy) sweeps every kept file of its cluster back to F and removes it only once that sweep
landed. Every run does this first, before it funds. A file that fails a check, or a rescue that fails, stops the run
before F pays anything. The words still reach no output (`assertClean`, `run.rescue.test.mjs` R1-R9,
`rescue.test.mjs` W1-W3).

So the words alone find the nonce rent after a kill -9 during setup, W's nonce account here is account 2 of the run's
code (m/44'/501'/2'/0'). This is for this proof only: the product derives its wallets at hashed indices (wallet.md
:1536-1563), so index 2 cannot collide there.

## W5: Base Sepolia (TN-02's EVM half, SB-02 on a public network)

**Pass line:** markets T3 (db751d2 :2110), `twin-base: one landed, twin nonce too low`. The TP and SL are full
EIP-1559 transactions from W at nonce N, chain id 84532 bound, min out = amount x trigger x (1 - the user's slippage)
rounded up (wallet.md :545; 300 bps in this run), output to W (§2.6 EVM column). The remainder stop (REM) is at N+1 (SB-02, :815). Every tx is read back on two readers.

**Result: passed, four times on chain.** The newest record is `base/runs/2026-10-31T09-01-07-820Z.json` (round 2,
code 7c4bd1f, tree f2a8a5e, clean), 2026-10-31 09:01-09:02Z. It is the first run funded by the test funder FB
0x1a8373cF90e00cd08F81170b0d212592edee5859 (CDP faucet claims) and the first that sweeps back:
- FB sent W 0x29D87769769A975990Ec043De647749EcaC8985f (m/44'/60'/0'/0/0 of the run's throwaway code) 2000000000000000
  wei: 0xc4a67a9dc370d946cb67913f1689e5b97476ca769122fa7e4f717848288c14be, block 0x3224304, status 1 on both readers.
- TP 0x4525adf758e3bb30bcc3cd5f0f346917f8bd991af5ef5f1a6be2a5133cfee49d landed in block 0x32243b0 with status 1 at
  nonce 2, paying 6215255664591084257376 against a min out of 5820000000000000000000 on both readers.
- The SL twin 0x8d9bff04414cbc40732aafbf69836bf6b3accfdc6b881c0d04e5b31e22245fea was refused with `nonce too low:
  next nonce 3, tx nonce 2`. It is absent on every reader, W's nonce is past 2, and its bytes recover to W at nonce 2.
- REM 0x49329dac45a6dd5b0e17e87da2557f8a9bf83b3cabbbb1f7c107054c6373200a landed in block 0x3224424 with status 1 at
  nonce 3, paying 3932523483364598162834 against a min out of 3880000000000000000000.
- The sweep sent W's 1796443739998430 wei (0x7f9795789e3d1a44f40a0925be38a33ef1767d0645fd29548f66eba46ae72d13, nonce 4)
  and the mover 0x5808F8C43a5Bc7C7e9fc7441a62b2A0dF7E32949's 199214713999491 wei
  (0x436137e415ca030e9683766b2edf25cfba87e854c6fa4db27b295f7ba2d5265f, nonce 2) to FB, both status 1 on both readers.
  Each left 105000000239 wei, under the bound of 231000000329. The run's words file was then removed (`kept: false`).
- Readers: https://sepolia.base.org and https://base-sepolia-rpc.publicnode.com, chain 84532 on both.

The run before it, `base/runs/2026-10-26T09-39-23-235Z.json`, ran on the code after the outside read's fixes (W9,
merged at 6e6e79e), 09:39-09:41Z:
- TP 0xb341baefc412184bdda5b509c6e8d2bc47919c4120d3089dc77de5abd9173e38 landed in block 50428970 with status 1 at
  nonce 2. W was paid 6215255664591084257376 against a min out of 5820000000000000000000, the same on both readers.
- The SL twin 0xbc928fe5d58c649d4fa2a3bf6ff22d6a3685d5cb30570e26fafb153cfa85d676 was refused with `nonce too low:
  next nonce 3, tx nonce 2`. The orchestrator then read it itself on both readers: absent, W's nonce past 2, and its
  bytes recover to W at nonce 2.
- REM 0x3a4f3a3d120e6e104a09cb66c4fa085edd16f9a3a8b0f4c90589379a1514ae63 landed in block 50429059 with status 1 at
  nonce 3, paying 3932523483364598162834 against a min out of 3880000000000000000000.
- W was 0xe8324B4f0EA999dfC526Eb8FbA0AA089805B1b0B. The lead re-read TP, REM and the twin on both readers at 09:41Z.

The earlier pass `base/runs/2026-10-26T08-58-48-045Z.json` (code c87ddd9, 08:58-09:00Z) ran before the payout and
twin re-reads existed:
- W 0xD6083805C6Af23D8c31EA413bA8F210410B4BFf1 (m/44'/60'/0'/0/0 of a throwaway 12-word code held in memory)
  was funded by 20 CDP faucet claims of 0.0001 ETH. No wallet secret was used. Each claim counts only if W's
  balance rose by exactly 1e14 wei in the claim's block on both readers. The faucet pays through contract
  0x3e4ed2d6d6235f9d26707fd5d5af476fb9c91b0f, so `to` is not W.
- W deployed the test pool (base/contracts/TestPool.sol, solc 0.8.28; its code was checked against TestPool.json on
  both readers). W signed TP and SL at nonce 2 and REM at nonce 3, and the device exited.
- After the mover pushed the price to 1.25, the sender (no key) sent the TP:
  0x21a0326c14758bf77db178c06d432229132dfbb1396fa99769b61b2d56b7ff6f, block 50416796, status 1, nonce 2.
- The SL twin 0x76302202f95bdd1649d6a225c5ceab042e58356da2a18a3b08509b089bfe6205 was then refused with
  `nonce too low: next nonce 3, tx nonce 2` by sepolia-sequencer.base.org, sepolia.base.org and
  base-sepolia-rpc.publicnode.com. It is absent on both readers, and W's balance did not move.
- After the mover pushed the price to 0.79, the sender sent REM, which landed after N was used:
  0xbf6c35a687ef9ae3620949ca22746c2a767f39c645065e7ac7f07ba027ce4939, block 50416888, status 1, nonce 3.
- Readers: https://sepolia.base.org and https://base-sepolia-rpc.publicnode.com, both chain 84532. The lead re-read
  TP, REM and the twin on both at 09:01Z.

Run `base/runs/2026-10-26T08-49-23-879Z.json` (code 213e4d2, 08:49Z) did the same on chain: TP 0xc977..0b42, the
twin refused with the same words, and REM 0x6ec3..ad7. It still printed pass:false because of two bugs in its run
script. The funder's own verdict line was counted as a sender verdict, and the funder checked `to = W`. Both are
fixed in c87ddd9, each with a test that fails before the fix and passes after; the record is kept as it was.

**Offline (anvil, `base/`, 63 tests):**
- A twin at N is refused after the first lands.
- A twin sent out of range lands with status 0, uses N and pays gas, and the other twin is then refused.
- REM is held until N is used.
- Each tampered payload is refused with its own reason: chain id, nonce, to, recipient, min out, value, signed bytes.
- The sender's process loads no key code and gets no secret.

**Found:** anvil queues a REM sent before N is used, then mines it the moment N is used, with no trigger check. The
sender therefore never broadcasts N+1 early. Base Sepolia's sequencer was not tested for the same queueing.

## What a breach of the order sender can still do (outside read, 2026-10-26 ~09:10Z)

These are the paper's break-in row (a) (wallet.md at e0fc533 :778): "send an exit early, which fills at the user's
price or better into W" and "burn a pair by sending a twin out of range, at the cost of one fee". The proof bounds
them; it does not remove them.
- **Any signed exit can be sent at any time.** That covers a TP or SL early, and a remainder stop as soon as N is used.
  The chain checks only min out, so the fill is at or above trigger x (1 - slippage), into W. The trigger check and
  the nonce hold live only in the sender. On anvil, a remainder stop sent early was queued and then mined the moment N
  was used. An EVM exit never expires.
- **The triggers in the pair and orders files are not signed.** Only min out is inside the signature. Scale tp, sl
  and slippage so that min out comes out the same, and the changed file passes the file check and makes an honest
  sender fire early, with the same bound as above. For the build, the device should sign the file's metadata.
- **A twin sent out of range burns N.** On Solana, `exits.mjs` then finds the pair DEAD and the device re-signs it. On
  Base, the open check that would do the same is not built yet.
- **Harness exception:** here the orchestrator process makes the throwaway 12 words and passes them to the device
  process on stdin. In the product, only the device (SIGN_HOST) makes and holds them.

## Not run: RM-02 (real money)

RM-02 (wallet.md at e0fc533, :822) is not yet run and belongs to the build: a Solana exit signed in advance fires
later with the phone locked, the twin is refused, and the same on Base. It is an owner paste with real money.

## (d) Does a real Jupiter sell with a durable nonce fit one v0 transaction? (W3, DRAFT)

**Pass line:** a mainnet Jupiter BONK -> SOL sell, with System `AdvanceNonceAccount` as ix 0 (wallet.md §2.6 at
e0fc533, :540-575; F17-F19 at :1097-1099), compiled offline from captured replies into one v0 tx whose serialized length
with W's 64-byte signature is at most 1232 bytes (`PACKET_DATA_SIZE`, solana-sdk 067f44a `packet/src/lib.rs:42`,
`1280 - 40 - 8`).

**Result: it fits for every route captured up to $5,000 (705-1156 bytes, margin 76-527). The $50,000 sell on Jupiter's
default route does not fit (1283 bytes, 51 over).** The same $50,000 sell with `maxAccounts=40` fits (1003 bytes), but
that reply quoted 5.4 % less SOL. The refusal holds: `size/exit.mjs` refuses to hand over any exit over 1232 bytes.

**How (all in `size/`):**
- `capture.mjs` (read-only, run once 2026-10-26T04:42:15Z-04:42:51Z): Jupiter Swap API V2 `GET
  https://api.jup.ag/swap/v2/build`, keyless. It is the documented single call that replaces `/quote` +
  `/swap-instructions` and returns the quote, the instructions and `addressesByLookupTableAddress`
  (https://developers.jup.ag/docs/swap/migration/metis-to-build.md:9-15, :39-46; parameters in
  https://developers.jup.ag/docs/swap/build/index.md:538-645, `maxAccounts` default 64 at :634; fetched 2026-10-26).
  The taker W is a fresh random keypair held in memory only. It signs each exit once so the fixture carries a real
  signature, its secret is never written down, and nothing is sent. The nonce account and nonce value are random
  placeholders. The 14 tables named were read with `getAccountInfo` on api.mainnet-beta.solana.com and
  solana-rpc.publicnode.com (both genesis `5eykt4Us...`, solana-core 4.3.2, feature-set 3383571666) and kept only if
  both address lists are byte-equal and active. This is the rule of `loadLookupTables` in proofs/g1-money-loop/solana.mjs
  (card/g1-money-loop, :211-228). Jupiter's own address lists are never used. Every raw reply is saved under
  `size/fixtures/` with its time and URL.
- `exit.mjs` compiles with `TransactionMessage.compileToV0Message`: ix 0 `SystemProgram.nonceAdvance` (nonce account
  writable, W authority), then `SetComputeUnitLimit` (600,000; /build returns no CU limit, build/index.md:551, :591),
  then Jupiter's compute-budget, setup, swap, cleanup and other instructions as returned. W pays,
  `recentBlockhash` = the nonce value, one signature slot. Every /build reply is treated as hostile: shapes and sizes
  are bounded, v0 only, no tip, compute budget = one SetComputeUnitPrice, and no Jupiter instruction may name the nonce
  account.
- `report.mjs` prints the table below from the fixtures.
- The 15 `size/fixtures/jup-*.json` files are committed (e741109). gitleaks `generic-api-key` flags 45 `"ammKey"`
  values in their `routePlan`. All 45 are 32-byte base58 pool addresses that the same reply's swap instruction names,
  so they are public, not secrets; the team lead marked them by fingerprint (research .gitleaksignore at e31180e, M192 (6)).

**Sizes** (exit = with the CU limit; "as returned" = without it, always 8 bytes less):

| Fixture | Sell | maxAccounts | Route (legs) | Exit bytes | Margin | As returned | Accounts (static + table) | Swap metas / data |
|---|---|---|---|---|---|---|---|---|
| jup-price-bonk-sol | 1M BONK (~$3) | unset (64) | Whirlpool+Raydium CLMM+Kipseli (3, multi-hop) | 1089 | 143 | 1081 | 44 (22 + 22 via 3 tables) | 55 / 52 B |
| jup-usd5 | $5 | unset (64) | Whirlpool+Raydium CLMM+Manifest+BisonFi (4, multi-hop) | 1070 | 162 | 1062 | 48 (19 + 29 via 4) | 66 / 57 B |
| jup-usd5-max40 | $5 | 40 | Raydium CLMM+Kipseli+Whirlpool (3, multi-hop) | 1089 | 143 | 1081 | 44 (22 + 22 via 3) | 55 / 52 B |
| jup-usd50 | $50 | unset (64) | Raydium CLMM+Kipseli+Whirlpool (3, multi-hop) | 1089 | 143 | 1081 | 44 (22 + 22 via 3) | 55 / 52 B |
| jup-usd50-max40 | $50 | 40 | Whirlpool+Raydium CLMM+Kipseli (3, multi-hop) | 1089 | 143 | 1081 | 44 (22 + 22 via 3) | 55 / 52 B |
| jup-usd500 | $500 | unset (64) | Whirlpool (1) | 705 | 527 | 697 | 21 (14 + 7 via 1) | 22 / 40 B |
| jup-usd500-max40 | $500 | 40 | Raydium CLMM+TesseraV+Whirlpool (3, multi-hop) | 1026 | 206 | 1018 | 44 (20 + 24 via 3) | 54 / 52 B |
| jup-usd5000 | $5,000 | unset (64) | Whirlpool+Meteora DLMM+Kipseli (3, multi-hop) | 1156 | 76 | 1148 | 44 (24 + 20 via 3) | 60 / 52 B |
| jup-usd5000-max40 | $5,000 | 40 | Meteora DLMM+Kipseli (2, multi-hop) | 1003 | 229 | 995 | 36 (21 + 15 via 2) | 48 / 46 B |
| **jup-usd50000** | $50,000 | unset (64) | Whirlpool+Meteora DLMM+Kipseli+Meteora DLMM (4, multi-hop) | **1283, refused** | **-51** | 1275 | 51 (26 + 25 via 4) | 79 / 57 B |
| jup-usd50000-max40 | $50,000 | 40 | Meteora DLMM+Kipseli (2, multi-hop) | 1003 | 229 | 995 | 36 (21 + 15 via 2) | 48 / 46 B |
| jup-usd500-excl1 | $500, default route's DEXes excluded | unset (64) | Meteora DLMM+Raydium CLMM+Kipseli (3, multi-hop) | 1129 | 103 | 1121 | 46 (23 + 23 via 3) | 63 / 51 B |
| jup-usd500-excl2 | $500, more excluded | unset (64) | Raydium+Bonkswap+Deriverse+Bonkswap (4, multi-hop) | 936 | 296 | 928 | 46 (15 + 31 via 4) | 73 / 62 B |
| jup-usd500-excl3 | $500, more excluded | unset (64) | Meteora+TesseraV+Meteora (3, multi-hop) | 911 | 321 | 903 | 45 (16 + 29 via 3) | 63 / 51 B |

"Multi-hop" means some leg goes through a middle mint (BONK -> USDC -> SOL), not only a split of BONK -> SOL. Routes
change from minute to minute. In an earlier capture at 04:40:50Z (same script, not kept: its W was gone before
`maxAccounts` was added for the large sells), the $5 sell was a 1-leg Whirlpool route (705 bytes), and the $50,000
default route was 1283 bytes there too.

**What makes the worst one big** (jup-usd50000 against jup-usd500): 26 static keys (832 B) against 14 (448 B), 25
table lookups in 4 tables (161 B) against 7 in 1 (41 B), and a swap with 79 account metas against 22 (instructions 186 B
against 112 B). The static keys are the cost. The worst one's 26 are W, 5 programs, 15 writable accounts (the nonce account,
W's token accounts and pool accounts) and 5 read-only ones (the RecentBlockhashes sysvar among them). The 20
non-program keys besides W are in none of the 4 tables, and each costs 32 bytes, against 1 byte for a key loaded
from a table. The durable nonce itself costs 74 bytes
on every route: the nonce account (32), the RecentBlockhashes sysvar (32) and ix 0 (10). This is exit bytes minus the
same tx without ix 0, printed by `report.mjs`.

**The nonce account must be a static key, never loaded through a lookup table.** Agave 4.3.2 (commit a203300,
`Cargo.toml:140` `version = "4.3.2"`) finds the nonce account in `runtime/src/bank/check_transactions.rs:291`
(``let nonce_address = message.get_durable_nonce()?;``), from `solana-svm-transaction = "5.0.0"` (`Cargo.toml:503`;
`Cargo.lock:11074-11077`, checksum `0afde938...cebadb`). That crate's
https://github.com/anza-xyz/solana-sdk/blob/067f44a2a9dae54e4b75ecd64878645f848e118a/svm-transaction/src/svm_message.rs#L170-L178
(the same bytes as the crates.io 5.0.0 crate, whose sha256 matches the lock file) reads:

```rust
            .and_then(|ix| {
                ix.accounts.first().and_then(|idx| {
                    let index = usize::from(*idx);
                    if index >= self.static_account_keys().len() || !self.is_writable(index) {
                        None
                    } else {
                        account_keys.get(index)
                    }
                })
            })
```

So a nonce account loaded from a table (index at or past the static keys) gives `None`, and the tx is treated as a
plain blockhash tx, which the nonce value cannot pass. Anyone can make a table that holds any address, so `exit.mjs`
leaves out every table that names the nonce account (the nonce account then compiles as a static key), and `checkExit`
also refuses a nonce index past the static keys.

**If a route does not fit.** The route is fixed when W signs, so the device compiles each exit before signing and
refuses to sign one over 1232 bytes. These remedies were measured on the jup-usd50000 reply (`report.mjs`):
1. **`maxAccounts` lower:** Jupiter's documented fix (https://developers.jup.ag/docs/swap/advanced/reduce-transaction-size.md:15-31,
   "Start with a moderate reduction (e.g. reducing 2 and retry)"). At 40 the $50,000 sell is 1003 bytes. The cost:
   457,213,225,666 lamports out against 483,388,603,636 for the default route (-5.4 %; quoted 2 s apart, so some of
   that is the market). At $5,000 the same cap cost 0.075 %. The docs warn that values "below 50 can result in **no route
   found** or **significantly worse pricing**" (:31).
2. **Drop the no-op setup:** if W's wSOL account is made at signing and left open, the create-idempotent is a no-op
   that can be left out (reduce-transaction-size.md:33-45). This gives 1241 bytes, not enough on its own.
3. **A lookup table W makes at signing,** holding the 19 static keys a table may hold (not W, not a program, not the
   nonce account): 728 bytes, or 686 with (2). Offline only. Making the table is an extra transaction plus rent, and
   that was not measured.
4. **A v1 transaction** (4096 bytes, no lookup tables): Jupiter says it "is live on mainnet" (SIMD-0385,
   https://developers.jup.ag/docs/swap/advanced/transaction-versions.md:9, :13) and `/build` takes
   `transactionVersion=1` (build/index.md:603). Not verified: whether durable nonces work in a v1 tx, and whether
   wallets can sign one (the docs say not all can, :78).
5. **A two-step exit** (two smaller sells, each on its own nonce) breaks the twin rule that one nonce kills the other
   (§2.6), so it is not a drop-in fix.

Which one ships is the markets lane's call (the route builder for exits is the markets paper's, §2.6). The size
check stays in front of every one of them.

**Tests** (`node --test`, 9 in `size/exit.test.mjs`, all offline from the fixtures): each fixture's compiled size
equals the size W signed at capture and web3.js `serialize().length`, is at most 1232, and its signature verifies
against W. Ix 0 is AdvanceNonceAccount on the static, writable nonce account with W signing and paying. The tests also
cover each of these refusals: ix 0 not AdvanceNonceAccount, a read-only or table-loaded nonce, a second signer, the
wrong blockhash, the real 1283-byte route, each multi-hop route without its tables, tables that differ between the two
RPCs, and hostile /build shapes. Each rule was shown red by a one-line mutation in a scratch copy, then green.

**Found on the way, not fixed (outside this card):** proofs/g1-money-loop/solana.mjs `ixFromApi` (card/g1-money-loop,
:104) refuses an instruction with more than 64 account metas. The default-settings $5,000 and $50,000 swaps had 60-79
metas here, and 72-77 in the first capture. That module asks with `maxAccounts=40` first, but its uncapped retry
(:243) can reach that refusal.
