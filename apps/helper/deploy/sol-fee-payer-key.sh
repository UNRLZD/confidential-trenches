#!/usr/bin/env bash
# Makes the mainnet Solana pool's fee payer key on the helper's server (card helper-sol-fee-payer-mainnet), as
# withdraw-relayer-key.sh makes the withdrawal relayer's. Run on the server, from the checkout redeploy.sh keeps:
#   apps/helper/deploy/sol-fee-payer-key.sh
# The order, which it prints again at the end with the commit and the address filled in:
#   1. apps/helper/deploy/redeploy.sh <a commit that has this file>, first: this step runs in the running helper's image
#      (ct-helper:<HELPER_COMMIT>) and reads that image's own solanaFeePayerLowMark, so an image from before this card is
#      refused (exit 7); the helper runs as before meanwhile, its mainnet pool off while the four lines are absent;
#   2. this step;
#   3. apps/helper/deploy/redeploy.sh <the same commit> again (the same commit keeps its release), so the helper starts
#      with the four lines;
#   4. the owner sends the printed SOL to the printed fee payer address;
#   5. once it has landed: the helper's live checks, helper-sol-fee-payer-mainnet among them.
# In order, stopping at the first failure with deploy/.env unchanged:
#   0. takes deploy/.env.lock, the lock the three key steps share (this one, withdraw-relayer-key.sh and
#      bind-relayer-key.sh, each of which replaces deploy/.env whole), held from the check below through the rename and
#      removed at the end, whatever the end: a second run while one holds it refuses (exit 9), so two runs never both
#      pass the check and both rename (two addresses printed, one key kept). A folder (mkdir is atomic on every
#      filesystem; flock is not on macOS, where the tests run). A run killed with SIGKILL leaves it, and, when killed
#      after step 4 began, its temporary file deploy/.env.solfee.XXXXXX (mode 600, which may hold a new key nobody was
#      shown): once no run is going, remove the folder and that file;
#   1. refuses (exit 3) when any line of deploy/.env sets one of the four names below (redeploy.sh's lines_of matcher),
#      so a second run never replaces a key the fee payer already holds SOL on; when deploy/.env names no image
#      (HELPER_COMMIT, exit 6); when the pool's mainnet deploy record, contracts/pool-solana/deployments/mainnet.json, does
#      not exist (exit 4);
#   2. reads, inside the helper's own image (ct-helper:<HELPER_COMMIT>, a read-only container that holds no secret), the
#      record (exit 4 unless it is mainnet's genesis, a program id and that program's pool account, the kit's
#      solanaPoolAccount) and the Rent sysvar on the two RPCs below (the kit's readSolanaRent: both must agree, exit 5
#      when they do not answer or agree), and from that rent the kit's solanaPoolFee and the helper's
#      solanaFeePayerLowMark (src/pool/solana.ts; exit 7 when the image has none: redeploy first, step 1). The helper's start holds POOL_SOLANA_FEE_MAINNET to that same fee for
#      the rent it reads (M362 (3)), so the line is written as the kit computes it, never typed;
#   3. makes one ed25519 key inside the same image with no network (node:crypto, --network none, read-only) and checks,
#      with the image's own code, that the helper's start takes the four lines (src/pool/solana.ts
#      solanaPoolSendersFromEnv: the key parses with feePayerKey, the program is one program id, the RPCs two different
#      URLs, the fee a whole number of lamports) and serves the record's pool;
#   4. writes deploy/.env again whole (a mode 600 temporary file beside it, then one rename), every line kept and these
#      four added:
#        POOL_SOLANA_PROGRAM_MAINNET=<the record's program_id>
#        POOL_SOLANA_FEE_PAYER_KEY_MAINNET=<base58 of the 32-byte seed and the 32-byte public key, the Solana CLI's keypair>
#        POOL_SOLANA_FEE_MAINNET=<solanaPoolFee at the rent read, lamports>
#        POOL_SOLANA_RPCS_MAINNET=<the two RPC URLs, comma apart>
# The secret goes from the key maker's stdout into the temporary file only (renamed to deploy/.env): never to the
# terminal, argv, the environment or any other file. Both containers run with --log-driver none, so docker keeps no copy
# of their stdout. It prints the program, the pool, the rent, the fee, the fee payer's address and the SOL it needs,
# all public.
# The RPCs: the two keyless mainnet providers the helper's trade reads and the pool live checks use
# (src/data/solana/trades.ts TRADES_RPCS); SOL_FEE_PAYER_RPCS in this shell replaces them ("<a>,<b>", two different
# https URLs). The fee payer holds gas only; the Jito tip comes from the pool, and on mainnet a tag 3 that fails on chain
# never lands (bundle-only, M362 (4), M369).
# On average a release pays the fee payer back more than it fronts: one that opens a state-tree page (deposits fill those
# pages too, deposit.rs:28, so it comes about once in 1,024 entries, not exactly once in 1,024 releases) costs it that
# page's rent, which the 715 lamports every release leaves for it (the page reserve, M356 (5)) pay back on average.
# exit 0 done, 2 usage, 3 a name already set, 4 no or a bad mainnet pool record, 5 the rent not read, 6 no image,
# 7 the image predates this step, 9 another key step holds the lock, 1 any other failure
set -euo pipefail

NAMES=(POOL_SOLANA_PROGRAM_MAINNET POOL_SOLANA_FEE_PAYER_KEY_MAINNET POOL_SOLANA_FEE_MAINNET POOL_SOLANA_RPCS_MAINNET)
RPCS_DEFAULT="https://api.mainnet-beta.solana.com,https://solana-rpc.publicnode.com"
# The failed plain sends the funding covers past the low mark: a mainnet tag 2, or a tag 3 whose every block engine
# failed on transport, pays its two signatures and its priority even when it fails on chain (M356 (1), M362 (4)), one
# per nullifier per epoch at most. On average landed releases balance through the page reserve (above), so over time
# only failures take the balance down.
FAILED_SENDS=32
# The funding is rounded up to this many lamports (0.01 SOL).
ROUND=10000000

# The reader, run by node in the helper's image from its WORKDIR (/app/apps/helper) with the network: the RPC pair on
# stdin's first line, the deploy record after it; one line on stdout: program pool fee mark lamports-per-byte factor
# budget. It holds no secret.
read -r -d '' READER <<'JS' || true
import { pathToFileURL } from "node:url";
const own = (p) => import(new URL(p, pathToFileURL(`${process.cwd()}/`)).href);
const { readSolanaRent, solanaJsonRpc, solanaPoolAccount, solanaPoolFee, solanaPoolPriorityBudget } = await import("@blindfill/kit");
const { solanaFeePayerLowMark } = await own("src/pool/solana.ts");
if (typeof solanaFeePayerLowMark !== "function") process.exit(7);
let text = "";
for await (const c of process.stdin) text += c;
const nl = text.indexOf("\n");
const rpcs = nl < 0 ? "" : text.slice(0, nl);
let rec;
try { rec = JSON.parse(text.slice(nl + 1)); } catch { rec = null; }
const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const KEY = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
if (rec === null || typeof rec !== "object" || rec.cluster !== "mainnet" || rec.genesis_hash !== MAINNET_GENESIS || !KEY.test(rec.program_id ?? "") || !KEY.test(rec.pool ?? "")) { process.stderr.write("sol-fee-payer-key: the deploy record names no mainnet pool program; nothing changed\n"); process.exit(4); }
let pool;
try { pool = solanaPoolAccount(rec.program_id); } catch { pool = null; }
if (pool !== rec.pool) { process.stderr.write(`sol-fee-payer-key: the record's pool ${rec.pool} is not program ${rec.program_id}'s pool account; nothing changed\n`); process.exit(4); }
const urls = rpcs.split(",");
let rent;
try {
  rent = await readSolanaRent([solanaJsonRpc(urls[0] ?? ""), solanaJsonRpc(urls[1] ?? "")]);
} catch (e) {
  const why = (e instanceof Error ? e.message : String(e)).replace(/\bhttps?:\/\/[^\s/?#]+[^\s]*/g, (u) => (URL.canParse(u) ? new URL(u).host : "<url>"));
  process.stderr.write(`sol-fee-payer-key: the Rent sysvar was not read on two agreeing RPCs: ${why}; nothing changed\n`);
  process.exit(5);
}
const fee = solanaPoolFee(rent);
process.stdout.write(`${rec.program_id} ${pool} ${fee} ${solanaFeePayerLowMark(rent)} ${rent.lamportsPerByte} ${rent.factor} ${solanaPoolPriorityBudget(rent, fee)}\n`);
JS

# The key maker, run by node in the helper's image from its WORKDIR with no network: "program pool fee rpcs" on stdin;
# the four lines on stdout, the fee payer's address on stderr.
read -r -d '' MAKER <<'JS' || true
import { generateKeyPairSync } from "node:crypto";
import { pathToFileURL } from "node:url";
const own = (p) => import(new URL(p, pathToFileURL(`${process.cwd()}/`)).href);
const { feePayerKey, solanaPoolSendersFromEnv } = await own("src/pool/solana.ts");
let text = "";
for await (const c of process.stdin) text += c;
const [program, pool, fee, rpcs] = text.trim().split(" ");
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const seed = Buffer.from(privateKey.export({ format: "jwk" }).d, "base64url");
const pub = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url");
const ALPHA = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const b58 = (bytes) => {
  let n = BigInt("0x" + (Buffer.from(bytes).toString("hex") || "0"));
  let s = "";
  while (n > 0n) { s = ALPHA[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; s = "1" + s; }
  return s;
};
const sk = Buffer.concat([seed, pub]);
const key = b58(sk);
const address = b58(pub);
const lines = { POOL_SOLANA_PROGRAM_MAINNET: program, POOL_SOLANA_FEE_PAYER_KEY_MAINNET: key, POOL_SOLANA_FEE_MAINNET: fee, POOL_SOLANA_RPCS_MAINNET: rpcs };
let served;
try {
  if (feePayerKey(key).address !== address) throw new Error("the key's address is not its public half");
  const senders = solanaPoolSendersFromEnv(lines, async () => { throw new Error("no network in the key maker"); });
  served = senders.size === 1 ? senders.get(pool) : undefined;
  if (served === undefined || served.feePayer !== address || served.program !== program || served.cluster !== "mainnet") throw new Error("the helper would not serve the record's pool from this fee payer");
} catch (e) {
  process.stderr.write(`sol-fee-payer-key: the helper's start does not take the four lines (${e instanceof Error ? e.message.replaceAll(key, "<key>") : "?"}); nothing changed\n`);
  process.exit(1);
}
process.stdout.write(Object.entries(lines).map(([k, v]) => `${k}=${v}\n`).join(""));
seed.fill(0);
sk.fill(0);
process.stderr.write(`sol-fee-payer-key: fee payer ${address}\n`);
JS

# The lock and the temporary file, removed at any end: the script's own exits, a signal (HUP, INT, TERM end it through
# exit, so the EXIT trap runs), an error under set -e.
LOCK=""
TMP=""
cleanup() {
  [[ -n "$TMP" ]] && rm -f "$TMP"
  [[ -n "$LOCK" ]] && rmdir "$LOCK" 2>/dev/null
  return 0
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# deploy/.env's lines setting NAME, in any form redeploy.sh's lines_of reads
lines_of() {
  grep -E "^[[:space:]]*(export[[:space:]]+)?$2[[:space:]]*[=:]" "$1" || true
}

main() {
  if [[ $# -ne 0 ]]; then
    echo "usage: sol-fee-payer-key.sh" >&2
    exit 2
  fi
  local deploy root env record commit name tmp rpcs url
  deploy="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  root="$(cd "$deploy/../../.." && pwd)"
  env="$deploy/.env"
  record="$root/contracts/pool-solana/deployments/mainnet.json"
  rpcs="${SOL_FEE_PAYER_RPCS:-$RPCS_DEFAULT}"

  if ! mkdir "$env.lock" 2>/dev/null; then
    echo "sol-fee-payer-key: another key step holds deploy/.env.lock (a run in progress; if none is, remove the folder and any deploy/.env.solfee.* file a killed run left); nothing changed" >&2
    exit 9
  fi
  LOCK="$env.lock"
  for name in "${NAMES[@]}"; do
    # grep -q: the matching line is never captured, so not even bash -x prints it
    if [[ -e "$env" ]] && lines_of "$env" "$name" | grep -q .; then
      echo "sol-fee-payer-key: $name is already set in deploy/.env; nothing changed (the fee payer keeps its key)" >&2
      exit 3
    fi
  done
  commit="$( { [[ -e "$env" ]] && grep -E '^HELPER_COMMIT=[0-9a-f]{40}$' "$env" || true; } | head -n 1 | cut -d= -f2)"
  if [[ -z "$commit" ]]; then
    echo "sol-fee-payer-key: deploy/.env names no HELPER_COMMIT (run redeploy.sh first); nothing changed" >&2
    exit 6
  fi
  if [[ ! -f "$record" ]]; then
    echo "sol-fee-payer-key: no contracts/pool-solana/deployments/mainnet.json: the mainnet pool is not deployed, so there is no pool to carry for; nothing changed" >&2
    exit 4
  fi
  # two different http(s) URLs with no comma, space or quote in them (the kit's solanaJsonRpc takes https, or http on
  # the loopback only)
  IFS=, read -r -a urls <<< "$rpcs"
  if [[ ${#urls[@]} -ne 2 || "$rpcs" != "${urls[0]},${urls[1]}" || "${urls[0]}" == "${urls[1]}" ]]; then
    echo "sol-fee-payer-key: SOL_FEE_PAYER_RPCS is not two different URLs, comma apart; nothing changed" >&2
    exit 2
  fi
  local url_re='^https?://[^[:space:],]+$'
  for url in "${urls[@]}"; do
    if [[ ! "$url" =~ $url_re || "$url" == *[\"\'\\]* ]]; then
      echo "sol-fee-payer-key: SOL_FEE_PAYER_RPCS is not two different URLs, comma apart; nothing changed" >&2
      exit 2
    fi
  done

  local rc=0 read_line
  read_line="$( { printf '%s\n' "$rpcs"; cat "$record"; } | docker run --rm -i --log-driver none --pull never --read-only --cap-drop ALL --security-opt no-new-privileges:true \
    --entrypoint node "ct-helper:$commit" --input-type=module -e "$READER")" || rc=$?
  if [[ $rc -ne 0 ]]; then
    if [[ $rc -eq 7 ]]; then
      echo "sol-fee-payer-key: the running image ct-helper:$commit predates this step (no solanaFeePayerLowMark in its src/pool/solana.ts): redeploy.sh $(git -C "$root" rev-parse HEAD 2>/dev/null || echo '<this commit>') first; with the four lines absent the mainnet pool stays off; nothing changed" >&2
      exit 7
    fi
    echo "sol-fee-payer-key: the reader stopped (exit $rc); nothing changed" >&2
    [[ $rc -eq 4 || $rc -eq 5 ]] && exit "$rc"
    exit 1
  fi
  if [[ ! "$read_line" =~ ^([1-9A-HJ-NP-Za-km-z]{32,44})\ ([1-9A-HJ-NP-Za-km-z]{32,44})\ ([1-9][0-9]{0,18})\ ([1-9][0-9]{0,18})\ ([1-9][0-9]{0,6})\ ([12])\ ([0-9]{1,19})$ ]]; then
    echo "sol-fee-payer-key: the reader's answer is not in its form; nothing changed" >&2
    exit 1
  fi
  local program="${BASH_REMATCH[1]}" pool="${BASH_REMATCH[2]}" fee="${BASH_REMATCH[3]}" mark="${BASH_REMATCH[4]}" per_byte="${BASH_REMATCH[5]}" factor="${BASH_REMATCH[6]}" budget="${BASH_REMATCH[7]}"

  umask 077
  tmp="$(mktemp "$env.solfee.XXXXXX")"
  TMP="$tmp"
  if [[ -e "$env" ]]; then cat "$env" > "$tmp"; fi
  if [[ -s "$tmp" && -n "$(tail -c 1 "$tmp")" ]]; then printf '\n' >> "$tmp"; fi
  # the maker's stdout (the four lines) into the temporary file, its stderr (public: the address, or why it stopped)
  # into `said`
  local said
  rc=0
  said="$(printf '%s %s %s %s\n' "$program" "$pool" "$fee" "$rpcs" | docker run --rm -i --log-driver none --pull never --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true \
    --entrypoint node "ct-helper:$commit" --input-type=module -e "$MAKER" 2>&1 >> "$tmp")" || rc=$?
  if [[ $rc -ne 0 ]]; then
    [[ -n "$said" ]] && printf '%s\n' "$said" >&2
    echo "sol-fee-payer-key: the key maker stopped (exit $rc); nothing changed" >&2
    exit 1
  fi
  local address
  address="$(printf '%s\n' "$said" | sed -nE 's/^sol-fee-payer-key: fee payer ([1-9A-HJ-NP-Za-km-z]{32,44})$/\1/p' | head -n 1)"
  if [[ -z "$address" ]]; then
    echo "sol-fee-payer-key: the key maker named no fee payer; nothing changed" >&2
    exit 1
  fi
  # each name once, each in its form, before the file replaces deploy/.env (checked, never printed)
  for name in "${NAMES[@]}"; do
    if [[ "$(lines_of "$tmp" "$name" | grep -c .)" != 1 ]]; then
      echo "sol-fee-payer-key: $name was not written once; nothing changed" >&2
      exit 1
    fi
  done
  if ! grep -qxE 'POOL_SOLANA_FEE_PAYER_KEY_MAINNET=[1-9A-HJ-NP-Za-km-z]{80,90}' "$tmp" \
    || ! grep -qxF "POOL_SOLANA_PROGRAM_MAINNET=$program" "$tmp" \
    || ! grep -qxF "POOL_SOLANA_FEE_MAINNET=$fee" "$tmp" \
    || ! grep -qxF "POOL_SOLANA_RPCS_MAINNET=$rpcs" "$tmp"; then
    echo "sol-fee-payer-key: the four lines are not in their form; nothing changed" >&2
    exit 1
  fi
  chmod 600 "$tmp"
  mv -f "$tmp" "$env"
  TMP=""
  # the funding: the low mark and FAILED_SENDS worst failed
  # sends (two signatures and the whole priority budget each), rounded up to 0.01 SOL
  local fail=$(( 10000 + budget ))
  local need=$(( ( (mark + FAILED_SENDS * fail + ROUND - 1) / ROUND ) * ROUND ))
  local sol
  sol="$(printf '%d.%09d' $(( need / 1000000000 )) $(( need % 1000000000 )) | sed -E 's/0+$//; s/\.$//')"
  echo "sol-fee-payer-key: wrote ${NAMES[*]} to deploy/.env (program $program, pool $pool, rent $per_byte lamports a byte x$factor, fee $fee lamports)"
  echo "sol-fee-payer-key: fee payer $address"
  echo "sol-fee-payer-key: the fee payer needs at least $mark lamports, its low mark: its own rent floor, one worst release fronted before the pool pays its fee back (spent mark, change entry, a new page, two signatures) and the whole priority budget"
  echo "sol-fee-payer-key: Next, in this order:"
  echo "sol-fee-payer-key: 1. apps/helper/deploy/redeploy.sh $commit again (the commit the helper runs, whose image made the key), so the helper starts with the four lines"
  echo "sol-fee-payer-key: 2. the owner sends $sol SOL ($need lamports) to $address: the low mark $mark and $FAILED_SENDS failed sends at $fail each, rounded up to 0.01 SOL; a page-opening release costs it the page's rent, which the page reserve pays back on average"
  echo "sol-fee-payer-key: 3. once it has landed: node scripts/live-checks/helper-sol-fee-payer-mainnet.mjs (PASS), then its After: helper line goes in"
}

main "$@"
