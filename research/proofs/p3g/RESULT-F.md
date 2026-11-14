# P3G-F: four follow-ups on the P3g dstack VM (update, maintenance, machine size, AK cert fields)

Lane P3G-F, 2026-10-22 05:50Z to 07:14Z (`date -u` reads). Google Cloud project `trenches-enclave-e0ff2c`. Every
gcloud call went through `g.sh` (log: `results-f/gcp.log`, set by `P3G_RESULTS=results-f`) or named
`--project=trenches-enclave-e0ff2c` itself. Same dstack v0.6.1 image as P3g (`p3g-dstack-0-6-1`), key provider `tpm`, no
BUSL part. No NEAR tx was sent. Nothing was deleted.

**Estimated spend: $0.43 of VM time (1.106 VM-hours), under $0.70 with disks, image, IP and bucket (cap $3.00).**
**Both VMs are STOPPED (TERMINATED), read back at 07:11Z (`results-f/final-instances.txt`).** Both vTPMs were in
dictionary-attack lockout at their last boot (§F1), so a plain start of either reboot-loops.

Tags: **M** = measured here. **D** = vendor docs or code (path:line or URL). **I** = my inference. **UNKNOWN** = not
verified. dstack paths are in `vendor-dl/dstack-src-v0.6.1/` (tag v0.6.1, P3g's sha256-checked download).

## Answers

1. **F-P3g-4 in-place update: FAIL (M + D).** A one-line compose change makes the sealed seed unopenable: TPM
   `POLICY_FAIL`, reboot loop, no new seed, LUKS never opened. dstack v0.6.1 has no update path on GCP and no re-seal
   path for the `tpm` provider. Putting the old compose back restored P3g's exact state (M).
2. **F-P3g-1 maintenance: PASS once, FAIL over time (M).** On a fresh VM one maintenance event kept everything: seed,
   LUKS, app_id, instance_id, compose, keysets, AK cert. Only PPID and PCK serial changed, because the VM moved host. But
   every GCE stop and maintenance event is an ungraceful power-off. The third one locks the vTPM (`TPM_RC_LOCKOUT`). p3g-c3
   hit it after its maintenance event, and p3g-c3x8 after two more stops.
3. **F-P3g-2 c3-standard-8: MRTD, RTMR1, RTMR2, PCR0, PCR2 the same; RTMR0 differs (M).** dstack-mr cannot compute the GCE
   set offline. It holds only the UKI hash for GCP (D).
4. **F-P3g-3 AK cert security properties: [0] security_version=0, [1] is_production=TRUE (D), [2]=TRUE, [3]-[5]=FALSE
   (meaning UNKNOWN).** Step 1 should check `is_production == TRUE` and record `security_version`. It should not pin [2]-[5].

## F-P3g-4: in-place update (FAIL)

**What dstack v0.6.1 offers (D).** `dstack-cloud` has no update or upgrade subcommand (`dstack/scripts/bin/dstack-cloud`
3388-3450). `deploy` refuses an existing instance unless `--delete` is passed: "Instance '…' already exists. Use --delete
to replace it." (1456-1458). `--delete` deletes the VM, and its data disk is created `auto-delete=yes` (1475). The shared
image is rebuilt (1356-1396). So the vendor path for a compose change on GCP is a new VM with a new data disk: new seed,
new instance_id (I from D). dstack-vmm's "Upgrade" keeps the app id (`docs/usage.md:135`), but it is a VMM feature, not
dstack-cloud on GCP. `docs/upgrading-to-0.6.md` covers KMS only (D).

**Emulated in place (M).** `f4.mjs` adds one YAML comment line to P3g's `docker-compose.yml` and nothing else.
`.sys-config.json` and `.instance_info` are byte copies, so the app_id stays `7c81cb60bb7f…02e6`. The compose hash goes
from `7c81cb60…fe81` to `3f2b9643899477b8efdfdd68672ddeabc173ebeb284a6b2c9bb8ca6169f06239` (`results-f/f4-compose.json`).
On stopped p3g-c3 the shared disk was swapped to `p3g-c3-shared-f4` (same device name), then started 05:58Z:

- Both boots (05:58:58Z, 05:59:32Z): `Generating app keys from TPM` → `failed to unseal from TPM` → `Unseal failed with TPM
  error: 0x0000099d` (`results-f/serial-f4-update-t2.txt:621-625, 1364-1370`). 0x99d = `TPM_RC_POLICY_FAIL` on session 1
  (ms-tpm-20-ref TpmTypes.h:498,545,599-600). `dstack-prepare` fails, and its `OnFailure=reboot.target` reboots the VM
  (`os/common/rootfs/dstack-prepare.service:6,14`).
- No new seed: dstack generates a seed only when the NV index is empty, and an unseal error stops the boot
  (`dstack-util/src/system_setup.rs:2443-2477`; `tpm2/src/commands.rs:764,803`). LUKS was not opened, the app never
  started, and ports 8080/8090 stayed closed.
- Why: the seed is sealed to PCR {0,2,14} (`tpm-attest/src/lib.rs:202-261`). PCR14 at seal time contains the
  compose-hash event. PCR14 at the seal point was `7d2c473a…e5f6` in P3g; with the F4 compose it is `b36b87df…cabf`
  (computed, `results-f/f4-pcr14-expected.json`).
- Compose hash in PCR14/RTMR3 does change. On p3g-c3x8, which runs the F4 compose, the quote's PCR14 and RTMR3 replay
  the compose-hash event `3f2b9643…6239` (`results-f/attest-f-c3x8-boot1.json`, `compose_hash_event_eq: true`).
- CKD root fingerprint and mint keysets: not readable, because the app never ran on the F4 boot.
- Image change (PCR2): not run. PCR2 is in the same policy, so the same `POLICY_FAIL` path applies (D, same lines).

**Restore (M).** Reattached the original `p3g-c3-shared` and started at 06:03:18Z. The log shows `unsealed root key seed
from TPM (PCR policy: sha256:0,2,14)`, then LUKS opened with its journal recovered. app_id, instance_id `8a9bdae8…11d6`,
compose `7c81cb60…fe81`, PCR14 `30397d05…2841`, PPID `b391ff59…`, PCK serial `7F1402E3…` and AK sha256 `7a409ff7…a6c8`
all equal P3g. Every attest check passed and the verifier returned `is_valid`. The mintt round trip passed: keyset
`01ae7231…`, the 13 held proofs UNSPENT, the 12 spent ones SPENT (`results-f/roundtrip-f-c3-mintt-restore.json`). So
p3g-c3 was back in P3g's state at 06:04Z. F-P3g-1 then locked it out.

**What this means for the design.** On GCE, dstack's `tpm` seed is bound to the exact compose and image. Every mint
update is a new identity unless we carry state across ourselves. Two ways: derive the root from CKD (re-requestable by
the new compose once the contract allows it), or do an attested old→new key handover before the old VM goes. Without
one of these, the data on the old disk is lost.

## F-P3g-1: host maintenance (PASS once, FAIL over time)

**Sample A, p3g-c3 (c3-standard-4) (M).** `simulate-maintenance-event` at 06:05:22Z; `terminateOnHostMaintenance` at
06:09:38Z; auto-restart at 06:11:29Z on the same IP. From the first boot (06:12:02Z,
`results-f/serial-f-c3-maint-first.txt:468-477`) every boot logged `failed to unseal from TPM` / `Load failed` / `TPM
error: 0x00000921`, then rebooted: 17 boots from 06:12 to 06:21Z, and 17 more from 06:22 to 06:32Z
(`results-f/serial-f-c3-maint.txt`). There was no recovery in 23 min. Stopped 06:35:49–06:38:05Z. 0x921 =
`TPM_RC_LOCKOUT` (TpmTypes.h:567,593). None of the (g) reads were possible.

**Sample B, fresh p3g-c3x8 (M).** Simulated at 06:51:25Z, terminated 06:55:07Z, auto-restarted 06:56:27Z. The seed
unsealed, LUKS opened and the app answered at 06:56:52Z, about 1.8 min down. Before → after
(`attest-f-c3x8-boot1.json` → `attest-f-c3x8-maint.json`):

| read | result |
|---|---|
| PPID | **changed** `f0172499…` → `b391ff59…` (p3g-c3's host) |
| PCK serial | **changed** `4B7CDBF4…` → `7F1402E3…` |
| AK cert sha256 | same `82a85897…d5dea8` |
| sealed seed / LUKS | unsealed / opened, journal recovered |
| app_id, instance_id, compose | same `7c81cb60…`, `afef4d8a…`, `3f2b9643…` |
| MRTD, RTMR0-3, PCR0/2/14 | same; TPM resetCount 4 → 5 |
| keysets | mintt `01ae7231…`, all 32 keys equal (`keys-c3x8-mintt.json`); TCB UpToDate, verifier valid |

**Cause of the lockout (M + D + I).**
- M: each GCE stop took 139 s. During STOPPING the guest printed nothing on serial, so it did not shut down and was
  forced off (`results-f/stop-c3x8-stop1.jsonl`). After sample B, p3g-c3x8 went stop → start (seed unsealed, 07:01Z) →
  stop → start: `Load failed` / `0x00000921` at 07:05Z (`f1-cycles.jsonl`, `serial-f1-cycle2.txt`). That was the third
  ungraceful power-off since its seal.
- D: GCE stop sends ACPI G2 soft-off, allows "a short time", and then "forces a shutdown"
  (https://docs.cloud.google.com/compute/docs/instances/graceful-shutdown-overview, updated 2026-10-20). dstack's prod
  profile removes `systemd-logind` (`os/mkosi/mkosi.profiles/prod/mkosi.conf:45-47`).
- D: dstack's SRK and sealed object are DA-protected. `rsa_storage_key` and `sealed_object` set no `NO_DA`
  (`tpm2/src/types.rs:620-633, 662-675`), and the `NO_DA` constant (`tpm2/src/constants.rs:207`) is used nowhere.
- D: in the TPM 2.0 reference (microsoft/ms-tpm-20-ref@ee21db0a DA.c), the defaults are `maxTries=3` and `recoveryTime=1000`
  s (22-23). A non-orderly previous shutdown adds one failed try when a DA-protected object was used (84-88;
  Startup.c:53). At `failedTries >= maxTries` the TPM returns `TPM_RC_LOCKOUT` (SessionProcess.c:1259-1264). Self-heal
  needs recoveryTime of TPM uptime (DA.c:50-68).
- I: sample B matches a count of 3: maintenance, stop, stop, each after less than 17 min of uptime. p3g-c3 fits too,
  through P3g's two stops plus the maintenance event. It fits only if the F4 reboot-loop stop did not count, which
  happens if it hit before that boot's `Load`. UNKNOWN: GCE's vTPM DA parameters, and whether a locked vTPM ever heals.
  dstack's reboot loop gave it no heal in 23 min.

**What this means for the design.** A single maintenance event is safe. A dstack `tpm` CVM on GCE is not safe over time:
three ungraceful power-offs in a short span lock the seed out, and dstack then reboot-loops. A locked seed means the data
disk and the CKD root on that VM are lost. Before a mainnet mint we need one of these (I, untested):
- an orderly guest shutdown path, so stops are graceful;
- an image built with `NO_DA` on the SRK and sealed object (new `os_image_hash`);
- a root that does not live only in the vTPM seal (as in F4).

Step 1 must not pin PPID or PCK serial, because they change when the VM moves host.

## F-P3g-2: c3-standard-8 measurements

p3g-c3x8: c3-standard-8 TDX, us-east4-a, images `p3g-dstack-0-6-1` + `p3g-shared-f4` + a new data disk from `p3g-data`,
VPC `p3g-net`, no service account, maintenance TERMINATE. Created 06:39:20Z; app up 06:40:18Z with `no sealed seed found,
generating new seed`. Against P3g's c3-standard-4 (RESULT.md §3) (M):

| register | c3-standard-4 | c3-standard-8 |
|---|---|---|
| MRTD | `c1ee9c16…` | **same** |
| RTMR0 | `071ea920…` | **differs** `89f55a2d62ee…72fb`; the same on c3x8's second host |
| RTMR1 | `fea84c84…` | **same** |
| RTMR2 | `961f79aa…` | **same** |
| PCR0 | `0cca9ec1…` | **same** |
| PCR2 | `88e61574…` | **same**, and the same 4 PCR2 events |
| PCR1 | — | differs: 3 `EV_PLATFORM_CONFIG_FLAGS` events; not in dstack's policy {0,2,14} |

FMSPC `00806f050000`, TCB UpToDate, `td_attributes` and `tee_tcb_svn` are the same. PPID, PCK serial, AK and instance_id
differ (other host, other VM).

**dstack-mr (D).** For GCP, dstack-mr v0.6.1 only wraps the UKI Authenticode hash (`dstack-mr/src/main.rs:20,70-81`;
`dstack-types/src/lib.rs:1625`). Its TDX path models QEMU's ACPI tables from `cpu_count`/`memory_size`
(`dstack-mr/src/acpi.rs`, `machine.rs:15-16`), not GCE's firmware. dstack's verifier checks GCP through fixed PCR0 plus
PCR2 event 3 only (`verifier/src/verification.rs:1022-1073`). So dstack computes no offline MRTD or RTMR0-2 for GCE.

**What this means for the design.** Step 1 can pin MRTD, RTMR1, RTMR2, PCR0 and PCR2 per image across machine sizes.
RTMR0 needs one measured value per machine type, from one boot of each type we allow.

## F-P3g-3: AK cert security properties

The bytes `A020301EA003020100A1030101FFA2030101FFA303010100A403010100A503010100` decode as `[0]` SEQUENCE of six explicit
tags: `[0]` INTEGER 0, `[1]` BOOLEAN TRUE, `[2]` BOOLEAN TRUE, `[3]` `[4]` `[5]` BOOLEAN FALSE. The c3-standard-4 and
c3-standard-8 AK certs carry identical bytes (M).

- **D:** the only public ASN.1 definition is go-tpm-tools `server/verify.go:103-106` (commit eb7fc06b, 2026-10-22):
  `gceSecurityProperties { SecurityVersion int64 explicit tag 0 optional; IsProduction bool explicit tag 1 optional }`.
  The extension is OID 1.3.6.1.4.1.11129.2.1.21 (`verify.go:30`). go-tpm-tools returns no instance identity when
  `!IsProduction` (`verify.go:265-268`). openpcc `gce_ak_certificate.go:33-45` and google/go-attestation `tpmsim/gce.go`
  define the same two fields or fewer.
- **UNKNOWN:** tags [2]-[5]. Google's attestation and vTPM docs (updated 2026-10-20) do not define them. [2] is TRUE in our
  certs and in salrashid123/gcp-vtpm-ek-ak's README (619d349d, 2024-12-30), and FALSE in go-tpm-tools' test payload
  (`server/verify_test.go:700`). So it varies, and its meaning is not published.

**What step 1 should check.** Parse the trailing structure. Require `[1] is_production == TRUE`, which is what Google's
own verifier enforces. Record `[0] security_version` (no minimum is published). Do not pin [2]-[5]: their meaning is
unknown, and a pin would break when Google flips one. Today the contract ignores the structure
(`contract/src/lib.rs:224-247`) and E37 checks only the project (488-491), so this is one added field check.

## Final state and resources

- `p3g-c3` TERMINATED with its original `p3g-c3-shared` attached; vTPM locked out at its last boot. `p3g-c3x8` TERMINATED;
  vTPM locked out at its last boot.
- Created by this lane, all kept: VM `p3g-c3x8` with disks `p3g-c3x8`, `p3g-c3x8-data`, `p3g-c3x8-shared`; image
  `p3g-shared-f4` and its bucket object `p3g-shared-f4.tar.gz`; disk `p3g-c3-shared-f4` (unattached); firewall
  `p3g-f-allow-mac` (tcp 8080/3338/3339/8090 from the Mac's IP, now **disabled**). P3g's `p3g-allow-mac` was not touched.
- Idle cost from here: about 32 GB of disks plus one image, at most about $0.16/day (I, from `results-f/spend-plan.json`
  prices).
- Lane tooling: `g.sh`, `spend.mjs`, `vm.mjs`, `attest.mjs`, `eventlog.mjs` and `cvm.mjs` take `P3G_RESULTS`/`P3G_CVM`/
  `P3G_SHARED*` env (defaults unchanged). `f4.mjs` builds `cvm-f4/`.

## Rerun

```sh
cd proofs/p3g && export P3G_RESULTS=results-f P3G_CVM=cvm-f4
node f4.mjs && P3G_SHARED=cvm-f4/shared/ P3G_SHARED_TAR=p3g-shared-f4.tar.gz node cvm.mjs disks shared
node attest.mjs <ip> <label> && node eventlog.mjs <ip> <label> && node vm.mjs serial <vm> us-east4-a <label>
./g.sh compute instances simulate-maintenance-event <vm> --zone=us-east4-a --async
node spend.mjs show
```
