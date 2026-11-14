# O35: the keyed 1Click run (FP-3 and MS-14)

Status 2026-10-21 21:37Z: **done, run by CO** with the partner key from `~/.confidential-trenches/env` (loaded only into
the child shell; the key is redacted from every output; gitleaks rc 0 on each record). No money moved: dry quotes and
status reads only. Records: `results/2026-10-21-fp3.json` (FP-3 alone, 21:25:17Z) and `results/2026-10-21.json`
(the full run, 21:25:38Z to 21:36Z). Tags: M measured, D docs.

## FP-3: PASS

- M: a keyed dry `CONFIDENTIAL_INTENTS → INTENTS` unshield quote (the FD-P-05 §2 body, 1 USDC, `dry: true`) answers
  HTTP 201: `amountIn` 1000000, `amountOut` 1000000, `minAmountOut` 990000, `refundFee` 0, `withdrawFee` 0,
  `timeEstimate` 10 s, `confidentiality: "basic"`, `appFees: []`, signed `ed25519:…`.
- M: the same request without the key answers 401 "User authentication is required for confidential intent quotes"
  (`results/2026-10-21-fp3-nokey.json`).
- So D5's FAR unshield call works with our key (paper 10 G row 36; P11 FP-3). No re-plan.

## MS-14: PASS-NO-429 up to 20 a second

| Endpoint | 1/s | 2/s | 5/s | 10/s | 20/s | p95 at 20/s |
|---|---|---|---|---|---|---|
| `POST /v0/quote` (dry, INTENTS → INTENTS) | 60 × 201 | 120 × 201 | 300 × 201 | 600 × 201 | 1,200 × 201 | 806 ms |
| `GET /v0/status` | 60 × 200 | 120 × 200 | 300 × 200 | 600 × 200 | 1,200 × 200 | 496 ms |

- M: every response carries `x-ratelimit-limit-unauth: 1200`, `x-ratelimit-remaining-unauth` and
  `x-ratelimit-reset-unauth` (counting down from 60), even with `X-API-Key` set. No header names an authenticated
  bucket.
- M: our keyed calls draw that bucket down: at 20/s, `remaining` reached 1 at the end of the quote step and 0 at the
  end of the status step. Each step started at 1199 again, so the window is 60 s.
- So the measured ceiling is **1,200 calls per 60 s (20 a second) per bucket**, and the partner key does not lift it.
  Whether the bucket is per IP, per key or per endpoint is UNKNOWN: the steps ran one after another.
- D: the OpenAPI (v0.1.10, sha256 c70ffe58…) declares no 429 on quote or status, and names `X-API-Key` as the
  recommended partner auth (`JWT-auth` is legacy). No rate limit is published (FD-P-05 C41).

## What it means

- The beta's load (cap X5, demo traffic) is far under 1 call a second, so 20 a second is more than 20× it. The trigger
  "any 429 at under 2× the current rate" (paper 10 risk row, P11 §3.13) has not fired.
- At 5k, FD-S-03's ≈ 664 calls a second is about 33× the measured bucket. That is a scale-path item with its number,
  not a beta blocker (CO decides the client pacing in the next merge note).

## Unknown

- Per IP, per key or per endpoint for the 1,200/60 s bucket; what the 1,201st call answers.
- Whether `confidentiality: "basic"` has another level, and what it changes.
