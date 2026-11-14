# G1 proof 1: a Privacy Pools withdrawal proof checked by a NEAR contract, gas measured

**Question.** Can a NEAR contract check a real Privacy Pools v1.3.0 withdraw proof (Groth16 on bn254, through NEAR's
alt_bn128 host functions), update the Poseidon LeanIMT tree, refuse a wrong proof and a reused nullifier, and at what
gas? Pin: vault paper `docs/plan1/vault.md` at dd56e19 §2.5.2 and §2.11. The current paper is card vault-followup's (absolute fee and salt; this test contract keeps the bps form).

**Answer: yes.** The real proof passes. Every wrong proof, a reused nullifier, a second proof on the same nullifier
and a past deadline are refused, with nothing written. That holds in near-sandbox 2.13.4 (protocol 86, mainnet's
version) and on NEAR testnet (protocol 88, the deployed build c4b13ef, §6). The withdraw check costs **82.3 Tgas at depth 32**, inside the paper's
estimate. The paper's Poseidon crate cannot run on NEAR; the trim build, proven equal, can (§5).

Status key: **M** = measured here, **S** = read in source at a pinned commit, **E** = the paper's estimate. Gas is the
contract's own receipt (vault receipt) unless a row says otherwise.

## 1. Gas per step, withdraw at depth 32 (M, sandbox 2.13.4, trim build)

| Step | Measured | Paper 2.11 (E) |
|---|---|---|
| Groth16 verify (vkey 0.031, multiexp 3.324, g1_sum 0.057, pairing 30.130, rest 0.032) | 33.575 Tgas | 33.4 |
| State-tree insert, 32 levels (about 1.41 Tgas per Poseidon(2) level) | 45.022 Tgas | 21-58 |
| Parse 0.465, field, deadline, context, root and amount checks 0.327 | 0.792 Tgas | |
| Nullifier record 0.167, spend record 0.142, leaf and root writes 0.408, Poseidon init 0.345, events 0.441, end 0.098 | 1.602 Tgas | 0.2 |
| Receipt gas outside the method's steps: 0.310 before the first step, 1.022 after the last (code loading, call base, not split further) | 1.331 Tgas | 1.2 fixed |
| **Withdraw, the vault's own work** | **82.322 Tgas** | 80.8-127.8 burnt, which includes 25-35 of payouts |

The real withdrawal at the other depths: **40.333 Tgas** (small tree, depth 3) and **49.682 Tgas** (seeded depth 16).
Source: `sandbox/results/runs/20261026T003727Z/sandbox-gas.json` (built from c4b13ef).

**Rows 14 and 15 (the storage charge, the payouts) and 2.5.4 `on_payout`, measured (M, card vault-followup).** The
`payouts` feature (off by default, so trim stays 160,057 B, sha256 1f9bdf5d…4b79, byte for byte, as do main, trimvk
and trimquiet) runs row 14 at the end of withdraw, then row 15's promises, and adds the `#[private]` callback; build
`trimpay`, 169,277 B, sha256 47d9ec99…7c95. Row 14: the attachment must cover (bytes written + 389) ×
`env::storage_byte_cost()` + `register_deposit` + 1 yocto per `ft_transfer`, else `InsufficientStorageDeposit` with
nothing written, and the rest above the bytes, the registration and the yocto stays in the spend record's `reserve`
(`contract/src/payouts.rs`). Against **the real USDC wasm**: mainnet account 17208628…33a1, 321,491 B, sha256
b98ccd53…cfe6, base58 = its code hash DVJx7F3dHEHJYwpYPwXHu8K9Uo7h4kXFcALucY5oNX8q on rpc.mainnet.fastnear.com and
near.drpc.org (equal bytes), set up as mainnet's init tx FEJRCgwW… and multisig mint, nothing patched
(`sandbox/usdc/fetch.py`, `sandbox/src/payouts.rs`). The fee is still the bps form (the absolute fee is a paper
change). Tgas; "exec" is the withdraw's prepaid gas less its burnt gas and its children's prepaid gas, which is two
parts: the execution fees the withdraw prepays for the receipts it makes (1.776-3.445) less its own receipt's
execution fee (0.891), which its burnt gas counts but the transaction prepaid (card vault-deposit-halt, Verifier P3-1
of vault-followup). The runner now asserts in every case that the first part, read as exec + the second, equals
protocol 86's fees for the receipts' methods and args (receipt creation 108,059,500,000 + 780,000,000,000 per function
call + 2,235,934 per byte of method name and args, mainnet's `EXPERIMENTAL_protocol_config`): 12 of 12 equal to the
last gas unit in `sandbox/results/runs/20261026T165227Z-payouts-trimpay/`, whose every gas figure equals the table's
run.
The minimum attach is own + exec + statics:

| Case | Withdraw receipt | Part 0 | Part 1 (fee) | `on_payout` | Whole tx | Exec | Statics | Min attach |
|---|---|---|---|---|---|---|---|---|
| depth 3, fee, registered | 41.614 | 2.048 | 1.997 | 1.714 | 48.638 | 1.773 | 60 | 103.387 |
| depth 3, fee, new recipient | 41.828 | 3.704 (with `storage_deposit`) | 1.997 | 1.714 | 50.510 | 2.554 | 70 | 114.381 |
| depth 3, fee 0 | 41.202 | 2.048 | none | 1.704 | 45.997 | 0.885 | 45 | 87.088 |
| depth 3, fee 0, new recipient | 41.418 | 3.704 | none | 1.704 | 47.870 | 1.665 | 55 | 98.083 |
| depth 3, recipient not registered | 41.614 | 1.750, failed | 2.038 | 1.707 | 48.597 | 1.773 | 60 | 103.387 |
| depth 32, fee, registered | 83.609 | 2.048 | 1.997 | 1.714 | 90.634 | 1.773 | 60 | 145.382 |
| **depth 32, fee, new recipient** | 83.823 | 3.704 | 1.997 | 1.714 | 92.505 | 2.554 | 70 | **156.377** |
| depth 32, fee 0 | 83.199 | 2.048 | none | 1.704 | 87.993 | 0.885 | 45 | 129.084 |
| depth 32, fee 0, new recipient | 83.414 | 3.704 | none | 1.704 | 89.866 | 1.665 | 55 | 140.079 |
| depth 32, recipient not registered | 83.609 | 1.750, failed | 2.038 | 1.707 | 90.592 | 1.773 | 60 | 145.382 |

- **Whole withdraw budget:** the largest case needs 83.823 + 2.554 + 70 = **156.377 of the 300 Tgas** the kit
  attaches, 143.623 to spare.
- **Row 14:** every case wrote 661 B and kept a reserve of the attachment less 661 B × 1e19, `register_deposit` and the
  yocto (4.38e21 yocto at the kit's (710 + 389) × 1e19). The case `short_by_one_yocto` (both trees) attaches
  (661 + 389) × 1e19 + 2 − 1: refused with `InsufficientStorageDeposit` and the vault's state equal before and after;
  then exactly the requirement passes, with a reserve of 389 × 1e19. Row 14 costs 0.126 Tgas in the receipt.
- In the withdraw receipt, against trim on the same cases (+0.843 to +1.451): row 14 0.126, the promises' send fees
  0.692-1.281 (`ACTION_COST` and `PROMISE_AND` in its gas_profile), 0.010 more code loading for the bigger wasm, net of
  trim's `payouts_not_made` log (0.089-0.115); the rest, 0.104-0.148, is the host and wasm work that builds the
  promises (not split further), so making them costs 0.80-1.43 in all. Row 14 moved the largest case from 83.693 to 83.823.
- The failed case: `on_payout` records `refund_pending` with refund_value 1,980,000 = the recipient part, and
  totals.returned rises by it. The vault's USDC goes from 10,000,000 to 9,980,000: only the fee's 20,000 left it. Every
  other case ends `paid` with exact deltas.
- Red: the same runner on the build before row 14 (trimpay a77febbc…, 168,534 B, the contract at 270bf65) is 12 of 12
  not as expected (row 14's reserve in all 12, and the one-yocto-short call accepted in both trees). Green: 12 cases,
  0 not as expected, twice (the worker's and the lead's runs), equal to the last digit. Runs
  `sandbox/results/runs/20261026T141032Z-payouts-trimpay/` and `20261026T152144Z-payouts-trimpay/` (red),
  `20261026T144314Z-payouts-trimpay/` and `20261026T150803Z-payouts-trimpay/` (green); logs in
  `20261026T150200Z-t2b-logs/`. tools/run.sh after the change: 88 cases, 0 not as expected, gas-compare against
  20261026T055312Z exit 0 (`20261026T145225Z/`, `20261026T151648Z/`). Round 1 (before row 14) is
  `20261026T133312Z-payouts-trimpay/`.

## 2. Refusals (M, sandbox; testnet in §6)

| Case | Refused with | Gas |
|---|---|---|
| (b) the vector's tampered proof (pi_a off the curve), proof C bit, G2 halves swapped | host abort "AltBn128 invalid input" | 35.536 |
| (b) a public-signal bit or the commitment bit flipped | InvalidProof (the pairing fails) | 35.577 |
| (b) a proof coordinate + q (a.x, b[0][0], c.y) | InvalidProofEncoding, at parse, before any row (run 20261026T044030Z, build 1f9bdf5d) | 1.458 / 1.521 / 1.678 |
| (c) the same nullifier again | NullifierAlreadySpent | 35.667 |
| (d) a second, valid proof on the same nullifier with another context | NullifierAlreadySpent | 35.667 |
| (f) a past deadline | DeadlinePassed | 1.733 |

Each refusal leaves the state unchanged: no nullifier written, storage +0. An off-curve point aborts the host call;
it does not return false (nearcore `logic.rs` l.1152), so a host error cannot read as success.

VT-U03 (vault.md 6fcfa94 l.746), a public signal = p: refused before the pairing, by withdraw row 1 with
FieldOverflow (S: `contract/src/lib.rs` l.611-616 at HEAD; the pairing is row 10, l.668-671). Tested in the unit test
`each_withdraw_row_refuses_with_its_own_error`, `contract/src/tests.rs` l.383-393 (signal 1 = p). Unit test only: no
sandbox case and no gas for it.

## 3. Deposits (M, sandbox; `deposit_sim`, the deposit's tree work without the token)

- Small trees: 5.8-20.0 Tgas. Storage is +756 B, +904 B when a tree grows a level, and +831 B once (deposit_sizes e_deposit_size4, where the label root write added 0 B; not traced further).
- Seeded depth 32 (both trees at index 2^32 - 1, every level hashed): **95.822 Tgas**, storage +756 B. Paper: 45-121.
- At 2^32 the tree is full and a deposit is refused (MaxTreeDepthReached).
- On testnet (the deployed build c4b13ef, §6), deposits cost 2.9-5.9 % more than in the 2.13.4 sandbox (run 003727Z,
  the same build). The cause was read, not guessed:
  - EXPERIMENTAL_protocol_config: 237 parameters, 0 differ;
  - deposit 1's gas profile, testnet run 2 against the 2.14.0-rc.5 rehearsal 20261026T034147Z-sandbox (the testnet build), differs only in READ_CACHED_TRIE_NODE (+319.2 Ggas) and TOUCHING_TRIE_NODE (+31.9 Ggas);
  - testnet's large shard trie makes each storage write's path deeper (nearcore `runtime/runtime/src/ext.rs`
    l.157-177, l.728-741).

  The mainnet vault will see the same, so its deposit min_gas needs that margin (vault-followup).

## 3.1 A deposit as U's own `ft_transfer_call`, USDC halted and not (M, sandbox, card vault-deposit-halt)

The kit's deposit path (M271 (2), vault paper 2.5.1 and 2.10): 1Click delivers USDC to the deposit's one-time NEAR
account U, and U's key signs `TOKEN.ft_transfer_call(vault, amount, msg)` with 1 yocto and 180 Tgas as a NEP-366
`DelegateAction`, which a relayer sends and pays for. Run on near-sandbox 2.13.4 with the `deposits` build (trim +
`contract/src/deposits.rs`: `storage_prepay` and `ft_on_transfer` with the paper's rows 1-11 and row 7's charge;
178,406 B, sha256 1ace7f25…; trim stays 1f9bdf5d…, byte for byte) against the real USDC wasm (sha256 b98ccd53…, code
hash DVJx7F3d…, set up and minted as in §1, `sandbox/usdc/fetch.py`). U is an implicit account (64 hex) made by a
plain Transfer; the halt is USDC's own: its two pausers' multisig request `Pause`, executed, its `x-fiat-token` event
`paused` read from the logs; unhalted the same way. Runner `sandbox/src/bin/deposit_halt.rs`, script
`sandbox/deposit-halt.sh`.

| Case | What it shows |
|---|---|
| `halted_u_call_fails_whole` (fresh tree; depth 32) | USDC halted: U's call fails at the token's `ft_transfer_call` with "FiatToken: paused"; no receipt runs on the vault; U's USDC, the vault's USDC and the supply unchanged; every vault key and value, storage usage and record count unchanged; the vault's NEAR unchanged; P's prepay unchanged and P unused, both read while halted and again after; U ends exactly 1 yocto up (the relayer's transaction paid the attached yocto, the failed call refunds it to U) |
| `after_unhalt_same_p_lands` (both trees) | unhalted, U signs the same deposit on the same P: `ft_on_transfer` returns `"0"`, the `deposited` event names U, the value and P, U's USDC goes down and the vault's up by the amount, the prepay is used and P recorded |
| `refused_deposit_comes_back_to_u` | a deposit on a P with no prepay: refused (`NoPrepay`), the resolve returns the whole amount to U |
| `lands` | a plain deposit with no halt, as today |
| `vault_unregistered` / `u_call_fails_whole` | the vault not registered on USDC: U's call fails at the token, U keeps its USDC, the vault's state unchanged |

Gas, Tgas burnt per receipt at 180 Tgas signed (refund receipts, which burn no NEAR, left out):

| Case | Relayer tx | `Delegate` on U | Token `ft_transfer_call` | Vault `ft_on_transfer` | Resolve | All | NEAR |
|---|---|---|---|---|---|---|---|
| Fresh tree, lands (the retry after the unhalt: 6.060, 11.580) | 0.517 | 0.517 | 2.863 | 6.053 | 1.623 | **11.573** | 0.00116 |
| Depth 32, lands | 0.517 | 0.517 | 2.863 | **96.043** | 1.623 | **101.563** | 0.01016 |
| Refused (no prepay) | 0.517 | 0.517 | 2.863 | 1.400 | 2.080 | 7.377 | 0.00074 |
| Halted | 0.517 | 0.517 | 1.361, failed | none | none | 2.395 | 0.00024 |
| Vault unregistered | 0.517 | 0.517 | 1.771, failed | none | none | 2.805 | 0.00028 |

- The NEP-366 envelope (the relayer's transaction and the `Delegate` receipt) is 1.034 Tgas, about 0.0001 N per
  deposit; an intents.near deposit does not have it, and the token's, the vault's and the resolve's gas are the same on
  both paths. U's account (creation, record and key, USDC registration) is the wallet's cost (wallet-followup item 12).
- The kit's 180 Tgas: (96.043 × 1.059 + 30) × 1.2 = 158.1 by the rule of §3, rounded up to the 180 the intents.near
  path keeps. Of 180, the vault's receipt is given 160.624 Tgas and the resolve 15.624 (at 250: 230.624 and 15.624),
  so the depth-32 deposit's 96.043 has 64.581 to spare.
- While USDC is halted even its view `ft_balance_of` fails with "FiatToken: paused" (run 20261026T162244Z, kept as
  evidence). That error is a halt signal a reader must never take as a zero balance; whether the wallet uses it as a
  halt read is the wallet paper's (wallet.md at e0fc533 D48 says USDC has no halt view). The runner reads balances
  before the pause and after the unpause, and the vault's own views while halted.
- Runs: green `sandbox/results/runs/20261026T171345Z-deposit-halt/` (7 cases, 0 not as expected; a landed case
  checks that every receipt succeeded, since a NEP-366 transaction's own status is `SuccessValue` even when the inner
  call fails; gas equal per receipt to `20261026T164857Z-deposit-halt/`, the run before that check); the same at
  250 Tgas signed, `20261026T163845Z-deposit-halt/` (the gas the 180 rule is taken from, equal per receipt); lint
  `20261026T171729Z-deposit-halt-lint/` (clean). Red:
  a4a8a36's runner has no such case (`20261026T164012Z-deposit-halt-base/`: each file hashed equal to a4a8a36's, then
  "usage: g1-vg-sandbox <wasm dir> <vectors dir> <out.json>", exit 1: a usage error, not a failed check); and the
  planted red, the check-level one, the same runner with the
  `Pause` request not sent (`--plant-no-halt`, `20261026T171512Z-deposit-halt-planted/`): 4 of 7 not as expected, both halted cases and both
  retries on their P, which the unhalted call had used.

## 4. Storage bytes (M)

| Record | Measured | Paper 2.3 |
|---|---|---|
| Deposit | +756 B; +904 B when a tree grows a level; +831 B once (§3) | 756 B; up to 904 B |
| Withdrawal, kept | +661 B in the sandbox with a 15 B recipient and a 64 B caller; +619 B on testnet (build c4b13ef) with a 22 B caller | 710 B with 64 B accounts (710 - 49 = 661; 661 - 42 = 619) |
| Refund reserve (389 B, returned by `settle`) | not measured: `settle` is not in this contract | 389 B |

## 5. Wasm size and the crypto stack (M)

Build: cargo-near 0.22.0 `non-reproducible-wasm --no-abi --locked`, rustc 1.96.0, opt-level "z", lto,
codegen-units 1, panic abort, overflow-checks, strip, then cargo-near's `wasm-opt -O`
(`sandbox/results/wasm-size.json`). 1 kB = 1,024 B.

| Build | Bytes | Largest function body | Runs on NEAR |
|---|---|---|---|
| main: the paper's stack, light-poseidon 0.4.1 `new_circom` | 1,513,471 (1,478 kB) at f97e0f2 (2826d510); 1,513,487 at HEAD (4370b3e5) | 1,369,515 B (`get_poseidon_parameters`, at f97e0f2) | **no**: over `max_function_body_size` 196,608 B |
| trim: the same Poseidon, t=3/t=4 constants as data | 160,033 (156 kB) at c4b13ef (e58f314b, the measured build); **160,057 (156 kB)** at HEAD (1f9bdf5d…4b79) | 14,026 B (at f97e0f2) | yes |

- **Proven equal:** `trim_equals_new_circom` checks the ark, mds and rounds against `get_poseidon_parameters` for t=3
  and t=4, plus 20 hashes per width. The circomlib vectors pass in both builds.
- **This is a test contract, not the vault:** these bytes set no vault size. team lead call: the trim build is the vault's
  stack, and the paper edit is on vault-followup.
- **Measured build:** every number above and in §6 was measured on trim e58f314b (160,033 B, built from c4b13ef), except the coordinate + q row of §2 (1f9bdf5d) and the §1 rows 14-15 block (trimpay 47d9ec99, its baseline trim 1f9bdf5d).
  - The lint commit (848f9e0) changed 25 data-section bytes (panic line numbers); the code is identical
    (`tools/wasm-diff.py`, `sandbox/results/runs/20261026T035433Z/wasm-diff-trim.txt`).
  - The review fixes (57b6b79) grew trim and trimvk by 24 B, and main and trimquiet by 16 B. Each trim call then
    costs exactly +26,143,080 gas (24 × `contract_loading_bytes` 1,089,295), and each trim deploy with `new`
    +2,720,302,896 (main and trimquiet at their own 16 B delta); all 81 metered cases are at the formula for their build's delta and nothing else differs (`tools/gas-compare.mjs`, exit 0;
    the planted red exits 1: `sandbox/results/runs/20261026T044030Z/`).

**The deploy, F8 (M).**
- The main build in the 2.8 batch [CreateAccount, Transfer, DeployContract, FunctionCall] rolls back at its
  FunctionCall (action index 3) with `FunctionBodyTooLarge`. No account is left, and the parent's balance drops only
  by the burnt gas.
- The same build with a bare DeployContract lands keyless and holds its code, but every later call fails with
  `FunctionBodyTooLarge`.
- So the trailing call in the vault's recipe is what keeps a dead contract from landing.

## 6. Testnet (M)

**The deployed build.** Every testnet number here (and in §1-§4 where testnet is named) is from the trim build
**e58f314b, 160,033 B, built from c4b13ef**: the `wasm` record of both runs' txs.json, and the code hash read back
below. team lead call: cite the deployed build, no redeploy. It differs from the trim build at HEAD (1f9bdf5d, 160,057 B) in
two behaviours, read in `contract/src/lib.rs` at each sha (the rest of the diff is rustfmt layout):
- `MAX_RELAY_FEE_BPS` is 1,000 at c4b13ef (l.59) and 5,000 at HEAD (l.61, paper 6fcfa94 2.2);
- a proof coordinate >= q is refused as `InvalidProof` at c4b13ef (`coord()`, l.371-377) and as `InvalidProofEncoding`
  at HEAD (l.386-392). In both builds `coord()` runs in `proof_bytes()`, before `step("parse")` and every row
  (c4b13ef l.566-567, HEAD l.608-609). The coordinate + q cases were sent only in the sandbox (§2, 1f9bdf5d), never
  on testnet.

HEAD's build on testnet, from §5's formula (each call +24 B × `contract_loading_bytes` 1,089,295 = +26,143,080 gas):
the depth-32 withdraw would read 82,420,441,979,409 + 26,143,080 = 82,420,468,122,489 gas, **82.420 Tgas** (82.4205).
26,143,080 gas is 0.000026 Tgas, so the three-decimal figure does not move; 82.446 would need 1,000 times that delta.
The sandbox shows the same delta on this case: 82,321,566,497,210 (003727Z) to 82,321,592,640,290 (044030Z), +26,143,080.

Test contract form: the trailing call is its init `new`; the vault's recipe ends with `config()` (vault.md 6fcfa94
2.8). `new` is not `#[private]`: in the keyless batch the predecessor is the parent, so a private `new` could never
run (near-sdk-macros 5.29.1 `impl_item_method_info.rs` l.185-190). `#[init]` refuses a second call (case g), and the
batch is atomic.

**Run 2**, `testnet/results/runs/20261026T034502Z-testnet/` (signed by the vault lead; key in the script's process
only, faucet NEAR only).
- Setup:
  - parent g1vg-20261026b.testnet, made by the faucet;
  - testnet at protocol 88, nearcore 2.14.0-rc.5;
  - 31 txs, 14 checks, 0 not as expected.
- Three vaults, each `[CreateAccount, Transfer, DeployContract, FunctionCall(new)]` with **no AddKey**:
  - small: tx Hghn3rFju7HFdAxJ4ZNNmEp6CL7vQwXJuRHvzjU1dX13;
  - d16: tx VDpa3YayfpRK493rhNDtsEBS9ZACX6kqQiFR9VyQNLC;
  - d32: tx 4xzYbGe5zgxxnKHfyqekfsdammT8jbeAY5Y5DbKuzZ9S.
- What the reads showed:
  - each key list reads `[]` after the deploy, after the last call, and at read-back time;
  - the code hash is GT71B8i42Z2xegTKpA6TUJQYghRqZfyJUNJG6rKf21DT = base58(sha256 e58f314b…de5a);
  - the small vault's roots after its 5 deposits equal the TypeScript roots, both from the events and from the stored
    side node.
- Read back with `testnet/readback.mjs` on two independent providers, **https://test.rpc.fastnear.com and
  https://near-testnet.drpc.org**: every tx, key list and code hash, with problems 0. Re-read at 6cf8cd6 against the
  run's own sha e58f314b: problems 0.
- Gas against the sandbox:

| Case | Testnet | Sandbox | Gap |
|---|---|---|---|
| Real withdraw, depth 3 | 40.584 | 40.333 | +0.62 % |
| Real withdraw, depth 16 | 49.918 | 49.682 | +0.48 % |
| Real withdraw, depth 32 | 82.420 | 82.322 | +0.12 % |
| Wrong proof | 35.537-35.580 | 35.536-35.577 | +0.01 % |
| Reused nullifier (c, d) | 35.668-35.670 | 35.667 | 0 % |
| Past deadline | 1.734-1.736 | 1.733 | at most +0.16 % |
| Deposits 1-5 | 6.167 / 9.065 / 9.405 / 11.900 / 9.755 | 5.824 / 8.723 / 9.014 / 11.562 / 9.293 | +2.9 to +5.9 %, trie-node reads (§3) |

**Run 1**, `testnet/results/runs/20261026T012516Z-testnet/`, parent g1vg-20261026a.testnet:
- It got as far as the small vault's real withdrawal (40.548 Tgas), then stopped.
- The cause: rpc.testnet.near.org answered -429 "THIS ENDPOINT IS DEPRECATED", and the script read that as "key
  absent".
- The root fix (ba1baee, 7642c1e):
  - an RPC error, or a reply with no result, is never an answer;
  - retries with backoff;
  - nothing is signed after an errored read;
  - node tests for each.
- Read back on the same two providers: 15 txs, problems 0.

**Stranded testnet NEAR** (the keys lived only in the script's process): parent a 7.8634 N and parent b 3.5937 N, both
re-read on FastNEAR and dRPC. Testnet only.

**The key in Keychain** (owner decision round 21, 06:55Z; card vault-followup): runs 1 and 2 kept the parent's key in
the script's process only. From now on `run-testnet.mjs --testnet` keeps it in Keychain item `ct-g1vg-testnet`
(`testnet/keychain.mjs`):
- when the item exists, the key is read from it and the item's account must be the run's parent;
- otherwise the key is made in memory, stored, read back and compared byte for byte, before the faucet call;
- a failed store, a failed read, a mismatch or an item holding another account's key stops the run before any faucet
  call or RPC write;
- the key goes to `/usr/bin/security` only on its stdin (`security -i`) and comes back on the child's stdout, which
  the script captures and never prints. It is never in argv, env, a file, a log, the script's own output or
  `txs.json`, and neither is its public key, with or without the `ed25519:` prefix.

Tested with a stand-in for `security` (`testnet/test/steps.test.mjs`: the store, read-back and refusal cases, and a
whole run in each mode with no `ed25519:` string in what it printed or in `txs.json`; in testnet mode the stored key's
bare base58 and the bare public key are looked for too). One test
round-trips a throwaway item `ct-g1vg-test-<random>` through the real login Keychain and deletes it
(`testnet/test/keychain.test.mjs`); it runs only with `G1VG_REAL_KEYCHAIN=1` on a Mac, and is skipped otherwise. It
passed on the Mac on 26 Oct (`testnet/results/runs/20261026T140311Z-followup-t3b/unit-flag-mac.txt`). The item
`ct-g1vg-testnet` itself does not exist (`security find-generic-password -s ct-g1vg-testnet` exit 44 at 26 Oct 14:23Z),
and `--testnet` has not been run with this code.

## 7. How to re-run

Every step that builds the pinned wasm (`contract/build.sh`) runs on the box, `BUILD_QUEUE=1`: build.sh refuses a
non-Linux host (card vault-followup).

- Prover and vectors: `scripts/the build queue <label> -- proofs/g1-vault-gas/prover/run.sh`. 10 node tests; the PP v1.3.0
  files are fetched by sha256 (wasm 36cda227…, zkey 2a893b42…, vkey 666bd098…).
- Contract, unit tests and the sandbox (88 cases): `BUILD_QUEUE=1 scripts/the build queue <label> --
  proofs/g1-vault-gas/tools/run.sh`. Then `node proofs/g1-vault-gas/tools/gas-compare.mjs <run A> <run B>`.
- Payouts against the real USDC wasm: `BUILD_QUEUE=1 scripts/the build queue <label> --
  proofs/g1-vault-gas/sandbox/payouts.sh run trimpay` (`run trim` is the red; `lint` lints the feature).
- A deposit as U's own call, USDC halted and not (§3.1): `BUILD_QUEUE=1 scripts/the build queue <label> --
  proofs/g1-vault-gas/sandbox/deposit-halt.sh run` (`run --plant-no-halt` and `base` are the reds; `lint`).
- Lint: `BUILD_QUEUE=1 scripts/the build queue <label> -- sh -c 'proofs/g1-vault-gas/contract/build.sh &&
  proofs/g1-vault-gas/tools/lint.sh'`. Besides rustfmt and clippy it runs the testnet node tests and fails when a
  count of them stated here differs from the runner's (`testnet/result-counts.mjs`).
- Testnet tooling: `proofs/g1-vault-gas/testnet/` (`BUILD_QUEUE=1 scripts/the build queue <label> --
  proofs/g1-vault-gas/testnet/rehearse.sh [version]` against a local near-sandbox, sandbox mode, no Keychain; `node --test
  'test/*.test.mjs'`, 53 tests; the real Keychain one is skipped unless `G1VG_REAL_KEYCHAIN=1` is set on a Mac, as it
  writes and deletes a throwaway item in the login Keychain; `readback.mjs <txs.json>`).
  The step tests need the trim wasm from build.sh.

## 8. Not measured or not verified here

- USDC halted or blocking for a withdrawal (VT-S16 (a), (c)). Rows 14-15 and `on_payout` are measured in §1; a halted
  deposit on the kit's path in §3.1. Not run: a halt that lands between the token's move and its resolve (2.5.1 case
  3), which a sandbox cannot time from outside; the intents.near deposit path (no intents.near in the sandbox).
- Row 14 with a state tree that grows a level: no case runs one (both trees have room), so the kit's +148 B for it is
  coded in the runner but never exercised. Row 14 charges the bytes it measures either way.
- The "exec" column assumes NEAR hands all of the withdraw's unused gas to its weight-1 receipts, so that the
  children's prepaid gas is their statics plus that share. The same split holds at both depths. Its two parts are
  checked against protocol 86's fees (§1), not read from a gas profile: the withdraw receipt's profile lists only the
  send fees it burns.
- `settle`, `ragequit`, `storage_prepay`, and the refund reserve's 389 B: not in this test contract.
- A reproducible build (`cargo near build reproducible-wasm`): these builds are non-reproducible.
- No `rehearse.sh` sandbox run of `run-testnet.mjs` at the 1f9bdf5d pin, and no testnet run with the Keychain code
  (§6). Its 53 testnet node tests drive it against a stub chain.
