# P7 Notes: result (local part, no TDX)

**Pass line (plan §8):** a CDK mint inside the dstack CVM, with keyset keys from a CKD-derived test secret, and a
cashu-ts wallet. Round trip: deposit → notes → buy with blank outputs → sell → notes → withdraw. Then restore from the
seed, and the wallet refuses a keyset not published on NEAR.

Tonight's scope: everything except the TDX part (P3 adds it). Run 2026-10-19 23:04Z, record
`runs/2026-10-19T23-04-28-428Z.json`. Status key: **VERIFIED** = read in source or measured here.

| # | Row | Status | Evidence (canonical run) |
|---|---|---|---|
| 1 | CDK mint inside the dstack CVM | **BLOCKED by Phala** (run 2, 2026-10-21) | Phala refused to provision twice, with 400 "violates our terms of use": once with the official `cashubtc/mintd:0.18.2` image (21:39Z) and once with only P3's `node:24-alpine`, the hash-pinned release binary fetched at start (21:50Z, Phala's FAQ remedy). So the block is not on the image name. No CVM was created and $0.00 was spent. The local rehearsal of the CVM's seed path passes. It needs the owner (Phala support) or another host (§6) |
| 2 | Keyset keys from a CKD-derived secret; same secret → same keyset | **PASS** (test root) | Two fresh mints (empty dbs) from test root S → keyset `01ae7231…229fa1fe`, all 32 keys equal. Another root → `01c66a46…c672680d`. The real S from `v1.signer` reaches the mint only inside the CVM: **WAITS-P3** |
| 3 | Deposit → notes → buy (blank outputs) → sell → notes → withdraw | **PASS** | $20.00 in → buy $10.00 (5 blanks, 19 ¢ change) → sell $15.00 → withdraw $10.00 (5 blanks, 19 ¢ change) → $14.98 = expected; 19 held notes UNSPENT, 16 inputs SPENT (NUT-07) |
| 4 | DLEQ (NUT-12) on every signature | **PASS** | 1,286 notes checked with `hasValidDleq(…, {require: true})`, on top of cashu-ts's own check with `requireSigDleq: true` |
| 5 | Restore from the seed (NUT-13 + NUT-09), same balance | **PASS** | Fresh wallet, seed only: 37 signatures restored, 19 unspent = $14.98, the same 19 secrets, DLEQ valid; includes the change from blank outputs |
| 6 | Refuse a keyset not published on NEAR | **PASS** (stand-in contract) | List read from a NEAR testnet view on 2 RPCs that must agree. A mint on the unpublished keyset is refused at open, and its notes are refused on receive. The list's source is SocialDB, not the ghost contract: that one function **waits for the ghost contract** |
| 7 | Double spend: parallel spends of the same notes | **PASS** | 70 races (50 two-way, 20 eight-way): exactly one winner in every race; inputs SPENT after |
| 8 | Latency, n ≥ 50 (budget: note check and record < 20 ms) | **PASS** | HTTP p95 on localhost: mint 2.77 ms, swap 3.07 ms, melt 4.45 ms (n = 60 each) |

## 1. Versions (pinned)

| Part | Version | Notes |
|---|---|---|
| CDK `cdk-mintd` | **0.18.2** (tag `v0.18.2`, commit `9f6d3a3734d7223d10b5553e3591d3f9d5c6c904`, 2026-10-13; crates.io latest stable 2026-10-14) | `--locked`, `--no-default-features --features fakewallet,sqlite`, release profile. Binary sha256 `ac63ef71274382882024fe3a3e192fbf6875067b75d86180db82a2b53b92aa5b` (macOS arm64). README: "**ALPHA** … the api will change" (VERIFIED) |
| Rust | 1.97.1 (the CDK repo's `rust-toolchain.toml` pin), via `RUSTUP_TOOLCHAIN` so rustup does not fetch the file's 16 cross targets | |
| protoc | 36.2 (`protoc-36.2-osx-aarch_64.zip`, sha256 `9cd98a53…3ae23466`) | needed by `cdk-signatory`'s build script, see §5 |
| `@cashu/cashu-ts` | **4.11.0** (npm `latest`; `next` is 5.0.0-rc.11) | |
| `@noble/hashes` / `@scure/bip39` / `near-api-js` | 2.4.0 / 2.4.0 / 7.3.1 | |
| Node | 24.12.0 (TypeScript run by type stripping, no build step) | |

## 2. How it maps onto the product (plan §4.1)

- **Unit `usd`, in cents.** CDK's usd keyset has 32 denominations (2^0 … 2^31). The fake backend advertises two custom
  NUT-04/05 methods on that unit. The mint core is stock CDK; only the payment backend is fake.
  - `nearintents`: deposit = a mint quote that the backend marks paid (stands in for 1Click `SUCCESS`); withdraw = a
    melt (stands in for the 1Click payout).
  - `ghost`: buy = a melt whose unused fee reserve comes back through NUT-08 blank outputs; sell = a mint quote for the
    proceeds, signed on fresh blinded outputs.
- **The real backend** is a `cdk-payment-processor` gRPC service (mintd feature `grpc-processor`). It can advertise
  custom methods the same way (`example.config.toml`, `[grpc_processor]` note), and the mint then routes
  `/v1/mint/quote/{method}`, `/v1/melt/quote/{method}`, etc. (VERIFIED, `cdk-axum/src/custom_router.rs`).
- **Keys from the root.** `entropy = HKDF-SHA256(ikm = S (48 B), salt "confidential-trenches/v1", info "mint/keysets",
  32 B)` → BIP-39 mnemonic → CDK's BIP-32 at `m/129372'/<unit index>'/<keyset index>'`, one child per denomination
  (VERIFIED, `cdk-signatory/src/common.rs:121`). The test root is `sha512("p7-notes test root S, not from CKD")[0..48]`,
  public and not a secret (fingerprint `1895b5d1ecf599b5`). The same id `01ae7231…` came back in every run.
- **Spec change for §4.1.** The plan says "keys = HKDF(S, "mint", keyset id)". That is circular: a NUT-02 keyset id is a
  hash of the public keys (v2: `01` + SHA-256 over keys, unit, fee and expiry), so the id cannot be an input. Derive
  one seed per purpose (`info "mint/keysets"`) and rotate keysets by CDK's index.
- **Where the seed lives.** cdk-mintd 0.18 takes the mnemonic only as an `env:`/`file:` reference. Here it is in the
  child process's environment. The db stores only the reference: the sqlite db, its WAL, the log and the config were
  checked and none holds the mnemonic. Plan §4.4 forbids security-relevant env vars in the CVM, so P3 must pass it as
  `file:` on a tmpfs path or wrap the `cdk` crate and hand it the seed in process.

## 3. Results

**Round trip** (cents; fake backend: fee reserve = max(2 %, 2), actual fee 1):

| Step | Method | Amount | Notes in / out | Blank outputs | Change | Balance |
|---|---|---|---|---|---|---|
| deposit | `nearintents` mint | 2000 | – / 6 | – | – | 2000 |
| buy | `ghost` melt | 1000 + reserve 20 | 8 / – | 5 | 19 (3 notes) | 999 |
| sell | `ghost` mint | 1500 | – / 7 | – | – | 2499 |
| withdraw | `nearintents` melt | 1000 + reserve 20 | 8 / – | 5 | 19 (3 notes) | **1498** |

**Restore:** a new `Wallet` with only the seed, `batchRestore()` → 37 signatures (last counter 38), NUT-07 check →
19 unspent, 1498 ¢, the same secrets as the wallet that made them.

**Refusals** (both `KeysetNotPublished`):
- `open`: keyset `01c66a46…` at the rogue mint (port 3339) is not on NEAR;
- `receive`: notes minted on that keyset are refused before use.

The wallet opens a mint only if the keyset it binds to is on the NEAR list, and it accepts a note only if the note's
keyset is on the list and its DLEQ verifies. cashu-ts also rejects a signature whose keyset id differs from the output's, and drops keys that do not
hash to their keyset id (VERIFIED, `lib/cashu-ts.es.js` `verifyKeysetId` and `validateReturnedSignatures`), so a mint cannot slip a
per-user keyset under a published id.

**Published list on NEAR testnet.** `publish.ts` made a faucet account `p7notes-24f457e5.testnet` with a key held only in
memory, wrote `["01ae7231…"]` to SocialDB (`v1.social08.testnet`, key `p7notes-24f457e5.testnet/p7notes/keysets`), and
dropped the key. Tx [`Drvni2Gx…`](https://testnet.nearblocks.io/txns/Drvni2GxtPMYUg997m1xGpGj2Ky8VGW5i3u3wuaFsWrm) is FINAL with SuccessValue on
both rpc.testnet.near.org and test.rpc.fastnear.com (block `9wXQh8ka…`). The wallet reads the list with `get` on both
RPCs, requires them to agree and fails closed (`published.ts`, one function: `publishedKeysets()`). The account still
has one full-access key on chain whose private half nobody holds; the ghost contract will have none (plan §4.3).

**Double spend.** For each race the wallet built k swaps of the same notes with different outputs and sent them at once
(`Promise.allSettled`). 70 of 70 had exactly one winner. Losers: 175 × `11001` (already spent), 15 × `11002` (pending,
the winner's saga held them). Mechanism: CDK's `proof.y` primary key plus the PENDING → SPENT saga in one sqlite writer
(VERIFIED, schema in the run db).

**Latency** (localhost, release build, sqlite, fake backend with 0 s delay, sequential, n = 60):

| Op | Shape | HTTP p50 / p95 (ms) | Wallet `complete*` p50 / p95 (ms) |
|---|---|---|---|
| mint | 1100 ¢ → 4 outputs | 1.32 / 2.77 | 26.1 / 33.2 |
| swap | 4 inputs → 9 outputs | 2.02 / 3.07 | 58.0 / 65.8 |
| melt | 8 inputs, 5 blanks | 3.21 / 4.45 | 22.3 / 26.3 |

The mint side (check, record, sign) is far under the 20 ms budget. The wallet side is dominated by DLEQ verification in
JS: our extra check costs **6.4 ms per note** (p50, n = 60) on this Mac.

## 4. Run it

```sh
cd proofs/p7-notes
git clone --depth 1 --branch v0.18.2 https://github.com/cashubtc/cdk .build/cdk
# protoc 36.2 for osx-aarch_64 unzipped into .build/protoc
cd .build/cdk && "$HOME/Downloads/NEAR trading terminal/scripts/the build queue" p7-notes -- env RUSTUP_TOOLCHAIN=1.97.1 \
  PROTOC="$PWD/../protoc/bin/protoc" cargo build --release --locked -p cdk-mintd --no-default-features --features fakewallet,sqlite
mkdir -p ../bin && cp target/release/cdk-mintd ../bin/ && cd ../..
npm ci
node run.ts --keyset-only        # 01ae7231ab72cc6e39cf75975539c697d9c103a59bda20796c24dba038229fa1fe
node publish.ts <keyset id>      # once; testnet faucet + SocialDB; writes published.json
node run.ts                      # ~1 min: rows 2-8, record in runs/
```

Ports 3338 (honest mint) and 3339 (rogue mint). Mint work dirs go to `run/` (gitignored), the binary to `.build/`.

## 5. Risks and findings

1. **API churn.** CDK 0.18 moved config into the db (`config init --new-mint` before the first start; secrets only as
   `env:`/`file:` references); 0.17 configs need `config migrate`. cashu-ts 5.0 is at rc.11 and flips defaults:
   `hasValidDleq` stops requiring a DLEQ by default, `bip39seed` must be 64 bytes, and a quote in the wrong unit or
   amount is refused (VERIFIED, 4.11.0 type docs). Pin exact versions and recheck both before Nov 1.
2. **CDK custom melts pass `amount: None` to the backend at payment time** ("correlation is via quote_id",
   `cdk-common/src/payment.rs:408`). The fake backend then pays its default 1000 units. A 1200 ¢ buy failed with `11012
   Incorrect quote amount` (`runs/2026-10-19T23-02-24-078Z.json`), so melts here are 1000 ¢. Our 1Click processor must
   read the amount from its own quote record by quote id.
3. **CDK requires `method` in a custom melt-quote body**, and it must match the route (`custom_handlers.rs:501-511`).
   cashu-ts's generic `createMeltQuote(method, payload)` does not add it, so we pass it. cashu-ts's
   `MintQuoteBaseResponse` has no `state`, so custom quote state is read from the raw response.
4. **Wallet cost.** DLEQ verification is ~6 ms per note in JS; cashu-ts already verifies DLEQs on mint responses, and
   our second check doubles that. A 9-output swap takes ~58 ms in the wallet against 2 ms at the mint. This is fine against the 5 s
   budget, but the number of notes per op (cashu-ts `denominationTarget`, default 3) drives it. Browser numbers are
   unmeasured.
5. **What the mint db knows** (input for the observer test). CDK keeps every blinded message with its quote or
   operation id and timestamps (needed for NUT-09), and every spent note with its melt quote. Blinding still hides
   deposit → spend (`B_` is not linkable to `Y` without `r`), but timing columns are there. This db belongs in the
   "full state dump" of the hardening test.
6. **Rollback (red-team C31).** The spent set is the sqlite `proof` table. A host that rolls the db back re-enables
   spent notes. The anchored log must cover it, or the db must live in the sealed, anchored store.
7. **One writer.** sqlite serialises writes; CDK's docs say postgres "does not currently make multiple active replicas
   safe". One mint process per enclave. The latency here is sequential with no concurrent load.
8. **Build.** `cdk-signatory`'s build script needs `protoc` even with `--no-default-features`: cdk-mintd pulls it in
   with its default `grpc` feature. Upstream publishes static x86_64 Linux binaries with `SHA256SUMS` per release
   (README). For the CVM, P3 should build the image from the tag.
9. **NUT coverage.** No gap blocked the pass line. cashu-ts 4.11 has generic custom-method mint and melt, NUT-08 blanks,
   NUT-09 `batchRestore`, NUT-12, NUT-13 and v2 keyset ids. CDK 0.18.2's fake backend supports custom methods per unit.

## 6. Run 2: CVM row

Run 2026-10-21 21:24Z-21:50Z (times from `date -u`, API and log lines). Scripts in `run2/`, raw outputs in
`results/run2/`. Tags: **M** = measured in this run, **D** = read from docs (URL given).

**Outcome: Phala refused to deploy the CVM twice, and the second time every image was one Phala had already accepted
for P3.** Both refusals came from the provision call, `POST /cvms/provision`, and gave the same answer:
**400 `{"detail":"You are not allowed to deploy the target applications since it violates our terms of use."}`**. The
command was `cd proofs/p7-notes/run2 && (set -a; . ~/.confidential-trenches/env; set +a; node cvm.mjs create p7-run2-mint 5)`.

| Attempt | Time (Z) | Images in the compose | Answer |
|---|---|---|---|
| 1 | 21:38:53-21:39:37 | `node:24-alpine@sha256:44fce696…` (app) + the official `cashubtc/mintd:0.18.2@sha256:60695eb0…b914` (two mints). Compose sha256 `398a14ea…aa4a`, in commit a6e7302 | 400 terms of use (`results/run2/provision-refused.json`) |
| 2 | 21:49:53-21:50:10 | `node:24-alpine@sha256:44fce696…` for all three services, the digest P3 deployed on 2026-10-20. The mints fetch the cdk-mintd v0.18.2 release asset at start and install it only if its sha256 equals the pinned `0d33d686…c54f`, which is also the release's SHA256SUMS entry. Compose sha256 `3c0428f7…2ae7` (`run2/cvm/docker-compose.yml`) | 400 terms of use, the same text (`results/run2/provision-refused-attempt2.json`) |

Attempt 2 was the coordinator's decision, made after attempt 1: one try of Phala's documented remedy, then stop on a
second refusal. Phala's FAQ, "Are there any anti-spam measures?" (D, <https://docs.phala.com/phala-cloud/faqs>, as
quoted by the coordinator at about 21:50Z; my own read at 21:4xZ matched in substance) says:
- "Certain Docker base images may be blocked if they've been used for abuse"
- "If your deployment is blocked with "violates terms & conditions", try using official base images (e.g.,
  `python:3.11`, `node:20`) or contact support if you believe it's a false positive."

The remedy did not help. With only P3's image left, **the block is not on the image name**: it is on something else in
the compose (an application-level block). I did not probe which part. Per the coordinator's rule I made no further
image change, renamed nothing, and stopped. Phala support is the owner's call. Phala's terms (D,
<https://phala.com/terms>, updated 2025-06-18):
- §3 bars crypto mining and workloads that earn external tokens.
- §7.4 bars mining, proxies, VPNs and tunnels on free or promotional credit, and reserves the right to block apps
  "deemed legally risky".
- Nothing covers ecash, mints or payment services.

**Spend and cleanup.** Phala credit **$4.904109** at 21:25:03Z, 21:49:52Z and 21:50:10Z: **$0.00 used** (cap $0.20).
CVMs: **total 0** at 21:25:03Z, 21:39:37Z, 21:42:13Z and 21:50:10Z, because none was ever created
(`results/run2/credits.jsonl`, `cvm-events.jsonl`). **No NEAR transaction was sent.** The P3 CKD path (fund n, admin
add_measurements, register, request_key) never started. Testnet reads only: the funder balance (1.858 N), the P3
contract's `get_config`, and P3's old request_key tx on two archival RPCs.

| # | Pass line item | Result | Evidence |
|---|---|---|---|
| 1 | CDK mint pinned to 0.18.2 runs in one Phala CVM; seed derived in the CVM from the CKD root, never an env var | **FAIL** (M): Phala refused both composes at provision, so nothing ran | Binary pinned in both attempts: sha256 `0d33d686…c54f`. It is the release asset `cdk-mintd-0.18.2-x86_64`, its SHA256SUMS entry, and the binary inside `cashubtc/mintd:0.18.2` (M, `image-provenance.json`, `installer-test.json`). The installer refuses a mismatch (M: a wrong pin gives `REFUSE`, rc 1, nothing installed). Handover as built: **a file on a tmpfs docker volume** `seed` (`driver_opts type=tmpfs`, mounted read-only in the mints). The config says `mnemonic = "file:/seed/ckd.mnemonic"`. The compose has no `environment` entry and `allowed_envs: []` |
| 2 | Same root → same keyset id and all 32 keys as P7's local run | **UNKNOWN in the CVM** (not run). Local parts PASS (M) | The CVM app's derivation of P7's public test root S gives P7's mnemonic: same full string, fingerprints `1895b5d1…`/`a002c091…` as P7's record (`test-app.json`, 12 checks). Through the CVM's own entrypoint script and `file:` config, P7's macOS cdk-mintd gives **`01ae7231…229fa1fe`** with 32 keys (`local-keys.json`, the reference `compare-keys.mjs` would check the CVM's comparison mint against) |
| 3 | Round trip from this Mac with P7's client: mint quote → blind sign → note → melt or swap (fake backend) | **UNKNOWN in the CVM** (not run). Local dry run PASS (M) | `run2/roundtrip.ts` against the local mint: deposit 2000 ¢ → 6 notes → swap 700 → `ghost` melt 1000 with 5 blank outputs, 19 ¢ change → 13 held UNSPENT, 12 spent SPENT, 37 DLEQs required and valid (`roundtrip-local-dry.json`) |
| 4 | A CVM restart keeps the same keyset | **UNKNOWN in the CVM** (not run). Local analogue PASS (M) | Second start on the same db took the "stored config found, no init" path: same id and all 32 keys (`local-ref.json`). `--after` mode: the earlier notes keep UNSPENT/SPENT by Y, and a new deposit lands on the same keyset (`roundtrip-local-dry-after.json`) |

**Keyset match, explained.** P7's `01ae7231…` comes from P7's *public* stand-in root
S = sha512("p7-notes test root S, not from CKD")[0..48]. The CKD root that P3's path delivers (P3 fingerprint
`95597ee0a98ca325`, MPC `v1.signer-prod.testnet`, path `confidential-trenches/root/v1`) is a different 48-byte value.
The same derivation therefore gives a different keyset, and nobody outside the CVM can compute it. So the compose runs
two mints:
- `mint` (:3338) is seeded from the CKD root. Item 4 covers it: same id and keys before and after the restart.
- `mintt` (:3339) is seeded from the public test root through the same in-CVM code and the same `file:` handover. It
  is for comparison only, and its keys are public by construction. Item 2 compares its 32 keys with `local-keys.json`.

**What is built and checked locally, ready to run** (`run2/`):
- `cvm/app.mjs` is P3's enclave app with the B2, TLS and token parts removed and every constant in the measured file.
  It has no `/ckd` input: `POST /ckd` names a request_key tx this boot signed. The app then reads that tx's FINAL
  outcome itself on rpc.testnet.near.org and test.rpc.fastnear.com, which must agree, opens S = C − a·Y, derives
  HKDF(S, "mint/keysets") → 24 words, and writes `/seed/ckd.mnemonic` (0400, atomic rename). A caller cannot inject
  a root.
- `test-app.mjs` holds 12 local checks: seed = P7's, BIP-39 = @scure/bip39, CKD open = noble, tx bytes =
  near-api-js, and the chain read returns P3's logged CKD answer for P3's real tx. That tx (37 h old) is gone from
  the two non-archival RPCs (`TIMEOUT_ERROR NOT_OBSERVED`), so this check reads archival nodes.
- The other scripts:
  - `cvm.mjs` is the lifecycle plus the in-CVM installer `FETCH_MINTD`.
  - `attest.mjs` and `register.mjs` are P3's attestation and CKD path with run 2's paths.
  - `roundtrip.ts` is P7's wallet, and `compare-keys.mjs` is the item 2 check.
  - `credits.mjs` is P3's, with only the key source and output path changed.

**Risk for M1 (Nov 4).** The mint is the core of plan §4.1, and plan §4.4 puts it in a Phala CVM. Phala Cloud now
refuses this application whichever image carries the mint, so M1's CVM milestone is blocked until one of two things
happens:
- the owner gets Phala to clear it (a support request; the owner's call), or
- the mint moves to another dstack/TDX host.

Unblocked, the run is ready: about 20 minutes and about $0.10 with the scripts above (an estimate; P3 used $0.096
for its hour).

## 7. Files

`lib.ts` (test root, HKDF → mnemonic, cdk-mintd launcher, HTTP timing), `published.ts` (the one-function NEAR read),
`publish.ts` (testnet publish, in-memory key), `run.ts` (rows 2-8), `published.json` (where the list lives),
`runs/` (the canonical record and the failed 11012 run; fingerprints only, no secrets), `package.json` / lock (exact
versions). Not committed: `.build/` (CDK clone, protoc, binary), `node_modules/`, `run/` (mint dbs and logs).

Run 2 (§6):
- `run2/cvm/app.mjs` is the enclave app.
- `run2/cvm/docker-compose.yml` and `compose-file.json` are attempt 2's compose. Attempt 1's is in commit a6e7302.
- `run2/cvm.mjs` renders the compose (including the installer) and runs create, restart, status, delete and list.
- `run2/attest.mjs`, `run2/register.mjs`, `run2/roundtrip.ts` and `run2/compare-keys.mjs` are the rest of the run, and
  `run2/test-app.mjs` and `run2/local-ref.mjs` are the local checks.
- `run2/phala.mjs` and `run2/credits.mjs` read the API key from the environment only.

Raw outputs are in `results/run2/`.
