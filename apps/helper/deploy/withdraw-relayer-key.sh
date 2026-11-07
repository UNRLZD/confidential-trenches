#!/usr/bin/env bash
# Makes the mainnet withdrawal relayer's key on the helper's server (card helper-mainnet-vault-env). Run on the server,
# from the checkout redeploy.sh keeps, once it is at a commit that has this file (git fetch and checkout, as redeploy.sh's
# step 1 does):
#   apps/helper/deploy/withdraw-relayer-key.sh [--fee-recipient <account>]
# The order, which it prints again at the end with the accounts filled in:
#   0. this step;
#   1. apps/helper/deploy/redeploy.sh <this commit>, so the helper starts with the four lines below;
#   2. the owner sends 1 NEAR to the relayer account (one withdrawal's floor is 0.4652 NEAR, send.ts withdrawFloor);
#   3. the owner calls storage_deposit on mainnet USDC (17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1)
#      with {"account_id":"<the fee recipient>","registration_only":true}, attaching 0.00125 NEAR (its
#      storage_balance_bounds().min): the fee recipient, the relayer itself by default, must be registered on USDC, else
#      every fee quote and every send holds (fee.ts readFeeAccount, send.ts check 7b);
#   4. once both have landed: the helper's live checks, helper-mainnet-vault-env among them.
# In order, stopping at the first failure with deploy/.env unchanged:
#   1. refuses (exit 3) when any line of deploy/.env sets one of the four names below (redeploy.sh's lines_of matcher),
#      or when deploy/.env names no image (HELPER_COMMIT, exit 6);
#   2. makes one ed25519 key inside the helper's own image (ct-helper:<HELPER_COMMIT>, node:crypto, no network, a
#      read-only container) and reads the vault from the mainnet deploy record
#      (the kit's rule: contracts/vault/deployments/mainnet-v1.json once it exists, else mainnet-test.json; its
#      account_id, the one vault the helper takes, send.ts MAINNET_VAULT);
#   3. writes deploy/.env again whole (a mode 600 temporary file beside it, then one rename), every line kept and these
#      four added:
#        WITHDRAW_VAULT_MAINNET=<the record's account_id>
#        WITHDRAW_RELAYER_MAINNET=<the key's implicit account: the public key's 64 lowercase hex>
#        WITHDRAW_FEE_RECIPIENT_MAINNET=<--fee-recipient, else the relayer account itself; never the vault or
#                                        intents.near, which every withdrawal refuses (send.ts check 8)>
#        WITHDRAW_RELAYER_KEYS_MAINNET=ed25519:<base58 of the 32-byte seed and the 32-byte public key>
# The secret goes from the container's stdout into the temporary file only (renamed to deploy/.env): never to the
# terminal, argv, the environment or any other file. The container runs with --log-driver none, so docker keeps no copy
# of its stdout (the default json-file driver writes one under /var/lib/docker/containers). It prints the relayer
# account, the public key and the fee recipient, all public.
# The relayer account does not exist until it is funded: a NEAR transfer to the 64-hex id creates it with this one
# full-access key. Its NEAR pays relay gas and storage only; the vault pays out only against a device's proof.
# exit 0 done, 2 usage, 3 a name already set, 4 the deploy record names no mainnet vault, 6 no image, 1 any other failure
set -euo pipefail

# mainnet USDC, the vault's token (the kit's VAULT_CONSTANTS.TOKEN)
USDC=17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1
NAMES=(WITHDRAW_VAULT_MAINNET WITHDRAW_RELAYER_MAINNET WITHDRAW_FEE_RECIPIENT_MAINNET WITHDRAW_RELAYER_KEYS_MAINNET)
# NEAR's account id rule (nearcore AccountId): 2 to 64 characters, lowercase parts joined by '.', '-' or '_' inside
ACCOUNT_RE='^(([a-z0-9]+[-_])*[a-z0-9]+\.)*([a-z0-9]+[-_])*[a-z0-9]+$'

# The key maker, run by node in the helper's image: the deploy record on stdin, the four lines on stdout, the public
# parts on stderr. argv[1] is the fee recipient or empty.
read -r -d '' MAKER <<'JS' || true
import { generateKeyPairSync } from "node:crypto";
let text = "";
for await (const c of process.stdin) text += c;
let rec;
try { rec = JSON.parse(text); } catch { rec = null; }
const ACCOUNT = /^(([a-z0-9]+[-_])*[a-z0-9]+\.)*([a-z0-9]+[-_])*[a-z0-9]+$/;
const ok = (a) => typeof a === "string" && a.length >= 2 && a.length <= 64 && ACCOUNT.test(a);
if (rec === null || rec.network !== "mainnet" || !ok(rec.account_id)) { process.stderr.write("the deploy record names no mainnet vault\n"); process.exit(4); }
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
const relayer = pub.toString("hex");
const fee = process.argv[1] || relayer;
if (!ok(fee) || fee === rec.account_id || fee === "intents.near") { process.stderr.write("the fee recipient is not a NEAR account id other than the vault and intents.near\n"); process.exit(2); }
process.stdout.write(`WITHDRAW_VAULT_MAINNET=${rec.account_id}\nWITHDRAW_RELAYER_MAINNET=${relayer}\nWITHDRAW_FEE_RECIPIENT_MAINNET=${fee}\nWITHDRAW_RELAYER_KEYS_MAINNET=ed25519:${b58(sk)}\n`);
seed.fill(0);
sk.fill(0);
process.stderr.write(`withdraw-relayer-key: vault ${rec.account_id}\nwithdraw-relayer-key: relayer account ${relayer}\nwithdraw-relayer-key: public key ed25519:${b58(pub)}\nwithdraw-relayer-key: fee recipient ${fee}\n`);
JS

main() {
  local fee=""
  if [[ $# -eq 2 && "$1" == "--fee-recipient" ]]; then
    fee="$2"
    if [[ ${#fee} -lt 2 || ${#fee} -gt 64 || ! "$fee" =~ $ACCOUNT_RE ]]; then
      echo "withdraw-relayer-key: --fee-recipient must be a NEAR account id" >&2
      exit 2
    fi
  elif [[ $# -ne 0 ]]; then
    echo "usage: withdraw-relayer-key.sh [--fee-recipient <account>]" >&2
    exit 2
  fi
  local deploy root env record commit name tmp
  deploy="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  root="$(cd "$deploy/../../.." && pwd)"
  env="$deploy/.env"
  record="$root/contracts/vault/deployments/mainnet-v1.json"
  [[ -e "$record" ]] || record="$root/contracts/vault/deployments/mainnet-test.json"

  for name in "${NAMES[@]}"; do
    if [[ -e "$env" ]] && grep -qE "^[[:space:]]*(export[[:space:]]+)?${name}[[:space:]]*[=:]" "$env"; then
      echo "withdraw-relayer-key: $name is already set in deploy/.env; nothing changed" >&2
      exit 3
    fi
  done
  commit="$( { [[ -e "$env" ]] && grep -E '^HELPER_COMMIT=[0-9a-f]{40}$' "$env" || true; } | head -n 1 | cut -d= -f2)"
  if [[ -z "$commit" ]]; then
    echo "withdraw-relayer-key: deploy/.env names no HELPER_COMMIT (run redeploy.sh first); nothing changed" >&2
    exit 6
  fi
  if [[ ! -f "$record" ]]; then
    echo "withdraw-relayer-key: no mainnet deploy record (contracts/vault/deployments/mainnet-v1.json or mainnet-test.json); nothing changed" >&2
    exit 4
  fi

  umask 077
  tmp="$(mktemp "$env.relayer.XXXXXX")"
  trap 'rm -f "$tmp"' EXIT
  if [[ -e "$env" ]]; then cat "$env" > "$tmp"; fi
  if [[ -s "$tmp" && -n "$(tail -c 1 "$tmp")" ]]; then printf '\n' >> "$tmp"; fi
  local rc=0
  docker run --rm -i --log-driver none --pull never --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true \
    --entrypoint node "ct-helper:$commit" --input-type=module -e "$MAKER" "$fee" < "$record" >> "$tmp" || rc=$?
  if [[ $rc -ne 0 ]]; then
    echo "withdraw-relayer-key: the key maker stopped (exit $rc); nothing changed" >&2
    [[ $rc -eq 2 || $rc -eq 4 ]] && exit "$rc"
    exit 1
  fi
  # each name once, each in its form, before the file replaces deploy/.env (checked, never printed)
  for name in "${NAMES[@]}"; do
    if [[ "$(grep -cE "^[[:space:]]*(export[[:space:]]+)?${name}[[:space:]]*[=:]" "$tmp")" != 1 ]]; then
      echo "withdraw-relayer-key: $name was not written once; nothing changed" >&2
      exit 1
    fi
  done
  if ! grep -qxE 'WITHDRAW_RELAYER_MAINNET=[0-9a-f]{64}' "$tmp" || ! grep -qxE 'WITHDRAW_RELAYER_KEYS_MAINNET=ed25519:[1-9A-HJ-NP-Za-km-z]{80,90}' "$tmp"; then
    echo "withdraw-relayer-key: the key lines are not in their form; nothing changed" >&2
    exit 1
  fi
  local relayer feeto
  relayer="$(grep -E '^WITHDRAW_RELAYER_MAINNET=' "$tmp" | cut -d= -f2)"
  feeto="$(grep -E '^WITHDRAW_FEE_RECIPIENT_MAINNET=' "$tmp" | cut -d= -f2)"
  chmod 600 "$tmp"
  mv -f "$tmp" "$env"
  trap - EXIT
  echo "withdraw-relayer-key: wrote ${NAMES[*]} to deploy/.env. Next, in this order:"
  echo "withdraw-relayer-key: 1. apps/helper/deploy/redeploy.sh <this commit>, so the helper starts with the four lines"
  echo "withdraw-relayer-key: 2. the owner sends 1 NEAR to $relayer"
  echo "withdraw-relayer-key: 3. the owner calls storage_deposit on $USDC with {\"account_id\":\"$feeto\",\"registration_only\":true}, attaching 0.00125 NEAR"
  echo "withdraw-relayer-key: 4. once both have landed: the helper's live checks, helper-mainnet-vault-env among them"
}

main "$@"
