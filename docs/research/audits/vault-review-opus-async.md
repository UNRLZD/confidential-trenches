# Vault review: NEAR's async rules (card vault-review-opus-async)

- Code: `UNRLZD/confidential-trenches` at `a7e7300eb7e988dd87a4b4112152c6dc12a08bc4`, `contracts/vault` and
  `packages/kit/src/vault`, taken with `git archive` into the reviewer's scratch folder.
- Read line by line: `lib.rs`, `constants.rs`, `promise.rs`, `payout.rs`, `withdraw.rs` (the method, its checks and
  `spend`), `deposit.rs`, `prepay.rs`, `ragequit.rs`, `settle.rs` and `tree.rs`'s insert path, with their unit tests.
  The other seven files of `src/` (context, field, poseidon, verifier, verifier_keys, events, tests) were searched for
  every host call that makes a promise, reads gas, reads or charges storage, or moves NEAR: there is none outside
  `promise.rs`. Read for context: `Cargo.toml`; the headers and cases of `tests/payouts.rs` and `tests/s17.rs`; `tests/harness/run.sh`;
  the kit's `shapes.ts` (the withdraw and ragequit attachments); the helper's `apps/helper/src/withdraw/send.ts` l.5-20
  and `fee.ts` l.330-345 and the wallet's `packages/wallet/src/arming/accounts.ts` l.1-30 (how `register_deposit` is
  set); near-sdk 5.29.1 `env.rs` l.2163-2175 (`promise_result_checked`).
- Paper: `docs/plan1/vault.md` 2.5.1-2.5.7 (V:280-520, so 2.5 V:402-473 in full), the M2 row (V:1089), VT-S01 to
  VT-S20 (V:1137-1156) and the V3 rows (V:1211-1225).
- When: 2026-11-06, 05:06Z to 05:35Z. Reviewer: a fresh Opus agent that wrote none of this code.
- Scope: every receipt the vault makes or causes, its callback, gas, storage, reentrancy across receipts, NEP-141
  order and refunds, the refund path and `in_flight` spends. The contract review
  (`vault-review-opus-contract.md`) was opened only after the findings table below was written.

## Every receipt the vault makes or causes

Statics (`src/constants.rs` l.34-38): `ft_transfer` 15 Tgas, `storage_deposit` 10 Tgas, `on_payout` 30 Tgas, each
with gas weight 1 (`src/promise.rs` l.23). Pre-check: `prepaid_gas >= Σ static + 100 Tgas` (`src/payout.rs` l.54-58).

| # | Method | Promise it makes | Callback | State written before the promise | Failure handling |
|---|---|---|---|---|---|
| 1 | `storage_prepay` (`prepay.rs` l.36-55) | none | none | `prepaid[P] += attached` | panic: nothing written, the runtime returns the attachment |
| 2 | `ft_on_transfer` (`deposit.rs` l.174-182), called by `TOKEN` inside `ft_transfer_call` | none; returns `"0"` | the token's own `ft_resolve_transfer`, a later receipt on the token | `prepaid[P]` deleted, `nonce`, both trees, `deposits`, `precommitments`, `label_index`, `totals.deposited` (`deposit.rs` l.102-150) | any refusal panics with nothing written; the token's resolve gives the sender the whole amount back (residuals in A-07) |
| 3 | `withdraw` (`withdraw.rs` l.280-323) | part 0 to `TOKEN`: `[storage_deposit(recipient, registration_only) with register_deposit, 10 Tgas, only when > 0; ft_transfer(recipient, to_recipient) with 1 yocto, 15 Tgas]` in one receipt. Part 1 to `TOKEN`, only when `fee > 0`: `ft_transfer(fee_recipient, fee)` with 1 yocto, 15 Tgas. `promise_and(part 0, part 1)` (`promise.rs` l.64-95) | `on_payout(spend_index, to_recipient, fee)` on the vault, 30 Tgas, 0 NEAR (`promise.rs` l.96-105) | the change leaf (leaf, leaf index, side nodes, root), `spent[nh]`, `spends[i]` as `in_flight`, `totals.spent` (`withdraw.rs` l.235-270); the record's `reserve` (`payout.rs` l.106-124) | before the promises: any panic, and too little gas (making a promise fails `GasExceeded`), rolls the whole receipt back with the nullifier unspent. After: each part is read by `on_payout` |
| 4 | `ragequit` (`ragequit.rs` l.67-126) | part 0 only, to the depositor, with the caller's `register_deposit` | `on_payout(i, value, 0)` | `spent[nh]`, `spends[i]` `in_flight` (payer = recipient = the depositor, fee 0, context 0), `totals.spent` (l.99-121); `reserve` (l.123) | as withdraw; a bounced payout becomes a refund note that only the private withdraw can spend |
| 5 | `on_payout` (`payout.rs` l.130-147), `#[private]` | none | none | (it is the callback) | panics before any read or write on a wrong result count or an unnamed result (`promise.rs` l.113-138); a Failed part's amount goes to `refund_value` and `totals.returned`. If the callback itself fails, the spend stays `in_flight` for good (A-03) |
| 6 | `settle` (`settle.rs` l.59-122), anyone | `Transfer(payer, reserve - cost)` and `Transfer(caller, unused attachment)`, plain, none for 0 (`settle.rs` l.108-109, `promise.rs` l.142-147) | none | the refund note (`nonce`, both trees, `refund_label`, `refund_leaf_index`), `status = settled`, `reserve = 0` | panic (`SpendInFlight`, `AlreadySettled`, `InsufficientStorageDeposit`, a tree check) rolls back; a Transfer to a deleted named account bounces and the runtime returns the NEAR to the vault |
| 7 | token side, caused by row 3 or 4 | the token's refund Transfer to its caller, the vault: a registration's excess, or the whole `register_deposit` when the account is already registered; a failed part's attached NEAR (`register_deposit` + 1 yocto) as the runtime's refund receipt, also to the vault; gas refunds to the signer | none | none | the vault has no method that reads or forwards this NEAR (A-02) |

## Findings

| ID | Severity | File:line | Trigger | What the user loses | Proof | Fix | Also in the contract review? |
|---|---|---|---|---|---|---|---|
| A-01 | Low | `src/promise.rs` l.94-95 (the recipient part and the fee part are two receipts joined only by `promise_and`); `src/payout.rs` l.94-101, l.139-141 | A relayed withdrawal (`fee > 0`) whose recipient part the token refuses while the fee part lands. The wallet always pays a fresh one-use account A and reads A's registration on two RPCs of two operators (`packages/wallet/src/arming/accounts.ts` l.11-16), and only A's own key can unregister A, so the paths left are narrow: a USDC halt, or a code change that raises the storage bound, landing between the two part receipts (they are separate receipts and can run in different blocks); Circle blocking A; both RPC operators wrong about A; or another app on the open kit that pays a typed account directly | The relay fee. The relayer is paid for a payout that never arrived, the refund note is `withdrawn - fee`, and the retry pays a second fee. Privacy Pools' relay is one EVM transaction, so its two transfers (`Entrypoint.sol:167-169`) revert together (the paper's own Dev 9 row: "PP's `_push` reverts the whole withdrawal on EVM", V:577); this port lost that. The reverse case (fee part bounces, recipient paid) leaves the user a refund note worth only the fee, dust no relayer carries | Scratch test `a01_fee_is_kept_when_the_recipient_part_bounces` (below). The team's own tests assert the same outcome as intended: VT-U06 case `[Failed, Successful]` returns 1,500,000 of 2,000,000 (`src/payout.rs` l.291), and `one_part_fails_usdc_recipient` on the real USDC wasm (`tests/payouts.rs` l.188-235), re-run here in near-sandbox: the recipient's `ft_transfer` failed ("The account alice.test.near is not registered"), the relayer's fee `ft_transfer` landed, `delivered 500000, refund_pending 1500000` | One receipt: part 0 = `[storage_deposit when register_deposit > 0, ft_transfer(recipient, to_recipient), ft_transfer(fee_recipient, fee) when fee > 0]` to `TOKEN`. A receipt's actions fail together (vault.md V:461), so both amounts move or neither, as in PP; `on_payout` then always reads one result and returns `withdrawn` or 0. Same statics and gas weights; `on_payout`'s arguments and the `payout` event keep their fields, so the kit's frozen types do not change. Cost: a fee recipient the token refuses bounces the whole payout (a full refund note, nothing lost) instead of only the fee | New. The contract review's Dev 4 row reads the two-part shape as holding and does not weigh the fee landing without the payout |
| A-02 | Info (documented) | `src/promise.rs` l.66-75; `src/payout.rs` l.80-91 (the reserve leaves `register_deposit` out); `src/deposit.rs` l.115-119; `src/settle.rs` l.108-109. Besides the `register_deposit` and the yocto it attaches to its own calls, the only NEAR the vault sends is settle's two Transfers | The token sends NEAR back to its caller, the vault: a registration's excess, the whole `register_deposit` for an account already registered, a bounced part's `register_deposit` + 1 yocto; a prepay above the bytes its deposit wrote; a settle Transfer to a deleted payer | The payer's NEAR, about 0.00125 N per registration case, and 148 B (0.00148 N) when the kit's 904 B prepay meets a deposit that grows no tree, stranded for good in a keyless account. The vault puts no upper bound on `register_deposit`; the relayer prices it into its fee and refuses a body above its quote (`apps/helper/src/withdraw/fee.ts` l.339-343, check 7 in `send.ts` l.12-15) | Documented: vault.md V:372-376, the 2.5.4 table (V:461), VT-S08 ("the extra registration NEAR is in the vault"), prepay.rs l.5-7 | None needed. The stranded NEAR also widens the margin of A-03's storage case | Also in the contract review (R-04; the deleted payer in R-06) |
| A-03 | Info (documented) | `src/payout.rs` l.130-147; `src/settle.rs` l.74 | `on_payout` fails: a NEAR re-pricing past its 30 Tgas static (it burns 1.704-1.714 Tgas, V:476), or a storage price rise beyond the vault's free NEAR at the end-of-receipt check (near-sdk 5.29.1's `env::storage_byte_cost()` is the constant 1e19, `env.rs` l.2703-2705, so the vault would go on charging the old price while its margin drains) | The spend stays `in_flight` for good: a bounced part's tokens have no note and are frozen, and the payer's reserve is never returned. NEAR never re-runs a failed callback | Documented V:466-474; VT-S17 (`tests/s17.rs`) forces it on a test build and records the state (not re-run here) | None inside a keyless vault: there is no second source of truth for whether a part moved. The 17x gas margin and anyone's NEAR top-up are the defence. Keep VT-S12's "at most a sixth of the static" gate on every nearcore upgrade | Also in the contract review (R-02) |
| A-04 | Info (new) | `src/payout.rs` l.131-143 | None today: `pay_then_on_payout` builds the callback's arguments from the same values it pays (`src/promise.rs` l.94-97), and `#[private]` keeps anyone else out (proved as a stranger in `tests/payouts.rs`) | Nothing today. If a later edit ever passed wrong amounts, `on_payout` would write them as given: an over-count makes a refund note larger than the bounce, paid from other users' notes, and once `returned > spent`, row 9's `spent - returned` underflows and every later withdrawal is refused `InvalidPoolState` (`src/withdraw.rs` l.226-229) | Scratch test `a04_on_payout_trusts_its_arguments` (below): a 1,000,000 spend takes a `refund_value` of 1,000,000,000 and `spent.checked_sub(returned)` is `None` | Take the amounts from the record (`to_recipient = s.withdrawn - s.fee`, `fee = s.fee`), or refuse a mismatch before any write. Worth doing only if `promise.rs` and `payout.rs` are opened again (for A-01) | New |
| A-05 | Info (documented) | `src/payout.rs` l.144; `src/withdraw.rs` l.307-322; `src/settle.rs` l.111-121 | The rule "no log before the last refusal" holds to the end of the method body only: near-sdk's state write and NEAR's end-of-receipt storage check run after the events, and NEAR keeps a failed receipt's logs | A reader that trusted logs would see a `payout` (or `withdrawn`) for a receipt that failed. Nothing is lost: the kit, the wallet's restore and the helper take every status from the views | Documented `tests/s17.rs` l.16-23 (its test build logs `payout` in a failed `on_payout`). Unreachable on withdraw: the 100 Tgas margin covers the vault's own work at depth 32 (83.823 Tgas in the sandbox, about 88.8 with testnet's 5.9 % trie margin, plus at most 2.554 Tgas of prepaid fees, V:415-423) | None | New to that review (the team's `tests/s17.rs` already names it) |
| A-06 | Info | `src/promise.rs` l.113-129 (a Failed part counts as nothing moved) | `TOKEN`'s `ft_transfer` changed by its key holder to return a promise, or to move the balance in a receipt whose returned promise then fails | `on_payout` would count a delivered part as returned and `settle` would write a refund note for money already paid out: one withdrawal paid twice from other users' notes | Not proven. Settles it: a mock token whose `ft_transfer` moves the balance and then returns a failing promise, run through `tests/payouts.rs` | None on chain: the vault trusts `TOKEN` in full, and Circle can already freeze it. Off chain, the relayer's code-hash watch (VT-S16 (d)) stops carrying calls; the exit tool and any other caller of `withdraw` should read the same code hash before they send | Also in the contract review (R-05 (a)) |
| A-07 | Info (documented) | `src/deposit.rs` l.174-182 | A refused deposit depends on the token's `ft_resolve_transfer`, a later receipt: a USDC halt that lands between the move and the resolve, for any sender. On intents.near's `ft_withdraw` path a refusal is credited back to the signer, but a token call that fails whole (USDC halted, or the vault not registered) is not: intents.near refunds nothing then | The deposit stays in the vault's token balance with no note (the halt case), or is lost inside intents.near (that path's two cases) | Documented V:264-322 (cases 1-3), VT-S14, VT-S16 (b) | None in the vault; the kit never deposits through intents.near | New to that review (the paper names both cases) |

Severity counts: Critical 0, High 0, Medium 0, Low 1, Info 6.

### Status (card vault-review-fixes-1, vault lead, 6 Nov)

- A-01: fixed by 0d52db30 on branch card/vault-review-fixes-1. `src/promise.rs` `pay_then_on_payout` makes ONE receipt to TOKEN with `[storage_deposit when register_deposit > 0, ft_transfer(recipient, to_recipient), ft_transfer(fee_recipient, fee) when fee > 0]`, each action its own static gas and weight 1, each `ft_transfer` 1 yocto; `promise_and` is no longer imported (`tests/s01.rs` PROMISES is six). `on_payout` reads exactly one result (`promise::payout_result`): Failed returns the whole withdrawn amount as the refund note and the relayer keeps no fee, as PP's relay. Tests: `payout::tests::vt_u06_a_relayed_payout_is_all_or_none`, `promise::tests::relayed_withdrawal_with_registration_and_fee_is_one_receipt`, `withdraw::tests::a_landed_call_makes_its_payouts_then_on_payout`, sandbox `payouts one_part_fails_{mock,usdc}_{recipient,fee}` (both the recipient and the fee recipient unregistered: delivered 0 to both, refund_pending 2,000,000), and `settle`, `s17`, `relayer_withdraw` re-asserted. Readers: the kit (`packages/kit/src/vault/sync.ts:308`), the wallet's restore (`packages/wallet/src/notes/restore.ts:303-309`) and the helper read `refund_value` from the `spends` view; none derives "withdrawn minus fee", so none changed. The `payout` event and the kit's frozen types are unchanged; `VAULT_ON_PAYOUT.results` in `packages/kit/src/vault/shapes.ts:274` still names two results ("recipient part", "fee part") and is now stale text (no code reads it; changing it moves the kit-freeze-vault live check).
- A-02: documented residual, not fixed: paper V:372-376, the 2.5.4 table (V:461), VT-S08, `src/prepay.rs` l.5-7. Same as R-04.
- A-03: documented residual, not fixed: paper V:466-474, VT-S17 (`tests/s17.rs`); no retry path can exist in a keyless vault. Same as R-02. Larger since A-01 (F-4, for paper 2.5.4 "What is left" and the judge sheet, CO): a failed payout now returns the whole withdrawn value to a refund note, so VT-S17's stranded-with-no-note amount at head is 9,000,000 (s17 at 0d52db30: "stranded with no note 9000000"), against 1,600,000 at 4a6f1499.
- A-04: fixed by 0d52db30 (with A-01), then changed by 78e0d0c1 after the independent review (F-3). `on_payout` takes its amounts from the spend record only (`outcome(s.withdrawn, ran)`). It keeps the two arguments of the kit's frozen `VAULT_ON_PAYOUT`/`VaultOnPayoutArgs` (`packages/kit/src/vault/shapes.ts:269-276`, named by the kit-freeze-vault live check), never reads them and never panics on them: 0d52db30's `PayoutMismatch` refusal is gone, since a callback that panics strands the spend in_flight. Test: `payout::tests::on_payout_takes_the_amounts_from_the_record_whatever_its_arguments`, 7 argument pairs (this review's scratch case first) x landed/failed, each settling from the record. It fails at 0d52db30 with `PayoutMismatch` and passes at d91072ec.
- A-01 follow-ups (independent review): F-1, at d91072ec. The withdraw relayer (`apps/helper/src/withdraw/send.ts` check 7b) signs nothing while its fee account is unregistered or blocklisted on the token. It reads both at check 7's block and again in the queue before signing; either one failing answers 503 `relayer_low` and logs "relayer fee account not ready". Live check `scripts/live-checks/vault-review-fixes-1.mjs`; `tests/relayer_withdraw.rs` step 3 expects the refusal. F-6, at 78e0d0c1: `scripts/live-checks/vault-skeleton.mjs` allows six promise imports. `promise_and` passes only for the two vaults deployed before one-receipt payouts (`DEPLOYED_BEFORE_ONE_RECEIPT`, by full sha256 and account together), which are keyless and can never change, so no entry is ever added. F-7, at 78e0d0c1: `tests/settle.rs` step 1 also reads 0 NEAR back from the token; USDC's storage_deposit refund is dropped with the failed batch (nearcore runtime `set_error` clears `new_receipts`).
- F-5, for the judge sheet (CO): a failed payout receipt still shows the `ft_transfer` event log of any action that ran before the one that failed. The state is rolled back, but the log stays in the outcome, so a reader must take a payout's result from the vault's `spends` view, never from token logs.
- A-05: documented residual: `tests/s17.rs` l.16-23; every reader takes status from the views, never from logs; unreachable on withdraw at the 100 Tgas margin.
- A-06: documented residual, a trust assumption on the token, not a vault bug: the token's key holder can already move any balance. Paper 2.8; relayer code-hash watch VT-S16 (d). Same as R-05.
- A-07: documented residual: paper V:264-322 (cases 1-3), VT-S14, VT-S16 (b); the kit never deposits through intents.near.

### Checked, no finding

- Every state write comes before the promises (`withdraw.rs` l.298-304, `ragequit.rs` l.99-124). Too little gas fails
  making a promise and rolls the whole receipt back; `check_gas` only names that case. A panic after the promises
  (an event, near-sdk's state write) also rolls everything back and drops the promises.
- `on_payout` is `#[private]`, and each spend gets one callback: it refuses any status but `in_flight`, and `settle`
  refuses `in_flight` and `settled`, so one spend yields at most one refund note.
- A part's result is read only as Successful or Failed, its content never copied into wasm (`max_len` 0; the host
  still charges the register copy by length, and the pinned token returns nothing).
- No `ft_transfer_call`, `approve` or `storage_unregister` is ever sent, so the vault never receives `ft_on_transfer`
  or `ft_resolve_transfer` from its own payouts, and no token callback re-enters it. `ft_on_transfer` answers only
  `TOKEN`.
- `totals.returned` counts a bounce once (`on_payout`); `settle` adds nothing. During `in_flight` row 9 is
  conservative (the amount counts as spent until the callback says otherwise).
- Storage: the prepay pays the deposit, the attachment pays withdraw and ragequit plus a 389 B reserve, the reserve
  pays the refund note, the caller pays any shortfall. The state record is a fixed size after the first write (the
  deploy's 0.01 N), and the first write is always a `storage_prepay`. The vault's NEAR above its storage and its open
  reserves only grows (every outflow is matched by an inflow in the same receipt), so no caller can push `on_payout`
  into `LackBalanceForState`; only a price rise can (A-03).
- Gas at the limit: the parts' statics are the same for the recipient and the fee transfer, so no attached-gas choice
  starves one part but not the other; a part that runs out of gas bounces into a refund note. `on_payout` gets at
  least its 30 Tgas whatever the caller attaches.
- NEAR's ordering of part 0 and part 1 is unspecified. Neither depends on the other today; under A-01's fix there is
  one receipt and no order.

## Cross-check with the contract review

Read once, after the table above was written (`vault-review-opus-contract.md`, code 85f232f; the vault's `src/` is
the same 6,351 lines at a7e7300e).

- Mine also in that review: A-02 (R-04, R-06), A-03 (R-02), A-06 (R-05 (a)).
- Mine that are new: A-01, A-04, A-05, A-07. A-01 is the one that matters: the contract review's Dev 4 row and its
  async table check that each part fails as a whole, not that the two parts can land apart.
- Theirs outside this scope, not re-checked here: R-01 (precommitment 0 accepted by the deposit), R-03 (a full page of
  `spends` burns 497 Tgas as a view), R-07 (dust filling the tree).
- One point I take from it: R-02's reading that near-sdk's `storage_byte_cost()` is a compiled constant, now cited
  in A-03. No disagreement on any shared finding's severity.

## Scratch tests

Scratch copy: `git archive a7e7300e contracts/vault packages/kit/src/vault packages/kit/test/vectors/vault-v1.json`
into `<local path>`,
plus one file, `contracts/vault/src/review_async.rs`, and the line `#[cfg(test)] mod review_async;` at the end of
`src/lib.rs` (test builds only; the wasm is unchanged). It uses the mocked chain exactly as `src/payout.rs`'s own tests do.
Below, `<scratch>` is
`<local path>`.

1. Unit tests (mocked chain), 05:26Z, through the Mac queue:

   ```
   HEAVY_REMOTE=0 <research repo>/scripts/heavy.sh vault-review-async-unit -- \
     bash -c "cd <scratch>/work/contracts/vault && CARGO_TARGET_DIR=<scratch>/target \
       cargo +1.96.0 test --locked --lib -- review_async vt_u06 relayed_withdrawal --nocapture"
   ```

   Output (`<scratch>/unit-run.log`), rc 0:

   ```
   A-01 RESULT: recipient part Failed + fee part Successful -> status RefundPending, refund_value 1500000, delivered 500000 (the fee): the user's refund note is withdrawn - fee; the fee for an undelivered payout is not returned
   test review_async::a01_fee_is_kept_when_the_recipient_part_bounces ... ok
   A-04 RESULT: on_payout(withdrawn 1000000, to_recipient 1000000000) -> refund_value 1000000000, totals.returned 1000000000 > spent 1000000, spent.checked_sub(returned) = None: no check against the record
   test review_async::a04_on_payout_trusts_its_arguments ... ok
   test result: ok. 7 passed; 0 failed; 0 ignored; 0 measured; 133 filtered out; finished in 0.19s
   ```

   The 7 are the two scratch tests, the four VT-U06 tests and `promise::tests::relayed_withdrawal_with_registration_and_fee`.
   `a01` also asserts the receipt shape: part 0 and part 1 each hold one `ft_transfer` and neither waits for the other
   (`receipt_indices` empty); only the callback waits for both.

2. The team's own sandbox case on the real USDC wasm, as A-01's on-chain proof, 05:26:53Z to 05:29:24Z, through the
   Mac queue (the harness built the release vault from the scratch copy at 231,294 B, sha256
   `7f7e1cd7b20a6f77a6223f3ba90360eb72e7987c94bb72b38156e4cfa8456f0c`, the same bytes the contract review built from
   main 85f232f, so the scratch line in `lib.rs` changed nothing in the wasm; USDC is the pinned
   `b98ccd53…cfe6`, code hash `DVJx7F3d…`):

   ```
   HEAVY_REMOTE=0 <research repo>/scripts/heavy.sh vault-review-async-sandbox -- \
     bash -c "cd <scratch>/work && CARGO_TARGET_DIR=<scratch>/target \
       contracts/vault/tests/harness/run.sh --test payouts one_part_fails_usdc_recipient"
   ```

   Output (`<scratch>/sandbox-run.log`), rc 0:

   ```
   same_call: part to alice.test.near: vault.test.near -> 17208628…33a1 [ft_transfer]: 1.750 Tgas, Failure(... "Smart contract panicked: The account alice.test.near is not registered")
   same_call: part to relayer.test.near: vault.test.near -> 17208628…33a1 [ft_transfer]: 2.034 Tgas, Success(Object {"SuccessValue": String("")})
   same_call: vault.test.near -> vault.test.near [on_payout]: 1.771 Tgas, Success(Object {"SuccessValue": String("")})
   Usdc, Recipient failed: delivered 500000, refund_pending 1500000
   I1: balance 30500000 = deposited 31000000 - spent 2000000 + returned 1500000 (0 in flight)
   test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 7 filtered out; finished in 31.32s
   ```

   The relayer holds its 500,000 fee while the user's 1,500,000 waits as a refund note. The same run also measures the
   gas this review leans on: `withdraw` 41.523 Tgas at depth 3, `on_payout` 1.771 Tgas of its 30, each USDC
   `ft_transfer` 1.750-2.034 Tgas of its 15.

## Verdict

**SHIP.** No Critical, High or Medium finding in NEAR's async rules. A-01 (Low) is a real deviation from Privacy
Pools' atomic relay with a small, contained fix; doing it before the freeze is the reviewer's recommendation, not a
condition.
