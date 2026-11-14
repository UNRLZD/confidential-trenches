# G1 extra: 1Click and a credit from a one-use account (RM-03)

**Question (wallet.md §8 item 10, §2.5 arming step 6, D50):** the vault's payout path has a one-use NEAR account A pay a
1Click deposit address by `ft_transfer_call(intents.near, amount, msg = the deposit address)`. Does 1Click start the
swap on that credit? Until now, 1Click deposit addresses were only funded from an intents.near balance (P1).

**Pass line:** one owner paste moves at most 0.65 NEAR plus gas (about $3), across every invocation of its `--run`, under the
conditions in "The ceiling" below. It answers RM-03 yes or no from a real
chain (or says why the run could not test it), with every tx read back on two providers and every leftover swept back to a wallet we keep.

**Status:** dry run only. The live run is the owner's paste and has not been run yet.

## The run

| # | Leg | What happens |
|---|---|---|
| 1 | arm-create | F (the funder, `951a5e…bb33`) makes A by a plain Transfer of 0.03 NEAR. A's key list is read on two RPCs and must be exactly A's own full-access key. F pays USDC storage for A, and for F itself when F is not registered |
| 2 | fund-usdc | F's NEAR goes through 1Click (`wrap.near`, ORIGIN_CHAIN) to USDC on A (DESTINATION_CHAIN, refund to F, ORIGIN_CHAIN) |
| 3 | arm-swap (RM-03) | A's whole USDC goes to a quote for USDC (`depositType INTENTS`) to SOL. The recipient is W on Solana, with refund to V (`refundType INTENTS`). A signs `ft_transfer_call(intents.near, amountIn, msg = depositAddress)`, 1 yocto, 100 Tgas. The run polls 1Click to SUCCESS, REFUNDED, FAILED or 15 minutes, and reads W's SOL on two Solana RPCs. `/v0/deposit/submit` (A as `nearSenderAccount`) is sent only if 1Click still reads PENDING_DEPOSIT or KNOWN_DEPOSIT_TX (or nothing) 120 s after A's call |
| 4 | sweep | After the legs, on every stop, or alone with `--sweep`: W's SOL goes to K; V's USDC on intents.near goes to F (V's `ft_withdraw`, carried by F); A's USDC goes to F, then `storage_unregister`, then A is deleted into F |

The amount A's call used is A's USDC before less A's USDC after. It is read only once A's call reads FINAL on two
providers, at finality final, and the two RPCs must agree. The `send_tx` answer only cross-checks it: when the two never
match within 30 s, the amount is unknown (never a stale read). An unknown amount is read again after the watch.

1Click's statuses are the enum of its OpenAPI 0.1.10 (https://1click.chaindefuser.com/docs/v0/openapi.yaml, read
2026-10-26T22:45:41Z, sha256 `c70ffe58…6a62`): `GetExecutionStatusResponse.status` (openapi.yaml:2097-2106) and
`SubmitDepositTxResponse.status` (openapi.yaml:2228-2237) are both KNOWN_DEPOSIT_TX, PENDING_DEPOSIT,
INCOMPLETE_DEPOSIT, PROCESSING, SUCCESS, REFUNDED, FAILED. A status read for an unknown deposit address answers HTTP 404
(read 22:46:53Z), which is no status at all. PENDING_DEPOSIT and KNOWN_DEPOSIT_TX are the waiting states: 1Click has
not acted on the deposit. `run.mjs` exports the enum (`STATUS_ENUM`) and the map below (`RM03_MAP`).

First, the amount A's call used:

| Used | Answer |
|---|---|
| 0 | **not tested**: nothing reached the deposit address |
| unknown | **not tested** when nothing moved (no status beyond waiting, W unpaid, the deposit address at its baseline); else **started, proof incomplete** |
| part of the amount | **started, proof incomplete** (the rest came back to A) |

When the call used the whole amount, the status the watch ends on decides: the final one, or the last one read when
the 15 minute timeout hits. Each status has exactly one answer:

| Ending status | Answer |
|---|---|
| SUCCESS | **yes** when W's SOL arrived on both Solana RPCs and every tx reads back ok on two providers (A's call, every Solana destination tx, every NEAR tx 1Click lists; g1-money-loop `legOk`); else **started, proof incomplete**. The yes is labelled by the submit: **yes (credit alone)** only when no `/v0/deposit/submit` was sent before 1Click first left the waiting states; after such a submit, **yes (after submit)** on an HTTP 2xx answer, and **yes (submit sent, answer unknown)** when its answer was lost or not 2xx. "After submit" means "not seen within 120 s, seen after a submit"; it does not prove the submit caused it |
| REFUNDED | **started, refunded** |
| FAILED | **started, failed** |
| PROCESSING | **started, proof incomplete** |
| INCOMPLETE_DEPOSIT | **incomplete deposit**: 1Click saw the credit as short of the quote. The answer names where the money is: the USDC on the deposit address inside intents.near (read on two RPCs), which 1Click refunds to V by the quote's deadline; `--sweep` then moves V's USDC to F |
| PENDING_DEPOSIT or KNOWN_DEPOSIT_TX | **no** when at least one status was read, no status beyond the waiting states was ever read, W's SOL never arrived, and the deposit address reads its baseline plus the whole amount on two RPCs. Reads that fail after the first are not needed: the deposit address holding the whole amount is the on-chain proof. Otherwise **started, proof incomplete** |
| a status outside the enum | **started, proof incomplete**, naming the status (it counts as beyond waiting, so it never gives "no") |
| no status ever read | **started, proof incomplete** |

A refund counts as "started", not "no": 1Click can refund only a credit it registered. This is the CO's settled call
(merge note M285 (4)).

The leg passes only on a yes. On any other answer the record shows the status seen, the time of each status, whether and
when the submit was sent, the amount used (chain and `send_tx`), and the USDC on the deposit address, on V
(intents.near) and on A, each read on two RPCs.

A `send_tx` whose answer is lost (a timeout) still counts when both providers read the tx back FINAL. Otherwise the
error stands and the stop's sweep reads everything again.

## Accounts

All accounts come from the kept test seed, Keychain item `ct-g1-seed` (g1-money-loop `keys.mjs loadSeed`). A live run
reads it after the typed confirm and before any funding, so nothing is lost if the process dies. The derivations are the
kit's own (wallet.md §2.2 encodings, `derive.mjs`), with the card's own test label l = `testLabel(--run)` and j = 0:

| Account | Derivation | Opens in |
|---|---|---|
| A, the arming account | `A_{l,0}`, HKDF info `onetime/arm` ‖ l ‖ j, a NEAR implicit account | the script (`--sweep`) |
| V, the refund id | `V_{l,0}`, HKDF info `onetime/refund` ‖ l ‖ j, an intents.near id | the script (`--sweep`) |
| W, the fresh Solana wallet | `W_{sol,l,0}`, `m/44'/501'/a'/b'` from HKDF info `wallet` ‖ 0x01 ‖ l ‖ j | the script (`--sweep`) |
| K, where W's SOL goes | `m/44'/501'/1'/0'` | Phantom, Account 2 of the same 12 words |

`derive.test.mjs` reproduces the wallet paper's §A.8 vector set byte for byte:
- s, l, the A info bytes, A_{l,0}, A_{l,1}, V_{l,0}, V_{l,1};
- R for all six tags;
- W_{sol,l,0} and W_{sol,l,1} (path and address);
- U.

On the `--run 1` dry run: A = `386aeb32…3ef8`, V = `a7e89509…54a1`, W = `J9a7qjPD…ZSqM`, K = `CDtgRfeQ…7R5t`.

## What the script checks before it signs

- **1Click quotes:** g1-money-loop `checkQuote`, unchanged:
  - the signature under the pinned key;
  - all 17 signed request fields equal what was sent;
  - a live request takes only an answer signed as live;
  - freshness, the loss bound and `amountIn`.

  Then `checkDeposit` adds:
  - recipient, refundTo, refundType and depositType equal to our request (A and F for the fund quote; W and V for the arm quote);
  - the deposit address is 64 hex and none of A, V or F;
  - `amountIn` equals the amount asked.
- **NEAR txs (`neartx.mjs`):** `signTx` is the only signer. It decodes the bytes itself and signs only when one of the
  module's checks passed on that decoded object:
  - `checkArmCall`: A's one `ft_transfer_call` on USDC, args exactly `{receiver_id: "intents.near", amount, msg: depositAddress}`, 1 yocto, 30-300 Tgas.
  - `checkFunderTx`: F's Transfer to A at most 0.03 N; `storage_deposit` of exactly 0.00125 N for A or F; the payment of exactly the typed fund amount to the deposit address; `execute_intents` carrying one checked `ft_withdraw`.
  - `checkSweepTx`: A's `ft_transfer` to F only; `storage_unregister`, never forced; `DeleteAccount` with beneficiary F only.

  The encoder is checked against four mainnet txs. Our bytes hash to the chain's tx hash, and the chain's signature
  verifies (`fixtures/golden-txs.json`).
- **V's withdraw (`intent.mjs`):** one `ft_withdraw` of USDC to F, at most V's balance, `raw_ed25519`, a versioned nonce
  under intents.near's `current_salt` read on two RPCs. The field names come from near/intents at 16d04f6, the commit
  intents.near names in its source metadata. Every dry run asks `simulate_intents` on two RPCs with a throwaway key:
  - our signed `ft_withdraw` is refused for the balance;
  - the same with one signature byte flipped is refused for the signature.

  So intents.near accepts the format, the key, the salt and the nonce.
- **Solana sweep:** W's one system transfer to K. Before W signs, the message must name only W (fee payer and only
  signer), K and the system program, with the exact lamports.
- **The typed plan:**
  - The fund amount is refused above 0.6 NEAR (`FUND_MAX`) before any quote.
  - The total is refused above 0.65 NEAR (`TOTAL_MAX`).
  - The operator types the exact total before the seed or the funder key is read.
  - Every F send that carries NEAR draws its plan line once, at its exact amount. Each draw is written to the run's
    record (`drawn`) before its send leaves.
  - fund-usdc pays exactly the typed fund amount; a price read after the prompt does not change it (lead fix 939e89d).
- **The ceiling across every invocation of one `--run`** (round 3, M293). Every live invocation writes its record in
  `runs/` before it sends anything, and writes it whole (a temp file, then a rename). The fresh run's record (the run
  without `--from` or `--sweep`) is marked `fresh` and lists every later invocation of the `--run`; each resume or
  sweep adds itself to that list after its own record is on disk and before it sends anything, or stops rc 2.
  - The record set of a `--run` is complete when `runs/` holds at least one live record of it, every one parses and
    holds what F drew (or its typed plan total), exactly one is the fresh run's, and every invocation that record lists
    is there. A record the list does not name is still read and counted.
  - A fresh run pays only when `runs/` holds no live record of the `--run` and A does not exist on two RPCs. Its plan is
    at most 0.65 NEAR (`TOTAL_MAX`).
  - A `--from` pays only on a complete set: what every record drew, plus this plan, must be at or under 0.65 NEAR, and
    (for fund-usdc) no fund deposit of the `--run` may be open. Otherwise it stops rc 2 before the prompt. On a set that
    is not complete it says which record is missing or cannot be read, that the `--run` cannot be resumed, and to run
    `--sweep`. It never advises moving or editing a record.
  - A `--sweep` on a complete set pays at most F's USDC registration (0.00125 NEAR), inside the same 0.65 NEAR. On a set
    that is not complete it pays nothing from F (typed total 0): W's SOL still goes to K, V's USDC goes to F only if F
    is already registered, and A is kept whole, since the missing record could hold an open fund deposit or arm call.
  - So F pays at most 0.65 NEAR plus gas per `--run` across every invocation the tool runs on this Mac, whatever
    happens to `runs/` (the marker below). A refund to F does not raise that room.
  - **This Mac's marker** (card arm-swap-run-marker). Outside `runs/`, a Keychain generic password per `--run`
    (service `ct-g1-arm-run`, account the `--run`) holds the NEAR the `--run` has committed from F and the folder
    that holds its `runs/`. Before each F send that commits NEAR, the draw goes on disk, then the marker is raised by
    it and read back, then the send leaves; a write that does not read back stops the send. A stop between any two
    steps leaves the records at or above the marker. Every live start reads it before the prompt (`--dry` never reads
    or writes it):
    - a fresh start with a marker present is refused rc 2, naming the folder to resume in;
    - a `--from` whose records count less than the marker is refused rc 2, naming the folder the marker was last
      raised from when it is another;
    - a `--sweep` whose records count less than the marker runs as on a set that is not complete: it pays nothing
      from F and keeps A whole;
    - a marker that cannot be read, or holds what the tool does not write, stops every live start rc 2.
  - **The one folder.** `runs/` is `~/Downloads/confidential-trenches/proofs/g1-arm-swap/runs/`, in the checkout the
    paste runs from, and every resume and sweep of a `--run` runs from there. The ways round 3's Verifier found for
    one `--run` to pass 0.65 NEAR through `runs/` alone (M299) are each refused now, by the marker:
    - **Records removed (V3-8).** Every record of a `--run` removed after a sweep deleted A: the fresh run that paid
      again (1.06375 NEAR from F in all) is refused, since the marker holds 0.5325 NEAR. Test M2.
    - **Another checkout.** A fresh paste of the same `--run` from a checkout whose `runs/` is empty is refused,
      naming the checkout to resume in; a resume there is refused too. The whole record set copied there counts what
      the marker holds and runs. Test M3.
    - **A stale copy (V3-10).** A copy of the fresh run's record made before a resume paid the fund, restored over
      `runs/` or copied into another checkout's `runs/`, counts 0.0325 NEAR against the marker's 0.5325: the resume
      that made a second fund deposit is refused. Test M4.
    - **A record edited by hand.** A lower `drawn` (or a list of later invocations cut short together with the files
      it names) lowers what the records count below the marker: the resume is refused. Test M5.
    - What the marker does not cover: the Keychain item itself removed or edited by hand, and a paste from another
      Mac.
  - A record removed for good also leaves A, with its USDC and up to 0.03 NEAR, kept whole: the tool will not sweep A
    without it.
  - A new `--run` is a new paste with its own 0.65 NEAR ceiling, by design. Both fresh-run refusals (a live record in
    `runs/`, or A already on chain) lead with the resume, `--from <leg>` or `--sweep`, which stays under the
    `--run`'s ceiling; only then do they say that a new `--run` is a new paste with its own (P3-1).
- **No second fund deposit while one is open:** fund-usdc pays nothing while any fund deposit recorded for this `--run`
  is not final at 1Click (SUCCESS, REFUNDED or FAILED) and its payment can still land. This is checked before the
  prompt and again right before the quote.
- **fund-usdc on a resume:** before any quote, A's key list on two RPCs must be exactly A's own key, and A must read
  registered on USDC on two RPCs.
- **One arm, one use:** a live run refuses a `--run` whose A exists on chain, whose `runs/` already hold a live record,
  or whose marker on this Mac is present, except with `--from` or `--sweep`. The refusal leads with the resume (see "The one folder" above).
- **The terminal gate:** `--live` and live `--sweep` run only with stdin and stdout a TTY. Otherwise they stop rc 2
  before any Keychain, seed, key or network read.

## Stop rule

The first failed leg stops the run. A live stop runs the sweep, then prints every balance on two RPCs and that leg's way
back. The proof is `node run.mjs --dry --fail-at <leg>` for each leg. Each run exits rc 1 at its own leg and prints:

| --fail-at | Way back printed |
|---|---|
| arm-create | NEAR is on F, or on A until the sweep above deletes A into F; if the sweep stopped, run `--sweep`. |
| fund-usdc | NEAR is on F, or 1Click holds it at the deposit address and refunds it to F (ORIGIN_CHAIN). USDC that arrived is on A. While 1Click's status is not final the sweep keeps A whole: run `--sweep` once it is SUCCESS or REFUNDED (or `--from arm-swap`, while A is kept and holds the USDC). |
| arm-swap | USDC is on A (a refused call: the sweep returns it to F), or credited to the deposit address inside intents.near, which 1Click swaps to W or refunds to V (run `--sweep` after its status is final: V's USDC to F, W's SOL to K). If 1Click never registers the credit, the USDC stays on the deposit address: ask 1Click support with the deposit address, correlationId and A's arm tx above. |
| sweep | Each sweep part reads first and moves only what is there, and a failing part does not stop the others: run `--sweep` again. |

Each run also prints which Keychain item and `--run` every account comes from. A live stop also prints, for each 1Click
deposit it made, the deposit address, the correlationId and the tx that paid it (what 1Click support asks for).

The sweep's three parts (W, V, A) each run even when an earlier one failed; the failures are reported together.

A's part runs only when both of these hold, for every record of this `--run` (this run and its earlier live records):
- each 1Click fund deposit is final (SUCCESS, REFUNDED or FAILED), or its payment can no longer land. Until then 1Click
  may still deliver USDC to A, so A is kept whole.
- each arm call of A reads FINAL on two RPCs, or can no longer land. So A is never deleted while its own call could
  still change its balance.

"Can no longer land" needs all three: neither RPC knows the tx; its block is more than the validity period behind the
final block; and the signer's key nonce on two RPCs is still below the tx's nonce (a landed tx that an RPC has
forgotten leaves the nonce at or above it).

A refund from 1Click goes to V, never to A. A `--sweep` alone reads the fund deposits, the arm calls and the last 1Click
deposit from this `--run`'s earlier live records in `runs/`. When that record set is not complete (see the ceiling
above), the sweep moves W's SOL to K, pays nothing from F, and keeps A whole.

## Dry run

`node run.mjs --dry`, 2026-10-27 00:12:18Z, on round 3's code (27dbe43, research main 491c91c merged in), keyless
1Click. It used the kept seed, real reads and real quotes, signed nothing with a seed or funder key, and sent nothing.
rc 0. The record is `runs/2026-10-27T00-12-18-766Z-dry-run1.json`, gitignored.

| Step | Checked |
|---|---|
| plan | a live run would ask for 0.476 NEAR: 0.03 to A, 0.00125 for A's USDC storage, 0.00125 for F's, 0.4435 to the deposit address ($2). F holds 0.53865 / 0.53865 NEAR (fastnear + drpc) and needs 0.526 with the 0.05 gas reserve: enough |
| arm-create | A does not exist on two RPCs; F's Transfer and both `storage_deposit` txs built, decoded and passed `checkFunderTx`; not signed |
| fund-usdc | dry and deposit quotes: the signature verifies, all 17 fields equal (dry true, then false), recipient A, refundTo F ORIGIN_CHAIN; loss 0.28 %; min out 1.975948 USDC; F's payment built and checked |
| arm-swap | dry and deposit quotes: as above, recipient W, refundTo V INTENTS, amount 1975664; loss 0.80 %; min out 0.019230581 SOL; A's `ft_transfer_call` built (A does not exist yet: nonce 1, the final block hash) and passed `checkArmCall`; not signed |
| sweep | W to K message checked; V's payload built; `simulate_intents` on both RPCs as above; F's `execute_intents`, A's `ft_transfer`, `storage_unregister` and `DeleteAccount` built and checked |

`--dry --fail-at <leg>` on the same code: rc 1 at arm-create, fund-usdc, arm-swap and sweep, each with its own way back.

## Tests

The suite, on the PC through `scripts/heavy.sh`, from the worktree of `card/g1-arm-swap` at 27dbe43, 2026-10-27 00:12Z. The box
syncs the tree without `node_modules`, so the command installs both folders first:

    HEAVY_REMOTE=1 scripts/heavy.sh arm-swap-r3 -- sh -c '(cd proofs/g1-money-loop && npm ci --ignore-scripts --no-audit --no-fund) && (cd proofs/g1-arm-swap && npm ci --ignore-scripts --no-audit --no-fund) && node --test "proofs/g1-arm-swap/*.test.mjs" && node --test "proofs/g1-money-loop/*.test.mjs"'

- g1-arm-swap: 194 tests, 193 pass, 0 fail, 1 skipped (`intent.live.test.mjs`, which runs with `ARM_LIVE_READS=1`; the lead ran it on the Mac at 939e89d, pass; it is unchanged);
- g1-money-loop (main's, imported, not changed here): 276 / 276;
- "done on <build box> in 34 s: exit 0".
- card arm-swap-p3s at 4e157a8, 2026-10-31 17:02Z, the same command: g1-arm-swap 196 tests, 195 pass, 0 fail, 1 skipped; g1-money-loop 277 / 277; "done on <build box> in 376 s: exit 0".
- card arm-swap-run-marker at 5c028df, 2026-10-31 17:46Z, on this Mac's heavy.sh queue (HEAVY_REMOTE=0; the box was
  busy with UNRLZD), the same tests: g1-arm-swap 206 tests, 205 pass, 0 fail, 1 skipped; g1-money-loop 277 / 277; exit 0.

| File | Tests | Red before |
|---|---|---|
| derive.test.mjs | 12 | module missing; mutants (j as 8 bytes, l little-endian) each fail 4 |
| neartx.test.mjs | 43 | stubs: 41 fail |
| intent.test.mjs | 17 | stubs: 17 fail; 26 rules weakened one at a time, every one caught |
| intent.live.test.mjs | 1 | stub: fails |
| run.test.mjs | 133 | module missing; 13 guards removed one at a time, each turns its tests red; the lead's fund-amount tests fail 2 at da78b12 and pass at 939e89d; outside read 1's fixes (F1): 17 fail on the 4df8fda code; outside read 2's fixes (F2): 12 fail on the a326c26 code; round 2's file: 22 fail on the 7154fde code; the draw-once guard and fundAmount's FUND_MAX, each removed alone, turn their own test red; round 3's file: 11 fail on the fd4bab9 code (the missing, unreadable and unlisted record cases, the sweep on them, and the whole-write cases); the "no" rule's `!fb` and its deposit-address equality, each removed alone, turn R3 VP-4 and R3 VP-5 red; card arm-swap-p3s: the two P3-1 refusal tests fail on the fa0ccba code; card arm-swap-run-marker's file (133): its 10 marker tests M1-M10 fail on the 0339b03 code (M2, M3 and M5: F paid 1.06375 NEAR in all; M4: a second fund deposit), its other 123 pass there; all pass after |

## No secret in the output

Checked over the dry output, the four stop outputs and every `runs/*.json`:
- gitleaks rc 0;
- no `privateKey`, `secretKey`, `mnemonic`, `seed`, `secretSeed32` or `priv` field;
- no 80-character base58 run.

## Live run

The owner's paste, after Verify:

    sh ~/Downloads/confidential-trenches/proofs/g1-arm-swap/live.sh

The defaults are `--run 1` and `--usd 2`. Use `--from <leg>` to resume and `--sweep` to sweep only.

The run asks for the exact total to type: 0.476 NEAR at the 00:12Z price. It is capped at 0.65 NEAR plus gas, under the ceiling's conditions above, across
every invocation of `--run 1`. Of that:
- about $2 comes back as SOL on K, Phantom Account 2;
- A's NEAR comes back to F when A is deleted;
- F's own USDC registration (0.00125 NEAR) stays on F;
- the cost is 1Click's fees on two quotes (about 1.1 % and 0.6 % keyless) and gas.

## Results: paste 3, 2026-11-01

Source: the owner's live record `proofs/g1-arm-swap/runs/2026-11-01T03-43-49-835Z-live-run1.json` (started 03:43:49Z, `--run 1`,
`mode: live`; kept out of git). Field names below are the record's. The CO's own re-reads at about 04:19Z are marked "CO read".

### RM-03: yes (credit alone)

The question, as the record's `rm03` block has it: does 1Click start the swap on a credit by A's
`ft_transfer_call(intents.near, msg = the deposit address)`? The answer field reads `yes (credit alone)`.

- Deposit address: `9045e27efa2179a6750e35e05eb756767eafb4f8fb979ea0973970685c4f8efe`.
- Correlation id: `ab2dfdfe-0aaf-4619-96f7-919f39c7b981`.
- Amount: 2003610 (2.00361 USDC). `minOut`: 20574933 lamports.
- Baselines before the arm call: W 0 SOL, deposit address 0 USDC, V 0 USDC.
- `submitted: false`. No submit was sent. The log says `/v0/deposit/submit not sent`.
- Used: 2003610 of 2003610 (`used`, `usedSendTx` and `usedChain` agree).
- Status times (`statusSeenMs`): PROCESSING first seen at 7.5 s, before any submit; SUCCESS at 48.2 s.
  `firstBeyond` is PROCESSING at 7510 ms with `beforeSubmit: true`.
- Arrival (`arrivedMs`): W's SOL arrived on both RPCs at 48.0 s (+20782610 lamports).
- `gate` is empty.

So the credit alone started the swap. Nothing else was needed.

### The arm-swap leg

- Quote: in $2.0035899639, out $1.9868319516, fee $0.0167580123 (`feeUsd`), `loss` 0.84 %, quote 1117 ms (`quoteMs`).
- Out: `amountOut` 20782761 lamports; `eta` 9 s.
- The quote check passed: the signature verifies under the pinned key and all 17 signed request fields equal what we sent.
- Request to arrival: 50339 ms (`requestToArrivalMs`). Leg total 467022 ms (`ms`), final SUCCESS.

### Every transaction

NEAR rows: the record's `txs` list. The CO read all six at about 04:19Z on two RPCs each. NEAR: rpc.mainnet.near.org and
near.drpc.org. Solana: api.mainnet-beta.solana.com and solana-rpc.publicnode.com. All six are FINAL (NEAR) or finalized
(Solana), status ok. A is the arm account `386aeb32...ed233ef8`, F the funder `951a5eab...0703bfb33`.

| # | Name | Hash or signature | Signer | Nonce, height | Read-back |
|---|---|---|---|---|---|
| 1 | A's cancel of its open arm call | `DFKY5VDHkxdvQkrRdppZ3y3qXgg5qFJ5vnkWa63AM6Mw` | A | 222476436000001, 222515334 | `readBackOk` true; CO read FINAL, ok |
| 2 | F tops A up (0.091 NEAR, `drawn` topA) | `7Y34e1rhvw2vbZdKXpdHs6AvMqHNBRQDQqYZphUQX4k9` | F | 220714460000019, 222515341 | `readBackOk` true; CO read FINAL, ok |
| 3 | A's arm call (to the USDC contract) | `74zdEExZgcayHmvPzT587W4fz5SQAaPx4WvcL2xFE8XN` | A | 222476436000002, 222515356 | leg `back`: FINAL, 0 failed receipts, on two RPCs; CO read FINAL, ok |
| 4 | W to K | `yL6dDLVSDu1J9jyeFMTYgurAyHNg8RDUZgiEBiVAmDr4KjTaUKWwaBw3EnC6E9ncYamzf1rA95fRauszFDmkSod` | W | Solana, 20777610 lamports | log: read back on two Solana RPCs; CO read finalized, ok |
| 5 | A's storage_unregister | `9XXiZAdtPCnn4itNs2ADsZaoGqYL4aW2GznX3gm96avM` | A | 222476436000003, 222516853 | `readBackOk` true; CO read FINAL, ok |
| 6 | A deletes itself into F | `Dw1nbvYGcjXs3HocsCxxz1GXr6wH8QNUkQV5FxffJPrM` | A | 222476436000004, 222516863 | `readBackOk` false in the record; CO read FINAL, SuccessValue (see "The stop") |

W to K moved 20777610 lamports. The arrival was 20782610, so the 5000 lamports difference is the Solana fee.

Also from the log:

- F's fund-deposit payment tx: `DpcHS5kRtmK8Pv46FUcuefpjBS5tXdLskxVAu1C2B2hN`.
- 1Click's fund deposit: `a998c6585100ca4bccbc0e0bcceb9abd66e59666e87bd03b1d83bb9544f7ce2f`, status SUCCESS, correlation id
  `f7c38c72-b112-42fd-986f-9705977fcf61`. This run's `plan.fund` is 0, so this run paid no fund deposit; the log names it
  only because the sweep checks it.

### The first arm call that never landed

- Hash: `4nMk5TMcifVHk57scxChuA2W2K3HxKWspgaiUdDroEKf`, nonce 222476436000001.
- `send_tx` refused it. It is in no block. The USDC never left A.
- A's cancel `DFKY5VDHkxdvQkrRdppZ3y3qXgg5qFJ5vnkWa63AM6Mw` took that same nonce, 222476436000001, and is FINAL on two RPCs. So the
  first call can never land. The sweep also saw A's key nonce at 222476436000002 on two RPCs, at or above it.
- Its deposit address `9d0e31ab07e77de30a3089a5803a5e8e447ad9ba982b12b7db00969f7bada421` (correlation id
  `36f02ac7-2226-47a1-ad9a-3eb51a7f4639`) holds 0 USDC on two RPCs.

### The stop at the last step was a false alarm

The record's `stopped` field: leg `sweep`, "A deletes itself into F: tx `Dw1nbvYGcjXs3HocsCxxz1GXr6wH8QNUkQV5FxffJPrM` not
confirmed on two RPCs", with "not ok" on free.rpc.fastnear.com and on near.drpc.org.

The CO read at about 04:19Z shows the sweep finished:

- The tx is FINAL with `SuccessValue`.
- Its only action is `DeleteAccount`, and the beneficiary is F.
- Receipt `9wEBNxb1a7` sent 119159735895219299999999 yocto from system to F and succeeded.
- Receipt `GBkJTsykxG`, from system to A, was a Transfer of 229993650000000000000 yocto. It failed with `AccountDoesNotExist`.
  That is NEAR's gas refund to an account the same tx deleted. It is the part of A's prepaid gas the tx did not burn; with A gone it is burnt too (0.00023 NEAR).
- A reads `UNKNOWN_ACCOUNT` on both RPCs.

The read-back rule counted that failed refund receipt as a failure. The rule is fixed in card `delete-refund-readback`.
The money moved; only the check was wrong.

### Where every leftover went

From the record's last log block, "Where the money sits now", read on two RPCs each:

| Where | Holds |
|---|---|
| F `951a5eab...0703bfb33` | 0.47226 NEAR, 0 USDC |
| A `386aeb32...ed233ef8` | deleted (does not exist); 0 USDC |
| V `a7e89509...a0a0bdd9c8e54a1` on intents.near | 0 USDC |
| Deposit address `9045e27e...4c8efe` (the arm call that landed) | 0 USDC |
| Deposit address `9d0e31ab...7bada421` (the call that never landed) | 0 USDC |
| W `J9a7qjPD2YAQKNBXJFA8dhF69nqUSsFdBqANYFhhZSqM` | 0 SOL |
| K `CDtgRfeQ1mdu7QN9yFo8EUk1kxTpZ3sCWpaJF3yM7R5t` (Phantom Account 2 of the test seed) | 0.02077761 SOL |

- The swap output went W to K, so the $2 came back as 0.02077761 SOL on K.
- The drawn top-up of A, 0.091 NEAR (`drawn`), came back to F through the close, with the rest of A's balance (119159735895219299999999 yocto).
- The 1Click arm-swap status is SUCCESS. A failed swap would have refunded to V.

### Cost

From the record's numbers only:

- Swap fee: $0.0167580123 on a $2.0035899639 swap (`feeUsd`; in minus out is the same number). That is about 0.84 % (`loss`).
- Solana fee on W to K: 5000 lamports (20782610 arrived, 20777610 sent).
- NEAR gas spent: not in the record. The log's "needs" lines are reserves the run checks before it sends, not gas burnt.
- 1Click's fee on the fund deposit: not in the record.
