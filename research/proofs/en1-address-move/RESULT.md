# EN1A: how a handover moves both hosts to the new CVM (paper 10 §7 row 61)

Lane EN1A (prep), 2026-10-22 20:54Z to 21:30Z (`date -u` reads). Paper 10 §7 row 61 asks team lead for "EN1's address-move
choice", due Oct 24. This folder holds the evidence and a recommendation. **No paper was edited**: §7 lists the edits
the choice needs.

The measurement ran in the test project `trenches-enclave-e0ff2c` only. Every gcloud call passed `--project` and
`--billing-project` for that project, and also set `CLOUDSDK_CORE_PROJECT`. Neither `trenches-mainnet-3c08bc` nor
the DNS project was touched.

- **Spend:** at most **$0.005** of the $0.20 cap. That covers 0.197 e2-micro VM-hours, two 10 GB disks and one static
  address. Run 2 lasted 447.9 s, 21:11:33Z to 21:19:01Z. Try 1 (21:09:31Z to 21:10:17Z) made only the address and
  the firewall rule; GCE refused its VMs.
- **Cleanup:** everything the run made was deleted by name. That is `en1a-vm1`, `en1a-vm2` (with their boot disks),
  the address `en1a-ip` (<server ip>) and the firewall rule `en1a-allow-mac`, in both tries.
- **Read back at 21:19:16Z:** the test project holds only P3g's resources: VMs `p3g-c3` and `p3g-c3x8` (TERMINATED),
  their 7 disks, and the rules `p3g-allow-mac` and `p3g-f-allow-mac`. It has no addresses.

Tags: **D** = Google's docs or a vendor's code say it (quoted, with the URL). **M** = measured here (§3). **I** = my
inference. **UNKNOWN** = not verified.

## 0. Answer

1. **Pick (a): one reserved static IPv4 for both hosts, moved from the old VM to the new VM. DNS never changes after
   boot 1, and C19 is posted once.**
   - The move is two GCE calls: delete the access config on the old VM, then add one with the static address on the
     new VM.
   - Over three moves, clients had no answer for **10.2-12.3 s** (M).
   - A kept-alive connection that sends after the move gets a **TCP RST within one round trip (274-303 ms, 3 of 3)**.
     The client then reconnects on a fresh connection and lands on the new VM with the same certificate (M).
2. **The move runs at H6, after the new N's B16, not at H2.** Moving the address cuts the internet egress of both VMs:
   - The old VM loses all egress, because our VPC has no Cloud NAT (D + M).
   - The new VM loses egress for **~8-10 s** while its ephemeral IP is swapped for the static one. Its open outbound
     connections die (M).
   - So the old VM must have finished its seal (the release anchor final on two RPCs) before the move.
   - The new VM should take the cut while it is already serving and checked, not mid-boot.
   - Boot 2 is the one exception: it takes the address at create, because its B13 issues the first certificate by
     TLS-ALPN-01 (§5, §6 E1).
3. **Off time of a planned handover** = H2 → the new N's B16 (unchanged), **+ ~12 s for the move**, + one round trip
   for kept-alive clients.
4. **(b) is kept only as a break-glass:** a new static IP, the A records, and C19. It is for when the address cannot
   be detached, for example when the old VM's zone is down (§6 E9).
5. **Google's own movable-address feature, protocol forwarding, is better on paper but does not fit this image.** One
   API call moves it and neither VM loses egress. But our dstack OS has no Google guest agent, so it would drop that
   traffic without an image change (§4.3).

## 1. Verified facts (Google Cloud docs, read 2026-10-22 20:57-21:10Z)

`cloud.google.com` now redirects to `docs.cloud.google.com`. The URLs below are where each page landed.

| # | Fact | Source |
|---|---|---|
| F1 | One resource per static address, one external IPv4 per NIC: "Only one resource at a time can use a static external IP address." "each network interface can be assigned only one external IPv4 address and one external /96 IPv6 address range." (D) | [configure-static-external-ip-address](https://docs.cloud.google.com/compute/docs/ip-addresses/configure-static-external-ip-address), Limitations |
| F2 | A move is two calls, never one: "If the instance already has an external IP address, you must remove that address first. Then you can assign a new external IP address to the existing instance." The commands: `gcloud compute instances delete-access-config INSTANCE_NAME --access-config-name="ACCESS_CONFIG_NAME"`, then `gcloud compute instances add-access-config INSTANCE_NAME --access-config-name="ACCESS_CONFIG_NAME" --address=IP_ADDRESS`. "Don't replace IP_ADDRESS with the name of the static IP address. You must use the actual IP address." (D) | same page, "Change or assign an external IP address to an existing instance" and "Unassign a static external IP address" |
| F3 | `gcloud compute instances network-interfaces update` cannot do it. Its flags cover alias ranges, IPv6, the network, the subnet and the stack type, with no external IPv4 flag. (D) | [gcloud reference: network-interfaces update](https://docs.cloud.google.com/sdk/gcloud/reference/compute/instances/network-interfaces/update), synopsis |
| F4 | The default access-config name: "external-nat is used as the default if this flag is not provided." Older VMs may use `External NAT`, so read it first. For `--address`: "that IP address must be reserved by the project and not be in use by another resource." (D). Our VMs got `external-nat` (M) | [delete-access-config](https://docs.cloud.google.com/sdk/gcloud/reference/compute/instances/delete-access-config); [add-access-config](https://docs.cloud.google.com/sdk/gcloud/reference/compute/instances/add-access-config); `results/run-info.txt` |
| F5 | In-flight traffic: "If there is traffic routed to the external IP, after deleting the access config operation, traffic to the external IP will not reach the VM anymore." Nothing else about open TCP connections is documented; §3 measures it. (D) | delete-access-config reference, DESCRIPTION |
| F6 | A static address stays with a stopped VM and is freed by deleting the VM: "Google Cloud considers a static external IP address as in use if it is associated with a VM instance whether the instance is running or stopped. If the instance is deleted or if the IP address is dissociated from the instance, Google Cloud considers the static IP address as not in use." "You can also unassign the IPv4 or IPv6 address by deleting the instance." "Deleting an instance doesn't automatically release a static external IP address." An ephemeral address is different: "In general, an ephemeral IP address is released if you stop or delete the resource." (D) | [network pricing](https://cloud.google.com/vpc/network-pricing), "In use or not"; configure-static page, "Unassign" and "Release" |
| F7 | VM state: the docs name no state limit on `deleteAccessConfig` or `addAccessConfig`. §3 ran them on RUNNING and TERMINATED VMs, and on a VM being deleted: all worked (M) | §3.4 |
| F8 | No Confidential VM or TDX limit on access configs is documented. The TDX limit that matters here is maintenance: "Live migration for Confidential VM instances is supported on N2D and C3D machine types running AMD SEV. All other Confidential VM instances don't support live migration, and must be set to stop and optionally restart during a host maintenance event." (D) | [live-migration-process](https://docs.cloud.google.com/compute/docs/instances/live-migration-process), Limitations |
| F9 | C3 VMs get maintenance notices. "You can view notifications for an instance's upcoming maintenance event only if the instance uses a machine type from one of the following machine families: … C3 …". The read is `gcloud compute instances describe VM --zone=Z --format="yaml(resourceStatus.upcomingMaintenance)"`. Notice periods: "For disruptive maintenance, Compute Engine provides a minimum of 7 days notice for most instances", but "Unscheduled or emergency maintenance events … can occur with shorter or no advance notice." (D) | [monitor-plan-host-maintenance-event](https://docs.cloud.google.com/compute/docs/instances/monitor-plan-host-maintenance-event) |
| F10 | IAM. `deleteAccessConfig` needs `compute.instances.deleteAccessConfig`. `addAccessConfig` needs `compute.instances.addAccessConfig` and `compute.networks.useExternalIp` or `compute.subnetworks.useExternalIp`. For the static address itself: "Authorization requires the following IAM permission on the specified resource natIP: compute.addresses.use". The page's role: "Compute Instance Admin (v1) (roles/compute.instanceAdmin.v1)". The test project's owner account had all of these (M) | [REST addAccessConfig](https://docs.cloud.google.com/compute/docs/reference/rest/v1/instances/addAccessConfig); [REST deleteAccessConfig](https://docs.cloud.google.com/compute/docs/reference/rest/v1/instances/deleteAccessConfig); configure-static page, "Required roles" |
| F11 | Without an external IP, a VM reaches the internet only through Cloud NAT: "With Public NAT, VM instances that don't have external IPv4 addresses can communicate with IPv4 destinations on the internet." In the docs' example, a VM in a subnet with no NAT gateway "cannot access the internet because no Cloud NAT gateway applies to any IP address range of that subnet." An external IP wins over NAT: "The existence of an external IP address on an interface always takes precedence and always performs one-to-one NAT, without using Public NAT." (D) | [Public NAT](https://docs.cloud.google.com/nat/docs/public-nat), Specifications and the translation example |
| F12 | Our VPC has no Cloud NAT: `gcloud compute routers list` in the test project gave 0 items at 20:54Z, so `p3g-net` has no router and no NAT. Both VMs' egress probes failed for as long as each VM had no address (§3.3) (M). The mainnet project was not read (out of bounds). 08 EN2 gives it "its own VPC with only the ingress it needs", and no step makes a router (I) | §3.3 |
| F13 | Price (USD; the billing account pays in VND at Google's conversion). The pricing page: "Static IP address (assigned but unused) $0.01 / 1 hour"; "Static and ephemeral IP addresses in use on standard VM instances $0.005 / 1 hour"; "You are not charged for static external IP addresses that are assigned to forwarding rules." The live Cloud Billing catalog (read 21:09:50Z, service `6F81-5844-456A`): "Static Ip Charge in Virginia" $0.011/h (SKU `EC8C-567B-4075`, first hour free); "External IP Charge on a Standard VM" $0.005/h (SKU `C054-7F72-A02E`). (D) | network pricing, "External IP address pricing"; Cloud Billing catalog API |
| F14 | Google's own movable address is protocol forwarding: "Provide an IP address which can be moved from one instance to another by either changing the VM referenced by the target instance object or by changing the target instance referenced by the forwarding rule." It "delivers packets while preserving the destination IP address of the forwarding rule". The guest accepts them only because Google's agent sets it up: "the guest agent creates a local route for the associated forwarding rule IP address"; without the agent "you must manually add local routes". A regional forwarding rule costs "$0.025 / 1 hour" (the first 5). (D) | [protocol forwarding](https://docs.cloud.google.com/load-balancing/docs/protocol-forwarding); [known issues](https://docs.cloud.google.com/compute/docs/troubleshooting/known-issues) (Dynamic NICs); network pricing, "Load balancing and forwarding rules" |
| F15 | Google discourages API-moved addresses for failover: "Using Alias IP addresses that move between VM instances is discouraged as a failover mechanism because it doesn't meet high availability requirements. In certain failure scenarios, like a zonal failure event, you might not be able to remove an Alias IP address from an instance." (D). An access config depends on the same API in the same way (I) | [patterns-for-floating-ip-addresses-in-compute-engine](https://docs.cloud.google.com/architecture/patterns-for-floating-ip-addresses-in-compute-engine) |
| F16 | dstack OS v0.6.1 runs no Google guest agent. Its network is systemd-networkd with DHCP (`os/mkosi/mkosi.skeleton/etc/systemd/network/20-wired.network:5`, `DHCP=yes`), and `google-guest-agent` appears nowhere in the release source (0 files). So our CVM's kernel would drop traffic sent to a forwarding-rule address unless the image added the local route (D from the source + I) | `proofs/p3g/vendor-dl/dstack-src-v0.6.1` (P3g's sha256-checked download) |
| F17 | Node's HTTP client waits long by default: undici's `headersTimeout` and `bodyTimeout` "**Default:** `300e3`" ms. That is the doc of undici 8.11.2. Node 24.22.1 bundles undici 7.30.1 (`process.versions`), and the same defaults there are an inference (I) | undici 8.11.2 `docs/docs/api/Client.md:44-51` (read in the UNRLZD repo's `node_modules`, read only) |

## 2. The setup

`measure.sh` (the orchestrator), `vm-startup.sh` (both VMs) and `client.py` (the Mac). `analyze.py` turns `results/`
into `results/summary.json`.

**VMs.**
- Two e2-micro VMs, Debian 12, in us-east4-a on the existing `p3g-net` / `p3g-subnet`. No service account, labels
  `lane=en1a`, tag `en1a`.
- VM1 was created on the static address `en1a-ip`. VM2 was created with an ephemeral IP, as a new CVM has at H1.
- e2 refuses `--maintenance-policy=TERMINATE` ("e2 instances do not support onHostMaintenance=TERMINATE unless they
  are preemptible", try 1). Run 2 therefore used e2's default.
- The access-config calls take no maintenance or confidential-compute input, so a TDX VM should move the same way.
  This is not measured on TDX (I).

**Firewall.** One rule allowed tcp 8080 from the Mac's IPv4 only (the Mac IP is masked as `<mac-ip>` in `results/`).

**Each VM ran:**
- an HTTP/1.1 keep-alive responder: `GET /` returns its hostname; `GET /sse` sends one line a second, like the
  market-data SSE; `GET /egress` returns its egress log;
- an egress probe once a second to `connectivitycheck.gstatic.com:80`, both on a fresh connection and on one kept-alive
  connection.

**The Mac's client probes against the static address.** The Mac is about 270 ms from us-east4 (one round trip).

| Probe | What it is |
|---|---|
| A | A fresh connection each second, like curl in a loop |
| B | One kept-alive connection with a GET each second; it reconnects after an error |
| C | A kept-alive connection idle across the move, then one GET once the new VM answers |
| D | A kept-alive connection that sends one GET at the instant the move starts (90 s wait) |
| E1 | An SSE stream with no TCP keepalive |
| E2 | An SSE stream with TCP keepalive at 10 s |

Timeouts were 2 s for A and B, so the edges of each gap are known to within 1-2 s.

## 3. Measurement (one run; one sample per case)

### 3.1 The three moves

Times are seconds from the start of each move. "Gap" = probe A's first answer from the new VM minus its last answer
from the old VM. Probe B agrees to within 0.3 s.

| Move | gcloud calls (s) | Calls done at | Last old answer | First new answer | **Gap** | Errors in the gap |
|---|---|---|---|---|---|---|
| 1: VM1 → VM2, as at a handover (VM1's delete ∥ VM2's ephemeral delete, then the add) | delete 8.95 ∥ 9.70, add 7.63 | 17.37 | 6.96 | 19.24 | **12.3** | 5 timeouts (no RST, no refusal) |
| 2: VM2 → VM1, a rollback (delete, then add) | delete 6.40, add 6.30 | 12.75 | 4.93 | 15.18 | **10.2** | 4 timeouts |
| 3: old VM dead: VM1 stopped (`stop` 19.03 s), then its access config deleted while TERMINATED, the add on VM2 | delete 4.41 (TERMINATED), add 6.65 | 11.12 | −20.69 (VM1 went dark ~3 s into the stop) | 13.72 | **13.7 after the move began** (34.4 from VM1's death) | 16 timeouts |

What these show:
- The data plane runs about 2 s ahead of a delete call's return and about 2 s behind an add call's return. So the gap ≈
  the calls' wall time.
- The gcloud calls took **4.4-9.7 s** each (8 calls).
- During a gap, new connections and requests time out, because the SYNs are dropped. They are not refused.

### 3.2 What clients on open connections saw (M)

| Probe | Move 1 | Move 2 | Move 3 |
|---|---|---|---|
| C: idle kept-alive, sends after the move | RST in 274 ms | RST in 303 ms | RST in 276 ms |
| D: sends as the move starts | answered by VM1 in 534 ms (the old VM still serves for the first ~5-7 s) | RST in 238 ms (the connection was VM1's; the address was on VM2) | answered by VM2 after 20.3 s. The connection had been opened to VM2, and the address had come back to it: a connection survives a there-and-back move |
| E1: SSE, no keepalive | RST 26.6 s in (7.3 s after the first new answer) | RST 15.8 s in (0.6 s after) | RST 18.4 s in (4.7 s after) |
| E2: SSE, keepalive at 10 s | RST 25.5 s in | RST 17.3 s in | keepalive timeout 24.8 s in |

Each probe reconnected at once and was answered by the new VM within 2.5 s of its error.

What these show:
- **A client with something to send learns of the move in one round trip** (RST from the new VM, which does not know
  the connection). This is the kept-alive OHTTP connection to REQ_HOST: its next request fails at once and the retry
  reaches the new VM.
- A read-only stream got a RST 0.6-7.3 s after the new VM first answered in 5 of 6 samples. The cause is not
  established. I: a retransmission or ACK of the old flow reaches the new VM, which resets it. A client should not
  rely on it (§6 E7).
- None of the 18 samples hung beyond the probe's own limits.

### 3.3 The VMs' own egress (M, `results/egress-*.txt`)

| VM, moment | Fresh connections out | The kept-alive connection out |
|---|---|---|
| VM1, from its delete (move 1) until its address came back (move 2) | none for **164 s**: every probe timed out until the add returned | connection 1 died; connection 2 worked once the address was back |
| VM2, swapping its ephemeral IP for the static (move 1) | none from ~6.6 s to ~16.6 s (**8-10 s**), back ~0.7 s before the add returned | **connection 1 died**; connection 2 worked at once |
| VM2, with no address between move 2 and move 3 | none for **86 s** | connection 2 died; connection 3 worked after the add |

What these show:
- A VM with no external IP has no way out in our VPC (F11, F12).
- A VM whose external IP changes loses every outbound connection it had open. In Node, a pooled connection that died
  this way waits up to undici's 300 s default (F17), which is longer than X10 = 90 s (§6 E8).

### 3.4 Other checks (M)

| Check | Result |
|---|---|
| Add the static to VM1 while VM2 holds it | Refused in 4.72 s: "External IP address: <server ip> is already in-use." A move cannot be done by one add |
| A stopped VM keeps the static | After `stop`: VM1 `TERMINATED`, natIP <server ip>, the address `IN_USE en1a-vm1` |
| Delete the access config of a TERMINATED VM | OK, 4.41 s (move 3) |
| Add the static to a TERMINATED VM | OK, 4.47 s; the address read `IN_USE en1a-vm1` while VM1 stayed TERMINATED |
| Delete the VM holding the static | `instances delete` 18.89 s. The address read `IN_USE` at 12.8 s and `RESERVED` at 16.0 s (polls about every 3 s). Detaching (4.4-9.7 s) frees it faster than deleting the VM |
| gcloud | Google Cloud SDK 587.0.0, account with project Owner on the test project |

## 4. (a) vs (b), and what Google offers

### 4.1 The two options

**(a)** One reserved static IPv4 for both hosts. The access config moves from the old VM to the new VM. The A and
CAA records are written once and C19 is posted once.

**(b)** A new static IPv4 per VM. At each handover both A records and C19 change. The old address is released after
H6.

| Criterion | (a) move the address | (b) new address + DNS |
|---|---|---|
| Handover off time | H2 → B16 as today, + **~12 s** for the move (M: 10.2-12.3 s), + one round trip for kept-alive clients | H2 → B16, then the switch: TTL 60 s plus every cache in between (resolvers, the OS, the browser). The tail depends on resolvers we do not run (I) |
| Kept-alive OHTTP connections (REQ_HOST) | Next request → RST in one round trip, retry → new VM (M, 3/3) | They stay on the old VM. The UNRLZD lesson of 2026-10-22 (f3daf9e11): "A DNS move never ends client connections to the old origin". Ours is sealed and answers `not_serving` until H6, and only a close by the old VM ends them. A reconnect with a cached old address lands on the old VM again, or times out after H6 |
| SSE streams (APP_HOST) | Ended by RST shortly after the move (5 of 6) or by keepalive (M). They reconnect to the new VM | They stay on the old VM until it closes them or stops |
| DNS changes, Nov 2-9 (boots 1-8 plus any hotfix boot) | **2 A records + 2 CAA, once** (boot 1, boot 2). **0 per handover** | 2 A records per handover × 7 handovers (boots 2-8) = **14 changes**. Each must reach `expected.json` before the record changes, or the DNS watch rings IN28: pause-worthy, the owner's phone at any hour, first step the guardian pause |
| CT noise | 0 per boot: the certificate comes from store B | 0 per boot (same) |
| C19 / the exit CLI | One address for the whole deployment: posted once, right during every handover | A new address each boot: a C19 tx per boot by the new N after the switch. Until it lands, V13 names the sealed old VM |
| Egress | Both VMs lose egress at the move (§3.3). Hence the move goes after the release anchor is final and after B16 (§5) | Unaffected: each VM keeps its own address |
| Zone outage holding the old VM | The detach may be impossible (F15, I). Break-glass = (b) for that boot | Unaffected |
| Operator's power | Can move the address to any VM in us-east4 with no DNS change (§4.2) | Can point the A records anywhere (team lead runs the DNS ops script) |
| Cost (F13) | One static at $0.005/h attached (running or stopped) ≈ $3.65/month. Unattached only for the seconds of a move ($0.011/h) | One static per VM, ≈ the same. Two attached during each overlap, ≈ $0.01 more per handover. Plus 7 C19 txs (10 TGas each). Both are under $1 apart |

### 4.2 The operator's power under (a)

What the operator can do:
- Whoever holds `roles/compute.instanceAdmin.v1` in the mainnet project (F10) can attach the address to any VM in
  us-east4 at any time, including one that is not the enclave.
- No DNS record changes and no certificate is issued, so the DNS watch and the CT watch (08 §7.3) see nothing.

What stops it from being more than an outage:
- **Neither host's TLS key can be had outside the CVM.** It is derived from S inside the CVM (`"tls/<host>"`, 06a
  §1.1), so another VM cannot serve the hosts' certificates.
- **It cannot get a new certificate.** The CAA on each host allows only `letsencrypt.org` with
  `accounturi=<the enclave's account>` and `validationmethods=tls-alpn-01` (08 WB1). The ACME account key is derived
  from S too (`"acme/account"`). Changing the CAA is a DNS change, which the DNS watch catches; any issuance is in CT,
  which the CT watch catches (IN28).
- **Clients pin.** The browser takes `h_pk` from chain, never from the server (06a §3.1), so sealed requests stay
  opaque even to a host with a valid certificate. The CLI pins TLS to `/v1/pub/tls`'s quote-bound key (06a C19).

So the address in the wrong place is an outage, as a stopped VM is. The operator can already stop the VM, so (a) adds
no power. Under (b) the same person can do the same through DNS.

The one gap: neither watch sees an address moved to a VM without the key. Today the watcher would notice only as
`/v1/pub/live` failing for 10 min. A cheap fix: on every poll, the watcher compares the SPKI each host serves by name
with `/v1/pub/tls` (WB1's check) (§7, 08 §7.3).

### 4.3 What else Google's docs offer, and why not now

- **Protocol forwarding: rejected for Nov 2-9.** This is a forwarding rule → target instance (F14). It is Google's
  documented movable address: one call, `gcloud compute forwarding-rules set-target`. Each VM keeps its own address,
  so neither loses egress, and the old VM can finish its seal undisturbed. The address itself is free on a forwarding
  rule; the rule costs $0.025/h ≈ $18/month.
  - Packets arrive with the forwarding rule's address as destination. Only Google's guest agent makes the guest accept
    them, and dstack OS v0.6.1 has none (F16).
  - Making it work needs a local route in the guest's host network namespace (CAP_NET_ADMIN). That is an image or
    compose change, so a new measurement and a 06a §2.5 compose-policy question.
  - A candidate for after the hackathon, alongside the "stable edge" the UNRLZD lesson names.
- **External passthrough Network Load Balancer: rejected.** It has the same guest-route need (F14 doc's "Although the
  guest environment automatically configures local routes…") and adds health checks.
- **Proxy load balancers (Application LB, proxy NLB): rejected.** They end TLS outside the CVM, which breaks 06a §3.1
  ("TLS ends inside the CVM").
- **Cloud NAT: not needed.** It would let a VM without an address reach out (F11). Under (a) it would not save the open
  connections: the source address changes either way (F11 "takes precedence") (I). It would add a router, ~$0.0014/h
  per VM, $0.005/h per NAT IP and $0.045/GiB (network pricing, Cloud NAT).

## 5. The recommendation, step by step

**Boot 1** (the bootstrap, EN2, Nov 2 ~13:00Z):
- Reserve the regional static address in us-east4 once, in the mainnet project.
- Create the bootstrap VM with `--address=<STATIC_IPV4>`.
- team lead's DNS ops script writes the A records on both hosts with B1's EN3 (paper 10 §3.3 Nov 2). The address never
  changes after this.
- The bootstrap issues no certificate (06a §3.1: "The bootstrap has no store B and gets none").

**Boot 2** (I0b, EN10, Nov 3 ~02:30Z). It issues the first certificate at its B13 by TLS-ALPN-01. 06a §3.1: "Only a
boot that holds the lease (from B13) issues or renews"; "It issues when store B holds no valid chain for a host; until
then that host serves nothing". So boot 2 must hold the address before B13:
1. Detach the address from the bootstrap VM, which never served: `delete-access-config` on it.
2. Create boot 2's VM with `--address=<STATIC_IPV4>`. It has no ephemeral IP and no move mid-boot.
3. The CAA goes in after boot 2 holds both certificates (paper 10 §3.3 Nov 3, unchanged).

**Boots 3-8, the hotfix boot, DR5's new VM, HL1, IN14, IN27 and IN30:**
- The new VM is created with an ephemeral IP (EN2's default, no `--address`).
- The operator reaches it on that IP with SNI = each host for the quote check and the B8 upload, as P3g did.
- **The address moves at H6, after B16.** 06a §6.2 H6 becomes the table below.

| H6 | Who | Action |
|---|---|---|
| H6a | New | B14-B16 |
| H6b | Operator | Read-only checks: (1) V3 `active_n` = the new N on two RPCs, and V11's last anchor is newer than the old N's release anchor; (2) on the new VM's ephemeral IP, for both hosts: WB1's quote and SPKI check and `/v1/pub/live` `serving`; (3) the old VM's `status` reads `sealed: true`; (4) the address reads `IN_USE <OLD>`; (5) `upcomingMaintenance` on the new VM is clear for the next hour (F9) |
| H6c | Operator | The move (commands below) |
| H6d | Operator | WB1's check on both hosts by name (the served SPKI = `/v1/pub/tls`); the address reads `IN_USE <NEW>`. Then stop and delete the old CVM |

Off time: H2 → B16 (as now), + ~12 s, + one round trip.

**The commands** (placeholders in `<>`; read the access-config name first, F4):

```sh
P=<MAINNET_PROJECT>; R=us-east4; ADDR=<ADDRESS_NAME>; IP=<STATIC_IPV4>
OLD=<OLD_VM>; ZO=<OLD_ZONE>; NEW=<NEW_VM>; ZN=<NEW_ZONE>
g() { CLOUDSDK_CORE_PROJECT=$P gcloud "$@" --project="$P" --billing-project="$P" --quiet; }
# H6b(4): expect "IN_USE  <OLD>"
g compute addresses describe $ADDR --region $R --format='value(status,users.map().basename().list())'
# expect "external-nat  <new VM's ephemeral IP>"; use the name it prints
g compute instances describe $NEW --zone $ZN \
  --format='value(networkInterfaces[0].accessConfigs[0].name,networkInterfaces[0].accessConfigs[0].natIP)'
g compute instances describe $NEW --zone $ZN --format='yaml(resourceStatus.upcomingMaintenance)'
# H6c: both deletes at once (measured 9-10 s), then the add (measured 6.3-7.6 s)
g compute instances delete-access-config $OLD --zone $ZO --access-config-name=external-nat & a=$!
g compute instances delete-access-config $NEW --zone $ZN --access-config-name=external-nat & b=$!
wait $a; ra=$?; wait $b; rb=$?
[ $ra = 0 ] && [ $rb = 0 ] || echo "a delete failed: read the address and both VMs before anything else (E5)"
g compute instances add-access-config $NEW --zone $ZN --access-config-name=external-nat --address=$IP
# H6d: expect "IN_USE  <NEW>", then WB1's check on both hosts by name
g compute addresses describe $ADDR --region $R --format='value(status,users.map().basename().list())'
```

Who runs it:
- The operator, from the Mac, with the owner's gcloud account, which has Owner on the mainnet project. The roles needed
  are in F10.
- It belongs in `scripts/deploy/`'s EN2 builder with its project guard (paper 10 §1.1, L5). It becomes a "move" step
  next to `create`.
- team lead's DNS ops script no longer runs at a handover.

## 6. Edge cases

| # | Case | What happens, and the rule |
|---|---|---|
| E1 | Boot 2's first issuance | TLS-ALPN-01 must reach boot 2 at its B13, so boot 2 holds the address from create (§5). Later boots find the chain in store B and issue nothing. At their B13 they renew only a chain with less than a third of its lifetime left (06a §3.1). A Let's Encrypt chain issued Nov 3 gets there ≥ 30 days later (I: 45- or 90-day chains), after the beta ends Nov 19. If a renewal ever falls before H6c, the challenge reaches the sealed old VM and fails; the next try is 12 h later, while the chain is still valid |
| E2 | The old VM is dead (crashed, maintenance-terminated, lost: IN14, IN30) | A TERMINATED VM keeps the address, and the detach works on it (M: 4.41 s). If it was deleted, the address is already RESERVED (M: 16 s after the delete began): just add. Clients time out from the old VM's death until the add (M: 34.4 s, including a 19-s stop), so move as soon as H6b passes. If the old VM died before its release anchor was final, H3's crash case applies (X10 + X9), as now |
| E3 | The new VM fails before H6c (no B16, or B13 halts) | The address never moved and stays on the sealed old VM. NI4's rollback (a new VM of the previous image) boots on an ephemeral IP, and the address moves from the old VM to the rollback VM at its H6. Nothing to undo |
| E4 | The new VM fails after the move | The address stays on it. The rollback VM takes it at its own H6, from a RUNNING or a TERMINATED VM (both measured). **Never move it back to the old VM**: that VM is sealed and answers only `not_serving`. A connection that comes back to its own VM does survive (D, move 3), but that buys nothing |
| E5 | The move fails halfway | Read the address's `status,users` before every retry: a call whose answer was lost may have worked (the lesson "look the tx up by hash before calling a send failed").<br>• Delete on the old VM fails: nothing has moved; retry. If the zone is down, see E9.<br>• Delete on the new VM fails: it keeps its ephemeral IP; retry.<br>• The add fails after both deletes: nobody serves, and **the new VM has no egress at all** (§3.3), so its lease lapses after X10 = 90 s. Retry the add up to 3 times within ~30 s. If it still fails, put an ephemeral IP back on the new VM (`add-access-config` without `--address`) so it keeps its lease, then take E9's path |
| E6 | A maintenance event mid-handover | TDX VMs do not live-migrate. A maintenance stops them, and every stop counts one vTPM try (F8; P3G-F).<br>• Old VM: E2.<br>• New VM before H6c: its ephemeral IP is released at the stop (F6). If it restarts, read its new ephemeral IP again before H6b.<br>• New VM after H6c: it keeps the address (M).<br>Read `upcomingMaintenance` on the old VM before NI4 and on the new VM at H6b. C3 VMs get at least 7 days' notice of scheduled maintenance but may get none for an emergency (F9) |
| E7 | Clients during the gap | New connections hang on SYN retries; they are not refused (M). A browser connect started in the gap succeeds on the SYN retry after the add (I: TCP backoff of 1, 2, 4, 8 s).<br>A request on a kept-alive connection gets a RST in one round trip (M). The 06b client should retry once on a fresh connection after a network error. Retrying with the same `id` is safe: 06a §3.3 "Same `id`, other digest → `replay_conflict`", and a repeat returns the stored state. Requests that reached the old VM after H2 got `not_serving` and never ran.<br>Market-data SSE: a server heartbeat every ≤ 15 s, with a client reconnect after two missed beats, covers the one sample that ended by keepalive rather than RST (I). Whether Chrome itself retries a POST after a RST on a reused connection: UNKNOWN; the app's retry covers it |
| E8 | The new VM's own outbound connections at H6c | Every pooled outbound connection (NEAR RPCs, B2, 1Click, Intel PCS) dies when its external IP changes (M, §3.3). With undici's 300 s defaults (F17) a request on a dead connection outlives X10 = 90 s and the new writer loses its lease. **Rule:** every outbound call in the core has a timeout well under X10 (≤ 15 s) and retries on a fresh connection, and a NEAR send is looked up by hash before it is resent. The cut lasts ~8-10 s (M) |
| E9 | The address cannot be detached (the old VM's zone is down, F15) | Break-glass (b) for this boot. Two ways to get the new address:<br>• promote the new VM's ephemeral IP to static: `gcloud compute addresses create <NAME> --addresses=<EPHEMERAL_IP> --region us-east4` ("promote existing ephemeral external IP addresses", F1 page intro);<br>• or reserve a new static and attach it.<br>Then team lead's DNS ops script writes `expected.json` first, then both A records (TTL 60 s), and the active N re-posts C19. The old address is released only after the zone recovers and the old VM is deleted, and its records are removed the same day (WB1's existing rule) |
| E10 | Both hosts | One address serves APP_HOST and REQ_HOST: a NIC has one external IPv4 (F1), and 06a §3.8 row 1 already puts both on one CVM. Each host keeps its own certificate with no shared name, so browsers do not coalesce them, even on one IP (06a §3.8 row 1). Both move in the one move |
| E11 | The exit CLI's endpoint (C19, V13) | Under (a), V13 names the right address across every boot, so the CLI sees what a browser sees: `not_serving` or the ~12 s gap during a handover, then the new VM.<br>C19 needs posting **once**, by boot 2's N (the first serving N) after B16. The value must come from a pinned input, not from the VM's current access config: boots 3+ still hold their ephemeral IP at B16. Options for 06a: the reserved IPv4 in the sealed blob (its hash is on chain) or in the measured compose. Re-post only at E9.<br>A dead-man restart runs in another project, which cannot hold our address, so it posts its own IPv4 (06a §2.7, unchanged) |
| E12 | Losing the address | A released static address is gone for good, and another customer may receive it. Only the owner's account holds Owner in the mainnet project. Scripts delete addresses only by an `en1a-`/test name. Never run `addresses delete` on the production address. I found no deletion protection for addresses in the pages read (UNKNOWN) |
| E13 | Firewall | The production VPC must allow tcp 443 from 0.0.0.0/0 to the CVM (and the operator's B8 upload path). That rule applies by tag to whichever VM holds the address, so a move needs no firewall change (M: one tag-based rule served both VMs) |

## 7. Edits the choice needs (not made)

Line numbers are as read at 2026-10-22 21:25Z (HEAD `3572f02` plus the working tree): 06a v1.71, 08 v1.53, 10 v1.59.
Other lanes were editing these files during this lane, so find each site by its quoted text.

**06a**

| Line | Now | Edit |
|---|---|---|
| 350 (C19) | "Stores the serving VM's static IPv4 (§3.1)" | The reserved static IPv4. Posted once, by boot 2's N after B16, from a pinned input (the sealed blob or the compose); never from the VM's current access config. Re-posted only after a break-glass address change (E9, E11) |
| 376 (V13) | — | Unchanged; note that it is stable across handovers |
| 918-924 (§3.1, hosting bullet) | "how the address moves at a handover (H1-H6): `[EN1: …]`" and "while the hosts move to it at H2 (§6.2)" | One reserved static IPv4 for both hosts. The operator moves it (detach from the old VM, attach to the new) at H6 after B16. DNS and CAA never change at a handover. A new rule: every outbound call in the core times out ≤ 15 s and retries on a fresh connection, because the new VM's external IP changes at H6 (E8) |
| 2466-2469 (§5.5, lease) | "at a new VM the hosts must also move to it at H2 (§6.2) … `[EN1: …]`" | "+ the address move at H6, ~12 s (EN1A: 10.2-12.3 s, three moves)" |
| 2559-2561 (§6.2 prose) | "At a new VM both hosts move to it at H2 … `[EN1: …]`" | "at H6, after B16"; the measured ~12 s; boot 2 holds the address from create (E1) |
| 2568 (§6.2 H6) | "B14-B16. The operator stops the old CVM" | H6a-H6d of §5 |
| 2628 (X10 row) | "`[EN1: …]`" | "+ ~12 s for the address move (EN1A)" |
| 2713 (§8 row 30) | "the address move at a handover is `[EN1: …]`" | "decided: the static address moves at H6 (EN1A)" |
| 3216, 3232 | Change-log rows | No edit (history) |

**08**

| Line | Row | Edit |
|---|---|---|
| 225 | EN2 | Boot 1 is created with `--address=<STATIC>`, and boot 2 likewise after the detach from boot 1. Every later new VM gets an ephemeral IP and receives the address at H6 (§5). "At H2 … the traffic moves to it (WB1; D4)" → "at H6, after B16 (WB1)" |
| 234 | EN10 | Replace the marker: detach the address from the bootstrap VM, then create boot 2 with it (E1) |
| 269 | NI4 | Off time = the new N serving + ~12 s. "at H2 … the traffic moves" → H6b-H6d. Rollback: the address moves to the rollback VM at its H6, never back to the sealed old VM (E3, E4) |
| 288 | WB1 | Replace "whether the static IP moves to the new VM or both A records change: `[EN1: …]`" with the move: §5's commands, order and checks. The A records (boot 1) and CAA (boot 2) are written once. Break-glass E9. The address's owner and E12 |
| 577 (HL1), 633 (IN27), 636 (IN30) | "The traffic moves to the new VM when V3 `ready_n` names the new N (WB1; D4)" | "the address moves to the new VM after its B16 (WB1 move; E2)" |
| 634 (IN28) | — | Unchanged. Add to the watcher row (784) a per-poll check that each host's served SPKI by name equals `/v1/pub/tls` (§4.2). It catches the address on a VM without the key, which no DNS or CT watch sees |
| 786 (DNS watch) | "only the ops script updates that file, at handovers" | "… at a break-glass address change (WB1 E9); a handover changes no record" |
| New incident row | — | The address stuck on a VM in a failed zone → E9 |

**10**

| Line | Where | Edit |
|---|---|---|
| 390 | §1.1 `ops/` | "what changes at a new CVM `[EN1: …]`" → nothing changes at a new CVM; the records change only at a break-glass. The move itself goes in `scripts/deploy/` (L5's EN2 builder) |
| 559-561 | §3.2 | "team lead's DNS ops script makes the DNS step at H2 … `[EN1: …]` (team lead's IP-move choice, §7 row 61)" → "the operator moves the reserved address to the new CVM at H6, after B16; DNS is unchanged (EN1A)" |
| 631 | §3.3 Nov 2 | Unchanged (boot 1's A records), plus "boot 1 is created on the static address" |
| 648 | §3.3 Nov 3 | "at H2 team lead's DNS ops script makes the DNS step on both hosts" → "boot 2 is created on the address after its detach from boot 1 (E1)"; the CAA sentence stays |
| 665, 699, 712, 721, 730, 736 | §3.3 Nov 4-10 | "the DNS step at H2 by team lead's DNS ops script" → "the address move at H6 (08 WB1)" |
| 935, 957, 967, 969, 971, 977, 983 | §5 (O5, O13, O15, O17, O23, O29) | "the DNS step … at H2" → "the address move at H6". O13's A records stay |
| 1099 | §7 row 8 | Marker → "EN1A, `proofs/en1-address-move`" |
| 1136 | §7 row 32 | "the switch … are team lead's DNS ops script" → "the address move" |
| 1157 | §7 row 61 | Done: (a) at H6, this folder, the commit |
| 1186 | §8 "DNS changes per CVM" | 0 per CVM; the risk becomes "address stuck (E9)" and "outbound timeouts (E8)" |
| 1240 | §9 item 9 | Closed by (a) |
| 1253 | §9 item 22 | "The DNS edit at H2" → "the address move at H6" |
| 36, 38, 40 | Header notes | History; no edit |

**Outside the three papers (for team lead):**
- 06b: the OHTTP client retries once on a fresh connection after a network error with the same `id` (E7). The
  market-data SSE gets a heartbeat with a client watchdog.
- 07: a test of E8, where the core survives its external IP changing mid-anchor, and a handover drill that times
  H6c.

## 8. Files and rerun

| File | What |
|---|---|
| `measure.sh` | The run. It refuses to start if `results/` holds a run or any `en1a-*` name exists, and its EXIT trap deletes exactly the four names. Run it as `./measure.sh` (~8 min) |
| `vm-startup.sh` | The VMs' responder and egress probe |
| `client.py` | The Mac's probes A-E2 |
| `analyze.py` | `python3 analyze.py results` → `results/summary.json` |
| `results/` | `steps.jsonl` (each call's start/end/rc, marks, address polls), `client.jsonl` (600 events), `egress-*.txt` (the VMs' own logs), `gcp-log.txt` (every gcloud command and its output), `run-info.txt`, `final-listing.txt`, `summary.json` |
| `results-try1/` | Try 1: GCE refused `--maintenance-policy=TERMINATE` on e2. The trap deleted the address and the rule |

Limits of this proof:
- One run, one sample per case.
- e2-micro, not a TDX CVM (§2).
- Probe resolution is 1-2 s.
- One client location (Vietnam, ~270 ms from us-east4).
- The mainnet project's VPC was not read (F12).
