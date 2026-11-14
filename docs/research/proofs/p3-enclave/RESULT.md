# P3 Enclave: result

This proof ran on 2026-10-20 from 08:03Z to 09:08Z, on Phala Cloud (Intel TDX, dstack) and NEAR testnet. Every time
below is UTC and was read from `date -u` or from a log line. The records are in `results/`.

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | dstack app on Phala's newest OS image | **PASS** | `dstack-0.6.1` was the newest image Phala offered (API read 08:04Z). TCB `UpToDate`, no advisories |
| 2 | Quote binds A; checked ON CHAIN (dcap-qvl in wasm, PPID and measurement allowlists) | **PASS** | E12, E11 and E13 refusals, then 2 registrations, all FINAL on 2 RPCs. `register` burns 190.2 TGas |
| 3 | Sealed state survives a restart; no Phala KMS in our design | **PASS, with a limit** | Same CKD root after a VM reboot, and store A unsealed. The volume itself needs Phala's KMS (see §3) |
| 4 | PPID pinning | **PASS** for create, restart and stop/start | Same node prod5 and PPID `3e306e13…` across 3 boots, read from the quote, the PCK cert and the API |
| 5 | TLS on `confidential.unrealized.trade` ends inside the CVM | **PASS** | LE cert issued in the CVM by TLS-ALPN-01 in 8.9 s. The served SPKI is bound in a verified quote |
| 6 | X15 boot budget, clocksource, store B PUT latency | **PASS** (measured) | Deploy → serving 54.9 s, restart → serving 65.7 s, `tsc`. B2 PUT p50 ≈ 340-350 ms from the CVM |
| 7 | P7 CVM row (CDK mint inside the CVM) | **NOT RUN** | The coordinator said to finish after TLS. Credit allowed it ($0.10 used) |

Phala credit: **$5.000000** at 08:03:20Z, **$4.904109** at 09:04:41Z. So **$0.095891** used (post-paid; a late
charge can still land). CVMs at the end: **0** (`GET /cvms/paginated` total 0 at 09:04:33Z).

## Values other papers need

| Value | Number | Source |
|---|---|---|
| X15 deploy → serving | **54.9 s** (POST /cvms 08:26:44.134Z → app answers with a ready quote 08:27:39.085Z). Status `running` came at 53.5 s | `results/cvm-events.jsonl` |
| X15 restart → serving | **65.7 s** (08:45:01.029Z → 08:46:06.741Z) | same |
| X15 stop → start → serving | stop 12.2 s; start → serving **65.4 s** (09:02:18.782Z → 09:03:24.140Z) | same |
| In-app boot work | keys 88.6 ms, first quote 1,038 ms, attestation ready 2,167 ms after the process starts | `results/attest-boot1.json` `timings_ms` |
| `register` gas | **190.19 TGas** in the contract receipt (190,190,377,531,098 at boot 1; 190,195,446,602,966 at boot 2). With the tx conversion and the deposit refund: 202.64 TGas, 0.020263 N burnt | `results/near-events.jsonl` |
| `register` prepaid needed | **210 TGas is enough** (boot 2 passed with 210 TGas). Boot 1 used 300 TGas | tx `Axd9YZLg…` |
| Refused `register` cost | 183.3-187.5 TGas, 0.0188-0.0192 N. The caller pays for verification even when refused | E12/E11/E13 txs |
| `register` args | 96,795 B of JSON. The quote (5,010 B) goes as a JSON number array; hex or base64 would shrink it | same |
| `request_key` | 13.6 TGas burnt, 0.00136 N; about 18 s from send to the MPC answer | same |
| Test contract wasm | **684,263 B**, sha256 `90351adb…edf3`, code hash `Ahvg8oS5x1tWWUDd8YNTtj4TKQQ1TVJh3HGnKHeJGB14`; deploy 87.2 TGas | deploy tx `H5gd9qD4…` |
| Store B PUT from the CVM (prod5, US-WEST-1 → B2 us-east-005), n = 100 each | **1 KB: p50 347.3, p95 934.6, max 2,487.0 ms. 16 KB: p50 339.6, p95 695.6, max 1,470.1 ms** (min ≈ 104 ms) | `results/b2-cvm-*-boot1.json` |
| Store B PUT from the Mac (home network), n = 100 each | 1 KB: p50 460.3, p95 1,187.4, max 3,745.8 ms. 16 KB: p50 509.3, p95 1,086.9, max 3,009.6 ms | `results/b2-mac-*.json` |
| Clocksource in the CVM | **tsc** (available: tsc, acpi_pm; flags constant_tsc, nonstop_tsc, tsc_known_freq, tsc_reliable). Same after the reboot | `results/clock-boot*.json` |
| Pinning answer | **Yes for what we can do**: `node_id` at create pins the node. Restart and stop/start kept prod5 and the PPID. **Not shown**: anything that stops Phala from moving the CVM itself | §4 |

## 1. OS image and measurements

- Phala's `GET /teepods/available` at 08:04:07Z listed two nodes, prod9 and prod5 (US-WEST-1). Both offered
  `dstack-0.6.1`, `dstack-0.5.12`, and the dev and nvidia builds of 0.5.12. 0.6.1 is the newest. The source is
  `results/teepods-available.json`.
- dstack's GitHub release v0.6.1 was published 2026-10-13T02:18:58Z as "a security release". Its guest OS
  `os_image_hash` is `ec43cb8c5e04b6bb6c53b33b16076a01d83d01f7f4b703f2f78a0d947d6247e6`
  (`results/dstack-releases-read.json`). The same hash is in the CVM's API record and in its `tcb_info`.
- The node's VMM reports `v0.6.0 (git:96583b6d6a5116c86be9)`. The CPU is family 6, model 0xAF, and the instance type
  is tdx.small (1 vCPU, about 1.9 GB RAM).
- Measurements were the same on all three boots (`results/attest-boot{1,2,3}.json`):
  - MRTD `2a674327c50218dba880066b349b8d559d749ed68dce33fd651c184a877d084b07a9e583767a7ad5da13ed91deec2b70`
  - RTMR0 `68102e7b524af310f7b7d426ce75481e36c40f5d513a9009c046e9d37e31551f0134d954b496a3357fd61d03f07ffe96`
  - RTMR1 `89ef86c5125b986c325f0a94acfa87718a4ef3a4d4f237dbb72dda3cf777fd2c054555fb4407eb53338d7d67329a7333`
  - RTMR2 `e9000e338f33233e8f51b7fd031e1c158bdcf8572eab041c0bc8eb7fef48b23259a6a556e6c8e2af99999fc39c793179`
  - key-provider event digest `83368b43a0fc6f824f5a9220592df85fd30e2d405ecbd253a5c6354af63e6c9b41aec557c38a38e348ab87f9ac8fc68c`
    (payload `{"name":"kms","id":"3059…"}`, Phala's KMS key)
  - compose hash `c9b4738fba83b998c3e3a77f2cc3cfc4d089cc1e269f3210cf6dd00b378ff33b`
- Platform TCB: `UpToDate`, `advisory_ids` empty. FMSPC `20A06F000000`. TCB evaluation data number 20, top level
  tcbDate 2025-08-13. The TCB info was issued 2026-10-19T23:58:51Z and its next update is 2026-11-18. TD debug bit
  0, `tee_tcb_svn` `0b0105…`. The collateral came from `pccs.phala.network` in about 1.4 s.
- The compose hash covers Phala's `pre_launch_script` v0.0.20 (sha256 `98218161…5ffe8`). Phala adds this script, and
  it can set a root password and SSH keys from `DSTACK_*` env vars. Our `allowed_envs` (measured) lists only
  `B2_KEY_ID`, `B2_APP_KEY` and `P3_CTL_TOKEN`. We did not test whether dstack drops env keys that are not listed.
- What item 1 does not show: that TEE.fail or DDRop are fixed. The quote shows only the newest image Phala offers and an
  `UpToDate` TCB under Intel's collateral of 2026-10-19. TEE.fail is a physical memory-bus attack; a TCB status
  does not speak to it.

## 2. On-chain `register` with the 06a binding

- **Contract.** `p3-ghost.p2ckd-be9844bc.testnet` has no access keys and was deployed by tx `H5gd9qD4…` at 08:27:58Z.
  near-sdk 5.29.1 (as P2). The checks run in NEAR's Shade Agent crate `shade-attestation` 0.2.0
  (NearDeFi/shade-agent-framework at commit `35758f354ad9862fb590daf9843fea4974d52549`). It is vendored in
  `contract/shade-attestation/` with its LICENSE, and its only change is relaxing the `serde_with` pin to `3.20` to
  build with near-sdk 5.29.1. It runs dcap-qvl 0.5.2 in wasm.
- **Order of checks** (shade's `verify`): quote and collateral (dcap-qvl) → TD 1.0 report → TCB `UpToDate` →
  `report_data` → PPID allowlist → RTMR3 replay → compose-hash event → measurement allowlist {MRTD, RTMR0-2,
  key-provider digest, compose hash}. Then our code checks that a_pk is a G1 point in the subgroup (NEAR host
  functions), and that the deposit covers storage.
- **Binding.** The CVM computes `report_data` = SHA-512("ghost/v1/register" ‖ a_pk(48) ‖ h_pk(32) ‖ n_pk(32)), and the
  contract recomputes it from the call's arguments. The Mac also recomputed it (`checks.report_data_matches_binding`).
- **PPID, read independently.** The JS dcap-qvl 0.6.3 returns no PPID. So `attest.mjs` reads it from the PCK leaf
  certificate in the quote (Intel SGX PCK Certificate, extension OID 1.2.840.113741.1.13.1.1): `3e306e133b7fdaa7bb79f67634cb520c`.
  The contract's Rust dcap-qvl reports the same value (in its E12 message and in the registration), and so does
  Phala's API (`node_info.ppid`).
- **Runs** (every tx was re-read at FINAL on rpc.testnet.near.org and test.rpc.fastnear.com: `results/near-final.jsonl`):

| Time (Z) | Allowlists before | Call | Result |
|---|---|---|---|
| 08:34:54 | measurements {boot}, PPIDs {} | register (boot 1) `2TKkYwjX…` | **E12** `PPID 3e306e13… is not in the allowed PPIDs list` (a machine not on the list is refused) |
| 08:35:57 | measurements {}, PPIDs {3e306e13…} | register `HVXB8FMV…` | **E11** measurements not approved |
| 08:36:59 | both set | register with h_pk changed `7GkHqG5n…` | **E13** report_data does not bind (a_pk, h_pk, n_pk) |
| 08:37:32 | both set | register `E5fTVNEV…` (300 TGas) | **OK**, key_id `5bd70224…`, event logged |
| 08:47:26 | both set | register boot 2 `Axd9YZLg…` (210 TGas) | **OK**, key_id `2d8b3013…` |

- In the CVM, the per-boot key n (an implicit account) signs each `register` and `request_key` tx. The Mac only
  relays the signed bytes. The receiver is fixed to the test contract (`POST /sign`).
- **Shade findings for 06a.** (1) The E11 text says "one of the embedded TCB info sets (prod or dev)", but the code
  only checks the list it is given (`verify_any_measurements`); there is no embedded fallback. (2) Shade's
  app-compose policy check (`validate_app_compose_config`) is commented out in 0.2.0. Flags such as `kms_enabled`
  and `allowed_envs` are therefore covered only by the allowlisted compose hash.

## 3. Sealed state across a restart

- **Shown.** At boot 1 (08:38:18Z), `request_key` (`HwoWYwaH…`) returned the MPC answer, and the CVM opened
  S = C − a·Y with its per-boot a. It sealed `/data/storeA/sealed.bin` under HKDF-SHA256(S, "confidential-trenches/v1",
  "store/p3-test/v1") with ChaCha20-Poly1305. S fingerprint: `95597ee0a98ca325`.
- Then a full VM reboot (`/proc/uptime` 46 s afterwards). Boot 2 had new a, h and n keys and a new N (`9358603a…`).
  It registered, ran `request_key` (`GdT2Q3uR…`, 08:47:58Z), got **the same fingerprint `95597ee0a98ca325`**,
  and **unsealed the file** (`existed: true, opened: true`; the log inside lists boot 1).
- The volume kept `first-boot.json` (sha256 `73cd6a93…`), `boots.log` (3 boots) and the sealed file across the restart
  and across a stop/start (`results/disk-boot*.json`). Caddy's certificate on its own volume was also kept (§5).
- **Our code uses no Phala KMS key.** `cvm/app.mjs` calls only `/GetQuote` and `/Info` on the guest agent: no
  `GetKey`, no `GetTlsKey`, no `Sign`. Store A's key comes only from S (NEAR MPC CKD). The committed `app.mjs` (sha256
  `46ab18af…eb1`) is byte for byte the code inside the attested compose.
- **But the platform does.** With `key_provider: kms`, dstack encrypts the data volume with a key from Phala's KMS
  (`kms.dstack-pha-prod7.phala.network`). We tested the alternative live. A `key_provider: none` CVM (`cvm_5wV6dGwd`,
  08:49Z) booted, but Phala refused it ingress: `dstack-gateway registration failed, the app has no ingress route:
  Missing allowed dstack-gateway app id` (`results/none-mode.jsonl`). With `none` it also gets no env encryption key.
  From the dstack v0.6.1 source (`system_setup.rs`, `disk_reusable = !key_provider.is_none()`), its disk is not
  reused across boots. So on Phala Cloud, persistence, ingress and encrypted env all need Phala's KMS.
- **What this means for 06a §5.** Store A's secrecy does not rest on Phala's KMS: whoever gets the disk key sees only
  ciphertext under HKDF(S). Store A's availability across restarts does rest on it. If the KMS refuses or is down at
  boot, the volume cannot be opened. That boot case was not tested. A rollback of the disk was not tested either
  (red-team C31; the anchor must cover it).

## 4. PPID pinning

- At create we passed `node_id: 5`, and the CVM ran on prod5 (node id 26, US-WEST-1). Passing the teepod id 26
  failed earlier with "No teepod found matching all requirements".
- Across create (08:27Z), restart (08:45Z) and stop → start (09:02Z), these stayed the same: node prod5, `instance_id`
  `46874aca…`, `app_id` `c515b804…`, and the PPID `3e306e133b7fdaa7bb79f67634cb520c` in all three quotes and in
  the API (`results/pinning.jsonl`, `results/attest-boot{1,2,3}.json`). The measurements stayed the same too.
- The API shows the node's PPID on the CVM record (`node_info.ppid`), so the allowlist value can be read before
  calling `register`. `/teepods/available` showed `ppid: null` for nodes at 08:04Z.
- `tcb_info.device_id` is sha256("") (`e3b0c442…`): dstack 0.6.1 leaves it empty. The API's node `device_id`
  (`c4691f9c…`) is a different field, so pin on the PPID, not the device id.
- **Not shown.** Phala may move or rebuild a CVM itself (for example during maintenance or the forced OS upgrade
  from 2026-11-20). We found no API field that rules that out: `GET /cvms/{id}/replicas` → 405, and the
  OpenAPI file is not served at `/openapi.json` or `/api/v1/openapi.json`. A move to another machine changes the
  PPID, and `register` then refuses with E12 until the new PPID is allowlisted. An OS upgrade changes the
  measurements (E11) in the same way.

## 5. TLS on our own domain

- **CAA.** No CAA records on `unrealized.trade` or `confidential.unrealized.trade` (08:08Z and 08:59Z, on 1.1.1.1,
  8.8.8.8 and the authoritative dns1.registrar-servers.com; `results/dns-before.txt`, `results/dns-after.txt`). The
  CNAME target's parent `dstack-pha-prod5.phala.network` has CAA `letsencrypt.org; validationmethods=dns-01;
  accounturi=…/acct/3859201366` (Phala's account). That record did not apply to our name: Let's Encrypt issued.
- **DNS.** The owner's first CNAME value had a typo (`phalanetwork`); it was fixed by 08:51Z. Live at 08:59Z:
  CNAME `confidential` → `gateway.dstack-pha-prod5.phala.network.`, and TXT `_dstack-app-address.confidential` =
  `c515b80430e2e5e4b27c65374d415db670142e77:443`. The gateway reads that TXT for an SNI outside its wildcard and
  passes the raw TLS stream to the CVM (dstack v0.6.1 `gateway/src/proxy.rs`, `proxy/tls_passthough.rs`).
- **Issuance inside the CVM.** Caddy 2.11 runs in the CVM with an ACME issuer for LE production, HTTP-01 off and
  TLS-ALPN-01 on. It holds no DNS token. Load at 09:00:23Z → certificate at 09:00:32Z (**8.9 s**).
  `CN=confidential.unrealized.trade`, issuer Let's Encrypt YE2, valid until 2027-01-18. SHA-256 fingerprint
  `E1:0F:53:E4:…:F1:16`, SPKI sha256 `5021eff37f11b880031c5182ebc4db80448e441d4ec6d283d1d843af5ccca776`.
- **Checked from the Mac** (`results/tls.json`, all true): TLS 1.3 to the gateway IP <server ip> with SNI
  `confidential.unrealized.trade` gets that certificate, trusted by the Mac. Its SPKI equals the one the CVM read from its own volume.
  It is not Phala's certificate: the gateway's URL for the same app serves `*.dstack-pha-prod5.phala.network`
  (YE1, TLS 1.2) with a different key. `https://confidential.unrealized.trade/health` answered from our app with
  boot id `9f2286d0…`, the attested boot.
- **The served key is bound to the attested code.** The CVM made a fresh quote with report_data =
  SHA-512("ghost/v1/tls" ‖ SPKI sha256). The Mac verified it (`UpToDate`) and recomputed report_data from the
  SPKI it was served. MRTD, RTMR0-3, the compose hash and the key-provider digest equal the attested boot.
- After the stop/start, the same certificate was served again with no new issuance (09:03:41Z).
- **Not shown.** The gateway operator controls the IP the name points to, so they could stop passing through and
  get their own certificate by TLS-ALPN-01. CT logs would show that. CAA with `accounturi` could block it, but CAA
  cannot sit next to the CNAME. It would have to go on `unrealized.trade`, which covers the whole domain: an owner
  decision. Clients that check the quote-bound SPKI (as `tls.mjs` does) are not fooled by such a certificate.

## 6. Store B (B2) detail

- Bucket `trenches-p3-20261020` (us-east-005): Object Lock on, default retention COMPLIANCE, 1 day (`results/b2-setup.jsonl`).
- The CVM used a new key scoped to that bucket (writeFiles, readFiles, listFiles; no delete, no bypassGovernance). It
  went in as a Phala encrypted secret (X25519 + AES-256-GCM to the app's env key). The key was deleted at 09:04:39Z.
  Only the owner's own key `…0001` is left.
- Both benches used the same code (`b2bench` in `cvm/app.mjs`): S3 SigV4 PUT with Content-MD5 over one kept-alive
  HTTPS agent. Each run of 101 PUTs used 2 TLS connections (one reconnect); the first PUT is reported as `warmup_ms`.
- Retention checked at 08:43:37Z with `b2_get_file_info`. A CVM object (uploaded 08:38:47Z) has `compliance`
  until 2026-10-21T08:38:47Z, and a Mac object has the same. A delete with the scoped key → 401 unauthorized; a
  delete with the account key → 401 access_denied. The PUT responses do not echo the lock headers.
- 202 CVM objects and 206 Mac objects stay locked until about 2026-10-21 08:42Z. The bucket can be emptied and
  deleted after that.

## 7. P7 CVM row

Not run. Everything for it is still open: a Linux `cdk-mintd` 0.18.2 image (upstream static binaries with
SHA256SUMS, or a build from the tag), the seed passed as `file:` on tmpfs (P7 §2), a new compose, a new measurement
allowlist entry and registration, and the cashu-ts round trip inside the CVM. The CKD root path is already proven
here (§3).

## Files

- `cvm/app.mjs` is the enclave app (Node 24 built-ins only), and `test-app.mjs` holds its 52 local checks.
  `cvm.mjs` renders the compose and handles deploy, restart and delete, and `cvm/docker-compose.yml` and
  `cvm/compose-file.json` are the rendered kms compose.
- `attest.mjs` verifies quotes and reads the PPID, `register.mjs` runs register, request_key and the admin calls,
  and `tls.mjs` covers item 5.
- `measure.mjs` reads the CVM endpoints, `pinning.mjs` reads the API pinning fields, and `bench-mac.mjs` runs the
  Mac B2 bench.
- `b2.mjs` and `b2-setup.mjs` set up and check B2. `near.mjs` and `deploy-contract.mjs` handle testnet, and
  `verify-txs.mjs` re-reads the txs at FINAL.
- `phala.mjs`, `credits.mjs`, `env.mjs` and `dns-read.sh` are helpers.
- `contract/` is the test contract (`src/lib.rs`, `build.sh`, `wasm/p3_ghost_test.wasm`, Cargo files, vendored
  shade-attestation).
- `results/` holds every record. No keys are in any file: secrets load from `~/.confidential-trenches/` and are
  never printed.

## Reproduce

```sh
npm ci && node test-app.mjs
cd contract && ./build.sh && cd ..            # 684,263 B, code hash Ahvg8oS5…
node b2-setup.mjs create && node cvm.mjs create p3-enclave-a 5 kms
node attest.mjs <cvm> boot1 && node register.mjs fund boot1 && node register.mjs admin add_measurements boot1
node register.mjs register <cvm> boot1 ok      # E12 until: node register.mjs admin add_ppid boot1
node register.mjs request-key <cvm> boot1 && node cvm.mjs restart <cvm> && node attest.mjs <cvm> boot2 ...
node tls.mjs <cvm> boot2                       # needs the CNAME + TXT records
node cvm.mjs delete <cvm> && node cvm.mjs list && node b2-setup.mjs delete-key && node credits.mjs end
```
