# V6: how a keyless vault pays R inside `intents.near` (pull method)

Status 2026-10-22 19:43Z: **sandbox PASS** (22/22 checks on the real mainnet wasm of `intents.near` and native USDC,
run 19:29:15-19:29:39Z). **No money moved.** The live check is written (`live.sh`), its `--dry` passes (19:43Z) and its tx builder passed on a local node; the owner runs it.

**M195 (1), 2026-10-22 20:09Z (§7):** intake in `mt_on_transfer` **sandbox PASS** (8 new checks, 30/30 in all, run
20:05:55-20:06:29Z): R's `mt_transfer_call` is counted exactly, another token is refunded in full, a direct call
panics, a plain `mt_transfer` lands uncounted. R's sweep burns 9.26 Tgas, the callback 1.44 Tgas. The float → R
unshield (`CONFIDENTIAL_INTENTS → INTENTS`, recipient R) is offered: dry keyed quote HTTP 201, fee $0, eta 10 s.
`live.sh`, `run.mjs` and `contract/wasm/v6_pay.wasm` are unchanged.

**Scope change (team lead, 2026-10-22 ~18:50Z).** The vault no longer verifies 1Click quotes: no vendor key or vendor API
format lives in the immutable vault. The vault pays its ONE fixed recipient R by a plain transfer inside
`intents.near`, under the VB rate limit; R (the enclave's account) then shields R → float through 1Click. This is
path B1 of `docs/research/vault-custody.md` (§4) with E = R. The first contract written for the old brief (a
quote-verifying `refill`) was dropped before any build or commit. The directory keeps its planned name.

## 1. The method (frozen into the Nov 1 interfaces)

**The vault calls `intents.near` `mt_transfer` as predecessor:**

```
receiver: intents.near   method: mt_transfer   deposit: 1 yoctoNEAR   gas attached: 10 Tgas
args: {"receiver_id": "<R>", "token_id": "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", "amount": "<u128 string>"}
returns: nothing (a failed receipt means nothing moved)     omit: approval (refused), memo (optional, public)
```

- **No access key, no signed intent, no registration, no storage deposit.** `intents.near` authenticates the call by
  `predecessor_account_id` alone; the vault never holds an `intents.near` public key and never needs one.
- **The vault's balance must exist before it can send** (the sender's account is looked up, not created); a deposit
  or a transfer to the vault creates it. R needs nothing: the receiver is created on first credit.
- **Gas, measured** (sandbox, protocol 86, the mainnet code): `mt_transfer` burnt **3.74 Tgas** in `intents.near`;
  the whole `pay_r` tx 7.83 Tgas (vault 2.01 + `intents.near` 3.74 + callback 1.33 + refunds). Mainnet precedent
  (E5): 3.92 Tgas burnt of 7 attached. Attach 10 Tgas to `mt_transfer`; 30 Tgas to the caller's tx is ample.
- **Timing:** tx at block b, the vault's receipt at b+1, `intents.near` moves the balance at **b+2** (R can spend
  it from then), the callback at b+3.
- **Callback:** `pay_r` chains `.then(on_paid)` (5 Tgas); `on_paid` reads the promise result with
  `promise_result_checked` and logs `paid` / `pay_failed`. The VB counter must be charged only on `paid` (or charged
  before and refunded on `pay_failed`): a failed `mt_transfer` panics inside `intents.near` and moves nothing.
- **Not available:** `ft_transfer` on `intents.near` does not exist (the contract is NEP-245 only; its 58 call methods
  list no `ft_transfer`). `ft_withdraw` + the token's `ft_transfer_call` also works for a contract, but it is two hops,
  needs USDC storage on the vault and leaves the money as NEP-141 on a failure; nothing needs it now that the vault pays
  R inside `intents.near`. A signed intent (`execute_intents`) is impossible for a keyless account: the signer must hold
  a registered key, and registering one gives that key full control of the balance (vault-custody §2).

### Evidence

| # | Fact | Tag | Source |
|---|---|---|---|
| E1 | `mt_transfer(receiver_id, token_id, amount, approval?, memo?)`, payable, call; `mt_batch_transfer` the same over lists. No `ft_transfer` among its 58 call methods (96 functions) | M | ABI embedded in the mainnet wasm (`__contract_abi`, zstd JSON), read at block 221,129,079 (2026-10-22, between 18:35Z and 18:45Z); code hash `BtA1BEFNS619KkvXFsgcpQ21Tb5yMm32aaUkn7xNothk` |
| E2 | `mt_transfer` → `mt_batch_transfer`: `assert_one_yocto()`; `approvals.is_none()` required; sender = `ensure_auth_predecessor_id()` | S | near/intents `16d04f6e` (defuse 0.4.5, the deployed build) `contracts/defuse/src/contract/tokens/nep245/core.rs:17-56` |
| E3 | `ensure_auth_predecessor_id`: refuses only when predecessor auth is disabled for that account; no key check | S | `contracts/defuse/src/contract/accounts/mod.rs:79-85` |
| E4 | Transfer rules: sender ≠ receiver, amounts > 0; sender must exist (`AccountNotFound`) and not be locked (`AccountLocked`); receiver `get_or_create` (locked receivers still receive); one NEP-245 `mt_transfer` event with sender, receiver, amount and memo | S | `core.rs:164-216` |
| E5 | Live precedent: `orderbook.fi.tg` has 0 NEAR access keys, `public_keys_of` = `[]`, predecessor auth on; its tx `5X2Hi3ZWzuu9tgR91j2gmJyhdJucRLS53GfwEj8eqDp1` has receipt `6qjojTWU…` `orderbook.fi.tg` → `intents.near` `mt_transfer` (deposit 1, gas 7 Tgas, burnt 3.92 Tgas, `SuccessValue`, event `old_owner_id: orderbook.fi.tg`) | M | 2026-10-22 18:58-18:59Z: keys and views on rpc.mainnet.near.org (blocks 221,131,236-258) and free.rpc.fastnear.com (221,131,261-268); the tx on archival-rpc.mainnet.fastnear.com and archival-rpc.mainnet.near.org (both `SuccessValue`, same receipts). First found by V1 (vault-custody 1.5) |
| E6 | On the real code: a contract created with no AddKey (0 access keys, `public_keys_of` = `[]`) receives by deposit and by transfer, pays R with `mt_transfer` (vault −1, R +1, one `mt_transfer` event vault → R), reads its own balance, and cannot be spent by any signed intent (`public key … doesn't exist for account`) | M (sandbox) | §2; `results/sandbox-run.json` |
| E7 | An `intents.near` role can stop any account, the vault included: `force_lock_account` (sends refused, receives allowed), `force_disable_auth_by_predecessor_ids` (the vault could not move anything until re-enabled), `mt_force_transfer` (moves anyone's balance). Roles DAO / UnrestrictedAccountLocker / UnrestrictedAccountManager / UnrestrictedWithdrawer | S | `contracts/defuse/src/contract/accounts/force.rs:16-82`; `tokens/nep245/force.rs:16-39`. The same trust as every `intents.near` balance; not new to this design |

## 2. Sandbox (PASS, 22/22)

Checks 1-22 below are the pull. The record `results/sandbox-run.json` is now the 20:05:55-20:06:29Z run, which adds
§7's intake checks 23-30 (30/30). Checks 1-22 gave the same results and gas as at 19:29Z.

`BUILD_QUEUE=0 scripts/the build queue v6-pull -- proofs/v6-shield/tools/run-sandbox.sh` (the build box `<build box>` reset SSH
at 18:58Z, `the build queue` exit 69, so the Mac slot queue ran it as `the build queue` documents). near-workspaces 0.23.0,
near-sandbox 2.13.4 (protocol 86, as mainnet), rustc 1.96.0, cargo-near 0.22.0, Darwin arm64. The two mainnet wasms are fetched by `view_code` at block 221,129,079 (FastNEAR archival) and must
match the pinned code hashes; they are patched in under their real ids (`intents.near`, the USDC account) and
initialised fresh (`intents.near` `new` with fee 0; USDC `init` with sandbox roles). The test contract
(`contract/`, 131,548 bytes, sha256 `a1021b73…f0cd`) is created by ONE batch: CreateAccount, Transfer, DeployContract,
`new` — no AddKey.

| # | Check | Result |
|---|---|---|
| 1-6 | `intents.near` `new` (fee 0) and USDC `init` on the mainnet wasms; USDC storage for alice and `intents.near`; alice's balance and the total supply patched to 10 USDC (FiatToken mints only through its multisig) | ok |
| 7 | Vault created by one batch: CreateAccount, Transfer 5 N, DeployContract, `new` (24.6 Tgas) | ok |
| 8 | Vault has **0 access keys** (storage 131,871 bytes) | ok |
| 9 | `intents.near`: `public_keys_of(vault)` = `[]`, `is_auth_by_predecessor_id_enabled` = true, with no call by the vault | ok |
| 10 | Deposit 3 USDC to the vault: `ft_transfer_call(intents.near, msg = vault)`; no registration of the vault anywhere | ok |
| 11 | A plain `mt_transfer` of 0.5 USDC from alice credits the vault | ok |
| 12 | **`pay_r(1 USDC)` called by a stranger: vault −1 USDC, R +1 USDC, one NEP-245 `mt_transfer` event `old_owner_id: vault`, `new_owner_id: R`; callback logs `paid`, returns true** | ok |
| 13 | `pay_r` above the balance: `intents.near` panics "insufficient balance or overflow", the callback logs `pay_failed` and returns false, nothing moves | ok |
| 14-16 | `pay_r(0)` refused; `return_to_owner` by a stranger refused; `on_paid` called directly refused ("Method on_paid is private") | ok |
| 17 | `vault.balance()`: a cross-contract `mt_balance_of(vault)` returns 2.5 USDC (the vault can read its own balance) | ok |
| 18 | **R (an implicit id, no `add_public_key`) signs a `transfer` intent (`raw_ed25519`, versioned nonce, salt from `current_salt`) to a 64-hex "deposit address": R −0.4, address +0.4** (the shape of R's shield intent, §3) | ok |
| 19 | A signed transfer intent credits the keyless vault | ok |
| 20-21 | A signed intent with `signer_id` = vault is refused with a random key and with R's key: "public key … doesn't exist for account 'vault.test.near'" | ok |
| 22 | `return_to_owner` by the owner: vault → owner, vault 0 | ok |

Earlier runs (19:04Z, 19:17Z) failed checks 10-12 and their followers: the sandbox USDC's total supply was 0 after
the balance patch, so `ft_transfer_call` panicked "Total supply overflow". The runner now patches the supply too
(check 5). Only the final run's record is kept.

Record: `results/sandbox-run.json` (every outcome: receipts, gas, block offsets, logs, errors). The run log is
gitignored (`*.log`); the same lines are in the JSON.

## 3. R → float: what P1 proved and what it did not

- **The call R makes** (the documented signed-intent deposit, docs L2888-2898):
  1. `POST /v0/quote` with the partner key: `{"dry":false,"swapType":"EXACT_INPUT","slippageTolerance":100,
     "originAsset":"nep141:<USDC>","destinationAsset":"nep141:<USDC>","amount":"<R's balance>","depositType":"INTENTS",
     "recipient":"<float>","recipientType":"CONFIDENTIAL_INTENTS","refundTo":"<R>","refundType":"INTENTS","deadline":…}`
     (docs L4313-4356: same asset both sides).
  2. `POST /v0/generate-intent` `{"type":"swap_transfer","standard":"raw_ed25519","signerId":"<R>","depositAddress":…}`.
  3. R's key signs the payload unchanged (`raw_ed25519`); 4. `POST /v0/submit-intent` `{"type":"swap_transfer","signedData":…}`.
  5. Poll `GET /v0/status?depositAddress=…`; the float sees the credit in `GET /v0/account/balances`.
  This is P1's `confLeg` (`proofs/p1-private-balance/run.mjs:366-398`) with `depositType: INTENTS` instead of
  `CONFIDENTIAL_INTENTS`.
- **P1 did not run this leg.** P1's shield was an `ORIGIN_CHAIN` deposit (a native NEAR Transfer to a 64-hex deposit
  address, `run.mjs:211`, RESULT "Deposit = native NEAR → private USDC"); its other legs started from a confidential
  balance (`depositType: CONFIDENTIAL_INTENTS`, signed for `intents.far`). An `INTENTS → CONFIDENTIAL_INTENTS` shield from
  a public `intents.near` balance is DOCS-ONLY (`docs/research/intents-confidential.md` row 2b) and its settle time is
  "not measured" (vault-custody §4 B1 step 8).
- **Dry evidence today** (`runs/2026-10-22T19-03-04-722Z-dry.json` 19:03Z, repeated by the final script in
  `runs/2026-10-22T19-30-36-819Z-dry.json` 19:30Z and `runs/2026-10-22T19-43-12-067Z-dry.json` 19:43Z): a keyed dry shield quote, 1 USDC → 1 USDC
  confidential (min 0.99), fee $0, eta 10 s; a real (unfunded, unsigned) shield quote + `generate-intent` returned
  the payload R would sign: `verifying_contract: "intents.near"`, `signer_id: <R>`, one `transfer` of
  `nep141:<USDC>` 1000000 to a 64-hex deposit address, deadline +72 h, versioned nonce. The sandbox ran this exact
  intent shape (an implicit id's own key, no `add_public_key`, a `transfer` to a 64-hex address): §2.

## 4. The live check: still needed, for R's leg

**Yes, one paste, about $1.** Not for the vault's call (E2-E6 settle that), but because R → float from a public
`intents.near` balance has never run: if 1Click does not take an `INTENTS`-origin shield, path B1 has no money leg.
The paste also measures the shield time (R9) that B1 step 8 lacks, on the same code as the sandbox.

```sh
sh ~/Downloads/confidential-trenches/proofs/v6-shield/live.sh
```

What it does (`run.mjs --live`; each step is skipped when the chain shows it done, so a rerun resumes):

| Step | Tx / call | Money |
|---|---|---|
| 1 vault | funder Transfer HOLD → fresh implicit account `v6-vault`; that account deploys `contract/wasm/v6_pay.wasm` (sha256 pinned) + `new(owner = funder, intents.near, nep141:USDC, r = R)` in one tx | HOLD 1.4854 NEAR (code storage + 0.15 for the deploy's prepaid gas), returned in step 5 |
| 2 fund | 1Click `ORIGIN_CHAIN` NEAR → USDC, `recipientType: INTENTS`, recipient = vault; funder sends one NEAR Transfer to the deposit address (P1's deposit leg) | $1 of NEAR (dry 19:43Z: 0.2033 NEAR → 0.996 USDC, fee $0.004) |
| 3 pay | funder calls `vault.pay_r(balance)` (30 Tgas); the vault calls `intents.near mt_transfer(R)` | moves the USDC vault → R |
| 4 shield | R: quote → `generate-intent` → check (signer R, `intents.near`, only USDC to this deposit address, ≤ `amountIn`) → sign → `submit-intent`; watches status and the float's balance | R → float (dry: fee $0) |
| 5 cleanup | the vault (balance 0) deletes itself; NEAR → funder | HOLD back |

- Refuses: `--usd` above 1; a funding quote above $1.05 in or losing more than 3%; a shield losing more than 1%; a vault
  balance above 1.05 USDC; `intents.near` code other than `BtA1…Nothk`; a wasm other than the pinned one.
- Funder: 4.1007 NEAR at 19:43Z; the run needs 1.7087 NEAR (of which the 1.4854 hold comes back), so no top-up.
- **The tx builder ran on a real node** (`tools/run-txtest.sh`, 19:42Z, `results/txtest.json`): `run.mjs`'s own Borsh
  code, extracted verbatim, sent Transfer (creating the implicit vault with the hold), DeployContract + `new`, `pay_r`
  and DeleteAccount to a local near-sandbox 2.13.4: 6/6 checks (code hash = the wasm, config, `pay_failed` with no
  `intents.near`, vault gone). Its first run caught a real bug: with a 0.02 NEAR margin the deploy failed
  `LackBalanceForState` (prepaid gas is taken before the storage check; that sandbox prices gas at 1e9 yocto); the
  hold now carries 0.15 NEAR and `new` gets 30 Tgas. The cleanup tx shows one failed receipt by design: the gas
  refund to the deleted vault.
- Keys: `~/.confidential-trenches/keys/v6-vault.json`, `v6-r.json`, `v6-float.json`, written 0600 before any money moves
  and kept. The float keeps the shielded ≈ $1 (its key signs it out later).
- The mainnet test vault keeps its deploy key, so it can delete itself and return the storage NEAR. `intents.near`
  never looks at NEAR access keys (E3), so this changes nothing in the call; keyless is proven by E5 and §2.
- A rerun after a stop resumes from the chain state; a rerun after a finished run sends nothing (vault gone, float
  credited). If a stop comes after the shield's `submit-intent`, wait for 1Click's status before rerunning.
- After the paste, team lead: `node proofs/v6-shield/verify.mjs proofs/v6-shield/runs/<run>-live.json` reads every NEAR tx on
  rpc.mainnet.near.org and FastNEAR (archival when old) and checks the pay receipt: predecessor = vault, `mt_transfer`,
  deposit 1, receiver_id = R, `SuccessValue`.

## 5. UNVERIFIED until the live paste

1. That 1Click settles an `INTENTS → CONFIDENTIAL_INTENTS` shield funded by R's signed `transfer` on `intents.near`, and
   how long it takes (R9).
2. Whether R's public `intents.near` balance must be fully swept or keeps dust (the quote's `amountIn` vs R's balance).
3. Gas of `pay_r` and `mt_transfer` on mainnet state (the sandbox ran protocol 86 like mainnet: 3.74 Tgas; mainnet's
   precedent burnt 3.92 Tgas).
4. That a float → R unshield settles, and how long it takes: the quote is offered (§7) but was dry only. The live paste
   does not run this leg either.

Not UNVERIFIED (settled here): the method, its args, deposit and gas; that a contract with no key holds and moves its
`intents.near` balance; that neither the vault nor R needs registration or storage on `intents.near`.

## 6. Public footprint (unchanged from vault-custody 3.4/3.5)

Each pay emits a NEP-245 `mt_transfer` event naming the vault, R and the amount; R's shield transfer names R and a
1Click deposit address. The float's id appears in no public event (it is only in the quote sent to 1Click).

## 7. Intake: the vault counts arrivals in `mt_on_transfer` (M195 (1))

### What `intents.near` does (source, near/intents `16d04f6e`)

| # | Fact | Source |
|---|---|---|
| I1 | `mt_transfer_call(receiver_id, token_id, amount, approval?, memo?, msg)` → `mt_batch_transfer_call`: 1 yocto, approvals refused, sender = `ensure_auth_predecessor_id()` (as E2) | `contracts/defuse/src/contract/tokens/nep245/core.rs:60-103` |
| I2 | It moves the balance first, then calls `<receiver>.mt_on_transfer(sender_id, previous_owner_ids = [sender_id], token_ids, amounts, msg)` with static gas = `min_gas` (none for `mt_transfer_call`, so 0) and **all unused gas** (weight 1), then `intents.near.mt_resolve_transfer` with a fixed 10 + 5 per token Tgas (weight 0) | `core.rs:219-306`; receiver trait `crates/near/nep245/src/receiver.rs` |
| I3 | `mt_resolve_transfer` reads the receiver's return as `Vec<U128>` of refunds. A panic, bad JSON or a wrong length means **refund in full**. Each refund is capped at the amount and at what the receiver still holds; a refund emits `mt_transfer` receiver → sender with memo `"refund"`. It returns the amounts kept | `contracts/defuse/src/contract/tokens/nep245/resolver.rs:13-122` |
| I4 | Other callers of `mt_on_transfer`: a `transfer` intent with `msg` (min_gas default 30 Tgas, floor 5; sender = the signer), and `mt_force_transfer_call` / `mt_force_batch_transfer_call` (DAO or UnrestrictedWithdrawer role; sender = the owner whose balance is moved). A deposit cannot notify at this commit (`DepositAction::Notify` is commented out). The `imt` mint path is behind a feature that the deployed ABI does not have (0 `imt` strings) | `core/src/intents/tokens.rs:60-128`, `core/src/tokens.rs:11-12`; `src/contract/tokens/nep245/force.rs:62-110`; `src/tokens/mod.rs:72-75`, `nep141/deposit.rs:46-61`; ABI as E1 |

So the vault keeps USDC by returning `["0"]`. If its `mt_on_transfer` panics, the whole sweep goes back to R: nothing
is lost and nothing is counted. A plain `mt_transfer`, a deposit or a transfer intent without `msg` never calls the
vault.

### Sandbox (PASS, 8/8; same harness, same hash-pinned mainnet wasm, run 20:05:55-20:06:29Z)

The receiver is `intake/` (crate v6-intake, 127,737 bytes, sha256 `f18a175d…5026`), a stand-in for the vault's
counter: `new(intents, token_id)`; `mt_on_transfer` requires predecessor = `intents.near`, keeps and counts USDC (refund
0), refunds any other token in full, logs `sender_id` and the amounts; `received()` is the counter. It is a separate
crate so that `contract/wasm/v6_pay.wasm`, whose sha256 `run.mjs` pins, stays byte-identical (the rebuild gave
`a1021b73…f0cd` again). R is the same key as §2, now also a NEAR implicit account so it can sign
`mt_transfer_call` itself.

| # | Check | Result |
|---|---|---|
| 23 | A second token, OTHER: the FiatToken wasm under `other.test.near`, alice holds 5 | ok |
| 24 | Intake contract created by one batch, 0 access keys | ok |
| 25 | R as a NEAR implicit account (a transfer creates it with R's key); R +3 USDC and +2 OTHER on `intents.near` | ok |
| 26 | **R `mt_transfer_call(intake, USDC, 1 USDC, msg "")`: `mt_on_transfer` logs `sender_id` R, `previous_owner_ids` [R], amount 1000000, returns `["0"]`; the counter goes 0 → 1000000 (exactly the amount); R −1, intake +1; the tx returns `["1000000"]` (kept)** | ok |
| 27 | **OTHER by `mt_transfer_call`: `mt_on_transfer` returns `["1000000"]`, `intents.near` emits the refund event intake → R (memo `"refund"`); R's OTHER unchanged, intake holds 0 OTHER, counter unchanged; the tx returns `["0"]`** | ok |
| 28 | **`mt_on_transfer` called directly by alice and by R (claiming 5 USDC): panics "only intents.near"; counter unchanged** | ok |
| 29 | **A plain `mt_transfer` R → intake of 0.25 USDC lands (intake +0.25), the counter is unchanged, and no receipt runs on the intake** | ok |
| 30 | Extra: R's signed `transfer` intent with `msg ""`, sent by alice (R spends no NEAR): `mt_on_transfer` sees `sender_id` R, counter +0.5, returns `["0"]` | ok |

**Gas, check 26** (100 Tgas attached; burnt):

| Receipt | Block | Tgas |
|---|---|---|
| R's tx → receipt | b | 0.32 |
| `intents.near` `mt_transfer_call` (moves the balance, calls the vault) | b+1 | 4.63 |
| **intake `mt_on_transfer` (the vault's callback)** | b+2 | **1.44** |
| `intents.near` `mt_resolve_transfer` | b+3 | 2.87 |
| **R's sweep in all** | | **9.26** |

- The counter rises at b+2. At mainnet's gas floor (1e8 yocto per gas) 9.26 Tgas is about 0.0009 NEAR.
- The two gas-refund receipts to R report 7.52 Tgas each but burn 0 tokens. A transfer to an implicit id is costed as
  create_account + add_key + transfer. With them the raw tx total is 24.31 Tgas.
- With a refund (check 27): 0.31 + 4.61 + 1.42 + 3.82 = 10.17 Tgas. Signed-intent form (check 30): 0.34 + 5.64 + 1.44
  + 2.87 = 10.29 Tgas, paid by whoever sends it.
- Not tested: less than 100 Tgas attached. The resolve reserves 15 Tgas (I2) and the callback gets the rest. A real
  vault callback that does more than count will burn more than 1.44 Tgas.

### The float → R quote (one dry, keyed quote)

`node proofs/v6-shield/tools/quote-unshield.mjs`, 20:07:27Z, record `runs/2026-10-22T20-07-27-335Z-unshield-dry.json`.

- Request: 1 USDC, `originAsset` = `destinationAsset` = `nep141:<USDC>`, `depositType: CONFIDENTIAL_INTENTS`,
  `recipient` R, `recipientType: INTENTS`, `refundTo` the float, `refundType: CONFIDENTIAL_INTENTS`, slippage 100,
  `dry: true`. R and the float are throwaway 64-hex ids. The partner key goes as `X-API-Key`. The body is FD-P-05 §2
  (`proofs/fdp05-unshield/RESULT.md`, docs L4356) with recipient R instead of the account itself.
- **M: HTTP 201 in 626 ms, and every field is echoed in `quoteRequest`, so 1Click offers it with R ≠ float.**
  `amountIn` 1000000 → `amountOut` 1000000 (min 990000), $0.999466 on both sides: **fee $0** (`refundFee` 0,
  `withdrawFee` 0), **eta (`timeEstimate`) 10 s**. `quoteRequest` adds `confidentiality: "basic"`, `depositMode:
  SIMPLE`, `insured: false`, `appFees: []`. A dry quote has no deposit address.
- These are the same numbers as FP-3 (`proofs/o35/RESULT.md`, where recipient = the same account).
- The script's summary line read `confidentiality` from `quote`, which lacks it, so the record's `summary` omits it.
  The raw response in the record has it. The script now reads `quoteRequest`; it was not rerun, since one quote was
  asked.

## Files

- `contract/` the test contract (`pay_r`, `on_paid`, `balance`, `return_to_owner`, `config`); `wasm/v6_pay.wasm` the
  build the live check deploys. `build.sh` builds it (cargo-near 0.22.0, rustc 1.96.0, `Cargo.lock` seeded from
  `proofs/v2-note-gas`).
- `intake/` the intake stand-in (§7: `mt_on_transfer`, `received`); `wasm/v6_intake.wasm` the build the sandbox ran.
- `sandbox/` the runner; `tools/run-sandbox.sh` builds both contracts and the runner and runs it.
- `tools/quote-unshield.mjs` the one dry, keyed float → R quote (§7).
- `run.mjs` (`--dry` default, `--live`), `live.sh` (the paste), `verify.mjs` (team lead's two-provider check; tried on the
  E5 precedent tx: both providers `SuccessValue`, pay shape ok), `tools/txtest.mjs` + `tools/run-txtest.sh` (the tx
  builder on a local node).
- `runs/` run records (no keys, no tokens); `results/` the sandbox record.
