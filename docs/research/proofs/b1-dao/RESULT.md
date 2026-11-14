# B1: the 2-of-2 admin DAO paste

Status 2026-10-22 18:59Z: **ready for the owner's Oct 25 paste**, prep lane B1 (timeline v2 §4.1 Oct 23 08:00Z row,
pulled forward). Nothing was sent on mainnet: every mainnet call below is a view. The sandbox run (§4) sent the same
calls to the real mainnet factory and DAO code in a local near-sandbox: **35 of 35 checks PASS**. Tags: R read
(vendor source or a mainnet view), M measured (sandbox), D decided here (technical call), A assumed.

Files: `dao.mjs` (the paste: `create` on device A, `vote` on device B; `--dry` / `--live`), `check.mjs` (CO's
read-back on two providers), `lib.mjs` (pinned values, policy, RPC client, signing), `PASTE.md` (the owner's lines),
`test/unit.test.mjs` (8 tests, no network), `test/sandbox.mjs` + `test/run-sandbox.sh` (the sandbox test),
`test/fixture-abi.json` (the on-chain ABI subset), `results/mainnet-reads-2026-10-22.json`,
`results/sandbox-2026-10-22.json`.

## 1. The owner's lines (O51; names filled after O50)

`<DAO_NAME>` is from O50, default `unrlzd-confidential` (the session A page's empty name field), so
`unrlzd-confidential.sputnik-dao.near`: R, `UNKNOWN_ACCOUNT` on free.rpc.fastnear.com (block 221142486) and
near.drpc.org (block 221142487) at 2026-10-22 20:48:44Z (edit 2026-10-22 20:57Z from `date -u`, fix wave 30 lane FW6; paper 10
v1.56 O50).

Device A, one paste:

```
cd ~/Downloads/confidential-trenches && node proofs/b1-dao/dao.mjs create --live --name <DAO_NAME> --member-a <A> --member-a-key <A_KEY_FILE> --member-b <B>
```

Device B, one paste (or the two near-cli-rs lines device A's run prints):

```
cd ~/Downloads/confidential-trenches && node proofs/b1-dao/dao.mjs vote --live --dao <DAO_NAME>.sputnik-dao.near --member <B> --key <B_KEY_FILE>
```

CO after: `node proofs/b1-dao/check.mjs --dao <DAO_NAME>.sputnik-dao.near --member-a <A> --member-b <B>` (exit 0 =
PASS). `npm ci --prefix proofs/b1-dao` is needed once per machine (done on this Mac).

## 2. What each value is read from

Vendor source: `near-daos/sputnik-dao-contract` at **2b0f34a3860460f285307ec2ccf36345acbe05a2** (2026-02-25), the
commit both mainnet contracts name (row 3). Mainnet reads: `results/mainnet-reads-2026-10-22.json`, 18:56:25Z-18:56:31Z,
on free.rpc.fastnear.com (block 221131002) and near.drpc.org (block 221131006), identical. The first reads (18:30Z-18:45Z,
blocks 221128858-221129397) gave the same values.

| # | Value | Tag and source |
|---|---|---|
| 1 | Factory `sputnik-dao.near`, code `BXd5idTX…DfnnY` (198,307 B; sha256 checked against the account's code hash) | R: view_account + view_code, both providers |
| 2 | Default DAO code `DtHZA1mU…hJXuF`, a global contract used by hash (444,088 B; sha256 checked); version [3, 2]; 1,992 DAOs | R: `get_default_code_hash`, `get_default_version`, `get_contracts_metadata`, `get_number_daos`; `view_global_contract_code` |
| 3 | Both built from commit 2b0f34a3 (`contract_source_metadata` of the factory; `get_contracts_metadata` for the DAO code); DAO `version()` = "2.3.1" (Cargo.toml) | R |
| 4 | Factory owner = itself, 3 full-access keys (not ours) | R: `get_owner`, view_access_key_list |
| 5 | `create(name: AccountId, args: Base64VecU8)`, payable; DAO id = `<name>.sputnik-dao.near`; minimum deposit 0.01 N; the batch is CreateAccount, Transfer(deposit), UseGlobalContract(default hash), `new(args)` with 40 Tgas; `on_create` refunds the deposit if `new` fails | R: factory2 `lib.rs:72-106`, `factory_manager.rs:8-11, 76-122`; the on-chain ABI (`__contract_abi`, `test/fixture-abi.json`) |
| 6 | `new(config: {name, purpose, metadata}, policy: VersionedPolicy)`; `metadata` is base64 ("" = empty); the policy fields and `deny_unknown_fields` | R: sputnikdao2 `lib.rs:98`, `types.rs` Config, `policy.rs:65-166`; ABI |
| 7 | `new` sets `auto_update: true`; at this commit `update()` takes code from the factory **at once** while it is true (the 2-week delay is only on main, after this commit) | R: `lib.rs:115-118`, `upgrade.rs:117-128`; `git log 2b0f34a3..main` = #233-#235 |
| 8 | Threshold: `Weight("2")` → min(2, members) = 2; quorum 0; per-kind `vote_policy` empty → the default applies to all 17 kinds | R: `policy.rs:91-106, 380-434`; `proposals.rs:67-121` (17 kinds) |
| 9 | Council permissions = the vendor default council (`*:AddProposal`, `VoteApprove`, `VoteReject`, `VoteRemove`, `Finalize`; "All actions except RemoveProposal") | R: `policy.rs:185-216` |
| 10 | `add_proposal({proposal: {description, kind}})`, deposit must equal the bond exactly (0); returns the id | R: `proposals.rs:535-589` |
| 11 | `act_proposal({id, action: "VoteApprove", proposal: <the stored kind>})`; a different kind panics `ERR_WRONG_KIND`; the approval that reaches the threshold executes at once | R: `proposals.rs:594-696`; UNRLZD `docs/contracts/dao-auto-update-off.md` (same calls on mainnet 2026-10-06) |
| 12 | `Vote` = "Just a signaling vote, with no execution"; `FactoryInfoUpdate {factory_info: {factory_id, auto_update}}` | R: `proposals.rs:109-112, 431-435`; README:292 |
| 13 | Gas: create 300 Tgas (a mainnet create, `AURGyKtq…`, sponsor.trezu.near, 0.09 N deposit, fee 0.0078 N); add_proposal 30 Tgas, act_proposal 100 Tgas | R: that tx (its `on_create` returned true); UNRLZD `docs/contracts/dao-auto-update-off.md` (30 / 100 Tgas, mainnet 2026-10-06). M: all passed in the sandbox |
| 14 | Shape reference, a live 2-of-2 on this code: council of 2, threshold "2", quorum 0, bonds 0, period 7 days, auto_update false (UNRLZD's own DAO; read only, nothing of UNRLZD's is used) | R: `get_policy`, `get_factory_info` |

## 3. Technical calls (D)

- **The policy:** one `council` role with the two members, the vendor's default council permissions, `vote_policy`
  {}; default vote `{RoleWeight, quorum "0", threshold "2"}`; `proposal_bond` 0; period 7 days; bounty bond 0. No
  `Everyone` role (only members can propose). No `RemoveProposal` (one key could delete a proposal alone; UNRLZD's DAO
  has it, the vendor default does not). So one key can neither propose-and-apply nor delete.
- **Two proposals, not one:** the test is the vendor's no-op `Vote`; the second is `auto_update` off (08 WK1 asks for
  it; row 7 shows why it matters on this commit: the factory's keys could replace the DAO's code at once). Both ride
  the same two pastes, so the owner's steps do not grow. This differs from "one no-op proposal" in paper 10 O51.
- **Deposit 1 N** (`--deposit`, minimum 0.1): M: the DAO uses 1,390 B with the two proposals and 1,514 B after both
  approvals (≈ 0.015 N); 1 N leaves ≈ 98 KB for later proposals. Only a 2-of-2 `Transfer` proposal moves it out.
- **Device B votes only on the two B1 proposals** (exact kind and description); anything else open is listed and left.
- **The checker FAILs** on any other proposal, any access key on the DAO, auto_update on, a policy that differs in
  any field, or two providers that disagree. It picks the first two of FastNEAR, dRPC, near.org that answer.

## 4. Sandbox test (M)

`HEAVY_REMOTE=1 scripts/heavy.sh b1-dao -- proofs/b1-dao/test/run-sandbox.sh`: the PC box refused SSH on four
tries, 18:49Z-18:58Z ("Connection reset by peer"; heavy-remote: `<build box> does not answer`), so it ran with `HEAVY_REMOTE=0` in this
Mac's queue (slot 1), last run 18:58:53Z-18:59:13Z (two earlier runs the same), near-sandbox 2.13.4 (Darwin-arm64), node v24.22.1:

- The mainnet factory wasm deployed to `sputnik-dao.near`, `store` made the DAO wasm a global contract (returned
  `DtHZA1mU…`), `store_contract_metadata([3,2], 2b0f34a3, default)`. Then the real `dao.mjs` and `check.mjs`:
- `create --dry`: all checks ok, 5 calls printed, A's nonce unchanged, no DAO. `create --live`: DAO made, 2
  proposals, A approved both; both stay InProgress with one approval; auto_update still true; `check.mjs` FAILs.
- Refusals on chain: an outsider's `add_proposal` and vote (`ERR_PERMISSION_DENIED`), A's second vote
  (`ERR_ALREADY_VOTED`), A's `RemoveProposal` (`ERR_PERMISSION_DENIED`), a vote with another kind (`ERR_WRONG_KIND`).
- `vote --live` as B: both Approved with two approvals, auto_update false, `check.mjs` **PASS** on both reads.
- A rerun of `create --live` sends nothing. A third proposal: B's `vote` leaves it, `check.mjs` FAILs. A DAO made
  with a 1-approval policy: `check.mjs` FAILs on the policy, `create` refuses its name. Same account twice: refused.
  The 0.1 N minimum deposit works.
- Fees: device A 0.0087 N over 5 txs (create 0.0077 N), device B 0.0006 N over 2 txs. No private key in any output.

## 5. ASSUMED or open

1. **A: device B can run `act_proposal`**: this repo with node, or near-cli-rs. A phone
   wallet cannot, unless a DAO web app supports it; none was checked. CO asks which device B is at O50.
2. **A: each member has a full-access key as a near-cli JSON file on its own device.** A wallet-only account needs
   its key exported, or each device makes a fresh account for its seat. CO settles this at O50.
3. A: the near-cli-rs fallback lines (`npx near-cli-rs@0.30.1 … sign-with-seed-phrase`) use the shape UNRLZD ran on
   mainnet 2026-10-06 (`docs/contracts/dao-auto-update-off.md`); not re-run here. A Ledger seat on near-cli-rs is not checked.
4. Fees are sandbox-measured; the mainnet create fee from the reference tx (0.0078 N) agrees.
5. The factory owner can change the default DAO code before Oct 25: `dao.mjs` then stops in its checks, and CO
   re-pins `lib.mjs` from a fresh read.
6. Risks for the O50 page, not changed here: in a 2-of-2 a lost device ends the group (no member change without both,
   and auto_update off removes the factory route); `Finalize` (vendor default) lets one member re-run an approved
   proposal that failed, within its 7 days; every admin proposal needs both approvals within 7 days.
