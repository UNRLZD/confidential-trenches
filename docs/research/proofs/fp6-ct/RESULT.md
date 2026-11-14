# FP-6 CT and DNS watch latency (the first DR20): result

**Status: PASS, run 2026-10-22 09:51:51Z-10:24:13Z by the owner's paste (§7).** Prepared 2026-10-21.

Prepared on 2026-10-21 from 21:17Z to 21:44Z. Every time below is UTC and was read from `date -u` or from a log line.
Nothing in the zone was changed and no certificate was requested. This proof answers G row 39 (10 §7; P11 §6 FP-6) for
08 IN28 and DR20 once the owner has run the drill. Tags: **D** = read from a vendor doc (URL and read time),
**M** = measured here.

## 1. What matters first

1. **The free Cert Spotter plan cannot poll the zone with subdomains every 60 s.** Full-domain queries
   (`include_subdomains=true`) are limited to 10 an hour. P11 F15's "100 queries an hour" applies only to
   single-hostname queries (D2, M3). 08 §7.3 and P11 §1.3 item 12 ("every 60 s ... subdomains included") need a
   change. The watcher here polls the single drill host every 60 s and the whole zone every 450 s, at least 400 s
   (`ct-watch.mjs`). For production, team lead has two options. One: poll APP_HOST and REQ_HOST as single hostnames every
   72 s or more (2 × 50 an hour is the plan's 100), plus the zone every 6 min or more. Two: a paid plan. Either way
   IN28's bound is Cert Spotter's delay (FP-6 measures it) plus the poll period.
2. **Let's Encrypt allows 5 certificates per exact name per 7 days** (D3). The drill uses 3, and before any change it
   stops if Cert Spotter already shows more than 2 for `ctwatch-test` in the last 7 days. That rules out a rerun of the
   drill within the same week. The Nov 10 rerun is fine.
3. **Both watchers worked, read-only** (M4, M5). The DNS watch's diff path was also shown without a DNS change (M5).

## 2. Docs (D)

| # | Fact | Source | Read |
|---|---|---|---|
| D1 | Cert Spotter `GET https://api.certspotter.com/v1/issuances?domain=…`; `include_subdomains` (default false: subdomains of any depth), `match_wildcards`, `after` = an issuance `id`, which returns "issuances that were discovered by SSLMate after the issuance with the specified ID" (discovery order; repeat with the last `id` until an empty array). `expand` values: `dns_names`, `pubkey_der`, `pubkey`, `issuer` (+ `.website`, `.caa_domains`, `.operator`, `.name_der`), `revocation`, `problem_reporting`, `cert_der`. Standard fields: `id`, `tbs_sha256`, `cert_sha256`, `pubkey_sha256`, `not_before`, `not_after`, `revoked`. An empty answer carries `Retry-After`. Errors: `rate_limited` (4xx). Auth: `Authorization: Bearer <key>`. No latency figure is stated | sslmate.com/help/reference/ct_search_api_v1 | 21:17Z |
| D2 | Free "Small" plan ($0): "100 single-hostname queries / hour", "10 full-domain queries / hour", "75 queries / minute", "5 queries / second", "15 second query timeout"; limits "may be reduced during periods of high load". A full-domain query is one that returns all subdomains (`include_subdomains`). No latency figure | sslmate.com/ct_search_api/ | 21:17Z |
| D3 | Let's Encrypt: "Up to 5 certificates can be issued per exact same set of identifiers every 7 days" (refills 1 per 34 h); 50 per registered domain per 7 days; 300 new orders per account per 3 h; 5 authorization failures per identifier per account per hour. ARI renewals are exempt; staging limits are "significantly higher" | letsencrypt.org/docs/rate-limits/ | 21:17Z |
| D4 | Let's Encrypt CAA: `accounturi` limits issuance to one ACME account (form `https://acme-v02.api.letsencrypt.org/acme/acct/<id>`); `validationmethods` accepts `http-01`, `dns-01`, `tls-alpn-01`; "the CA will always respect the CAA record _closest_ to the domain name"; CAA is checked "before every certificate we issue". It does not say whether reused authorizations re-check CAA | letsencrypt.org/docs/caa/ | 21:17-21:22Z |
| D5 | lego Google Cloud DNS provider: code `gcloud`; `GCE_PROJECT`, `GCE_SERVICE_ACCOUNT_FILE` (a path), `GCE_SERVICE_ACCOUNT`, `GCE_ZONE_ID` (skips zone detection), `GCE_TTL` (default 120), `GCE_PROPAGATION_TIMEOUT` (default 180), `GCE_POLLING_INTERVAL` (default 5), `GCE_ALLOW_PRIVATE_ZONE`, `GCE_IMPERSONATE_SERVICE_ACCOUNT`, `GCE_ACCESS_TOKEN`. Example: `lego run --dns gcloud -d …` | go-acme.github.io/lego/dns/gcloud/ | 21:17Z |
| D6 | lego v5 CLI (source at tag v5.5.2, the latest release, 2026-09-23): flags go after the command (`lego run …`); `lego accounts register` registers without an order; `--account-id`, `--cert.name` (a new name always takes the obtain path, never renew), `--always-deactivate-authorizations`, `--log.format text`; the account URI is `registration.accountURL` in `accounts/<server host>/<account id>/account.json`; certificates are `certificates/<cert name>.crt` and `.key`; the log line "Validations succeeded; requesting certificates." comes before the order is finalized; `GCE_ZONE_ID` makes the provider call `ManagedZones.Get` on that zone only; `GCE_SERVICE_ACCOUNT_FILE` is read as a file path (`_FILE` suffix) | github.com/go-acme/lego `cmd/`, `cmd/internal/flags/`, `cmd/internal/storage/`, `providers/dns/gcloud/googlecloud.go`, `certificate/certificates.go`, `docs/content/migration/cli.md` | 21:17-21:22Z |

## 3. Measured (M)

| # | Fact | Evidence | Time |
|---|---|---|---|
| M1 | Delegation live: `dig NS confidential.unrealized.trade` (system resolver and 1.1.1.1) returns ns-cloud-a1 to a4.googledomains.com, with no CNAME | `dig` | before 21:17Z |
| M2 | Zone, read with gcloud as the zone's service account (`CLOUDSDK_CONFIG=proofs/fp6-ct/.gcloud`, `CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE`; the user's gcloud config untouched): dnsName `confidential.unrealized.trade.`, public, DNSSEC off, 2 record sets (NS ns-cloud-a1..a4, TTL 21600; SOA serial 1). No CAA at `unrealized.trade` (1.1.1.1) or at the child apex; `ctwatch-test` is NXDOMAIN at ns-cloud-a1. The servers' IPs are <server ip>, .34.106, .36.106 and .38.106 | `results/zone-before.json`, `expected.json` | 21:21Z |
| M3 | Cert Spotter with the key: a full-domain query answers `x-ratelimit-limit: 10`, a single-hostname one `x-ratelimit-limit: 100`. Across the runs the remaining count behaves like a bucket that refills (full-domain: 9 at 21:22Z; 9 then 8 at 21:30Z; 8 then 7 at 21:34Z; single-hostname stays at 99 when polled every 60 s). An empty answer carries `Retry-After: 3600`. Baseline: one issuance under the zone (`confidential.unrealized.trade`, not_before 2026-10-20T08:01:57Z, pubkey_sha256 `5021eff3…a776`, id 17883777060); none for `ctwatch-test` | probe headers; `results/test-ct-*.jsonl` | 21:22-21:37Z |
| M4 | **ct-watch test runs.** Run 1, 21:30:34-21:32:35Z: it stopped after 2 min because its deadline check had no slack. Fixed, then run 2, 21:34:24-21:37:25Z: 4 single-hostname polls 60 s apart (all HTTP 200, n=0), the full-domain baseline in 2 calls (the issuance above, then an empty page), crt.sh refused both times (run 1: 30 s timeout; run 2: HTTP 502 in 130 ms). Each refusal was logged and crt.sh waited 10 min; no retry loop | `results/test-ct-20261021T2130Z.jsonl`, `results/test-ct-20261021T2134Z.jsonl` | 21:30-21:37Z |
| M5 | **dns-watch test run**, 21:30:35-21:33:35Z: 4 rounds, 76 queries each (6 names × A, CAA, TXT, plus NS at the apex, × 4 servers), 0 errors, 0 differences, 129-250 ms per round. Diff path, 21:34:13Z: one round against a copy of expected.json that claims an A at `ctwatch-dns-test` and a CAA at `ctwatch-test` logged 8 differences (2 names × 4 servers), the first 80 ms after the start | `results/test-dns-20261021T2130Z.jsonl`, `results/test-dns-diffpath-20261021T2134Z.jsonl` | 21:30-21:34Z |
| M6 | A Let's Encrypt leaf (letsencrypt.org's own) has notBefore 14:34:32 and SCTs at 15:33:02.377 and 15:33:02.552: not_before is backdated by about 59 min. The drill therefore times each delay from its own issuance time (lego's exit) and from the SCTs, never from not_before. `drill-lib.mjs certinfo` reads the SCTs through openssl 3.6.4 | `openssl s_client` + `x509 -text` | 21:23-21:30Z |
| M7 | `drill.sh --plan` ran read-only (zone describe and list only) and printed the plan below. lego is not installed (Homebrew's stable formula is 5.5.2, `brew info lego`) and no ACME account exists yet | `results/plan-20261021T2140Z.txt` | 21:40Z |

## 4. The drill (`drill.sh`), as `--plan` printed it

Run 21:40Z (`results/plan-20261021T2140Z.txt`):

0. Start ct-watch and dns-watch in the background, from a fresh zone snapshot. No change is made until Cert Spotter
   answers and dns-watch's first round is clean. Stop if Cert Spotter shows more than 2 `ctwatch-test` certificates in
   the last 7 days.
1. Let's Encrypt (production): `lego accounts register … --account-id fp6-drill`, `--path ~/.confidential-trenches/fp6-lego` (chmod 700).
2. Cloud DNS: create `ctwatch-test.confidential.unrealized.trade. CAA 60 '0 issue "letsencrypt.org; accounturi=<account URI>; validationmethods=dns-01"'`,
   then wait until all four servers serve it. The run's expected.json gets the CAA (the drill's own change).
3. Cloud DNS, out of band (not in expected.json): create `ctwatch-dns-test.confidential.unrealized.trade. A 60 192.0.2.1`,
   wait for dns-watch's detection (at most 300 s; the pass line is 120 s), then delete it.
4. Let's Encrypt: certificate 1 of 3 for `ctwatch-test.confidential.unrealized.trade` by DNS-01
   (`lego run --dns gcloud --cert.name fp6-<run>-1 --always-deactivate-authorizations`, `GCE_ZONE_ID` = the zone).
   lego adds and removes `_acme-challenge.ctwatch-test…` TXT.
5. Certificate 2, at least 10 min after 1. 6. Certificate 3, at least 10 min after 2.
7. Cloud DNS: delete the CAA. 8. Snapshot the zone again and diff it with the one before (SOA reported, not compared).
9. ct-watch runs until Cert Spotter shows all three, by both single-hostname and full-domain queries, for at most 4 h
   after the last issuance. 10. Delete the three certificate private keys; write `results/drill-<date>.json`.

Error rule: one retry in all across steps 2-6. A create is re-listed before its retry. A lego run that reached
"Validations succeeded; requesting certificates." is never retried, and the drill never asks for a fourth
certificate. On any exit, the drill removes what it added and still finds (A, CAA, lego's TXT), and only when the
record still holds the drill's own value. Only these three names can be written (`allowed()`). The parent
`unrealized.trade` and every other zone are never touched. gcloud and lego output pass through `redact()`, so no env
value reaches the screen or `results/`.

The result file gives, per certificate: issued time, SCTs, serial, pubkey_sha256, and the first-seen time with the
delay for each source (Cert Spotter single-hostname, Cert Spotter full-domain, crt.sh). It also gives the max delay
per source, the DNS test (added, detected, delay, pass ≤ 120 s), the before/after zone comparison, and DR20's three
first-run checks.

## 5. Files

- `ct-watch.mjs`, `dns-watch.mjs`: the watchers. `drill-lib.mjs`: shared helpers (expected.json, zone diff, cert facts, report).
- `drill.sh`: the drill and `--plan`. `PASTE.md`: the owner's one paste, its run time, what is permanent and what is cleaned up.
- `expected.json`: from today's `results/zone-before.json`. The drill builds its own from a fresh snapshot.
- `.gcloud/`: gcloud's scratch config (gitignored). The drill deletes its access-token file on exit.
- Not installed here: lego (the paste's first step). the build queue was not needed: every job was a light network read.

## 6. Unknown

1. How fast Cert Spotter shows a new certificate. The drill measures this (P11 §1.5 item 2).
2. Whether crt.sh answers during the drill: it refused in both test runs (timeout, 502), as in P11 F17.
3. Whether the service account can write. Only reads were run (describe, list); O33 granted DNS admin on the zone.
   Step 2 is the first write; if it fails, the drill stops before any certificate.
4. The exact shape of Cert Spotter's rate-limit window. The remaining counts look like a refilling bucket (M3), but the
   API gives no reset header. The drill uses 9 full-domain calls an hour (one call of headroom) and 60 single-hostname calls.
5. Whether Cloud DNS raises the SOA serial on `record-sets create`. The drill reports SOA before and after; the DNS
   watch does not rely on it.
6. lego 5.5.2 has not been run on this Mac. Its flags were read from the v5.5.2 source (D6), and the drill checks for
   major version 5 before any change.
7. Let's Encrypt's current 7-day count for `unrealized.trade` (50 a week, shared with UNRLZD's certificates) was not
   read, since a full-domain query on it costs one of the 10 an hour. The drill adds 3.

## 7. The drill (2026-10-22, the first DR20): PASS

Run by the owner's paste from 09:51:51Z to 10:24:13Z; written up by team lead at 16:00Z from `results/drill-2026-10-22.json`
and `results/drill-20261022T0951Z/` (M). Three certificates for `ctwatch-test.confidential.unrealized.trade`, 0 retries,
no stop; the zone after equals the zone before; the certificate keys were deleted.

| # | Issued | Cert Spotter, single host: seen after issue | Cert Spotter, zone: seen after issue | crt.sh |
|---|---|---|---|---|
| 1 | 09:53:18Z | 754.4 s | 814.4 s | not seen (2 answers, 4 refusals) |
| 2 | 10:03:36Z | 676.1 s | 646.0 s | not seen |
| 3 | 10:13:57Z | 595.0 s | 475.0 s | not seen |

- **IN28's bound from this run:** a new certificate for our host shows on Cert Spotter within **754.4 s** (single-host
  poll, 60 s period included) and **814.4 s** (zone poll, its period included). Three samples, one morning: a floor for
  the bound, not a distribution. The Nov 10 rerun adds three more.
- **DNS watch:** a test record added at 09:52:01Z was seen at 09:52:52Z on `ns-cloud-a1`, **50.7 s** (pass: within
  2 min). 24 rounds of 76 queries; 17 single-query timeouts (`ETIMEOUT`) over the run, none on the detecting round.
- **Rate limits seen:** Cert Spotter refused 4 of 17 single-host queries (the free plan's limits, §1 item 1); crt.sh
  answered 2 and refused 4, so it is no watcher we can count on.
- **G row 39** (10 §7) is done with this run; 08 IN28 and DR20 take 754.4 s and 814.4 s.
