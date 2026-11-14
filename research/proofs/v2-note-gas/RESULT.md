# V2: verify a Cashu note on NEAR: gas

**Question.** Can a NEAR contract verify a Cashu note `{id, amount, secret, C, dleq: {e, s, r}}` (cdk-mintd 0.18.2,
NUT-12 DLEQ) on chain, with an optional NUT-20 BIP-340 check, and at what gas?

**Answer: yes.** Every vector passed in both ways: 194 of 194 checks, 0 failed. Through NEAR's `ecrecover` host
function a note costs about **2.8 Tgas**. In pure wasm with k256 it costs **20.5 Tgas**.

Status key: **M** = measured here (near-sandbox 2.13.4, protocol 86), **S** = read in source at the pinned commit,
**E** = estimate from measured parts, not built.

## 1. Verdict

These are the contract's own receipt gas on the opt-level "z" build (the shipping profile). The opt-level 3 build is
in brackets. All rows are M.

| Way | Tgas per note (slope) | One note alone in a tx | Max notes per 300 Tgas tx | Max per 1,000 Tgas tx |
|---|---|---|---|---|
| (a) pure wasm, k256 0.13.4 | **20.47** [19.16] | 21.43 median, 22.35 max | **14** [15] | 48 |
| (b) ecrecover, all lifts by ecrecover (`b_ecr`) | **2.77** [2.54] | 3.72 median, 4.70 max | **107** [116] | not run (E about 360) |
| (b) ecrecover, hash_to_curve and C lift by k256 sqrt (`b`) | 3.00 [2.77] | 3.98 median, 4.90 max | 99 [107] | 333 |
| (a) + one NUT-20 BIP-340 per note | 26.81 [25.06] | 27.73 | **11** [11] | not run |
| (b) + one NUT-20 BIP-340 per note | 3.39 [3.10] | 4.39 | **87** [96] | 293 |

- **NUT-20 alone (M).**
  - One BIP-340 adds **0.39 Tgas** per note in way (b): one ecrecover, two host SHA-256 and the parse. It adds
    **6.34 Tgas** in way (a).
  - A whole NUT-20 mint-request check in one tx costs 1.66 Tgas (b) and 7.55 Tgas (a). That covers the 20.md message
    digest plus BIP-340, on the spec vector and on the real cdk request.
  - With `b_ecr` the note-plus-lock row would be about 3.16 Tgas, or about 94 per 300 Tgas (E, not run).
- **Fixed cost per call (M).**
  - The contract receipt costs 0.8-1.2 Tgas at N = 0 (fit intercept). That includes loading the ~218 kB wasm.
  - The tx's gas outside the contract receipt is 0.33 Tgas for one note and 1.8 Tgas for 67 notes. It grows with the
    argument bytes.
- **Spread per note (M).**
  - Each extra hash_to_curve counter costs 0.307 Tgas, a wasm sqrt (way a, `b`), or 0.326 Tgas, one more ecrecover
    (`b_ecr`).
  - The 21 single-note runs were the spec note and the first 20 cdk notes. Of these, 11 lifted at counter 0, 5 at 1,
    4 at 2 and 1 at 3.
  - "Max" in the table is a real boundary, not a fit. N passed and N + 1 failed, on the same 200 notes in a fixed
    order. At 300 Tgas the failure was "Exceeded the prepaid gas". At 1,000 Tgas the runner kept only the first
    300 characters of the error, which end before its kind. Those txs burnt 1,002-1,012 Tgas in all.
  - The receipt figure can pass the prepaid gas by about 1 Tgas (300.53 at 300). That is because nearcore puts the
    receipt's and the action's execution fees into the receipt's `gas_burnt`, in addition to the wasm gas that the
    prepaid gas limits (nearcore 2.13.4 `runtime/runtime/src/lib.rs` l.540-543, l.833-835).
- **The 300 Tgas limit is out of date (S + M).**
  - Protocol 83 raised `max_total_prepaid_gas` and `max_gas_burnt` from 300 to 1,000 Tgas (nearcore 2.13.4
    `core/parameters/res/runtime_configs/83.yaml` l.7-9).
  - Mainnet answered protocol 86 with both at 1,000,000,000,000,000 (one `EXPERIMENTAL_protocol_config` read,
    2026-10-22 10:39:52Z, `results/mainnet-protocol-config.json`).
  - The 1,000 Tgas rows were run in the sandbox at protocol 86. There the prepaid gas and the burn limit are the
    same value, so the first failing size crosses both (nearcore `gas_counter.rs` l.168-205).

**Where the gas goes (M, z build, per primitive, net of drawing the test scalar).**

| Primitive | Tgas |
|---|---|
| `ecrecover` call: protocol base 0.279 + register + wasm glue | 0.317 |
| k256 field sqrt (point lift) | 0.291 |
| k256 point add + `to_affine` (one field inversion) | 0.312 |
| k256 scalar multiplication | 3.89 |
| k256 two-scalar `lincomb` | 5.92 |
| host `sha256` (short input) | 0.016 |
| k256 on-curve check of x‖y | 0.0095 |

- **Why (a) costs 20.5 Tgas.** The note's four scalar products (two `mul`, two `lincomb`, 19.6 Tgas) are about 96% of
  it. Under NEAR's per-instruction wasm gas (`regular_op_cost` 822,756), one k256 scalar multiplication costs as much
  as 12 ecrecovers.
- **Why `b_ecr` costs 2.77 Tgas.**
  - Five ecrecovers (s·Y, r·A, the C lift, −e·C' + s·r·G, R1) cost 1.59 Tgas.
  - Failed hash_to_curve counters cost 0.326 Tgas each. The 21 single notes averaged 0.76 of them; 1 is expected for
    random secrets.
  - The two wasm additions cost 0.62 Tgas, one inversion each.
  - The parse costs 0.08 Tgas.
  - The rest, about 0.2 Tgas, is the hex hash and scalar work.
- **Floor (E, not built).**
  - The caller could pass C's y, the two addition slopes and a non-residue witness per failed counter. The contract
    would check each with a few field multiplications.
  - That removes about 1.2 Tgas, for about **1.55 Tgas per note**: about 190 per 300 Tgas and about 640 per
    1,000 Tgas.
  - Four ecrecovers (1.27 Tgas) remain a hard floor for this formula.
- **B' alone (E, for F2 in docs/drafts/walkaway-design.md).**
  - B' = hash_to_curve(x) + r·G costs one ecrecover per counter tried: ecrecover(x_i, even; 1, r).
  - That is 0.32 Tgas plus 0.33 Tgas per failed counter, about 0.65 Tgas on average, before the parse, the Merkle
    path and storage.
  - The draft assumed 10-30 Tgas for a whole claim. The curve part uses about 2-7 % of that.

## 2. Method

**Contract (`contract/`).**
- near-sdk 5.29.1 (no default features; `unstable` is needed for `env::ecrecover`, `env.rs` l.582) and k256 =0.13.4
  (`arithmetic`, `schnorr`, no precomputed tables, no std).
- Each NEAR call is a fresh wasm instance, so k256's lazy generator tables would be rebuilt on every call.
- Built with cargo-near 0.22.0 and rustc 1.96.0, twice: opt-level "z" (the profile in Cargo.toml) and opt-level 3.
- Box builds: `v2_note_gas_z.wasm` 217,734 B, sha256 `3038bdc2…37013`; `v2_note_gas_o3.wasm` 268,105 B, sha256
  `ca8bb975…17db4`.
- Not committed: `out/`.

**Keys.** `register_keyset` stores each mint key A as x‖y once. Measured at 16.6 Tgas for cdk's 32 keys, one time.
`verify_notes` reads A by `"<keyset id>/<amount>"`. Every verify method takes `&self`, so the runner gets answers from
view calls and gas from transactions.

**Way (a).** All in wasm, NUT-12 Carol's check (12.md l.130-148):
1. Y = hash_to_curve(secret) by k256 decompression: x = SHA256(SHA256("Secp256k1_HashToCurve_Cashu_" ‖ secret) ‖
   counter_le32), even y, first counter that lifts. The secret is the note's UTF-8 string (00.md l.32-41, l.120).
2. B' = Y + r·G and C' = C + r·A.
3. R1 = lincomb(G, s; A, −e) and R2 = lincomb(B', s; C', −e).
4. e must equal SHA256 of the four uncompressed points as lowercase hex (12.md l.48-61).
- BIP-340 uses k256 `VerifyingKey::verify_raw`.
- Hashes use NEAR's `sha256` host function in both ways. The comparison is about the curve work.

**Way (b): ecrecover as an a·P + b·G engine.**
- NEAR's `ecrecover(hash, sig, v, malleability_flag)` returns the recovered key as 64 bytes x‖y. It costs
  `ecrecover_base` = 278,821,988,457 gas (S: nearcore 2.13.4 `logic.rs` l.1693-1789; `signature.rs` l.960-1003;
  `48.yaml` l.2; `parameters.snap` l.137).
- Inside it, libsecp256k1 computes Q = u2·R + u1·G with u2 = s/r and u1 = −z/r. R is the point with x = r (+ n when
  v & 2) and y parity v & 1. It refuses r = 0, s = 0, an x off the curve, or Q at infinity (S: secp256k1-sys 0.8.1
  `src/modules/recovery/main_impl.h` l.87-121; nearcore 2.13.4 pins secp256k1 0.27.0).
- With malleability flag 0, r = x(P) mod n, s = a·r and z = −b·r, it returns **a·P + b·G for any point P and scalars
  a ≠ 0, b**. A point given as x and parity goes in directly, so no lift is needed in wasm. When x ≥ n, it is sent as
  r = x − n with v | 2.
- Per note (`note_b`):
  1. s·Y: try each hash_to_curve x with ecrecover(x, even; s, 0). A refusal means x is not on the curve, so the next
     counter is tried. `b` lifts with k256 instead.
  2. r·A = ecrecover(A; r, 0). C comes from ecrecover(C; 1, 0), or from a k256 lift in `b`.
  3. C' = C + r·A, a k256 addition.
  4. R2 = s·B' − e·C' is rewritten as s·Y + (−e·C' + s·r·G). The second term is one ecrecover(C'; −e, s·r). Then one
     k256 addition gives R2, so B' is never formed.
  5. R1 = ecrecover(A; −e, s).
  6. The same hash compare as (a).
- BIP-340 is one call: R = ecrecover(P_x, even; −e, s), then x(R) = r and y(R) even. The tagged hash uses host
  SHA-256, and the code checks s < n and r, P_x < p.
- **Edge cases fail closed.** A zero scalar, or x(P) exactly n, makes ecrecover refuse, so the note is refused. For an
  honest note the chance is about 2^-128 or less. Points with x in [n, p) are tested through the v | 2 path: lift
  x = n + k, k = 1..23, matched k256 on all 23 (12 of them lift).

**Sandbox (`sandbox/`).**
- near-workspaces 0.23.0 with the near-sandbox 2.13.4 binary (commit `44f7ae6c…`, the same tag as the sources above).
- The runner read the sandbox's own `EXPERIMENTAL_protocol_config`: protocol 86, `ecrecover_base` 278,821,988,457,
  `regular_op_cost` 822,756, max prepaid gas 1,000 Tgas. All four equal mainnet's live answer.
- All gas figures are the contract receipt's `gas_burnt`. The fits are least squares over N = 1 and three larger
  sizes up to about 250 Tgas, using the 200 real notes in order.
- Calibration of the sandbox against testnet for another contract: −0.03 % (proofs/p3g-pre §3). It was not redone
  here.
- Raw output: `results/gas-run.json`. Run 2026-10-22 10:53:10Z-11:15:12Z.

**Answers checked (M, 97 per build, 194 total, 0 failed).**
- NUT-00 hash_to_curve: 3 vectors, both ways.
- NUT-12: `hash_e`; two BlindSignature DLEQs and tampered copies, both ways; the Proof vector, both ways and `b_ecr`.
- Seven tampered notes must be refused: e, s, r, secret, C, amount pointing at another key, and another note's r.
- All 200 cdk-mintd 0.18.2 notes valid in a, b and `b_ecr`.
- NUT-20: spec digest; spec and real request true; a tampered signature, another quote and another key false.
- The two NUT-20-locked real notes with their lock true, and with a bad lock false.
- All 19 BIP-340 vectors, both ways. These include public keys off the curve or ≥ p, r = p and s = n.
- The x ≥ n lift path.

## 3. Vectors

| Vector | Source | sha256 of our copy |
|---|---|---|
| `vectors/nuts.json` | NUT-00 hash_to_curve (tests/00-tests.md l.7-20); NUT-12 hash_e, deterministic-nonce and BlindSignature DLEQs, Proof with DLEQ (tests/12-tests.md l.1-75); NUT-20 signed request + digest (tests/20-test.md l.25-51). All 26 hex values checked against the downloaded files | `4745c833…dbcb08` |
| `vectors/cdk-0.18.2.json` | 200 notes (1-512 cents, 20 of each) + 2 NUT-20-locked notes and their real mint request (cashu-ts 4.11.0 → cdk-mintd 0.18.2, accepted on the first try with the 20.md v1 message: no legacy fallback). Made by `tools/cdk-notes.ts` at 10:48:33Z on P7's binary (sha256 `ac63ef71…aa5b`) and public test root; every note passed cashu-ts `hasValidDleq(require)` | `0f10d370…981cb5` |
| `vectors/bip340-test-vectors.csv` | github.com/bitcoin/bips @ `c0c5aea41e6a334d34db4ca87ae53bbfd7f268d1` bip-0340/test-vectors.csv | `34c9d1d9…851c2d` |

**The cdk notes are public test data.**
- The wallet's NUT-13 seed is SHA-512 of a public label, so every secret and blinding factor can be recomputed. Two
  fresh mints gave the same 200 secrets, r and C.
- The keyset comes from P7's public root, so the notes unlock nothing.
- gitleaks flags every `"secret"` field as generic-api-key: 202 here, plus the spec vector's secret in `nuts.json`.
  These 203 lines are in `.gitleaksignore` with that reason.

## 4. Sources

- **Cashu NUTs.** github.com/cashubtc/nuts @ `48b6fc26ffba5e2bc988d615f777b109b712cdfe` (2026-10-20):
  - 00.md l.32-41 (hash_to_curve), l.120 (secret is a UTF-8 string), sha256 `e2e8bce2…7426e`.
  - 12.md l.13-40, l.48-61, l.85-103, l.130-148, sha256 `937fb5f5…63f3`.
  - 20.md l.110-132 (message and BIP-340 over its SHA-256), sha256 `e673b7fe…de24`.
  - tests/00-tests.md `e425c4ff…70c4`; tests/12-tests.md `d5c010b1…787d`; tests/20-test.md `7c178b14…8231`.
- **nearcore 2.13.4** (tag commit `44f7ae6cd7ef08bab604e20a473bf77e35d4c993`):
  - `runtime/near-vm-runner/src/logic/logic.rs` l.1693-1789 (`ecrecover`, cost doc l.1710-1712).
  - `runtime/near-vm-runner/src/logic/gas_counter.rs` l.168-205.
  - `runtime/runtime/src/lib.rs` l.540-543, l.833-835 (execution fees in a receipt's `gas_burnt`).
  - `core/crypto/src/signature.rs` l.960-1003.
  - `core/parameters/res/runtime_configs/48.yaml` l.1-2, `49.yaml` l.1, `83.yaml` l.7-9.
  - `parameters.snap` l.110, l.115-116, l.137, l.202, l.212.
  - `core/primitives-core/src/version.rs` l.628 (stable protocol 86).
- **libsecp256k1 as vendored in rust-secp256k1 tag `secp256k1-sys-0.8.1`:** `src/modules/recovery/main_impl.h`
  l.87-121.
- **near-sdk 5.29.1:** `src/environment/env.rs` l.582-607.
- **k256 0.13.4:** `src/schnorr/verifying.rs` l.48 (`verify_raw`).
- **Mainnet read:** `results/mainnet-protocol-config.json` (rpc.mainnet.near.org, 10:39:52Z, read only).

## 5. Where it ran

| Job | Where | Why / result |
|---|---|---|
| Two toolchain probes | build box | Answered, but user `ct` had no Rust ("no cargo / no rustup / no rustc"), no OpenSSL headers, no pkg-config, and "sudo: a password is required" |
| Contract builds 1-3, full run 1 (started 10:40:17Z, slot 2) | This Mac's queue (`BUILD_QUEUE=0`) | Chosen because the box had no Rust: its probe printed "sh: 1: cargo: not found". Builds 1-2 failed to compile. Build 2 rebuilt unchanged source, because my edit script aborted and the build was not chained to it. Build 3 waited for a slot held by `release-a876d1408-e2e-terminal`, then ran in slot 2. Run 1 stopped on a bug in my own micro check |
| `tools/box-setup.sh` (10:49:05Z, 46 s) | build box | Installed rustup + rustc 1.96.0 + wasm32 and the cargo-near 0.22.0 release binary (sha256 `9429064e…7d1a` checked) in `ct`'s home. No sudo |
| Full runs 2-3 | build box | Run 2: the runner's copied lockfile conflicted. Run 3: openssl-sys found no OpenSSL. near-jsonrpc-client 0.22.0 always takes native-tls, so the runner now builds OpenSSL from source |
| Probe 3, then full run 4 (10:53:10Z-11:15:12Z, exit 0) | build box | Every number in this file |

The cdk-mintd mint (`tools/cdk-notes.ts`) ran on the Mac outside the queue. It is a light local process, and the
binary is macOS-only.

## 6. Rerun

```sh
BUILD_QUEUE=1 scripts/the build queue v2-gas -- proofs/v2-note-gas/tools/box-setup.sh   # once per box account
BUILD_QUEUE=1 scripts/the build queue v2-gas -- proofs/v2-note-gas/tools/run.sh         # builds + 194 checks + gas, ~22 min
node proofs/v2-note-gas/tools/cdk-notes.ts <work dir outside the repo>            # Mac, only to remake the cdk notes
```

## 7. Open points

- **Not run against live chains.** No testnet or mainnet tx was sent (sandbox only). The constants match mainnet's
  live read.
- **Gas the measurement leaves out.** Arguments are JSON. Borsh would cut part of the 0.04-0.08 Tgas parse per note.
  Spent-note bookkeeping (a set of Y or secrets) is not in this contract, so a real redeem adds one storage write per
  note.
- **Key reads.** `store::LookupMap` caches a key within a call, so batches read each keyset key once. A single-note
  call includes one storage read.
- **The hinted (b) variant is an estimate.** It would need extra code and review for the hint checks.
