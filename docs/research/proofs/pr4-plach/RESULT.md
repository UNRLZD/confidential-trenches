# PR4: can v1 route Plach-only NEAR tokens without the Intear router?

Written 2026-10-23 01:27Z (from `date -u`). Prep lane PR4. Mainnet was only read, with free keyless RPCs. No funded
account, no mainnet or testnet tx, no key read or copied. Every key in the sandbox was made in memory for that run.

## Verdict: PASS

Plach (`dex.intear.near`) can be a v1 route through RPC views only, with these limits:

1. G calls the engine directly with one `SwapSimple` followed by one `Withdraw` to itself.
2. The quote comes from `dex_view get_pool` plus our own math.
3. The code hashes are pinned, and a mismatch or a pause means "no route".

On mainnet's wasm and state in near-sandbox 2.13.4, every check passed (69 of 69):

- **Output.** It went only to the caller.
- **Other accounts.** No receipt reached any account other than G, the engine and the token.
- **Min-out failures.** They refunded every unit.
- **Unregistered token account.** A payout to an account that is not registered on the token stayed whole in G's own balance inside Plach and was claimed later.
- **Quotes.** Our view-only quote equalled the actual output to the unit in every swap.

## 1. Facts from the source and the chain

| Fact | Value | Source, time |
|---|---|---|
| Engine code | `DJ3sK9WKXSfhH4Q8ZL9PQWtAQjN1FZSDLevSy9MCRt1y`, 1,435,661 B, storage_usage 3,754,510 | `view_account` on FastNEAR free and dRPC at block 221,169,660 (01:13:53Z) and at H = 221,169,716 (01:14:24-25Z), `results/facts-rpc.jsonl`, `facts.json`; sha256 of `view_code` equal at 221,170,590 and 221,170,792 (sandbox runs, `results/state-manifest-*.json`) |
| Source, licence | NEP-330: github.com/INTEARnear/dex `fd30f501ec27dbc3239e1529b4ce1d8cf5b5ecff`, `cargo near build non-reproducible-wasm`; GitHub API `license: null` (no licence), pushed 2026-10-20T20:17:06Z | `contract_source_metadata` on both RPCs at H (01:14:25-26Z); api.github.com/repos/INTEARnear/dex read 01:28:57Z (`results/github-repo.json`); the commit resolves (HTTP 200, 01:28:58Z) |
| Node | nearcore 2.13.4 (44f7ae6c), protocol 86 | FastNEAR `status`, 01:13:50Z and 01:14:22Z |
| Control | 2 full-access keys (`9P4BVbD2…`, `9vBRw9qE…`); `CAN_PAUSE` = slimedragon.near, pause.slimedragon.near (intear-dex-types/src/lib.rs:22); `trusted_code_deployer` = slimedragon.near, the only account that can deploy or upgrade a dex program (src/internal_operations.rs:43-45); not paused at H | `view_access_key_list`, `get_trusted_code_deployer`, `is_paused` at H |
| Swap program | `slimedragon.near/xyk`, 154,383 B, sha256 `DjEuRWww3siDpKzRDSHox95f7d895oBt3hokaZnHbGu6` on both RPCs | `dex_code` on both RPCs at 221,169,660 (01:14:00Z) and H (01:14:31Z) |
| Entry points | Buy: `deposit_near({operations})`, payable, native NEAR (src/asset_deposit.rs:17). Sell: the token's `ft_transfer_call` → `ft_on_transfer` (asset_deposit.rs:66-123); it always returns 0 used, so a panic in the operations refunds through `ft_resolve_transfer`. Claim: `withdraw(asset_id, amount, withdraw_to)` 1 yocto (src/lib.rs:413). Also `register_assets`, `storage_deposit`, `storage_withdraw` | source at fd30f501 |
| Message | `[{SwapSimple:{dex_id, message: b64 u32 LE pool id, asset_in, asset_out, amount:{Amount:{ExactIn}}, constraint}}, {Withdraw:{asset_id, amount:{Full:{at_least}}, to, rescue_address}}]`; assets are `near` or `nep141:<id>` | intear-dex-types/src/engine_api.rs |
| Recipient | The message does have recipient fields: `Withdraw.to` and `rescue_address`. If `to` is null, the payout goes to the caller (`by`: G for `deposit_near`, the `ft_transfer_call` sender for a sell). Our build must set both to null | internal_operations.rs:742-860; shown on chain in §2 |
| Min-out | `amount_out >= constraint`, else the panic "Output amount is less than constraint" (internal_operations.rs:190-215). The panic reverts the whole receipt | §2 D1, D2 |
| Payout failure | `Withdraw` is a detached `ft_transfer` (10 Tgas, 1 yocto) or a native `Transfer`, then `after_withdraw`. On failure, the amount is re-credited to the recipient's inner balance when the recipient has the asset registered (internal_operations.rs:1040-1109; log "Refunding to … (recipient)"). With no registered owner and no rescue address, the call panics before anything moves (internal_operations.rs:801) | §2 E1, F1 |
| Fees | Each fee in the pool view's `fees` list takes floor(in × fee / 1e6) of the input. The protocol fee is 0.1% to `plach.intear.near`, cut to 1 ppm for NEAR, USDC, USDt and omft (dexes/xyk/types/src/lib.rs:30-51). Pool 273 also charges account, community and pool fees. Referral fees apply only when the message names a referrer, so ours names none | lib.mjs `quote`; matched on chain |
| Math | out = floor(R_out × in_net / (R_in + in_net)). A launch pool prices NEAR on its near_amount, which includes the phantom liquidity | dexes/xyk/src/lib.rs:312; 8 of 8 against mainnet `simulate_swap_simple` at H, `results/facts.json` |
| Views only | Reserves and fees come from `dex_view{dex_id, method:"get_pool", args: b64 u32}` as Borsh; our decoder is independent, with no source copied. The engine pauses its views too: `simulate_swap_simple` answers "Contract is paused" | facts.json; §2 G1 |
| Storage | Min 0.005 N, max none. `storage_unregister` panics: `unimplemented!` at storage_management.rs:223-224, reached from :264. Used storage is never returned. A 64-hex account's first pair uses 846 B for jelly-1 and 847 B for quant (= 436 + 6·64 + the token id's length): 0.00846-0.00847 N, which stays in Plach for good | source; §2 A, X |
| Plach-only | jelly-1.launch.intear.near and quant.launch-v2.intear.near have no Rhea DCL pool with wrap.near at fees 100/400/2000/10000 and appear in none of the 8,982 Rhea classic pools | FastNEAR at block 221,169,809, 01:15:18Z, `results/plach-only.json` |
| Catalog | 298 pools, all readable: 19 private, 113 public, 166 launch (38 LaunchV2). 235 are NEAR-paired, and 40 of those hold ≥ 1 N real NEAR | `get_pool_count` and `get_pools` at H |

## 2. Sandbox run

**Method.** `sandbox.mjs` uses the B2 genesis pattern (proofs/b2-n14-shape) on the near-sandbox 2.13.4 binary, protocol 86, which is mainnet's version.

**State fetched.** The engine's whole state was fetched with one `view_state` call to rpc.intea.rs. The free providers refuse it with TOO_LARGE_CONTRACT_STATE, and Intear's own test suite imports the engine the same way (tests/common/mod.rs:569). The engine's account and code and both tokens' account, code and state came from FastNEAR free at the same block.

**Checks that the fetched state is mainnet's at that block:**

- The storage-usage sum matches exactly: 3,754,510 = 100 + code + Σ(key + value + 40) over 19,456 records + 2 keys.
- The engine code hash is the pinned one.
- The xyk program hash is the pinned one.
- `get_pool(136)` and `get_pool(273)` are byte-identical to mainnet's.
- `get_pool_count` and `total_in_custody(near)` equal mainnet's.

**Tokens.** On mainnet they run NEP-591 global contracts: jelly-1 `8D1NEU2N…`, quant `GVFRDj8D…`. In the sandbox the same bytes were deployed on each token account.

**Runs:**

- **Run 2: PASS, 69 of 69 checks.** 2026-10-23 01:24:51-01:26:06Z, H = 221,170,792. Files: `results/sandbox-2026-10-23T01-24-51-994Z.json`, `sandbox-checks-…jsonl`, `sandbox-txs-…jsonl`.
- **Run 1: 62 of 63 checks.** 01:22:53Z, H = 221,170,590. The one failure was in the harness, not in Plach. A panicking view comes back as `{error}` with no `result`, and the helper read `result`. Run 1's tx log shows the same "Contract is paused" refusal on chain. After the fix, run 2 checked that the view itself answers "Contract is paused". Both runs are kept.

**Where it ran.** Both runs went through `scripts/heavy.sh pr4-plach -- proofs/pr4-plach/run.sh`. The PC box did not answer ("<build box> does not answer"), so both ran in the Mac's slot-2.

Pools: 136 = jelly-1 (launch v1, 10.63 N real). 273 = quant (LaunchV2 with four fee receivers, 4.25 N real). Each G is a
fresh 64-hex implicit account.

| Case | What ran | Result |
|---|---|---|
| X | 0.005 N `registration_only`, then `register_assets([near, T])` | Fails: "Storage used (0.009 NEAR) exceeds total (0.005 NEAR)". The arm needs `registration_only: false` and more than 0.005 N |
| A | One tx G → engine: `storage_deposit` 0.02 N, `register_assets`, `storage_withdraw` | Armed. 0.00846/0.00847 N stays as used storage, 0 available. G paid exactly that + 2 yocto + gas. Only G and the engine touched |
| B | Buy, `deposit_near` 0.5 N, constraint = our quote | Tokens = our quote = simulate, to the unit, on both pools. G's NEAR fell by exactly 0.5 N + gas. One `ft_transfer`, receiver = G. Nothing left inside Plach |
| C | Sell all, `ft_transfer_call` | One `Transfer` engine → G = our quote = simulate (0.499001… N and 0.481202… N). G's NEAR rose by exactly quote − 1 yocto − gas |
| D1 | Buy 0.3 N, constraint = quote + 1 | "Output amount is less than constraint". The runtime refunded exactly 0.3 N; G lost only gas. Pool bytes unchanged |
| D2 | Sell, constraint = quote + 1 | Same panic inside `ft_on_transfer`. `ft_resolve_transfer` returned every token; G lost gas + 1 yocto. Pool unchanged. The same tokens then sold at the quote (D3) |
| E1 | Buy with G registered on Plach but not on the token | Swap lands. The `ft_transfer` to G fails, and the whole output is re-credited to G's own balance inside Plach. No other account touched |
| G | Pause by pause.slimedragon.near while E1's output is held | The quote view answers "Contract is paused". A buy sent anyway fails, with its deposit refunded in full. The held output cannot be withdrawn while paused but stays whole. Then unpaused |
| E3 | After the token registration (N-3): `withdraw({asset_id, amount:{Full:{at_least:null}}, withdraw_to:null})` | Pays the full held amount to G. Inner balance 0 |
| F1 | Buy from a G never registered on Plach | "No rescue address provided…". 0.25 N refunded in full, pool unchanged |
| H1 | N-3, then one tx: `storage_deposit` 0.02 N, `register_assets`, `storage_withdraw`, `deposit_near` 0.5 N | Arms and buys in one receipt (all or nothing). Tokens = quote. G paid exactly 0.5 N + 0.00847 N + 2 yocto + gas. A sell back paid the quote |
| H3 | X's half-registered G runs A's batch | Armed, 0 available |

**Gas.** Per tx: what was attached, then what was burnt across all receipts, from the tx log.

| Tx | Attached | Burnt |
|---|---|---|
| Arm (A) | 60 Tgas | 33.5 Tgas, 0.00184 N |
| Buy (B) | 100 Tgas | 49.7-52.3 Tgas, 0.0027-0.0030 N |
| Sell (C) | 150 Tgas | 75.3-78.4 Tgas, 0.0038-0.0041 N |
| Arm + buy (H1) | 160 Tgas | 77.9 Tgas, 0.0048 N |
| Claim (E3) | 50 Tgas | 31.8 Tgas, 0.0009 N |
| Token registration (N-3) | 10 Tgas | 9.4-9.6 Tgas |
| A failed buy | 100 Tgas | 18-35 Tgas |

## 3. What a v1 Plach route needs (for CO and the build lane)

**Shapes**, all signed by G:

- **P-1 arm.** The A batch, or merged with the first buy as H1. It runs after N-3 has executed, as DN-24 (d) already requires on Plach.
- **P-2 buy.** `deposit_near`.
- **P-3 sell.** The token's `ft_transfer_call` to `dex.intear.near`.
- **P-4 claim.** `withdraw`, for `fill.held`.

**Checks (§5.3):**

- `dex.intear.near` joins the receiver allowlist, with its methods.
- The message is re-parsed after the build: exactly one `SwapSimple` on the quoted pool and `dex_id`, then one `Withdraw` of `asset_out`.
- `to` and `rescue_address` are null, and there is no `referrer` or `referral_fees`.
- `constraint` = `at_least` = minOut > 0.

**Quote:**

- Decode `get_pool` (Borsh) and apply the fee list and xyk math.
- Read the engine's `code_hash` at the same block on every quote.
- Read the xyk program's sha256 (a 154 kB `dex_code` read) on a cached interval.
- A mismatch, `is_paused`, or a view error means "no route".

**Fill.** `fill.held` is a non-zero `asset_balance_of({Account: G}, T)`. The claim is P-4.

**Rent and teardown:**

- About 0.0085 N per G that ever trades on Plach is never returned. It goes in `rentOpened` and on the stranded line, like a refused N-12.
- Teardown runs P-4 for any held balance before N-13.

**Trust.** The engine is upgradable at any time by 2 full-access keys and pausable by 2 accounts. In October its code was redeployed four times (Oct 5, Oct 15, and twice on Oct 20) and the xyk program three times (Oct 15, 17, 20). Source: UNRLZD `docs/facts/external-facts.md` E1 and `docs/audit/plach-redeploy-2026-10-21.md`. With no standing approvals, our exposure is the in-flight trade plus any held balance.

## 4. Build work, lane-days (method of docs/spec/10-build-plan.md §4.2; all [derived])

| Item | Days |
|---|---|
| Adapter shapes P-1 to P-4 in `adapters/near/`, the §5.3 Plach checks and message re-parse, receiver and method allowlist, fill.held and claim | ≈ 0.75 |
| Quote: Borsh PoolView decoder, the fee list and xyk math, the token → pool index (`get_pools`, 13 pages of 24), code-hash pins, pause and mismatch → "no route" (ported from `lib.mjs`, already unit-equal with the chain) | ≈ 0.75 |
| AU cases in `harness/au-near/` from `sandbox.mjs`: arm, buy, sell, min-out (both sides), held payout and claim, not registered, paused | ≈ 0.5 |
| Rent and teardown: the Plach storage on the stranded line, P-4 in N-9 | ≈ 0.25 |
| Journeys and route check: J3.3 and J4.F8 lose "Plach-only included"; the "no route" state stays for tokens with no pool at all; copy unchanged | ≈ 0.1 |
| **Total** | **≈ 2.35** |

**Lane.** Two lanes own these folders, and neither can take the whole of it:

- `adapters/near/` is L2's, and L2's slack is ≈ 0.45.
- `harness/au-near/` is L1e's, and L1e's slack is ≈ 0.7.

The NEAR adapter is not on M1's path; it goes to M2 at I2, Nov 5 22:00Z. CO has three ways to place the work:

- **Split by lane.** L1e takes the AU cases (0.5), and the ≈ 1.85 for the adapter and the quote goes to a lane with ≥ 1.85 slack. None has that by §4.2: L6 has ≈ 1.8 by M222 (≈ 1.05 by its rows), L3 ≈ 1.5, L1c ≈ 1.4.
- **New lane.** A new short lane takes `adapters/near/plach/` from Nov 2.
- **Land later.** Plach lands in I3 (Nov 6 22:00Z) instead of I2.

`[value needed: CO, the lane]`.

## 5. Open

1. **Storage for a second token.** The cost of a second Plach token on the same G (the extra bytes of `register_assets`) was not measured.
2. **Sell gas.** 100 Tgas for a sell was not tried. Run 2 attached 150 Tgas and burnt ≤ 78.4.
3. **xyk hash re-read interval.** How often to re-read the xyk program's hash is a design choice. Only slimedragon.near can change it (internal_operations.rs:43-45).
4. **Coverage.** The 95% bar rests on 03's count (528 of 568 without Plach). This lane did not recount coverage with Plach. The catalog shows 235 NEAR-paired pools.
5. **Real money.** No real-money canary has run any of this; that comes after the build, per the money-flow rule.

## 6. Files and rerun

- **Shared code.** `lib.mjs` holds the keyless RPC client (call cap, every call logged), the Borsh decoder and the quote math.
- **Mainnet reads.**
  - `facts.mjs` reads step 1's facts and writes `results/facts.json` and `facts-rpc.jsonl`.
  - `plach-only.mjs` runs the Rhea check and writes `results/plach-only.json`.
- **Sandbox.** `sandbox.mjs` and `run.sh` run it: from the repo root, `scripts/heavy.sh pr4-plach -- proofs/pr4-plach/run.sh`. Each run writes `results/run-*.txt`, `state-manifest-*.json`, `sandbox-*.json`, `sandbox-checks-*.jsonl`, `sandbox-txs-*.jsonl` and `fetch-rpc.jsonl`.
- **GitHub.** `results/github-repo.json` holds the GitHub repo read.
- **Not committed.** The fetched engine state (2.5 MB) and the wasm. The manifest records their hashes, sizes and record counts.
