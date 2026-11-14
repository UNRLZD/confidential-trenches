# Vault contract review: fresh Opus reviewer (card vault-review-opus-contract)

Reviewer: a fresh Opus agent that wrote none of the vault. Read only: no code changed and nothing committed in the
public repo. Written 2026-11-06, 04:02Z to 05:30Z.

- **Code reviewed:** `contracts/vault/src/*.rs` at public main `85f232fdbad22e594af8f41b181b51c2b522d103`, 6,351 lines,
  read line by line: lib, constants, context, field, tree, poseidon (the wrappers; the constant tables only by their
  tests), deposit, prepay, withdraw, payout, promise, ragequit, settle, verifier, verifier_keys, events. The test suites
  in `contracts/vault/src/tests.rs` and `contracts/vault/tests/` were read for coverage, not re-run whole.
- **Reviewed against:** the vault paper `docs/plan1/vault.md` at research main 956e36a:
  - 2.2-2.5 (the method tables, the rows each finding cites);
  - 2.6 (l.522) and 2.7 (l.565);
  - row V3.7 (l.1225) and the V2.2-V2.6 rows (l.1202-1206);
  - Privacy Pools' four audit reports at PP `c312dcd` (`audit/*.md`, fetched with `gh api` into the scratch folder);
  - NEAR's async rules as the card lists them;
  - near-sdk 5.29.1, near-vm-runner 0.37.4, near-parameters 0.37.4 and zeropool-bn 0.5.11 sources from the cargo
    registry.
- **Scratch:** every scratch test is under
  `<local path>`
  (`repo/` is `git archive` of main at 85f232f for `contracts/vault`, `packages/kit/test/vectors` and
  `packages/kit/zk`, plus the two review test files).

## Verdict

**SHIP.** No Critical, High or Medium finding. Nothing found lets anyone move or freeze money. Every path out of the
vault needs a Groth16 proof under the ceremony keys, or the depositor's own signature plus a commitment proof. Each
of the ten deviations holds its reason in the code. The three Privacy Pools audit notes the vault inherits (2.6: zero
padding, the full tree, a reused nullifier) are still there, as the paper says, and none is exploitable here. Every NEAR async rule is handled; the one gap is the residual the paper already names
(2.5.4, VT-S17). The findings below are one Low and six Info.

| Severity | Count |
|---|---|
| Critical | 0 |
| High | 0 |
| Medium | 0 |
| Low | 1 |
| Info | 6 |

## Findings

| Id | Severity | File:line | Scenario (inputs → wrong outcome) | Proof | Fix (one line) |
|---|---|---|---|---|---|
| R-01 | Info | `src/deposit.rs:80-88`, `src/prepay.rs:21-28` | `storage_prepay("0")`, then the token's `ft_on_transfer` with `{"precommitment":"0",...}` → the deposit lands as a note. Nobody can find a `(nullifier, secret)` with Poseidon(nullifier, secret) = 0, and both the withdraw and the commitment circuit need that preimage, so no proof can ever spend the note and the USDC is locked for good. Withdraw and ragequit refuse a `refund_precommitment` of 0 (`src/withdraw.rs:140-142`, `src/ragequit.rs:76-78`); the deposit path does not, so the two rules differ. Only the sender's own deposit is hurt, and the kit always sends P = Poseidon(n, s) | `tests/review_unit.rs` `r01_a_deposit_on_precommitment_zero_lands_as_a_note`: see "Proof runs" below | Refuse precommitment 0 in `deposit_message` and `precommitment_arg` (`InvalidPrecommitment`), as `refund_precommitment` is refused |
| R-02 | Info (named residual) | `src/payout.rs:130-147`; `src/settle.rs:73-75` | `on_payout` fails → the spend stays `in_flight` for good. `settle` then refuses it (`SpendInFlight`), so a bounced part gets no note and the record's `reserve` never goes back. NEAR does not re-run a failed callback. Ways it can fail: a NEAR storage price rise beyond the vault's free NEAR (`env::storage_byte_cost()` is a constant 1e19 in near-sdk 5.29.1, `env.rs:2703-2705`, so the vault never sees a new price), or a token result so long that copying it into a register uses up the 30 Tgas static (the content is never read, but `promise_result` copies all of it, near-sdk `env.rs:2163-2175`). Only Circle's code sets that result; today's `ft_transfer` returns nothing | Paper 2.5.4 "What is left" and VT-S17 (`tests/s17.rs`) already record this. Callback gas: 1.704-1.714 Tgas of 30 (paper 2.5.4, M) | Answer in writing (keyless: no retry path can exist without a setter); keep the margin and the token code-hash watch (R-05) |
| R-03 | Low | `src/lib.rs:292-314`, `src/lib.rs:166-169`, `src/field.rs:64-81`; the kit's `packages/kit/src/vault/sync.ts:172-176` | The kit reads every list in pages of `PAGE_MAX` (1,000) rows. A full page of `spends` burns 497 Tgas: each row writes 4 field elements as 77-digit decimals by long division, plus 2 account ids and 5 u128s. The protocol's view cap is 1,000 Tgas (`parameters.snap` l.203, `max_gas_burnt_view`), but each RPC node can set a lower cap in its own config (`near-chain-configs` `client_config.rs:836`). Any RPC that caps below about 500 Tgas refuses the first full page of spends, so the kit's sync, and the exit tool, which must run on public RPCs alone (Dev 7), stop there once the vault holds about 1,000 spends. No money moves; the views are only reads | MEASURED, `tests/review_viewgas.rs` `a_full_page_of_each_list_view_and_its_gas` (near-sandbox 2.13.4, the release build of main, 1,000 largest rows written by a state patch, each page sent as a transaction): `spends` 1,000 rows 497.053 Tgas, 500 rows 249.148, 250 rows 125.135; `deposits` 1,000 rows 276.385; `leaves` 1,000 rows 162.548. The sandbox RPC (no cap of its own) served every page. PLAUSIBLE: that a public RPC the kit uses caps lower; a read of each RPC with one full spends page would prove or clear it | Kit side (the vault's code is frozen and `PAGE_MAX` is only a cap): read `spends` in pages of 250 rows (125 Tgas) and halve the page on a gas error; add a test that reads one full page of the largest rows on each listed RPC |
| R-04 | Info | `src/promise.rs:64-80`; `src/payout.rs:80-91` | `register_deposit > 0` and the recipient was already registered when the part runs (a race with another payout, or a stale read), or the part fails → the NEAR comes back to the vault (from USDC for an account already registered, NCS4 `storage_impl.rs` l.45-67; from NEAR's refund receipt for a failed part, paper 2.5.4), where it stays as free NEAR. It does not go back to `payer`, and `reserve` does not grow. That costs the caller about 0.00125 N. Paper 2.5.2 and 2.5.4 name this as the caller's cost | Read from code and the paper; no test needed (documented behaviour) | None in the vault; the kit sets `register_deposit` from a read taken as late as it can |
| R-05 | Info (named residual) | `src/promise.rs:113-138`; `src/deposit.rs:176-178` | The vault's books rest on the token's code: (a) a part read as Failed must have moved nothing; (b) `ft_on_transfer` from TOKEN must mean the amount moved. Circle holds a full-access key to USDC and can replace its code (paper 2.8). New code whose `ft_transfer` moves the funds and then returns a failing promise would be counted twice (paid, and a refund note). A mint path that calls `ft_on_transfer` with no transfer would create notes no USDC backs | Paper 2.8 "The token is not ours"; the code hash is pinned in `tests/fixtures/real-wasm.json` and watched by the relayer and Verify (7.3) | Keep the code-hash watch, and stop carrying deposits and withdrawals when the hash changes (already planned, 7.3) |
| R-06 | Info | `src/withdraw.rs:297-298`; `src/settle.rs:108-109` | Anyone can copy a pending `withdraw` (same args, with their own gas and attachment) → the copy lands, and the copier becomes `payer` and later gets its own reserve back. The relayer's transaction fails with `NullifierAlreadySpent` and the relayer loses only gas. The recipient, fee recipient, fee and `register_deposit` are all bound in `context`, so no money goes anywhere else. Separately, when `payer` is a named account deleted before `settle`, the reserve Transfer fails and that NEAR stays in the vault | Read from code (PP `relay` is open to anyone the same way, `C/Entrypoint.sol:133`) | None: the paper's design ("Copying someone's call ... gains nothing", 2.5.2) |
| R-07 | Info | `src/withdraw.rs:209-213`, `src/tree.rs:84-86` | PP audit "Missing minimum amount for withdrawals" (Oxorio, NO ISSUE): a 1-unit withdraw inserts a change leaf, so dust can fill the state tree toward 2^32, after which no private exit and no `settle` works (paper 2.6, 2.5.5). Here each insert pays its own storage (at least 710 B + the 389 B reserve, about 0.011 N), so filling the tree costs over 4.7e7 N | Arithmetic: 2^32 × 0.011 N | None (inherited, priced out) |

### Status (card vault-review-fixes-1, vault lead, 6 Nov)

- R-01: fixed by eb111b66 on branch card/vault-review-fixes-1: `storage_prepay` (`src/prepay.rs` `precommitment_arg`) and the deposit message (`src/deposit.rs` `deposit_message`, row 2) refuse precommitment 0 with `InvalidPrecommitment`; a refused `ft_on_transfer` panics, so the token's resolve refunds the whole amount. Tests: `prepay::tests::precommitment_zero_is_refused`, `deposit::tests::precommitment_zero_is_refused`, sandbox `deposit_msg precommitment_zero_is_refused_{mock,usdc}` (red at 4a6f1499, green at the branch head). Not fixed, for the CO: the kit's `vaultStoragePrepay` and `vaultDepositMessage` still build P = 0 (`packages/kit/test/vault-messages.test.ts:121` asserts it); the vault now refuses it, so nothing is locked, but the device could refuse it first.
- R-02: documented residual, not fixed. A keyless vault has no second source of truth and no retry path without a setter. Named in paper 2.5.4 "What is left" and VT-S17 (`tests/s17.rs`, updated by this card to the one-receipt payout). Same as A-03. Its size grows with A-01's fix: 9,000,000 stranded with no note in VT-S17 at head, against 1,600,000 at 4a6f1499 (F-4: paper 2.5.4 and the judge sheet need the new figure).
- R-03: not this card: card vault-review-fixes-kit (the kit's page size for `spends`).
- R-04: documented residual, not fixed: the caller's cost, about 0.00125 N, named in paper 2.5.2 and 2.5.4 and VT-S08 (`tests/settle.rs`). Since A-01's fix a failed payout returns the whole attachment (`register_deposit` + 1 yocto per transfer) to the vault as the runtime's refund, which `tests/settle.rs` step 1 now reads (`REGISTER + 2` from `system`). Same as A-02.
- R-05: documented residual (a trust assumption on the token, not a vault bug): Circle's key can already move or freeze any balance. Paper 2.8 "The token is not ours"; the code hash pinned in `tests/fixtures/real-wasm.json` and watched by the relayer and Verify (paper 7.3). Same as A-06.
- R-06: documented residual by design: paper 2.5.2 ("Copying someone's call ... gains nothing"); every payout field is bound in `context`. The deleted-payer reserve stays in the vault (R-04's case).
- R-07: documented residual, inherited from PP (Oxorio NO ISSUE) and priced out: each insert pays its own storage (paper 2.6, 2.5.5); filling 2^32 leaves costs over 4.7e7 N.

## Proof runs

Every run went through `scripts/heavy.sh` on the Mac queue (`HEAVY_REMOTE=0`, since the scratch copy is not a git
checkout), with `cargo +1.96.0 ... --locked`.

- **R-03.** `<local path>` built the release wasm of main with cargo-near (231,294 B, sha256
  `7f7e1cd7b20a6f77a6223f3ba90360eb72e7987c94bb72b38156e4cfa8456f0c`) and the mock token. Then
  `<local path>` ran `cargo +1.96.0 test --locked --features sandbox --test review_viewgas` (output in
  `<local path>`, 04:33Z):

  ```
  REVIEW spends(0, 1000) as a transaction: 497.053 Tgas burnt, ok true, None
  REVIEW spends(0, 1000) as an RPC view: 1000 rows
  REVIEW spends(0, 500) as a transaction: 249.148 Tgas burnt, ok true, None
  REVIEW spends(0, 250) as a transaction: 125.135 Tgas burnt, ok true, None
  REVIEW deposits(0, 1000) as a transaction: 276.385 Tgas burnt, ok true, None
  REVIEW leaves(0, 1000) as a transaction: 162.548 Tgas burnt, ok true, None
  test result: ok. 1 passed; 0 failed
  ```

  The rows are the largest each list holds: 77-digit field elements, 64-character account ids and `u128::MAX`
  amounts. Real rows are about the same size, since field elements are random below p and the kit's accounts are
  64-hex. The test writes them by a sandbox state patch at STATE's offsets from `tests/s10.rs`.
- **R-01.** `<local path>` ran `cargo +1.96.0 test --locked --test review_unit` (output in `<local path>`, 05:01Z).
  `storage_prepay("0")` with 904 B is accepted; the token's `ft_on_transfer` of 5,000,000 on precommitment 0 returns
  `"0"` (all used) and logs `deposited {..., "value":"5000000", "precommitment":"0"}`; `deposits(0, 10)` holds the
  row and `totals.deposited` is 5,000,000: `test result: ok. 1 passed`. (A first run that prepaid only 756 B was refused
  `InsufficientStorageDeposit: the deposit wrote 904 B`, the first insert's two side nodes that paper 2.3 names, not a
  finding.) Today's tests already show row 2 passing P = 0 (`src/deposit.rs:238-239`, `KIT_MSG_ZERO`); none asserts
  that it should be refused.

## The ten deviations (2.7), each against its reason

The table holds the eleven rows of 2.7 (Dev 11, the zero-value ragequit, came after the "ten").

| Dev | Reason (2.7) | Holds in code? | Line |
|---|---|---|---|
| 1 No Entrypoint, no admin | No access key, owner, upgrade, pause or setter | Holds. The exports are only `storage_prepay`, `ft_on_transfer`, `withdraw`, `ragequit`, `on_payout` (`#[private]`), `settle` and the views; no state field names an account with powers; constants are compiled in, with no init and no setter. The import list is VT-S01's (`tests/s01.rs:28-56`) | `src/lib.rs:109-125`, `:237-329`; `src/constants.rs:6-44` |
| 2 No ASP postman | The vault approves every deposit itself; any past root of either tree; removes AW-M-02 | Holds. Every deposit inserts its label (`src/deposit.rs:129`) and every refund note its own (`src/settle.rs:87`); every root goes into a set with no eviction (`src/tree.rs:146`); 0 is never a root (`:131-133`); withdraw checks both sets (`src/withdraw.rs:203-208`). Safe because labels are never removed and the spent set is global | `src/tree.rs:131-148`; `src/withdraw.rs:202-208` |
| 3 NEAR storage | Each deposit pays its own way; no shared reserve | Holds. A new prepay needs ≥ 756 B (`src/prepay.rs:46-49`). The deposit checks its measured bytes against the prepay, measured after the prepaid record is removed (`src/deposit.rs:116-150`). Withdraw and ragequit pay measured bytes + 389 B + `register_deposit` + 1 yocto per transfer (`src/payout.rs:80-124`). Settle pays from the reserve, then from the attachment (`src/settle.rs:95-107`). `on_payout` writes no new bytes. The 200 B state record is paid by the deploy margin (2.8). Residual: the constant byte price (R-02) | as given |
| 4 NEP-141, async payouts | A plain transfer tells the vault for certain whether money moved | Holds. Each part is one receipt to TOKEN with `[storage_deposit?, ft_transfer]` at fixed static gas, then `promise_and`, then `on_payout`; never `ft_transfer_call`. `on_payout` reads each part only as Successful or Failed and panics on anything else (fails closed) | `src/promise.rs:64-138` |
| 5 NEAR encodings | String accounts and no chain id; keccak mod p keeps the circuit; a fresh 16-byte salt per attempt | Holds. `scope` is Borsh of (tag, vault, token) (`src/context.rs:24-36`). `label` is scope ‖ nonce in 64 bytes (`:39-49`). `context` is Borsh of the frozen field order ‖ scope (`:56-81`). The salt is exactly 32 lowercase hex (`:85-100`). The context recompute (`src/withdraw.rs:158-170`) uses `processor` = the current account. The 50 shared vectors pass byte for byte (`src/context.rs:139-209`) | as given |
| 6 Verifier on alt_bn128 | NEAR host functions; no GPL verifier | Holds. Every coordinate is a canonical decimal below q (`src/verifier.rs:59-66`) and every signal is below p (`:96-99`), so no point and no signal has two spellings. Off-curve and off-subgroup points are refused by the host (near-vm-runner `alt_bn128.rs:113-149`, zeropool-bn `AffineG2::new` subgroup check `groups/mod.rs:214-228`). The pairing is snarkjs's 4-pair check (`src/verifier.rs:103-119`). Spends are keyed on the nullifier hash, never on proof bytes, since a proof can be re-randomised | `src/verifier.rs:59-120`; `src/withdraw.rs:239-240` |
| 7 Paged views; no secret-keyed point view | The exit tool works from public data; no RPC learns which note a device holds | Holds on privacy: no view takes a precommitment, a nullifier hash or a prepaid key; only roots, which are public (`src/lib.rs:316-324`). On liveness, see R-03 (a full page's gas) | `src/lib.rs:257-328` |
| 8 Absolute relay fee | A whole number of basis points cannot price a small fee on a large withdrawal | Holds. `relay_fee` is a u128 bound in `context`; the backstop `fee·10,000 ≤ withdrawn·5,000` is computed in exact 256-bit (`src/withdraw.rs:175-187`, `:219-221`); the split is exact and `to_recipient ≥ 1` (`src/payout.rs:61-66`) | as given |
| 9 Refund notes and `settle` | A keyless vault cannot undo a spend; returned money must stay with the proof's maker | Holds. A failed part's amount sets `refund_pending` and `totals.returned` (`src/payout.rs:134-144`). `settle` writes one note of exactly `refund_value` on the `refund_precommitment` the proof bound (withdraw: in `context`; ragequit: the depositor's own argument), with a fresh label in the label tree and no `label_index` row, so it cannot be ragequit (`src/settle.rs:80-93`). One spend gives at most one note (`:73-77`, `:96`). The open case is R-02 | `src/payout.rs:130-147`; `src/settle.rs:61-122` |
| 10 Withdrawal deadline | Every root is kept, so a held request would never expire | Holds. `block_timestamp_ms() > deadline_ms` refuses before anything else in row 2 (`src/withdraw.rs:148-150`), and the deadline is bound in `context`. Ragequit has none and is signed only by the depositor | `src/withdraw.rs:148-150`; `src/context.rs:67` |
| 11 Zero-value ragequit refused | It pays nothing yet would spend a nullifier and write a record | Holds. `value_of` refuses 0 and anything ≥ 2^128 before the gas check, the depositor check and the proof (`src/ragequit.rs:52-60`, `:80`) | `src/ragequit.rs:52-80` |

PP checks with no line in the vault (2.7's second table):

| PP check | Where the vault stands |
|---|---|
| `nonReentrant` | Every write comes before the first promise: withdraw `src/withdraw.rs:298-304`, ragequit `src/ragequit.rs:104-124`, settle `src/settle.rs:96-109`. Between a withdraw and its callback, `settle` refuses `in_flight` and `on_payout` touches only its own record and adds to `totals.returned` |
| `InvalidPoolState` | Row 9, `withdrawn ≤ deposited − (spent − returned)`, each step checked (`src/withdraw.rs:222-229`) |
| `ZeroAddress` | `AccountId` type; the vault and `intents.near` refused (`src/withdraw.rs:151-155`), `DepositorIsTheVault` (`src/deposit.rs:85-87`) |
| `PoolIsDead`, `onlyEntrypoint` | No wind-down and no Entrypoint; `processor` = this vault in `context` (`src/withdraw.rs:159`) |

## Privacy Pools' audit findings (2.6), each against this code

| Report | Finding (status at PP) | This vault exposed? | Line |
|---|---|---|---|
| Circuits (Oxorio) | Unused `stateTreeDepth` / `ASPTreeDepth` (FIXED: squared in the circuit) | No: the fixed circuit and keys are reused byte for byte, and the vault also refuses a depth over 32 | `src/withdraw.rs:197-201` |
| Circuits | Inclusion proof manipulation, several proofs per leaf through zero padding (ACKNOWLEDGED, accepted, paper 2.6) | Inherited, not exploitable: state leaves are Poseidon(3), so no internal Poseidon(2) node can pass as a leaf. A label in the label tree must also be the label inside a real state leaf. A spend is keyed on the nullifier hash, so a second proof of one leaf is refused | `src/withdraw.rs:236-240`; `src/tree.rs:175-181` |
| Circuits | `nullifier` / `secret` collision (FIXED in circuit) | No: the fixed circuit | n/a (circuit) |
| Circuits | No check on `existingValue` (FIXED: deposits below 2^128) | No: amounts are u128, `u128::MAX` refused at deposit, refund values ≤ the spend, change values bounded by the circuit | `src/deposit.rs:112-114` |
| Circuits | Uninitialized `main`, unused signals, anonymous components, check order (ACK / INFO) | No: circuit build only | n/a |
| Circuits | No non-zero `withdrawnValue` in circuit (NO ISSUE) | The vault refuses 0 (as PP's relay does), so there is no zero-value rotation; a 1-unit withdraw still rotates a note | `src/withdraw.rs:210-213` |
| Contracts (Oxorio) | Sending to the zero address (FIXED) | No: valid `AccountId` only; the vault and `intents.near` refused. A non-existent named recipient is the device's to refuse (kit rule, 2.5) | `src/withdraw.rs:151-155` |
| Contracts | No private withdraw once the tree is full (ACKNOWLEDGED) | Inherited; here it also stops `settle` (paper 2.5.5) | `src/tree.rs:84-86` |
| Contracts | Deanonymisation by ragequit of a change note (NO ISSUE) | Inherited, documented (paper 2.5.3) | `src/ragequit.rs:94-97` |
| Contracts | Missing relay data checks (FIXED: fee cap) | No: the absolute fee bound in `context` plus the 50 % backstop | `src/withdraw.rs:219-221` |
| Contracts | Missing new pool checks, postman/owner validation, deposit fee front-run, `withdrawFees` zero address, relay after pool removal (various) | No: no Entrypoint, no pools, no owner, no fees (Dev 1) | n/a |
| Contracts | Token decimals in fee calculation (ACKNOWLEDGED) | No: the fee is an absolute amount (Dev 8) | `src/withdraw.rs:144` |
| Contracts | Shared ASP tree across pools (ACKNOWLEDGED) | No: one label tree per vault | `src/lib.rs:115` |
| Contracts | No minimum withdrawal, dust fills the tree (NO ISSUE) | In form only; each insert pays its storage (R-07) | `src/payout.rs:106-124` |
| Contracts | Only the latest ASP root accepted (NO ISSUE) | Every label root accepted, which is safe: labels are never removed (Dev 2) | `src/withdraw.rs:206-208` |
| Contracts | Info items (expression twice, constants, redundant parameter, hardcoded number) | No: Entrypoint-only | n/a |
| Auditware | AW-M-01 insecure `approve` | No: the vault never calls `approve`; VT-S01 checks the method names in the wasm | `src/promise.rs:10-12` |
| Auditware | AW-M-02 root history overwrite | Removed: every root kept, none evicted | `src/tree.rs:146` |
| Auditware | AW-M-03 unaudited Poseidon library | Not this library: light-poseidon 0.4.1 (Veridise-audited) in the trim build, held to `new_circom` and circomlib's vectors (VT-U01). Inputs ≥ p are refused, never reduced | `src/poseidon.rs:63-75` |
| Auditware | AW-L-01 postman DoS; a failed transfer reverts the withdrawal | Postman: none. A failed transfer becomes a refund note, never a revert (Dev 9) | `src/payout.rs:134-144` |
| Auditware | AW-L-02 wrong index returned | n/a; `leaf_inserted.index` is the 0-based position, documented | `src/tree.rs:143-147` |
| Auditware | AW-L-03 unbounded relayer fee | Backstop 50 %; the device's own `fee_max` is the real bound (paper 2.2) | `src/constants.rs:26`; `src/withdraw.rs:185-187` |
| Entrypoint upgrade (Oxorio) | Nullifier reuse with a different secret passes the precommitment check (ACKNOWLEDGED) | Inherited, accepted in 2.6: the vault checks the precommitment only, and refund notes check none (by design, I2). The kit derives every nullifier from the 12 words, an index and a domain tag | `src/deposit.rs:104-106` |
| Entrypoint upgrade | Check order (INFO) | The vault checks the precommitment first | `src/deposit.rs:103-106` |

## NEAR's async rules

| Rule | Where it is handled | Holds? |
|---|---|---|
| A callback after a failed promise | `on_payout` reads each part's result as Successful or Failed only, checks the count (1 without a fee, 2 with one) and panics on anything else before any write (`src/promise.rs:113-138`, `src/payout.rs:131-147`). A receipt's actions fail together (`[storage_deposit, ft_transfer]`), so Failed means nothing moved | Yes |
| State written before a cross-contract call and not rolled back | The spend (nullifier, change leaf, record, totals) is final by design. Every failed part's amount becomes a refund note (`src/payout.rs:139-143`); nothing is un-spent | Yes (R-02 is the callback's own failure) |
| Storage staking | Every writing call measures `storage_usage()` and charges it from the caller: `src/deposit.rs:144-150`, `src/payout.rs:106-124`, `src/settle.rs:99-107`; prepay ≥ 756 B (`src/prepay.rs:46-49`); `on_payout` and `charge_storage` are same-size overwrites | Yes; the residual is a price change (R-02) |
| `predecessor_account_id` vs `signer_account_id` | `signer_account_id` is used nowhere. `ft_on_transfer` checks predecessor = TOKEN (`src/deposit.rs:176`); `ragequit` checks predecessor = the label's depositor (`src/ragequit.rs:84-88`); `on_payout` is `#[private]` (`src/payout.rs:130`); `payer` = predecessor (`src/withdraw.rs:297`) | Yes |
| Gas running out mid-promise or in the callback | Each promise reserves its static gas when it is made, so a short attachment fails the whole receipt, the spend with it (`src/promise.rs:64-107`). Pre-check: statics + 100 Tgas (`src/payout.rs:54-58`). The callback gets 30 Tgas plus a weighted share and burns about 1.71 | Yes; R-02 for the residual |
| A refund path callable twice | `on_payout` needs `in_flight` (`src/payout.rs:136-138`); `settle` needs `refund_pending` or `paid` and writes `settled` (`src/settle.rs:73-77`, `:96`); each nullifier is spent once (`src/withdraw.rs:239`, `src/ragequit.rs:100`) | Yes |
| Reentrancy across a promise boundary | All writes come before the promises, and events after them (`src/withdraw.rs:298-322`). A receipt that runs between a withdraw and its callback sees finished state: `settle` refuses `in_flight`, a new withdraw needs its own nullifier, and the change note can be spent at once without touching the in-flight record | Yes |

## V2.2-V2.6 and V3.7 (paper l.1202-1206, l.1225)

| Row | Contract side | Status from this read |
|---|---|---|
| V2.2 encoding, Groth16 verify, key generator | `src/verifier.rs`, `src/verifier_keys.rs` (generated, sha256-pinned to the `.vkey`; `tests/vkey.rs` fails on drift) | Encoding matches the host's (LE, Fq2 c0 then c1); real-proof, bit-flip, +q and off-curve tests in `tests/groth16.rs:157-269` |
| V2.3 shared vectors | `src/context.rs:139-209` against `packages/kit/test/vectors/vault-v1.json` (8 scope, 10 label, 32 context) | Byte for byte, both sides |
| V2.4-V2.6 prover worker, phone timing, input builder | Device side, not in the contract | Out of this review's scope |
| V3.7 outside-eyes review | This report (the Opus half; the second model family is a separate card) | Done; findings above, each with its status |
