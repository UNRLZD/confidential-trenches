# Pool review, round 2

A second review of the Solana pool (`contracts/pool-solana/`) and the EVM pool (`contracts/pool-evm/`) before they
go to mainnet with no upgrade path. Both pools are permanent once deployed, so every finding below is fixed here or
answered in writing.

- **Read at:** f30c9be62a3b650a651df24949b862d10b133a03, by review A and review B. Neither reader wrote any of this
  code. Each read the code and the sources below first, made its own pass, and only then got round 1's findings.
- **Read against:** Privacy Pools v1.3.0's audit reports (github.com/0xbow-io/privacy-pools-core at c312dcd,
  `audit/`: contracts_audit_oxorio.md, contracts_audit_auditware.md, circuits_audit_oxorio.md,
  entrypoint_upgrade_audit_oxorio.md); the deviations from Privacy Pools (the vault's list, the same port, and the
  pool design calls M350-M372); both NOTICE files and TAG3.md; and the kit's signers that feed the pools
  (`packages/kit/src/trade/evm/`, `packages/kit/src/trade/solana/`, tags 2 and 3).
- **Read line by line by both:** every file under `contracts/pool-solana/src/` (vk.rs's key bytes aside); in
  `contracts/pool-evm/src/`, PrivacyPool.sol, PrivacyPoolSimple.sol, State.sol, SellDelegate.sol, both adapters,
  lib/ProofLib.sol and poseidon/PoseidonT3.sol; `lib/lean-imt/InternalLeanIMT.sol`'s insert; TAG3.md and both NOTICE
  files; the kit's EVM signers (`buy.ts`, `buy-unpinned.ts`, `sell.ts`, `sell-unpinned.ts`, `pool-fee.ts`,
  `quoted.ts`) and its Solana tag 3 builder and checker (`pool-buy.ts`).
- **By one of them:** WithdrawalVerifier.sol and PoseidonT4.sol in full by review B (review A read the verifier's
  field checks); the interfaces in part; the kit's Solana `pool.ts`, `build.ts`, `send.ts` and `flow.ts`, the helper's
  Solana sender and the signing page's pool flows, the svm tests and the forge tests Buy, PrivacyPool, ExactDebit,
  HostileSell, HostileSellV4 and Keyless. Review B's first pass claimed every file in the checkout; its second pass
  names the files it read line by line, and only those count here.

## Findings

| Severity | Count | Findings |
|---|---|---|
| HIGH | 0 | |
| MEDIUM | 1 | F1 (fixed) |
| LOW | 4 | F2 (answered), F3 (fixed), F7 (answered, with a kit change named), F9 (answered) |
| INFO | 4 | F4, F5, F6, F8 (answered) |

Severity is the reader's unless the line says otherwise. Lines are at f30c9be.

### F1 · MEDIUM · Solana: an insert that lands first fails a deposit or a release on chain

- **Found by:** review A (R-1, rated LOW). Raised to MEDIUM here: its second pass found nothing that rebuilds after
  this failure, so a plain send costs the fee payer its fee, the user's run stops and the note waits for its deadline
  before it is proved again. That is a user's withdrawal blocked under a normal condition, and the program is final.
- **Where:** `contracts/pool-solana/src/state.rs:292-309` (`push_entry`), `deposit.rs:52-63`, `release.rs:269`;
  the senders pick the page at `packages/kit/src/trade/solana/pool-buy.ts:211`,
  `packages/signpage/src/pool-deposit.ts:238-239` and `pool-sell.ts:433-434`.
- **Attack:** anyone's deposit or release, or plain traffic, that lands between a sender's read of the tree's size and
  its own landing and carries the index past a 1,024-entry page makes that deposit, tag 2 or tag 3 fail with
  `WrongAccount`, at about (inserts in that window) / 1,024 per transaction.
- **Fix:** `d3edab1`. Every insert may also name its tree's next page: tag 1 takes `[next state page, next label
  page]` after its six accounts, tag 2 a ninth account, tag 3 flag bit 1 with the next state page after the tip
  account. `state::page_for` writes to the page named first when it is the index's page, else to the next one, and
  `push_entry` checks whichever it picks as before, so the next page can only be the tree's next page. Tag 3 treats
  the next page as a pool account: no inner instruction and no tip may name it, though it may not exist yet. A sender
  that names no next page gets exactly today's behaviour.
- **Regression tests** (`svm-tests/tests/release.rs`): `a_release_built_on_the_full_page_lands_with_the_next_page`
  (tag 2, then a deposit naming both next pages; a label page or another address as the next page is refused),
  `a_tag3_built_on_the_full_page_lands_with_the_next_page` (an inner instruction or the tip naming the next page is
  refused), `the_next_page_is_used_only_when_the_first_is_not_the_one`.
  - Before (the program built from f30c9be, these tests at the fix): `test result: FAILED. 0 passed; 3 failed; 0 ignored; 0 measured; 51 filtered out; finished in 9.02s` (panics at `release.rs:993`, `:1023`, `:1072`)
  - After (the program built from the fix): `test result: ok. 54 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 149.62s` (the whole svm suite; program sha256 080ae1b8f46296b3d4b84e4fda26c0a727ef7d1c7e3b951e16cd22c2ec6e8517)
- **Other paths:** the EVM pool has no pages; the NEAR vault keeps its trees in contract storage. Neither has this race.
- **Left for a follow-up card, outside the pools:** the senders naming the next pages (the kit's tag 3 builder and
  checker, the helper's carry checks, the signing page's deposit, sell and withdraw builders), and the helper's header
  at `apps/helper/src/pool/solana.ts:53`, which says a tag 2's only on-chain failure is the note spent elsewhere.
  Until then every sender works as today; the program change is the part that cannot wait for mainnet.

### F2 · LOW · Both pools: a full state tree locks every note left in it

- **Found by:** review A (R-2) and review B (R-3).
- **Where:** `contracts/pool-solana/src/tree.rs:48-54` with `release.rs:269`; `contracts/pool-evm/src/State.sol:165-169`
  with `PrivacyPool.sol:262-263`.
- **Attack:** once the state tree holds 2^32 leaves, every release fails, since each inserts a change leaf, and with no
  ragequit the notes left in the pool can never leave.
- **Answer, no change:** Privacy Pools v1.3.0 acknowledged the same limit (Oxorio, "No option to withdraw privately in
  an edge case": "practically impossible, it requires 2^32 deposits"). Filling the tree takes 2^32 paid inserts: on
  Solana each leaf's 72-byte page entry alone locks 365,760 lamports of rent for good at mainnet rent (M352), over
  1.5 million SOL for the tree; on EVM each is its own paid transaction, 2^32 of them. A change-free release would
  need a circuit that can omit the change commitment, and the circuit and its ceremony key are kept byte for byte; a
  ragequit was removed on purpose (M350 (3)). The NEAR vault keeps ragequit, so it has an exit at the same limit.

### F3 · LOW · EVM: every sell reads WETH, so Robinhood's WETH admin can stop native-asset sells

- **Found by:** review A (R-3).
- **Where:** `contracts/pool-evm/src/SellDelegate.sol:151`, `:177-178`; NOTICE change 15 on Robinhood Chain's WETH.
- **Attack:** the admin of Robinhood Chain's WETH proxy (an upgradeable aeWETH) upgrades it to revert, and every EVM
  sell there fails, including a v4 route that ends in the native asset and never touches WETH.
- **Fix:** `65b1ed9`. The sell reads and unwraps WETH only for a route that can pay in it: any v3 route, or a v4 route
  whose last hop ends in WETH (`_paysInWeth`). A v4 route to the native asset trusts no WETH contract, as the buy
  adapter already does on the buy side (`UniswapV4Adapter.sol:130-134`). Gas: the v4 one hop to ETH 494,066 to 490,040 (two reads saved), to WETH 504,757 to 506,926 (the path decode), the mock-router sell 445,008 to 445,273, forge 1.7.1 (NOTICE change 17).
- **Regression test** (`test/SellV4.t.sol`): `test_v4SellToTheNativeAssetTrustsNoWeth`, a sell to the native asset
  with a WETH whose every call reverts.
  - Before (f30c9be, forge 1.7.1): `[FAIL: EvmError: Revert] test_v4SellToTheNativeAssetTrustsNoWeth() (gas: 849925)`
  - After (forge 1.8.6, the whole suite): `[PASS] test_v4SellToTheNativeAssetTrustsNoWeth() (gas: 1278320)`; `254 tests passed, 0 failed, 0 skipped (254 total tests)`
  - The mutation list (`test/mutants.mjs`) gains `_viaWeth` forced true (killed by the new test) and forced false
    (killed by `test_v4SellToWethLands`): `[FAIL: EvmError: Revert] test_v4SellToTheNativeAssetTrustsNoWeth() (gas: 849941)` and `[FAIL: MinOutNotMet()] test_v4SellToWethLands() (gas: 551993)`, both killed
- **Other paths:** the buy adapters (v4 touches WETH only for a route from WETH; v3's router path is WETH by design);
  the Solana pool and the NEAR vault have no WETH.

### F4 · INFO · A sell's return note is off the ladder

- **Found by:** review A (R-4, a question).
- **Where:** `contracts/pool-evm/src/SellDelegate.sol:186` (deposits all of the gain less the fee);
  `packages/signpage/src/pool-sell.ts:465` (the Solana return note is minOut less the reserve);
  `packages/wallet/src/pool/queue.ts:239`.
- **Attack:** none; the question is whether the change below the smallest rung that a sell's note leaves is ever
  released, since releasing an odd amount would mark it against the sell's public deposit value.
- **Answer, no pool change:** both pools take any deposit value at or above their minimum and release any amount the
  proof binds, so how a return note is split into rungs is the wallet's queue policy, not a pool rule. The wallet's
  handling of the remainder goes to a follow-up card for the wallet.

### F5 · INFO · The kit's Solana tag 3 builder takes the program and the pool from its caller

- **Found by:** review A (R-5).
- **Where:** `packages/kit/src/trade/solana/pool-buy.ts:763`, `:985` (`cfg`), exported at `packages/kit/src/index.ts:39`.
- **Attack:** none today: the kit signs nothing for Solana, and the signing page pins the program
  (`packages/signpage/src/rules/pool.ts:518`). Another app on the kit that skipped its own pin would let a server name
  the program that gets W's signer privilege.
- **Answer, no pool change:** the pools are not involved. A per-cluster Solana pin list in the kit, as M370 gave the
  EVM signers, goes to a follow-up card for the kit.

### F6 · INFO · The EVM pool keeps root to time, not index to root

- **Found by:** review A (R-7).
- **Where:** `contracts/pool-evm/src/State.sol:63-65`, `:172`, `:188`.
- **Attack:** none. M350 (2) says the EVM pool keeps index to root; the code keeps each root's block time, so every
  root stays known (spends are sound) but no root can be read by index on chain.
- **Answer, no change:** the device reads roots from the `LeafInserted` events, re-reading the tail on two RPCs and
  binding to the root at a block hash both agree on (M371 (1)); a root it picks that the pool never had fails on
  chain with `UnknownStateRoot`. M350 (2)'s wording goes back to the design record for correction.

### F7 · LOW · Solana: a Token-2022 transfer fee reached inside the venue's call lowers what W receives

- **Found by:** review B (pass 2 R-1, rated MEDIUM). LOW here, for the reasons below.
- **Where:** `packages/kit/src/trade/solana/pool-buy.ts:789-831` (the venue reader admits mints with TransferFeeConfig
  and TransferHook); `contracts/pool-solana/src/buy.rs:181-194` (no balance check after the venue).
- **Attack:** a mint whose transfer fee is non-zero makes the venue's transfer to W deliver less than the amount the
  venue's own instruction names, so W receives less than the device quoted while the note is spent.
- **Answer, no pool change:** tag 3 is open to any venue by design (M356 (1)) and binds the venue's bytes with W's
  signature; the amount W receives is the venue's instruction's, which the device rebuilds and checks. The kit admits
  only pump curves and canonical PumpSwap pools, whose mints pump's own create instruction makes, and Token-2022 fixes
  a mint's extensions when the mint is initialized; the recorded mainnet pump mint carries only MetadataPointer and
  TokenMetadata (`packages/kit/test/solana-pool-buy.test.ts:232-234`). A transfer hook cannot change an amount (it can
  only fail the transfer, which undoes the release), and a new transfer fee takes effect two epochs after it is set
  (spl-token-2022's transfer fee extension; not re-read for this file). So no recorded venue reaches this today. The
  kit change, refusing a pool buy whose mint holds a non-zero transfer fee in either of its two fee slots, so the
  device's minimum out is what W receives on Solana as the pool's balance check makes it on EVM, goes to a follow-up
  card for the kit.

### F8 · INFO · Poseidon implementations without their own audit

- **Found by:** both readers, from Auditware AW-M-03 (review B pass 2 R-2).
- **Where:** `contracts/pool-evm/src/State.sol:97-100`, `poseidon/PoseidonT3.sol`, `PoseidonT4.sol`;
  `contracts/pool-solana/src/tree.rs:25-32`.
- **Attack:** none found; a flaw in a Poseidon implementation could break commitments or roots.
- **Answer, no change:** the EVM pool uses poseidon-solidity's T3 and T4, the library Privacy Pools v1.3.0 deploys and
  whose finding it acknowledged, and the pool's constructor refuses to deploy unless the code at those addresses has
  the pinned code hashes (`State.sol:98-99`).
  The Solana pool uses the runtime's `sol_poseidon` with circomlib's parameters, checked against circomlib's vectors,
  the ones the vault pins (`tree.rs:88-99`). Both match the circuit's hash on every deposit and release in the tests,
  since the circuit's proofs verify only against the roots they compute.

### F9 · LOW · One nullifier under two precommitments locks the second note

- **Found by:** both readers, from Oxorio's Entrypoint upgrade report (review B pass 2 R-4).
- **Where:** `contracts/pool-evm/src/PrivacyPool.sol:89-93`, `State.sol:152-158`; `contracts/pool-solana/src/deposit.rs:80-86`,
  `release.rs:260`.
- **Attack:** a user who reuses one nullifier with two secrets can spend one note and then never the other; no one
  else can cause it or gain from it.
- **Answer, no change:** the same acceptance as Privacy Pools (only the holder of the secrets can reuse a nullifier).
  The wallet derives each note's nullifier and secret from the 12 words per note
  (`packages/wallet/src/derive/notes.ts:3-4`), so two notes never share one.

## Round 1 still holds

Round 1 was the per-card reviews pool-evm-buy (5998168, b61f0f5), pool-evm-sell (c2a8da2), evm-pool-buy-tx (ee348ad),
evm-pool-sell-tx (8fd535f) and wallet-pool-ladder (467209e). Both readers checked each of its nineteen fixes against
the code at f30c9be and found every one in place:

| Round 1 fix | Where it holds at f30c9be |
|---|---|
| R1-1 every root stays known (M350 (2)) | Solana: each page entry keeps leaf, root and the Clock time, pages are never closed (`state.rs:259-276`, `:291`). EVM: every root keeps its block time (`State.sol:63-65`, `:172`, `:188`); see F6 on the merge note's wording |
| R1-2 no ragequit (M350 (3)) | No ragequit method in either pool (`PrivacyPool.sol`, `lib.rs` tags 0-3); `ProofLib.sol` keeps the unused `RagequitProof` struct, which nothing reaches |
| R1-3 W signs every EVM spend (M354 (1)) | `PrivacyPool.sol:176-183`: payees not 0 or the pool, the fee under its cap, the signer equal to the recipient, all before the spend; 65 bytes and low s at `:205-216`; Withdraw and Buy type hashes differ, so one cannot pass as the other |
| R1-4 the signature binds nullifier, context and value (M354 (2), M357 (2)) | `PrivacyPool.sol:63`, `:121`; `PrivacyPoolSimple.sol:39-40`, `:86-101` |
| R1-5 a v3 partial fill reverts (M357 (1)) | `UniswapV3Adapter.sol:40-55`: the router's ETH and every middle token unchanged, else `PartialFill` |
| R1-6 a hooked v4 hop is bound by minOut (M360) | `UniswapV4Adapter.sol:121`, `:126`; the sell's callback the same way (`SellDelegate.sol:230-232`, `:180`) |
| R1-7 the sell pays the sender at most the signed cap (M358 (1)) | `SellDelegate.sol:143`, `:182-186`; the ten-field Sell type and the domain under W at `:83-85`, `:250-262`; the nonce at its ERC-7201 slot, recomputed by review A |
| R1-8 the transient guard at its ERC-7201 slot (M363 (1)) | `SellDelegate.sol:69`, `:139-140`, `:188`, `:333`, `:343`; slot recomputed by review A |
| R1-9 the kit checks a sell's target and calldata (M363 (3)) | `sell-unpinned.ts:183-260`, and the read-back's byte equality at `:338-339` |
| R1-10 no WETH after a buy route's first token, listed middles (M358 (3)) | `buy-unpinned.ts:402-405`; the device-quoted v4 exception is safe on chain, since each v4 hop must spend all the hop before gave (`UniswapV4Adapter.sol:121`) |
| R1-11 the route ends in the user's token (M366 (1)) | `buy-unpinned.ts:466`; on chain only `_buy.token`'s balance on W counts (`PrivacyPoolSimple.sol:63-66`) |
| R1-12 no export signs a caller's digest (M366 (2), (3)) | `buy-unpinned.ts:456-508`: a module-private WeakSet of the builder's own builds, the digest made inside the kit, one frozen route copy |
| R1-13 only pinned pools, adapters and delegate (M370 (1)) | `buy-unpinned.ts:516-561`, `sell-unpinned.ts:558-585`; the authorization takes no delegate; `index.ts:41-46` exports only the pinned signers |
| R1-14 the sell deadline on the device's clock (M370 (2)) | `sell-unpinned.ts:357` |
| R1-15 the hop cap on buy and sell routes (ee348ad, 8fd535f) | `EVM_POOL_MAX_HOPS` = 4 (`buy-unpinned.ts:263`), checked at `:372`, `:381`, and for sells at `sell-unpinned.ts:199`, `:238`, `:311`, `:326` |
| R1-16 the Solana marks (M353 (1), M355 (3)) | `deposit.rs:86-93` (value, nonce, tag); `release.rs:258-266` (withdrawnValue, number, tag); `MARK_TAG` = 1 (`state.rs:41`) |
| R1-17 no Token-2022 step (M362 (1)) | `pool-buy.ts:350-352`: pump, PumpSwap, Token, the associated token program and System. A venue can still reach Token-2022 inside its own call: F7 |
| R1-18 the mainnet tip floor (M369 (4)) | `pool-buy.ts:703`, run at build (`:763`) and at the check's rebuild (`:1037`) |
| R1-19 W signs every Solana release (M354 (1)) | `release.rs:188-193`, reached by tag 2 (`:157`) and tag 3 (`buy.rs:179`); in tag 3 no inner signer but W (`buy.rs:168`, `:189`) |

## Privacy Pools v1.3.0 audit findings, against this port

| Report and finding | In this port |
|---|---|
| contracts_audit_oxorio: sending to the zero address | Handled: EVM refuses a zero or pool payee (`PrivacyPool.sol:176-177`); on Solana both payees sign (`release.rs:188-193`) |
| contracts_audit_oxorio: no private withdrawal at the full tree | Applies: F2 |
| contracts_audit_oxorio: deanonymization through ragequit | n/a: no ragequit in either pool (M350 (3)) |
| contracts_audit_oxorio: missing relay data checks | Handled: `PrivacyPool.sol:150-151`, `:176-186`, the 192-byte RelayData; `release.rs:185-193`, `:227-237` |
| contracts_audit_oxorio: new pool checks, decimals in the fee, a shared ASP tree, postman or owner checks, deposit fee, withdrawFees recipient, relay after removal, and the five INFO items | n/a: no Entrypoint, no registry, no ASP postman and an absolute fee; each pool fills its own label tree |
| contracts_audit_oxorio: no minimum withdrawal | Applies only as the dust path of F2, which cost rules out; 0 is refused (`release.rs:218`, `PrivacyPool.sol:254`) |
| contracts_audit_oxorio: processooor equal to the depositor | n/a: the processooor is the pool (`PrivacyPool.sol:233`); Solana binds the program and the pool in the context |
| contracts_audit_oxorio: only the latest ASP root | Handled the other way: every past label root is accepted (`State.sol:207-209`, `release.rs:215`) |
| contracts_audit_auditware AW-M-01: ERC-20 approvals | Handled: the sell approves exactly the amount and must end at 0 (`SellDelegate.sol:162`, `:169`); the pool and the adapters approve nothing |
| contracts_audit_auditware AW-M-02: root history overwritten | Handled: every root is kept (`State.sol:172`, `:188`; Solana pages are never closed) |
| contracts_audit_auditware AW-M-03: an unaudited Poseidon library | Applies: F8 |
| contracts_audit_auditware AW-L-01: DoS through the ASP root or a failed transfer | The ASP part is n/a. A payee that refuses ETH on EVM is the user's own choice of address; Solana moves lamports directly (`release.rs:273-278`) |
| contracts_audit_auditware AW-L-02: the updateRoot index | n/a: no updateRoot |
| contracts_audit_auditware AW-L-03: an unbounded relay fee | Handled: the cap the proof binds, then the backstop (`PrivacyPool.sol:179`, `:186`; `release.rs:227-232`) |
| circuits_audit_oxorio: unused inputs, an uninitialized main, unused or commented signals, value checks after calculations, anonymous components | n/a: the circuit and its ceremony key are Privacy Pools v1.3.0's, unchanged |
| circuits_audit_oxorio: inclusion proof manipulation through actualDepth | Applies, no impact: every state leaf's label is a deposit's real label, computed on chain (`deposit.rs:95`, `PrivacyPool.sol:96`), state leaves are Poseidon(3) so no inner node passes as one, and the label tree holds every deposit |
| circuits_audit_oxorio: a nullifier equal to a secret | Handled in the v1.3.0 circuit the key comes from |
| circuits_audit_oxorio: existingValue unchecked | Handled: a deposit is below 2^128 on EVM (`PrivacyPool.sol:87`) and a u64 on Solana (`deposit.rs:75`) |
| circuits_audit_oxorio: a zero withdrawnValue | Handled: refused at `release.rs:218` and `PrivacyPool.sol:254` |
| entrypoint_upgrade_audit_oxorio: nullifier reuse in precommitment tracking | Applies: F9 |
| entrypoint_upgrade_audit_oxorio: check order for gas | n/a: no Entrypoint |

## A third reading of the two fixes

A reader who wrote neither fix read `65b1ed9` and `d3edab1` and found no fault in the program or in SellDelegate. It
found three faults in the tests and the notes, each fixed in `fbf0566`:

- **MEDIUM:** `scripts/mutants.mjs` still named five source lines that `d3edab1` rewrote (the flags check and the four
  `is_pool_account` calls), so the sweep stopped at its first entry. The entries now name the new lines, and ten more
  remove each part of the fix: `page_for`'s choice (both ways), the two page checks it reads, the release's ninth
  account, the deposit's two, the next page's key in `is_pool_account`, tag 3's next-page index (at 8 and at 9) and
  flag bit 1. `scripts/mutants.test.mjs` (Solana) and `test/mutants-list.test.mjs` (EVM), both run by CI, fail when a
  mutant's text is not exactly once in its file or its test is not a real test, so a stale list now fails CI.
- **MEDIUM:** tag 3's next page with no tip, at account 8, had no test: the only tag 3 test had a tip, so a mutant
  pinning the index to 9 passed. `a_tag3_with_no_tip_names_its_next_page_at_8` holds it.
- **LOW:** `state.rs` said the second page "can only be the next page". It can be any account the index's entry may
  go to; `push_entry` checks the page it writes to. The comment now says so.

The fold's sweep ran in full on the program built at `fbf0566`: `64/64 mutants caught`, each new entry among them
(`tag 3 next page at 8 with no tip: a_tag3_with_no_tip_names_its_next_page_at_8 fails without it, passes with it`).

## Deploy sha

fbf05664916a8a00eec9ce87574deb0cf9225d12 (the commit of the last fix; the commits after it change no file of either
pool's program).

The Solana program built from it, the code a deploy must hold (`scripts/pin.mjs` reads the line below; the deploy
script refuses a public cluster's code that is not it, and CI's pool-solana job holds its own build to it):

Program sha256: `c86fc7fc1b442851c660c5ec0c4f3c4ad8648a5965b5a0da59189fbf0fdb5162` (79,088 bytes)

- **Built three times, the same bytes each time:** cargo-build-sbf 4.4.0 with platform-tools v1.57, in the checkout
  at `0930594` (whose `contracts/pool-solana` is tree `392a518`, the same as `fbf0566`'s), and again from a fresh copy
  of that tree in another directory with a target directory of its own; and CI's pool-solana job (cargo-build-sbf
  4.5.0, platform-tools v1.57) printed `pool-solana code: sha256 c86fc7fc…5162, 79088 bytes` for the merge of
  `0930594` (run 42012187381).
- **Why it is not the hash F1 names** (`080ae1b8…8517`, built at `d3edab1`): the fold's comment in `state.rs` is one
  line longer, so every later line moves down one, and the code carries the line of each bounds check it can panic
  at. The same fresh copy with `d3edab1`'s comment put back builds to `080ae1b8f46296b3d4b84e4fda26c0a727ef7d1c7e3b951e16cd22c2ec6e8517`;
  the two programs differ in 7 bytes, each the line number of a panic location record (24 bytes apart, offsets
  2984-3128), each one higher: 293 to 294, 326 to 327, 327 to 328, 328 to 329, 341 to 342, 342 to 343, 343 to 344,
  the lines of `state.rs`'s slice reads and writes at `fbf0566` (294, 327-329, 342-344). An earlier note here said the
  comment left the code unchanged; it was carried over without a build, and the pin above is now held by one.
