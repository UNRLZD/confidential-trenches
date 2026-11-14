# Pre-audit security scan: Confidential Trenches contracts at 46b16ca4

- **Repo:** UNRLZD/confidential-trenches, main at `46b16ca48be23c19dace0cddfe4c75a3bab0f0d9`, read in a detached
  worktree. The repo was only read: nothing was committed, and nothing was sent on any chain.
- **Scope:** `contracts/vault/src` (NEAR, Rust), `contracts/pool-evm/src` (Solidity) and `contracts/pool-solana/src`
  (Solana, Rust).
- **Method:** cloudflare/security-audit-skill. The installed copy's `PINNED.txt` says it is
  `cloudflare/security-audit-skill skills/security-audit at c1c8a8c1471069fb0e188eeaff69b8e8db6564a8`, which is the
  pinned commit. On top of it, the EVM, Solana, ZK-verifier and NEAR checklist from the brief.
- **Who did what:**
  - The EVM pool is my own read.
  - The vault and the Solana pool each went to a separate hunter agent, briefed only with scope, checklist and rules.
  - I re-read the source behind every candidate the hunters returned before ranking it.
- **Builds and tests at this sha:** CI run 42362082423 (push of 46b16ca4) is green. That covers:
  - test-vault;
  - the 4 vault-sandbox shards;
  - pool-solana (LiteSVM suite on the pinned build);
  - test-scripts (forge: 288 tests passed, 0 failed);
  - slither.

## Verdict: CLEAR

No High or Medium finding in any of the three contracts. There are three Lows (L-S1 Solana, proven by a test; L-V1 NEAR, argued; L-E1 EVM, shown by the repo's own test) and two Infos. None loses or freezes user funds, spends a note twice, or lets anyone but the note's owner choose where its value goes. The Lows are griefing or a design residual: none gives the attacker more than an honest run would, and L-V1 and L-S1 cost their target (the relayer, or a sender's time) rather than any user's money. The Infos are operational notes for the release and the auditors.

## Findings

### L-S1 (Low). Over 1,024 inserts landed in one window push a release or deposit past both pages it names, so it fails until rebuilt

- **Where:**
  - `contracts/pool-solana/src/state.rs:274-279`: `page_for` picks only `page` or `next`.
  - `contracts/pool-solana/src/state.rs:319-333`: `push_entry` refuses any page that is not the index's own, with
    `WrongAccount`, error 22.
  - `contracts/pool-solana/src/release.rs:155`: a release takes only 8 or 9 accounts. The same holds for
    `deposit.rs:72-76` and `buy.rs:155-159`.
  - Pages hold 1,024 entries (`state.rs:73`).
  - This is what is left after review 2's F1 fix (R-1, the next page). It is new ground: the fix tolerates exactly one
    page crossing.
- **Who attacks:** any depositor.
- **Scenario:**
  1. A sender reads the state tree at slot `s` of page `k`, and names pages `k` and `k+1`, as R-1 allows.
  2. Before it lands, the attacker lands at least `2048 - s` minimum deposits. That is 1,025 at `s = 1023`, all within
     one blockhash window.
  3. The change leaf's index is now on page `k+2`. `page_for` falls through to `next`, and `push_entry` refuses it
     (`if addr != *page.key { return Err(PoolError::WrongAccount.into()); }`, `state.rs:322-324`).
  4. Every tag 1, 2 or 3 transaction built in that window fails.
- **Impact:**
  - Nothing is lost or locked. The transaction fails whole, and a resend with fresh pages lands the same proof, since
    roots are named by index.
  - The cost to the attacker, per blocked window:
    - measured at LiteSVM rent: 3,018,397 lamports per deposit;
    - estimated at mainnet rent: about 2.47M per deposit, so about 2.5 SOL per window.
  - Each 1,000,000-lamport note is below the smallest release (`lib.rs:52-57`), so it cannot be withdrawn on its own.
- **Fix, optional:** the device treats error 22 as "rebuild with fresh pages and resend". Alternatively, the program
  could accept the index's own page by address, wherever it is.
- **Proof:** a test. `hunt_inserts_past_the_next_page_fail_a_release_until_rebuilt`, in
  `wt/contracts/pool-solana/svm-tests/tests/hunt.rs`.
  - hunt.rs is a scratch copy of the svm `release.rs` tests with two tests added; the repo's own tests are untouched.
  - The Solana hunter ran it on the box through heavy.sh, on the pool program built with `cargo-build-sbf --locked`.
  - The log at `scratchpad/hunt-pool-sol.log` (lines 349-354) reads:
    - `HUNT stale release after the stranger's inserts: Some(22)`;
    - `HUNT rebuilt release landed: change leaf at 2048`;
    - `test result: ok. 2 passed`.
  - I re-read `page_for` and `push_entry` (`state.rs:266-342`) and the log myself.

### L-V1 (Low). A user can bounce their own relayed NEAR payout after the relayer's checks pass; the relayer pays and gets no fee

- **Where:**
  - `contracts/vault/src/promise.rs:82-95`: the payout is one receipt to the token, all actions or none.
  - `contracts/vault/src/payout.rs:136-150`: on a Failed result, `on_payout` marks the spend `refund_pending` with
    `refund_value = withdrawn`.
  - `contracts/vault/src/settle.rs:80-90`: `settle` turns that into a full-value refund note.
  - The off-chain control it gets past is `apps/helper/src/withdraw/send.ts:12-15`, check 7: `register_deposit` is 0
    when `storage_balance_of(recipient)` is set, read at an agreed final block.
- **Who attacks:** a note owner, who also holds the key of the recipient account they named.
- **Scenario:**
  1. The owner names a recipient that is registered on USDC with a 0 token balance. The device sets
     `register_deposit = 0`, the context binds it, and the helper's check 7 passes.
  2. After the helper's final-block read, and before the payout receipt runs on the token (the read trails the head
     by the finality lag, and the payout is a separate receipt a block or more after the vault's), the recipient calls
     USDC's `storage_unregister`.
  3. `ft_transfer` panics, so the whole payout receipt fails. `on_payout` records `refund_pending` for the full
     amount. Nothing moves, the fee included.
  4. Anyone may call `settle`; it writes a full-value refund note. The owner can repeat this from the refund note,
     with a fresh recipient each time.
- **Impact:**
  - No user funds are lost, and the vault behaves as specified.
  - Each round the relayer (the helper's NEAR) loses the withdraw's gas and the storage of the change leaf and spend
    row, about 0.02 NEAR (argued from the 100 Tgas pre-check plus a few hundred bytes).
  - It earns no fee.
  - The attacker pays one transaction plus a registration they get back on unregister.
  - The helper cannot block repeat offenders, because each new withdrawal is unlinkable by design.
  - This fits the skill's Low anchor: sustained effort for minimal gain.
- **USDC really has `storage_unregister`:**
  - The repo's harness says USDC's code is near-contract-standards 5.29.1 NEP-141/145
    (`contracts/vault/tests/harness/mod.rs:55-60`).
  - The wallet refuses `storage_unregister` on one-time ids because "the token would burn a refund to it"
    (`packages/wallet/src/deposit/bind.ts:312`).
- **Fix (helper side; no vault change):** price the bounce risk into the relay fee, or attach
  `storage_balance_bounds().min` every time. The second has its own cost: see I-V3.
- **Proof:** argued only. Not reproduced. The test to write is a near-sandbox case in
  `contracts/vault/tests/relayer_withdraw.rs` on the real USDC wasm (`TokenKind::Usdc`):
  1. register the recipient;
  2. build the withdraw with `register_deposit = 0`;
  3. call `storage_unregister` from the recipient before the payout receipt;
  4. assert `spends()[i].status == refund_pending`, the fee recipient's USDC unchanged, and the relayer's NEAR down.

### L-E1 (Low). A failed EVM buy now pays the relay fee for a trade that did not happen

- **Where:** `contracts/pool-evm/src/PrivacyPoolSimple.sol:64-65` (the fee is paid before the swap) and `:96-97`
  (a failed swap pays W `withdrawn - fee` in ETH). This came in with card pool-evm-buy-pays-revert (6059b2af). It is
  after review 3, so it is not a repeat.
- **Who attacks:** whoever can make the swap fail when the buy lands. That could be:
  - a sequencer that reorders transactions;
  - anyone who moves a thin pool's price past `minOut` in the same block;
  - a route whose token or hook the sender can steer.
- **Scenario:** the sender, or a party working with it, pushes the price past `minOut` just before W's signed Buy
  lands. buySwap reverts with MinOutNotMet, the note is spent, the bound fee recipient keeps up to `feeCap`, and W gets
  ETH instead of the token. Before 6059b2af the whole buy reverted: no fee, and the note stayed unspent.
- **Impact:**
  - W loses at most the fee it signed (`feeCap`, at most half of `withdrawnValue`), and its trade.
  - Only the context-bound fee recipient gains. Its gain equals the fee it would have earned on an honest buy, so a
    third party gains nothing and the helper gains nothing extra.
  - NOTICE change 18 states this outcome as intended, and the residual is a product trade-off. It is listed here so
    the auditors see it. The device should keep `feeCap` at the fee it means to pay (review 3, I-1).
- **Proof:** shown by the repo's own test.
  - `contracts/pool-evm/test/Buy.t.sol` `test_minOutNotMetPaysOut` runs a short swap through `_paysOut`. `_paysOut`
    asserts that buy returns false (`:139`), that "the fee recipient got the fee" (`:143`) and that "W got the rest in
    the native asset" (`:144`).
  - It is `[PASS]` in CI job 128373145757 at 46b16ca4.

### I-V2 (Info). The permanent mainnet test vault runs pre-fix code, and the helper still names it as the mainnet vault

- **Where:**
  - `contracts/vault/deployments/mainnet-test.json`: `vault-test.confidential.unrlzd.near`, keyless, on mainnet USDC,
    built at main 1656ae5a.
  - `apps/helper/src/withdraw/send.ts:514`: `MAINNET_VAULT = "vault-test.confidential.unrlzd.near"`.
  - `packages/kit/src/near/networks.ts:28`: the kit's mainnet `vault: null`.
- **What I checked:** `git merge-base --is-ancestor` reports that none of these fix commits is in that build:
  - 0d52db30 (A-01 and A-04, the one-receipt payout);
  - eb111b66 (R-01);
  - 78e0d0c1 (F-3).

  The vault cannot be upgraded, so it keeps the pre-fix payout path for good.
- **Why it is only Info:** the audited code is fine. The risk is operational: until mainnet-v1.json lands, the helper
  carries mainnet withdrawals for the test vault. Its comment says the commit that adds mainnet-v1.json changes the
  constant, and its test fails otherwise.
- **Action:** make sure no user deposit is ever routed to the test vault, and that the release commit swaps the
  constant.

### I-V3 (Info). NEAR given to the token beyond registration comes back to the vault and stays there

- **Where:** `contracts/vault/src/promise.rs:83-86` sends `storage_deposit(recipient, registration_only: true)` with
  `register_deposit` attached.
- **The mechanism:** near-contract-standards (USDC's code) refunds the whole deposit to the predecessor when the
  account is already registered, and the excess over the minimum otherwise. The predecessor is the vault.
- **Scenario:** a stranger registers W just before the payout. The relayer's `register_deposit` (0.00125 NEAR) then
  lands in the vault's NEAR balance, which no method pays out.
- **Impact:** griefing at equal cost to the stranger, and dust in the vault. No user funds are touched.
- **Proof:** argued only, from the NCS refund rule. The repo does not hold the USDC source.

## EVM pool (contracts/pool-evm/src): checked and sound

Read in full: PrivacyPool.sol, PrivacyPoolSimple.sol, State.sol, SellDelegate.sol, FeeCollector.sol,
adapters/UniswapV3Adapter.sol, adapters/UniswapV4Adapter.sol, lib/ProofLib.sol, the checks in
verifiers/WithdrawalVerifier.sol, and the RelayData and Buy structs in interfaces/IPrivacyPool.sol.

- **Reentrancy, single-function and cross-function.** Every pool entry (deposit, withdraw, buy) holds the transient
  guard (State.sol:83-88 `_entered`). The nullifier is marked and the change leaf inserted inside `_spendChecked`
  (PrivacyPool.sol:260-263) before any ETH moves. buySwap answers only the pool itself (PrivacyPoolSimple.sol:111), and
  runs inside buy's guard, so an adapter calling buy, withdraw, deposit or buySwap is refused (test_anAdapterCannotReenter,
  test_R_feeRecipientCannotReenterBuy). SellDelegate.sell holds its own transient guard at an ERC-7201 slot
  (SellDelegate.sol:143-144, :198); unlockCallback runs only from the PoolManager with the exact payload hash set by the
  sell (:210-212).
- **Read-only reentrancy.** No contract reads pool state on chain during a callback. During buySwap's adapter call the
  pool's state is already final for the spend (nullifier marked, leaf inserted, fee paid); a failed swap leaves the
  same state, and the rest is paid to W (:97). Nothing on chain depends on a mid-call view.
- **External call return handling.** `_push` reverts on a failed send (PrivacyPoolSimple.sol:160-161). SellDelegate's
  `_approve` and `_transfer` accept true or empty return and revert otherwise (:314-328); the router call bubbles its
  revert (:171-176). The buy self-call's return data is copied only on success and only 32 bytes from the pool's own
  code (:77-83), so a reverting adapter's return data (a return-data bomb) costs the failure path nothing.
- **The buy failure path (card pool-evm-buy-pays-revert, 6059b2af and 3c424cd7).** The swap is an external self-call
  given `gas() - BUY_FAIL_GAS` (:78); the 63/64 rule leaves the caller at least max(150,000, G/64) after a swap that
  burns everything, and the push plus Withdrawn use 51,214 of it (test_gasTheFailurePathUsesOfItsReserve). The floor
  check (:75) means the swap frame gets at least 500,000 (test_theSwapGetsAtLeastBuySwapGas) and a sender who sends
  less lands nothing (test_R_gasGriefingLandsNothing). A failed swap is undone alone: the ETH sent to the adapter comes
  back with the revert, and W gets `withdrawn - fee` (:97). The fee goes only to the context-bound feeRecipient.
- **Approvals and allowance races.** The pool never approves. SellDelegate approves exactly the amount, in the same
  call as the router call, and requires the allowance to end at 0 (:170, :177), so no standing allowance exists to race.
- **Fee-on-transfer and rebasing tokens.** buy measures W's balance rise across the swap (:113-116), so a taxed or
  rebasing token cannot fake minOut. SellDelegate requires W's balance to fall by exactly the signed amount (:183) and
  measures ETH gained (:189); the v4 sell settles with `sync`/`settle`, which credits only what arrived (:247-249).
- **Uniswap v4 hooks and callbacks.** Both unlockCallbacks check `msg.sender == POOL_MANAGER` (UniswapV4Adapter.sol:92,
  SellDelegate.sol:210); the PoolManager calls back only the contract that called unlock, and SellDelegate also pins the
  payload hash (one-shot). Each hop must take its whole exact input (adapter :121, delegate :241); the last currency
  must be native or WETH on a sell (:216-217); minOut bounds a hooked hop. Hooks are in the route W signs.
- **Gas griefing and the 63/64 rule.** Covered above for buy. withdraw and sell are all-or-nothing: an out-of-gas
  anywhere reverts the whole call, and the nullifier or the sell nonce stays unused.
- **Signature replay and chain id.** The pool's EIP-712 domain reads `block.chainid` and `address(this)` at each call
  (PrivacyPool.sol:194-196); Withdraw and Buy have distinct typehashes and each signs the proof's nullifier, context and
  value (:63, PrivacyPoolSimple.sol:39-41); s is capped at n/2 and the signature is exactly 65 bytes (:205-216);
  ecrecover's 0 never equals a recipient, which is refused when 0 (:176). SellDelegate's domain names W and the chain
  (:271-272), its nonce makes each Sell single-use (:152-153), and its typehash differs from the pool's two.
- **Storage collisions.** SellDelegate keeps its one stored value (the nonce) at an ERC-7201 slot of W (:70) and its
  guard and v4 flag at ERC-7201 transient slots (:73, :77); WETH and the PoolManager are immutables in code. The pool
  is not a proxy.
- **selfdestruct or code changes of called contracts.** The constructor pins the code hashes of PoseidonT3,
  PoseidonT4 and the verifier (State.sol:98-100). The verifier source has no SELFDESTRUCT. Probe: an opcode walk of
  poseidon-solidity 0.0.5's T3 and T4 init code (test/fixtures/poseidon-deploy.json, salt stripped, PUSH data
  skipped) finds no SELFDESTRUCT, CALL, CALLCODE, DELEGATECALL, STATICCALL, CREATE, CREATE2 or SSTORE, so the code at
  the pinned addresses cannot remove or change itself. The adapters, SellDelegate and
  FeeCollector have no SELFDESTRUCT or owner (grep of src/: the only hit is SellDelegate.sol:42's comment). The v4 PoolManager is
  not upgradeable; Robinhood's WETH is an upgradeable proxy, which review 2 (F3) handled for sells to native ETH.
- **ZK binding.** The context is `keccak256(abi.encode(withdrawal, SCOPE)) mod p` (PrivacyPool.sol:236) with
  `processooor == this` (:233) and RelayData exactly 192 bytes (:150-153); RelayData carries recipient, feeRecipient,
  feeCap, deadlineMs, refundPrecommitment and salt (IPrivacyPool.sol:45-52); SCOPE binds pool address, chain id and
  asset (State.sol:105). The fee is the sender's pick up to the bound cap (review 3 I-1, known). Nullifiers are a
  mapping checked and set once (State.sol:152-158); all 8 public signals are range-checked against r before the
  pairing (WithdrawalVerifier.sol:194-208); the precommitment is checked below p (PrivacyPool.sol:90). Roots: every
  root either tree has had is accepted (State.sol:172, :188, :198-209), which is safe here because the label tree only
  grows (no ASP removal). Groth16 proof malleability does not matter because uniqueness is the nullifier, not the proof.
- **Verifier key pinning.** The verifier is snarkJS's generated contract with the key in code, pinned by code hash at
  pool construction (State.sol:50, :100). Its alpha (0x245229d9...e2c7) and IC0 (0x2e3f15ca...ab85) are the same
  points as pool-solana/src/vk.rs (generated from packages/kit/zk/withdraw.vkey, sha256 666bd098...) and, byte-reversed,
  vault/src/verifier_keys.rs WITHDRAW: one ceremony key on all three chains.
- **No admin path.** No owner, setter, pause, upgrade or SELFDESTRUCT in any EVM contract read.
- **Slither** (CI job `slither`, run 42362082423, job 128373145769, at 46b16ca4): slither-analyzer 0.11.6 hash-pinned,
  150 hits (High 10, Medium 8, Low 15, Informational 117); every High and Medium is listed with its reason in
  contracts/pool-evm/slither/triage.json and the gate passed. I checked the triage reasons for arbitrary-send-eth
  (`_push`, `sell`), incorrect-return (the snarkJS verifier), reentrancy-balance (`buySwap`, `sell`) and
  unchecked-transfer (the v4 adapter's WETH9 transfer) against the code above, and agree with each. I did not
  re-read the remaining triage entries one by one.

## NEAR vault (contracts/vault/src): checked and sound

These are from the vault hunter's report. I re-read the lines marked (re-read). The hunter ran the vault's unit tests
for ragequit, settle, payout, field, verifier and withdraw through heavy.sh: 60 passed, 0 failed (771 s, on the box).

- **Public-signal binding.**
  - `ContextFields` binds processor (the vault), recipient, `register_deposit`, `fee_recipient`, the exact `relay_fee`,
    `refund_precommitment`, `deadline_ms` and salt (context.rs:58-69, re-read).
  - The context is compared with signal 7 under the vault's scope.
  - `to_recipient = withdrawn - fee`.
  - The relay fee is exact here, unlike the EVM pool's cap.
  - The ragequit proof binds no context, but only the deposit's named depositor may call it (ragequit.rs:83-88; header
    re-read).
- **Nullifier.** Checked and marked spent in the same receipt, before the promise. Never cleared. A bounced payout
  becomes a refund note on a new precommitment, so the old nullifier stays spent.
- **Roots and depths.** Every root is kept, 0 is refused, and both depths are capped at 32. Labels come from a
  strictly increasing nonce, so nobody can pre-insert a refund note's commitment to block a settle.
- **Field range and malleability.** Signals must be canonical decimals below p, proof coordinates below q, and spends
  are keyed on the nullifier, not the proof bytes. On-curve and subgroup checks are left to nearcore's alt_bn128 host
  functions (argued).
- **Key pinning.**
  - Both keys are compile-time constants with no setter (verifier_keys.rs).
  - Delta differs from gamma in both, so each key had a phase-2 contribution.
  - WITHDRAW's alpha and IC0, byte-reversed, equal the EVM verifier's and Solana's `vk.rs` (my comparison of alpha and IC0 on all three).
- **Promise callbacks and their failure paths (re-read).**
  - One payout receipt, then `on_payout`. The count must be exactly 1, and the result is read only as Successful or
    Failed (promise.rs:82-126).
  - Successful marks the spend `paid`. Failed marks it `refund_pending` for the full amount (payout.rs:136-150).
  - `settle` refuses an in-flight spend (settle.rs:73-77).
  - So no note is paid twice, and none is spent without a payout or a refund note. An `on_payout` that itself fails
    leaves the spend in flight: the documented VT-S17 case.
- **`#[private]`** on `on_payout` (payout.rs:135, re-read).
- **Storage staking.** Every writer pays for its bytes: deposit, withdraw, ragequit, settle and `storage_prepay`.
  `on_payout` overwrites a record of the same size. NEAR leaves the vault only as the reserve's rest to the payer and
  the caller's own unused attachment.
- **No keys.**
  - The only promise actions are `promise_batch_action_function_call_weight` and `promise_batch_action_transfer`
    (promise.rs:64, :133).
  - A grep of src/ for add_key, access_key, deploy_contract, delete_account, delete_key, stake, global deploy,
    state_write, migrate and `init(ignore_state)` finds none (my grep).
  - The built wasm's imports are the live check's job (`scripts/live-checks/vault-skeleton.mjs`).
- **Cross-contract gas.** Prepaid gas must cover the statics plus 100 Tgas (payout.rs:57-61). `on_payout`'s static is
  30 Tgas. A static that cannot be reserved fails the whole receipt.
- **Reentrancy between promise and callback.** No `ft_transfer_call`, and nothing read before the promise is assumed
  after it.
- **`ft_on_transfer`.** Only TOKEN may call it (deposit.rs:182-184, re-read). The message is parsed strictly, and any
  refusal panics so the token refunds the sender.
- **Arithmetic.** Overflow checks are on in release (Cargo.toml). The fee backstop's products are exact, the split
  refuses a fee of the whole amount or more, and every total uses checked math.
- **Ragequit and settle.** Ragequit is depositor-only through `label_index`. Refund notes get no `label_index` row,
  so they can never be ragequit. A ragequit and a withdrawal of one note spend the same nullifier hash. Anyone may
  call `settle`, but its outcome is fixed.

## Solana pool (contracts/pool-solana/src): checked and sound

From the Solana hunter's report. I re-read state.rs:266-342 and buy.rs:95-245, and release.rs:150-245.

- **Every write and CPI is gated.**
  - Lamports are debited only from `pool_acc` (release.rs:276).
  - Data is written only to:
    - the pool, after `Pool::load`'s owner, length, discriminator and bump checks (state.rs:119-144);
    - the precommitment mark (deposit.rs:97) and the spent mark (release.rs:266), each just after its creation at a
      canonical PDA;
    - pages, after `push_entry`'s checks.
  - `invoke_signed` goes only to the fixed system program id, signing for the new PDA alone (state.rs:156-158,
    :201-215).
  - Venue instructions run with `invoke` and W's signer flag only (buy.rs:189-202).
- **Owner and signer checks.** Pool, pages and marks are checked by owner, discriminator, tree, page number and entry
  count, or by canonical address (state.rs:119-132, :191-193, :234-255, :319-325). The system program is checked by
  key (release.rs:180). W and the fee payer must sign (release.rs:191-196).
- **PDA seeds and bumps.**
  - Every derivation uses `find_program_address`, and no bump comes from the user.
  - `Pool::load` uses the bump `init` stored.
  - The four seed kinds have distinct lengths, so no two kinds collide.
- **Rent and closed-account revival.** No path closes, debits or reassigns a mark or a page. A pre-funded address is
  topped up, allocated and assigned. A spent mark is made only after the proof verifies (release.rs:257, then :263).
- **Token-2022.** Not applicable on chain: the program holds only lamports and makes no token CPI. On the venue side,
  Token-2022 is review 2's F7.
- **CPI privilege passing.**
  - The pool as an inner program is refused (buy.rs:168-170).
  - Pool accounts, by key or by owner, are refused as inner or tip accounts (buy.rs:110-112, :162-175).
  - Any signer other than W is refused (buy.rs:176-178).
  - The zero-lamport `show_balances` transfer cannot debit the pool, which the system program does not own
    (buy.rs:115-136).
- **Duplicate mutable accounts.** Lamports are re-read on each write, so W, the fee payer and the tip as one key pay
  exactly. A tip on the next page is refused, and other aliasing is refused by address, length or discriminator.
- **Arithmetic.** Checked subtractions and multiplications (release.rs:184, :240, :242-245; deposit.rs:94, :107). The
  backstop is computed in u128 (release.rs:150-152). Depth is at most 32 before any shift.
- **ZK binding.** The context is computed on chain from program, pool, W, fee payer, fee cap, tip cap, deadline and
  salt (release.rs:198-210). The 8 signals are put together by the program, and the roots are read by index from the
  pool's own pages. The fee and the tip are exact under W's transaction signature. Separation between clusters rests on
  the deploy rule of a fresh program id per cluster (lib.rs:47-50).
- **Nullifier.** One mark at the canonical `["spent", nh]`, with `nh` below p (release.rs:177). Never closed. A
  stranger can only pre-fund its address.
- **Field ranges and malleability.** Coordinates below q, signals below p, `-A` correct including infinity, and the
  pairing must equal exactly 1 (verifier.rs:28-70).
- **Verifier key.** Compile-time constants, tested equal to `withdraw.vkey` (verifier.rs:162-187), with no setter.
- **Buy path.** `minOut` is in the inner instruction data that W signs. The pool pays exactly `withdrawnValue` in
  three parts (release.rs:240, :276-281), so no one keeps a difference.
- **Dropped candidate.** The fee payer is short when a change opens a page: the hunter measured -494,720 lamports net,
  against +507,520 for a plain entry. The kit already adds a page reserve
  (`packages/kit/src/trade/solana/pool-buy.ts:679-687`) and the helper enforces it
  (`apps/helper/src/pool/solana.ts:271`), so this is not a finding.
- **Observation, argued only.** Every deposit and release write-locks the single pool account. Someone paying priority
  fees can crowd a block's per-account compute and delay releases. This is a liveness limit common to one-account
  programs, and nothing is lost.

## Not run

- **The skill's full six-phase artifact set.** No `run-metadata.json`, coverage ledger, `findings.json`, schema
  validators, or fresh-agent record verification. Given the 75-minute window, this was a scoped, quick-profile pass:
  one hunter per area, and my own re-read of each candidate. A quick or scoped run is partial coverage. It does not
  say the rest is fine.
- **Slither on this Mac.** Not run, per the brief. Its result above is CI's run on GitHub's runner at this sha.
- **Forge, locally.** I did not re-run the EVM forge suite: the worktree's forge-std submodule is empty, and CI
  already ran it at this sha (288 passed). The vault unit tests and the Solana probe ran on the box through heavy.sh.
- **No test for L-V1 or I-V3.** Both need a near-sandbox run on the real USDC wasm, which did not fit the window.
- **Solana: what was not run.** Only the hunter's two new tests ran, not the full svm suite (CI ran it at this
  sha). The solana-bn254 syscall internals (the curve and subgroup checks) rely on review 3's read.
- **The circuits.** Not reviewed (`packages/kit/zk`). Every binding above assumes Privacy Pools v1.3.0's withdraw and
  commitment circuits as audited, and that the ceremony key matches them.
- **Off-contract code.** Deploy scripts, live checks and the kit or helper were read only where a finding touched
  them. One exception: the Solana deploy script deploys `--final`, with no upgrade authority
  (`contracts/pool-solana/scripts/mainnet-deploy.sh:25`).
- **Third parties' own code.** Circle USDC's code beyond NEP-141/145, Uniswap's PoolManager and SwapRouter02, and
  Robinhood Chain's WETH proxy were not read.
- **Gas after a NEAR re-pricing.** Not checked (VT-S17's residual).
