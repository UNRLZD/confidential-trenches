# P3g pre-proof: the GCP vTPM check on NEAR, before any cloud spend

Lane PG, 2026-10-21 22:18Z to 2026-10-22 02:32Z (times below are `date -u` reads). No cloud resources, no account, no spend,
no gcloud. Everything ran on the Mac: public downloads, live Intel PCS collateral, a local near-sandbox.

Tags: **M** = measured here (commands in "Rerun"). **D** = a vendor's own docs or code say it (URL, read time).
**I** = my inference. **UNKNOWN** = not verified.

Context: docs/research/tee-host-mint.md (fdf2028) recommends one GCP C3 TDX VM running Apache-2.0 dstack v0.6.1, and
says the contract's PPID allowlist must give way to an on-chain check of Google's vTPM quote bound to the TDX quote
(dstack `docs/attestation-gcp.md`). P3's `register` (TDX only) burns 190.2 TGas on testnet; NEAR's cap is 300 TGas.

## Answers

1. **Vectors (M).** dstack (v0.6.1 and `next`) has **no** real GCP TDX quote + vTPM quote + AK certificate set. It
   has a GCP TPM event log, an unsigned 117 B TPMS_ATTEST stub, Google's root, and a Phala-type TDX attestation.
   Real Google vectors fill the gap: a GCP TDX quote with its CCEL (google/go-tdx-guest), a full real GCE vTPM
   attestation (AK cert, signed quote, 24 KB event log; google/go-tpm-tools), a 2022 GCE P-256 AK certificate, and
   Google's CA certificates and its live root CRL. 17 files, URLs and sha256 in §1.
2. **TCB (M).** The sample GCP TDX quote (FMSPC `00806F050000`, PPID `8ebf8894…`) against Intel PCS collateral issued
   2026-10-21T23:04:49Z: **OutOfDate**, 14 advisories (INTEL-SA-00960 … INTEL-SA-01313); QE `UpToDate`. Our
   contract's rule (UpToDate only) would **refuse** it (E10). This is a 2024 sample: today's GCP hosts may report a
   different TCB; only a fresh quote from a GCP VM answers that (UNKNOWN).
3. **Gas (M, sandbox).**
   - **dstack's tpm-qvl on NEAR:** it compiles to wasm32 and runs in a NEAR contract with one patch, the clock.
     Unpatched, it panics on chain (M).
   - **vTPM half alone:** 97.3 TGas. The AK chain is 61.5, the P-256 AK signature 31.2, everything else under 3.
     Checking Google's root CRL, as dstack does by default, adds 30.6, for 128.0 TGas.
   - **TDX and vTPM in one call:** **275.1 TGas without the CRL**, so it fits. Adding P3's other `register` work
     gives about 285 TGas (I), about 15 TGas of headroom. **With the CRL it does not fit:** the call runs out at
     the 300 TGas prepaid limit (M).
   - **Two-step `register`:** step 1 (vTPM with CRL, plus a stored pending digest) costs **126.7 TGas**. Step 2
     (pending-digest check plus the TDX check) costs **181.7 TGas**, about 191 with P3's other work (I).
4. **Google's vTPM root (D + M).** "EK/AK CA Root" (O=Google LLC, OU=Google Cloud), **RSA 4096**, sha256WithRSA,
   valid 2022-07-08 to 2122-07-08, DER sha256 `594759…beb2`. It signs "EK/AK CA Intermediate" (RSA 4096), which
   signs per-VM AK certificates (AK keys RSA 2048 or ECC P-256). Google publishes it in go-tpm-tools and at a Google
   CAS bucket URL (§4); dstack embeds the same bytes. No Google Cloud docs page names it.
5. **PPID (M + D; host retention UNKNOWN).** Yes, the GCP TDX quote's PCK leaf carries a PPID (M), and Google's
   provenance page tells verifiers to read it (D). Whether a stopped/started or maintained VM keeps its host:
   **UNKNOWN**. No Google doc says it stays; the API says TERMINATE restarts the VM "away from the maintenance
   activity" (D).

---

## 1. Test vectors

All downloads went into `vectors/` (data only; my scripts live in `tools/`, `prep/`, `contract/`, `sandbox/`, and
take the vector paths as arguments). `cd vectors && shasum -a 256 -c ../vectors.sha256` checks all 17 files.

**What dstack has (M; tree of tag v0.6.1 = commit `7f143148cc49f4a09799958835d310e050137cb3` and branch `next`, read
22:19:25Z; seven more branches checked, same set):** no GCP TDX + TPM pair in `tpm-qvl`, `tpm-attest`,
`dstack-attest/tests` or `verifier/fixtures`; the GCP path is only exercised with `mock-attestation` /
`tee-simulator` (a synthetic CA). Its four related files (downloaded 22:20:43Z from
`https://raw.githubusercontent.com/Dstack-TEE/dstack/7f143148cc49f4a09799958835d310e050137cb3/<path>`):

| File (vectors/) | Path in dstack | sha256 | What it is |
|---|---|---|---|
| dstack-v0.6.1/attestation.bin (9,254 B) | `dstack/guest-agent/fixtures/attestation.bin` | `555709d537b1bb518f4d4584ec3639c9de96d8383f58542c5868078807babff2` | SCALE `VersionedAttestation`, variant 0 = **DstackTdx** with a 5,010 B quote: a plain TDX attestation, not GCP (M: bytes `00 00 49 4e`) |
| dstack-v0.6.1/tpm_eventlog.bin (29,812 B) | `dstack/cc-eventlog/samples/tpm_eventlog.bin` | `efcd77d4700281c9ee837a0f78cb44d0fb6d926711556357d12159b16699a933` | TCG2 event log; dstack calls it the "GCP TPM event-log template" (`os/image/assemble.sh`, test `test_decode_gcp_tpm_eventlog`). 43 events; PCR0 3, PCR2 4 (3rd = UKI hash `9ab14a46…`), PCR14 0 (M) |
| dstack-v0.6.1/tpm_quote_sample.bin (117 B) | `dstack/tpm-attest/tests/tpm_quote_sample.bin` | `310200aab8f81def80513e4acb20a08e29301a777ffa3807109e3d79139b58ee` | Unsigned TPMS_ATTEST, 4-byte nonce `12345678`, PCRs 0-2; its README says provenance is not recorded and calls it hand-captured or synthetic |
| dstack-v0.6.1/gcp-root-ca.pem | `dstack/tpm-qvl/certs/gcp-root-ca.pem` | `f3aec6c9c718361332fc9d1ba7451a74d332bd25bb53946b236c8b6ab508ffb8` | Google "EK/AK CA Root" (§4) |

**Real Google vectors used instead** (Apache-2.0 repos, commit-pinned raw URLs
`https://raw.githubusercontent.com/google/<repo>/<commit>/<path>`; downloaded 22:22:41Z and 22:38:53Z):

| File (vectors/) | Repo @ commit, path | sha256 | What it is |
|---|---|---|---|
| go-tdx-guest/cos-113-tdx-quote.dat (8,000 B) | go-tdx-guest @ `23b3eac9db39ba4e1df1426bacb3bfa3a7018e97`, `testing/testdata/ccel/cos-113-tdx-quote.dat` | `54334c81b4e03634ab3a269ad397c9cea3b5c9ee96c57505b684470b964fd15e` | TDX v4 quote, cert data type 6/5 (3-cert PCK chain inside). Committed 2024-08-26 by a Google engineer with the CCEL below ("cos-113" = Container-Optimized OS 113). GCP origin is **I** (name, author, FMSPC). Google's TDX launch endorsement for its MRTD returns 404 (M, 22:24:21Z), but that bucket's oldest TDX object is dated 2024-10-15, after this quote |
| go-tdx-guest/ccel_data.dat, ccel_table.dat, nonce.dat | same commit, `testing/testdata/ccel/` | `090dc18758380a5cc03014bf2fe354788a4f4222671e1e38f85b772d2fd344b5`, `81a3eda132a0ff77a9d862e05df2f5879cb47289315ca23fc19c3488eb6e39b5`, `f5a5fd42d16a20302798ef6ed309979b43003d2320d9f0e8ea9831a92759fb4b` | The quote's TDX event log (CCEL) and its 64 B report data (zeros) |
| go-tpm-tools/gce-cos-85-nonce9009.pb (29,602 B) | go-tpm-tools @ `051b05919c51ee9a89809709e17a25c469171a82`, `internal/test/attestations/gce-cos-85-nonce9009.pb` | `ede1026dec7e9d71c43c73fa82fb51774627e4135c337d20eb88c63a026a033d` | A real GCE vTPM attestation (COS 85 Shielded VM, 2021): AK cert (RSA 2048, Google's older chain), SHA-1/256/384 quotes over PCRs 0-23 (RSASSA 2048), qualifying data `9009`, 23,970 B event log. **dstack's tpm-qvl verifies it natively: OK, 24 PCRs, 44 events (M)** |
| go-tpm-tools/pca_tpm_ecc_sign_cert.pem | same commit, `internal/test/certificates/pca_tpm_ecc_sign_cert.pem` | `4f06edf59d745723dabdd3b727bfcf191064c045df4733426c868acc3b7a0a9e` | Real GCE AK certificate, ECC P-256 key, issued 2022-11-23 by "EK/AK CA Intermediate" (subject L=us-central1-a, O=Google Compute Engine). No quote is published for this key |
| google-pki/gtt-gcp_ek_ak_ca_root.crt | same commit, `server/ca-certs/gcp_ek_ak_ca_root.crt` | `594759594b9b61524f6c8ef668f7177f7b9066bc0674f2f49fe9e052be78beb2` | EK/AK CA Root (byte-equal to Google's CAS URL, §4) |
| google-pki/gtt-gcp_ek_ak_ca_intermediate_v3.crt | same commit, `server/ca-certs/` | `c84de8116dfaf5a908f21e810487791f5437e206d00ad8025050cca6bd2ff627` | EK/AK CA Intermediate (byte-equal to the AIA URL in the AK cert, §4) |
| google-pki/gtt-tpm_ek_root_1.cer, gtt-tpm_ek_intermediate_2.crt, gtt-tpm_ek_intermediate_3.crt | same commit, `server/ca-certs/` | `9bd5285f8fb18502a7947e621ffd470266f49fcd3b73e19a190f690ad32a7caf`, `5d8dbcf8c8053dd8ffad711b6219355032b7122c34cac0f90ccb49def69ec504`, `7132b6ea71101f6c51bb58f98c3798c19b65be510eca0344318900510b593178` | Google's older vTPM chain (2018 root). The first two are byte-equal to `https://pki.goog/cloud_integrity/tpm_ek_root_1.crt` and `…/tpm_ek_intermediate_2.crt` (M, HTTP 200, 22:38:53Z) |
| google-pki/gcp_ek_ak_ca_root.crl (765 B) | `http://privateca-content-62d71773-0000-21da-852e-f4f5e80d7778.storage.googleapis.com/032bf9d39db4fa06aade/crl.crl` (the CRL distribution point in the intermediate; HTTP 200, 2026-10-22 02:05Z) | `bb053e6588c0673cf8552003bdd4a03f967bcd46662d49862d3b89a02861a581` | EK/AK CA Root's CRL: number 1567, issued 2026-10-22 01:12:26Z, next update 2026-10-29 01:12:26Z, no revoked certificates, sha256WithRSA. It carries a CRL number and a next-update date, so a later fetch can have a different sha256 |
| p3-testnet/tx-Axd9YZLg.json (138,515 B) | archival-rpc.testnet.near.org, `tx` Axd9YZLgp1G2fuAvHAzDKf55HG9MfsBEA8VhtwRRDKg6 (22:41:38Z) | `4c257c5b28805f2c8224541de53be9f5a1375c53e6c7b2086cb62f7cd0c68c73` | P3's own boot-2 `register` tx (args 96,795 B), replayed in the sandbox to calibrate gas |

Not found anywhere I looked (M: dstack all branches listed above, google/go-tpm-tools, google/go-tdx-guest, GitHub
code search for "EK/AK CA Intermediate"): one public set where a GCP TDX quote and a vTPM quote bound to it
(qualifying data = sha256(TDX quote)) come from the same VM. The gas run uses each real piece for the step it
exercises (§3).

## 2. TCB of the sample GCP TDX quote

`prep/target/release/p3g-prep tdx-tcb vectors/go-tdx-guest/cos-113-tdx-quote.dat results/cos-113-collateral.json`
(dcap-qvl 0.5.2, the version in P3's contract; collateral from `https://api.trustedservices.intel.com` in 2.6 s;
verified at 2026-10-21T23:58:36Z). Output: `results/tcb-check-cos113.txt`.

| Field | Value (M) |
|---|---|
| FMSPC | `00806F050000` (P3's Phala host was `20A06F000000`) |
| PPID | `8ebf889447fd60ab1913348582eb509e` (dcap-qvl; the same from the PCK leaf by `tools/inspect_tdx_quote.py`) |
| TD report | debug bit 0, `mr_signer_seam` zero, `tee_tcb_svn` `04010700…`, MRTD `dae67181…f94a`, RTMR3 zero, MR_OWNER zero |
| TCB info | TDX v3, tcbEvaluationDataNumber 20, issued 2026-10-21T23:04:49Z, next update 2026-11-20T23:04:49Z |
| Platform TCB status | **OutOfDate** |
| Advisory IDs | INTEL-SA-00960, -00982, -00986, -01010, -01036, -01076, -01079, -01099, -01103, -01111, -01192, -01245, -01312, -01313 |
| QE status | UpToDate |
| Our `register` rule (UpToDate only, E10) | **would refuse** |

The quote's PCK leaf was issued 2024-07-02 and the quote was committed 2024-08-26: this is one 2024 host's TCB, not
today's GCP fleet. Google may have updated its C3 hosts since. **Today's GCP C3/C4 TDX TCB stays UNKNOWN** until one
fresh quote from a GCP VM (the test the TH paper already lists). dstack's own GCP verifier checks only debug-off and
`mr_signer_seam` (D, dstack `docs/attestation-gcp.md`), so dstack accepting a host says nothing about this.

## 3. Gas

**Setup (M).**
- **Sandbox:** near-workspaces 0.23.0 with near-sandbox 2.13.4, run locally with wall-clock block time.
- **Toolchain:** the same as P3's contract: rustc 1.96.0, cargo-near 0.22.0, near-sdk 5.29.1, dcap-qvl 0.5.2,
  `opt-level = "z"`, LTO.
- **Gas contract:** `contract/`, built to 1,055,077 B of wasm, sha256 `02445dac6823989c87788b3e80037b1e2cbffe7e083dd11c4d30e56aa83a70e3`.
- **Method:** every call attaches 300 TGas. Each method records `env::used_gas()` after every step, so one
  receipt gives the per-step split.
- **Run:** finished 2026-10-22T02:28:56Z at sandbox block 53. Raw numbers: `results/gas-run.json`.

**Calibration (M).** I deployed P3's own wasm (`proofs/p3-enclave/contract/wasm/p3_ghost_test.wasm`, sha256
`90351adb…edf3`) and replayed the exact `register` arguments of its boot-2 testnet tx (96,795 B):

| Where | Contract receipt gas |
|---|---|
| Sandbox | 190,131,548,966,617 |
| Testnet | 190,195,446,602,966 |

That is −0.03 %, so the sandbox prices this work as testnet does. That testnet tx was prepaid 210 TGas and makes no
cross-contract call; its only outgoing receipts go back to the signer.

**dstack's tpm-qvl on NEAR (M).**
- **Build:** dstack v0.6.1 `tpm-qvl` builds for wasm32-unknown-unknown inside the near-sdk 5.29.1 contract, with
  default features off. That drops `crl-download`, the network fetcher; CRLs can still be passed in.
- **Unpatched:** it reads `SystemTime::now()` in its AK-chain step. On chain the call panics with "time not
  implemented on this platform" after 27.86 TGas (run 2 below).
- **Patch:** `vendor/tpm-qvl` differs from upstream (`dstack/tpm-qvl/src`, verify.rs sha256 `9fbaf108…`, lib.rs
  `caf9ee11…`) only in that clock line and a setter in lib.rs. The contract sets the time from the block timestamp.
  Patched, it verifies the real GCE attestation on chain (run 1).

| # | Call (one receipt, 300 TGas attached) | Inputs | Contract receipt TGas (M) | Result |
|---|---|---|---|---|
| 0 | P3 `register` replay | P3 wasm + boot-2 args | 190.13 | UpToDate (testnet 190.20) |
| 1 | `tpm_qvl_verify`: dstack tpm-qvl, full verify | real GCE attestation: RSA 2048 AK, 2018 chain, 24 PCRs, 44 events | 66.83 | OK |
| 2 | same, upstream clock | same | 27.86 | panic: time not implemented |
| 3 | `vtpm_steps`, no CRL | P-256 AK cert → EK/AK CA Intermediate → EK/AK CA Root; one P-256 signature; dstack GCP log | 97.29 | every step true |
| 4 | `vtpm_steps` + root CRL | as 3, plus Google's live root CRL | 127.97 | every step true |
| 5 | `tdx_dcap` | cos-113 GCP TDX quote + Intel PCS collateral | 180.65 | OutOfDate (§2) |
| 6 | `combined` = 5 + 3, one call | | **275.12** | OK: fits |
| 7 | `combined` = 5 + 4, one call | | **300.998** | **"Exceeded the prepaid gas."** |
| 8 | `tpm_step1` = 3 + store pending digest | | 96.05 | OK |
| 9 | `tpm_step1` + root CRL = 4 + store | | **126.72** | OK |
| 10 | `tdx_step2` = pending check + 5 | | **181.73** | pending matched, OK |

Per step (M, `env::used_gas()` deltas; the vTPM rows are identical within 0.04 TGas across runs 3, 4, 6, 8 and 9):

| Step | TGas |
|---|---|
| vTPM: AK chain, webpki, two RSA-4096 signatures (intermediate by root, AK certificate by intermediate) | 61.47 |
| vTPM: the same chain plus Google's root CRL (parse, plus one more RSA-4096 signature) | 92.08 (+30.61) |
| vTPM: AK public key from the certificate (x509-parser) | 0.18 |
| vTPM: AK signature, one P-256 ECDSA `verify_prehash` over sha256(message) (tpm-qvl's ECC branch) | 31.16 |
| vTPM: qualifying data == sha256(the 8,000 B TDX quote), sha2 in wasm | 0.87 |
| vTPM: replay 7 events into PCRs 0, 2 and 14, plus the PCR digest | 0.17 |
| vTPM: PCR2 UKI digest compare (OS image binding) | 0.02 |
| TDX: collateral JSON parse | 1.64 |
| TDX: dcap-qvl 0.5.2 `verify` | 174.77 |
| two-step only: pending-digest read, sha256(quote) compare, delete | 1.03 |
| two-step only: store pending digest | 0.17 |
| entry (wasm load + args) | 1.6 to 3.4 |

**Does TDX + vTPM fit one 300 TGas call?**
- **Without revocation: yes (M).** Both halves together cost 275.12 TGas. P3's `register` does about 9.5 TGas of
  work beyond DCAP (190.13 − 180.65: measurement checks, storage, event; I). A P3g `register` would therefore be
  about **285 TGas (I)**, roughly 15 TGas under the cap. That is before PCR14 runtime events (0.17 TGas per 7 events
  here) and before dstack's OS-image metadata check, which is not measured.
- **With revocation, as dstack does by default: no (M).** Run 7 ran out at the 300 TGas prepaid limit. The parts
  sum to about 306 TGas, or about 315 TGas with P3's other work (I).

**Two-step `register` (M).**

| Step | What it does | TGas |
|---|---|---|
| 1 `tpm_step1` | vTPM half: AK chain with root CRL, AK signature, PCR replay, UKI. Then it stores the TPM qualifying data as the caller's pending digest | **126.72** (96.05 without the CRL) |
| 2 `tdx_step2` | Reads the caller's pending digest and requires sha256(TDX quote) == it. Deletes it, then runs dcap-qvl on the TDX quote | **181.73**, about 191 with P3's other work (I) |

Both steps keep more than 100 TGas of headroom. A real contract would also expire stale pending digests (I).

Another way to stay in one call (I, not measured): check Google's root CRL in a separate call whenever it is
reissued (7-day validity), and store the CRL number and next-update date on chain. `register` then only checks the
stored result, which is about the 285 TGas case.

**How the vectors map to the steps.** No public set binds a vTPM quote to a TDX quote (§1), so each step uses the
real piece for its own work:
- **AK chain:** the real 2022 GCE P-256 AK certificate, Google's real intermediate and root, and the live CRL.
- **AK signature:** one real P-256 signature, namely the TDX quote's own attestation-key signature over its first
  632 B. No TPM quote signed by that AK is public. The work is the same, one `verify_prehash` over a sha256 digest.
- **Qualifying data:** sha256 of the real GCP TDX quote, compared with a value made from it (a synthetic match).
- **Events:** dstack's GCP event log (PCR0 3 events, PCR2 4, PCR14 0).
- **End to end:** run 1 checks one real matched GCE attestation (AK, quote, log) through dstack's own code, on the
  RSA AK path.

## 4. Google's vTPM root CA

- **The chain dstack trusts (M):** dstack `tpm-qvl/certs/gcp-root-ca.pem` = C=US, ST=California, L=Mountain View,
  O=Google LLC, OU=Google Cloud, **CN=EK/AK CA Root**; self-signed; **RSA 4096**; sha256WithRSAEncryption;
  2022-07-08 00:40:34Z to 2122-07-08 05:57:23Z; DER sha256 `594759594b9b61524f6c8ef668f7177f7b9066bc0674f2f49fe9e052be78beb2`.
  It signs CN=**EK/AK CA Intermediate** (RSA 4096, from 2022-08-23), which signs per-VM AK certificates. The 2022 GCE
  AK certificate (ECC P-256 key) carries AIA "CA Issuers" =
  `http://privateca-content-633beb94-0000-25c1-a9d7-001a114ba6e8.storage.googleapis.com/c59a22589ab43a57e3a4/ca.crt`;
  that URL serves the intermediate (HTTP 200, byte-equal to go-tpm-tools' copy; 22:38:53Z).
- **Where Google publishes the root (D):** Google's own verifier code, google/go-tpm-tools `server/verify.go` (commit
  051b0591, read 22:38:42Z): "To trust the MachineState's GCE instance_info, the caller MUST use authentic
  Google-signed certificates provided in server/ca-certs OR fetched via
  https://privateca-content-62d71773-0000-21da-852e-f4f5e80d7778.storage.googleapis.com/032bf9d39db4fa06aade/ca.crt
  https://pki.goog/cloud_integrity/tpm_ek_root_1.crt." The first URL serves exactly the EK/AK CA Root above (M, HTTP
  200, same sha256, 22:38:53Z). The second is Google's older root (CN=tpm_ek_v1_cloud_host_root-signer…, RSA 4096,
  2018-2118), whose RSA 2048 intermediate signed 2021-era AK certificates such as the COS 85 sample. dstack trusts
  only the 2022 root, so a VM whose AK certificate is on the old chain would fail dstack's check (I).
- **Revocation (M):** the intermediate names one CRL distribution point, the root's
  `…/032bf9d39db4fa06aade/crl.crl`, which is live (CRL 1567, 7-day validity, RSA-4096 signature, nothing revoked;
  02:05Z). The AK certificate names no CRL. dstack's tpm-qvl downloads and enforces such CRLs by default (D:
  `crl-download` is its default feature; `get_collateral` fetches the CRLs, and `verify` checks them with depth Chain
  and CRL expiry enforced, `tpm-qvl/src/verify.rs` v0.6.1). Its cost on chain is in §3.
- **AK key types (D):** Compute API discovery document (revision 20261007, read 22:40:11Z,
  `https://compute.googleapis.com/$discovery/rest?version=v1`), `ShieldedInstanceIdentity`: "signingKey: An
  Attestation Key (AK) made by the RSA 2048 algorithm…" and "eccP256SigningKey: An Attestation Key (AK) made by the
  ECC P256 algorithm…". dstack's guest uses the ECC AK first and RSA as fallback (D, `tpm-attest/src/gcp_ak.rs` v0.6.1).
- **Google Cloud docs (D, negative):** "Retrieving endorsement keys" and the Confidential VM attestation page (both
  "Last updated 2026-10-13", read 22:37:50Z) name no CA and give no root URL.

## 5. PPID and host moves

- **PPID in a GCP TDX quote: yes (M).** The sample's PCK leaf ("Intel SGX PCK Certificate", issuer "Intel SGX PCK
  Platform CA") has SGX extension 1.2.840.113741.1.13.1.1 = `8ebf889447fd60ab1913348582eb509e`; dcap-qvl returns the
  same. Google's TDX provenance page (D, "Last updated 2026-10-13", read 22:39:17Z,
  https://docs.cloud.google.com/confidential-computing/confidential-vm/docs/tdx-provenance): "Extract the platform
  provisioning ID (PPID) from the quote's embedded PCK certificate", then "Use the PPID to fetch the host registry
  JSON document from a Cloud Storage bucket to verify provenance."
- **Does a VM keep its host? UNKNOWN.** Read 22:39:17Z-22:40:11Z:
  - Compute API `Scheduling.onHostMaintenance` = TERMINATE (D, discovery revision 20261007): "Tells Compute Engine to
    terminate and (optionally) restart the instance away from the maintenance activity … Your instance may be
    restarted more than once, and it may be restarted outside the window of maintenance events." It does not say
    same or different host.
  - Confidential VM live-migration page (D, https://docs.cloud.google.com/confidential-computing/confidential-vm/docs/troubleshoot-live-migration,
    updated 2026-10-13): non-migratable Confidential VMs "are stopped" during host maintenance and "restarted after the
    maintenance is complete"; nothing on which host.
  - Stop/start page (https://docs.cloud.google.com/compute/docs/instances/stop-start-instance, updated 2026-10-19),
    the provenance page and the host-maintenance-policy page: nothing on host placement.
  - Sole-tenant nodes, the only GCE feature that pins hardware, are not available for TDX (D, TH paper F15).
  - So a PPID allowlist cannot be relied on for GCP (I); the vTPM check is the replacement.

## Not verified (UNKNOWN)

1. **Today's GCP C3 TDX TCB.** Only a 2024 sample was checked, and it is OutOfDate today. Answering this takes one
   fresh quote from a GCP VM.
2. **Host retention.** No Google doc says whether a stopped/started or maintained GCP TDX VM keeps its host, and
   with it its PPID.
3. **GCP origin of `cos-113-tdx-quote.dat`.** Inferred from its name, its Google author and the FMSPC. Google's
   endorsement lookup returns 404, and that bucket's TDX objects start after the quote's date.
4. **End-to-end GCP TDX + vTPM check.** No public set has a vTPM quote whose qualifying data is sha256 of a TDX quote
   from the same VM. The gas uses the same primitive work (§3), but the end-to-end check is unproven until one real
   dstack GCP attestation runs through the contract.
5. **A real P3g `register` call.** The 285 TGas (no CRL) and 315 TGas (CRL) totals add measured parts to P3's other
   work, which I got by subtraction. Neither is one measured call.
6. **dstack's runtime checks.** The number of PCR14 runtime events in a running dstack app is unknown, and dstack's
   OS-image metadata check beyond the UKI digest is not measured. Event replay costs 0.17 TGas per 7 events here.
7. **Which chain a GCP TDX VM's AK is on.** dstack trusts only the 2022 root. Whether every GCP TDX VM's AK
   certificate chains to it is unknown; the 2021 sample uses the 2018 chain.
8. **Mainnet gas.** Calibrated against testnet only (−0.03 %).
9. **RSA AK on the 2022 chain.** Not measured separately: no such certificate with a quote is public. Run 1 (RSA
   2048 AK, 2018 chain, full tpm-qvl) costs 66.83 TGas in total.

## Rerun

From the repo root. Heavy steps go through the UNRLZD heavy gate in the foreground. The prep step needs network
access to Intel PCS; the sandbox step downloads near-sandbox 2.13.4 on first use.

```sh
cd proofs/p3g-pre
(cd vectors && shasum -a 256 -c ../vectors.sha256)                      # 17 x OK
H="~/Downloads/NEAR trading terminal/scripts/the build queue"
"$H" pg -- tools/build-all.sh                                           # prep (native), contract (wasm), sandbox runner
P="$PWD"
prep/target/release/p3g-prep tdx-tcb "$P/vectors/go-tdx-guest/cos-113-tdx-quote.dat" "$P/results/cos-113-collateral.json" > results/tcb-check-cos113.txt   # Q2, live Intel PCS
python3 -I tools/inspect_tdx_quote.py "$P/vectors/go-tdx-guest/cos-113-tdx-quote.dat"                                                                     # PPID/FMSPC from the PCK leaf
prep/target/release/p3g-prep gce-tpm "$P/vectors/go-tpm-tools/gce-cos-85-nonce9009.pb" "$P/vectors/google-pki/gtt-tpm_ek_intermediate_2.crt" "$P/vectors/google-pki/gtt-tpm_ek_root_1.cer" "$P/results"
prep/target/release/p3g-prep dstack-evlog "$P/vectors/dstack-v0.6.1/tpm_eventlog.bin" "$P/results"
"$H" pg -- tools/run-gas.sh                                             # gas: writes results/gas-run.json
```

- **Gas runs check the wall clock.** dcap-qvl 0.5.2 refuses expired collateral ("TCBInfo expired", "QE Identity
  expired"). The stored copy's QE identity expires 2026-11-20 22:58Z. If that has passed, rerun the `tdx-tcb` line
  first.
- **The root CRL expires 2026-10-29 01:12Z.** After that, refetch it from the URL in §1 into
  `vectors/google-pki/gcp_ek_ak_ca_root.crl` and update its line in `vectors.sha256`, or runs 4, 7 and 9 fail on CRL
  expiry.

## Files

- `vectors/` downloaded data (untrusted), `vectors.sha256` their checksums.
- `tools/inspect_tdx_quote.py` (TDX quote fields, PPID/FMSPC from the PCK leaf), `tools/pb_fields.py` (protobuf field
  lister), `tools/build-all.sh`, `tools/run-gas.sh`.
- `prep/` native helper: Intel PCS TCB check, GCE attestation → dstack `TpmQuote` (SCALE) with a native tpm-qvl verify,
  dstack GCP event-log events, TDX P-256 signature parts.
- `contract/` the gas contract (near-sdk 5.29.1, dcap-qvl 0.5.2, dstack tpm-qvl; an optional `crl` adds the root CRL
  check to the vTPM methods). `vendor/tpm-qvl/` dstack v0.6.1
  tpm-qvl, Apache-2.0, LICENSE kept, upstream manifest kept; one change (the clock, §3).
- `sandbox/` near-workspaces 0.23.0 runner. `results/` every output (args, summaries, `gas-run.json`).
