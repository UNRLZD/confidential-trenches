# F3: old call arguments read back from archival RPCs

Run by prep lane PR1 on 2026-10-22 from 19:02:49Z (from `date -u`), for merge note M190 (12). Input: walkaway draft F3
("Old call arguments stay readable from archival sources (neardata, FastNEAR archival, NEAR Lake)", ASSUMED) and
04 VLT-14 ("archival access to old arguments: ASSUMED"). Read-only and keyless: no key, header or token in any request.

**Verdict: PASS.** The full arguments of a 20.9-day-old mainnet function call (3,503 bytes) came back byte-equal from two
archival RPC providers, keyless: FastNEAR archival (`archival-rpc.mainnet.fastnear.com`) and NEAR's
(`archival-rpc.mainnet.near.org`). neardata, a third keyless source, returned the same bytes. A second run with a
91.4-day-old call (2,345 bytes) passed on the same two providers. Leaves passed only as call arguments can be read back
after 14+ days, from two providers.

## Method

`archival.mjs` (no dependencies; `node archival.mjs --days 21`, then `--days 90`):
1. neardata `GET https://mainnet.neardata.xyz/v0/last_block/final` for the head, then `GET /v0/block/<h>` forward from
   about `--days` back until a chunk holds a `FunctionCall` whose base64-decoded args are 2-16 KiB. Those bytes and
   their sha256 are the reference.
2. One JSON-RPC call per provider, 1 s apart:
   ```json
   {"jsonrpc":"2.0","id":"f3","method":"tx","params":{"tx_hash":"<hash>","sender_account_id":"<signer>","wait_until":"FINAL"}}
   ```
   PASS = the provider returns the tx and the sha256 of its decoded `FunctionCall.args` equals neardata's.

Raw output: `results/2026-10-22T19-02-49-448Z.json` (run 1) and `results/2026-10-22T19-04-55-933Z.json` (run 2).

## The two transactions

| Run | Tx | Signer → receiver, method | Block, time | Age at read | Args | sha256 of args |
|---|---|---|---|---|---|---|
| 1 | `Bv7hjXuDcC9WePLNbq3qntubUKqDR8x8dvgJSSH7mk8o` | `intents.near` → `intents.near`, `execute_intents` | 218,107,654, 2026-10-01 20:50:22Z | 20.93 days | 3,503 B | `a95937a8…3482e48a` |
| 2 | `ekw87JgbWiB4ZLLDvyx5173JFkYE5URBXL4577RAzNM` | `sweat-relayer.near` → `fast-auth.near`, `sign` | 208,171,877, 2026-07-23 09:08:46Z | 91.41 days | 2,345 B | `3d2c7816…4c771542` |

Head at the read: 221,131,653 (run 1), 221,131,865 (run 2).

## Responses

| Provider | Run 1 (21 d) | Run 2 (91 d) | Notes |
|---|---|---|---|
| `archival-rpc.mainnet.fastnear.com` | **PASS**, HTTP 200, 700 ms, args 3,503 B byte-equal | **PASS**, 1,313 ms, 2,345 B byte-equal | Keyless. FastNEAR's docs (docs.fastnear.com, /auth, read 19:06Z) do not state keyless terms for the archival host; docs.near.org lists FastNEAR archival as "Paid only". It answered keyless today; a later limit is possible |
| `archival-rpc.mainnet.near.org` | **PASS**, HTTP 200, 3,722 ms, byte-equal | **PASS**, 3,558 ms, byte-equal | docs.near.org/api/rpc/providers (read 19:02Z): archival, free tier "Severely rate limited" |
| neardata `mainnet.neardata.xyz/v0/block/<h>` | reference bytes | reference bytes | Whole archival blocks with each tx's actions; keyless (180 req/min per IP, `proofs/fds15-treasury`). Needs the block height, not only the hash |
| `near.lava.build` | HTTP 410 `"This endpoint has been discontinued."` (points to gateway.lavanet.xyz) | same | docs.near.org lists Lava archival with no free tier |
| `near.drpc.org` | HTTP 408 code 30 "Request timeout on the free plan, please upgrade to paid plan" | same | Listed not archival |
| `near.blockpi.network/v1/rpc/public` | HTTP 503 code 100021 "Apikey not found" | same | Listed not archival |
| `1rpc.io/near` | -32601 "the method tx does not exist/is not available" | same | Listed not archival |
| `free.rpc.fastnear.com`, `rpc.mainnet.near.org`, `rpc.intea.rs` | no answer in 30 s (client timeout) | same | Not archival: `wait_until: FINAL` waits for a tx the node does not hold |

## What this does and does not show

- Shows: two independent keyless archival RPCs return a past call's full args, byte for byte, at 21 and 91 days.
- Does not show: how long either keeps serving keyless (no SLA read; NEAR's endpoint is rate limited), or a NEAR Lake
  read (S3, requester-pays, not tried). A reader also needs each tx's hash and signer (`tx`), or its block height
  (neardata), to find the args.
