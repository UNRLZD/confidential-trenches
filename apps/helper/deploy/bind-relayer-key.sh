#!/usr/bin/env bash
# Makes the mainnet deposit carry's gas account key on the helper's server (card helper-bind-relayer-mainnet), as
# withdraw-relayer-key.sh makes the withdrawal relayer's. Run on the server, from the checkout redeploy.sh keeps, once it
# is at a commit that has this file and contracts/vault/deployments/mainnet-v1.json (main fetched and the commit found
# on it, as redeploy.sh's step 0 does, then checked out, its step 1; vault-lines.sh's step 1 has the command):
#   apps/helper/deploy/bind-relayer-key.sh
# The first deploy of mainnet-v1.json: the order is in vault-lines.sh's header, its one place (this step is its step 3:
# the key is checked against the running image's MAINNET_VAULT, exit 5 below, and the record commit R moves that pin,
# so R must be running first, with its vault lines moved). A later run (a new server, a lost .env) on a running commit
# that has the record needs only this step and the ones it prints at the end (redeploy, fund, live checks), where step
# 1 names the checkout's commit.
# In order, stopping at the first failure with deploy/.env unchanged:
#   1. refuses (exit 3) when any line of deploy/.env sets one of the three names below (redeploy.sh's lines_of
#      matcher), so a second run never replaces a key the gas account already holds; when deploy/.env names no image
#      (HELPER_COMMIT, exit 6); when contracts/vault/deployments/mainnet-v1.json does not exist (exit 4: the mainnet
#      vault is not deployed, and the bind carry never falls back to mainnet-test.json); when BIND_MARGIN_K does not
#      reach the helper as 1 to 600 (exit 7: src/bind/env.ts stops the helper at start without it);
#   2. makes one ed25519 key inside the helper's own image (ct-helper:<HELPER_COMMIT>, node:crypto, no network, a
#      read-only container) and checks, with the image's own code: the record names a mainnet vault (exit 4); its
#      account_id is the vault the image carries, src/withdraw/send.ts MAINNET_VAULT, and WITHDRAW_VAULT_MAINNET when
#      deploy/.env sets it (exit 5: src/bind/env.ts stops the helper at start on either); the key parses with
#      src/bind/send.ts relayerKey and the account is its implicit one;
#   3. refuses (exit 8) when the gas account or its key is one deploy/.env already names for another sender
#      (WITHDRAW_RELAYER_<NET>, WITHDRAW_RELAYER_KEYS_<NET>, BIND_RELAYER_TESTNET, BIND_RELAYER_KEY_TESTNET):
#      src/bind/env.ts refuses one key on one account in two relayers, and this carry has its own;
#   4. writes deploy/.env again whole (a mode 600 temporary file beside it, then one rename), every line kept and these
#      three added:
#        BIND_VAULT_MAINNET=<mainnet-v1.json's account_id>
#        BIND_RELAYER_MAINNET=<the key's implicit account: the public key's 64 lowercase hex>
#        BIND_RELAYER_KEY_MAINNET=ed25519:<base58 of the 32-byte seed and the 32-byte public key>
# The secret goes from the container's stdout into the temporary file only (renamed to deploy/.env): never to the
# terminal, argv, the environment or any other file. The container runs with --log-driver none, so docker keeps no copy
# of its stdout. It prints the vault, the gas account and the public key, all public.
# The gas account does not exist until it is funded: a NEAR transfer to the 64-hex id creates it with this one
# full-access key. Its NEAR pays deposit gas, one-time id creation and storage prepays only; it holds no user's money.
# exit 0 done, 2 usage, 3 a name already set, 4 no mainnet vault record, 5 the vault not the record's, 6 no image,
# 7 no BIND_MARGIN_K, 8 an account or key another sender uses, 1 any other failure
set -euo pipefail

NAMES=(BIND_VAULT_MAINNET BIND_RELAYER_MAINNET BIND_RELAYER_KEY_MAINNET)
# the names whose accounts and keys this carry must not share (src/bind/env.ts, src/withdraw/fee.ts RELAYER_ENV,
# src/withdraw/send.ts SEND_ENV)
OTHER_ACCOUNTS=(WITHDRAW_RELAYER_MAINNET WITHDRAW_RELAYER_TESTNET BIND_RELAYER_TESTNET)
OTHER_KEYS=(WITHDRAW_RELAYER_KEYS_MAINNET WITHDRAW_RELAYER_KEYS_TESTNET BIND_RELAYER_KEY_TESTNET)

# The key maker, run by node in the helper's image from its WORKDIR (/app/apps/helper): the deploy record on stdin, the
# three lines on stdout, the public parts on stderr. argv[1] is WITHDRAW_VAULT_MAINNET or empty.
read -r -d '' MAKER <<'JS' || true
import { generateKeyPairSync } from "node:crypto";
import { pathToFileURL } from "node:url";
const own = (p) => import(new URL(p, pathToFileURL(`${process.cwd()}/`)).href);
const { MAINNET_VAULT } = await own("src/withdraw/send.ts");
const { relayerKey } = await own("src/bind/send.ts");
let text = "";
for await (const c of process.stdin) text += c;
let rec;
try { rec = JSON.parse(text); } catch { rec = null; }
const ACCOUNT = /^(([a-z0-9]+[-_])*[a-z0-9]+\.)*([a-z0-9]+[-_])*[a-z0-9]+$/;
const ok = (a) => typeof a === "string" && a.length >= 2 && a.length <= 64 && ACCOUNT.test(a);
if (rec === null || rec.network !== "mainnet" || !ok(rec.account_id)) { process.stderr.write("bind-relayer-key: mainnet-v1.json names no mainnet vault; nothing changed\n"); process.exit(4); }
if (rec.account_id !== MAINNET_VAULT) { process.stderr.write(`bind-relayer-key: mainnet-v1.json names ${rec.account_id}, but this image carries ${MAINNET_VAULT} (src/withdraw/send.ts MAINNET_VAULT); redeploy a commit whose pin is the record's first; nothing changed\n`); process.exit(5); }
const withdrawVault = process.argv[1] || "";
if (withdrawVault !== "" && withdrawVault !== rec.account_id) { process.stderr.write(`bind-relayer-key: WITHDRAW_VAULT_MAINNET in deploy/.env is ${ok(withdrawVault) ? withdrawVault : "not an account id"}, not mainnet-v1.json's ${rec.account_id}; set it to the record's vault first; nothing changed\n`); process.exit(5); }
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
const key = `ed25519:${b58(sk)}`;
const account = pub.toString("hex");
if (Buffer.from(relayerKey(key).pub).toString("hex") !== account) { process.stderr.write("bind-relayer-key: the key does not parse as the helper reads it; nothing changed\n"); process.exit(1); }
process.stdout.write(`BIND_VAULT_MAINNET=${rec.account_id}\nBIND_RELAYER_MAINNET=${account}\nBIND_RELAYER_KEY_MAINNET=${key}\n`);
seed.fill(0);
sk.fill(0);
process.stderr.write(`bind-relayer-key: vault ${rec.account_id}\nbind-relayer-key: gas account ${account}\nbind-relayer-key: public key ed25519:${b58(pub)}\n`);
JS

# deploy/.env's lines setting NAME, in any form redeploy.sh's lines_of reads
lines_of() {
  grep -E "^[[:space:]]*(export[[:space:]]+)?$2[[:space:]]*[=:]" "$1" || true
}
# NAME's value as compose reads it: this shell's if set there, else its one plain NAME=value line in deploy/.env, else
# empty. Exit 1 on a line that is not plain. Never printed by a caller.
value_of() {
  local found
  if [[ -n "${!2+set}" ]]; then printf '%s' "${!2}"; return 0; fi
  [[ -e "$1" ]] || return 0
  found="$(lines_of "$1" "$2")"
  [[ -z "$found" ]] && return 0
  [[ "$found" != *$'\n'* && "$found" == "$2="* ]] || return 1
  printf '%s' "${found#"$2"=}"
}

main() {
  if [[ $# -ne 0 ]]; then
    echo "usage: bind-relayer-key.sh" >&2
    exit 2
  fi
  local deploy root env record commit name tmp k wvault
  deploy="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  root="$(cd "$deploy/../../.." && pwd)"
  env="$deploy/.env"
  record="$root/contracts/vault/deployments/mainnet-v1.json"

  for name in "${NAMES[@]}"; do
    # grep -q: the matching line is never captured, so not even bash -x prints it (review FIX 3)
    if [[ -e "$env" ]] && lines_of "$env" "$name" | grep -q .; then
      echo "bind-relayer-key: $name is already set in deploy/.env; nothing changed (the gas account keeps its key)" >&2
      exit 3
    fi
  done
  commit="$( { [[ -e "$env" ]] && grep -E '^HELPER_COMMIT=[0-9a-f]{40}$' "$env" || true; } | head -n 1 | cut -d= -f2)"
  if [[ -z "$commit" ]]; then
    echo "bind-relayer-key: deploy/.env names no HELPER_COMMIT (run redeploy.sh first); nothing changed" >&2
    exit 6
  fi
  if [[ ! -f "$record" ]]; then
    echo "bind-relayer-key: no contracts/vault/deployments/mainnet-v1.json: the mainnet vault is not deployed yet, so there is no vault to carry deposits for; nothing changed" >&2
    exit 4
  fi
  if ! k="$(value_of "$env" BIND_MARGIN_K)" || [[ ! "$k" =~ ^[1-9][0-9]{0,2}$ ]] || (( k > 600 )); then
    echo "bind-relayer-key: BIND_MARGIN_K is not one plain line of 1 to 600 blocks (the release's pin), so the helper would stop at start; set it first; nothing changed" >&2
    exit 7
  fi
  if ! wvault="$(value_of "$env" WITHDRAW_VAULT_MAINNET)" || [[ "$wvault" == *[[:space:]]* ]]; then
    echo "bind-relayer-key: WITHDRAW_VAULT_MAINNET in deploy/.env is not one plain line; nothing changed" >&2
    exit 5
  fi

  umask 077
  tmp="$(mktemp "$env.bind.XXXXXX")"
  trap 'rm -f "$tmp"' EXIT
  if [[ -e "$env" ]]; then cat "$env" > "$tmp"; fi
  if [[ -s "$tmp" && -n "$(tail -c 1 "$tmp")" ]]; then printf '\n' >> "$tmp"; fi
  local rc=0
  docker run --rm -i --log-driver none --pull never --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true \
    --entrypoint node "ct-helper:$commit" --input-type=module -e "$MAKER" "$wvault" < "$record" >> "$tmp" || rc=$?
  if [[ $rc -ne 0 ]]; then
    echo "bind-relayer-key: the key maker stopped (exit $rc); nothing changed" >&2
    [[ $rc -eq 4 || $rc -eq 5 ]] && exit "$rc"
    exit 1
  fi
  # each name once, each in its form, before the file replaces deploy/.env (checked, never printed)
  for name in "${NAMES[@]}"; do
    if [[ "$(lines_of "$tmp" "$name" | grep -c .)" != 1 ]]; then
      echo "bind-relayer-key: $name was not written once; nothing changed" >&2
      exit 1
    fi
  done
  if ! grep -qxE 'BIND_RELAYER_MAINNET=[0-9a-f]{64}' "$tmp" || ! grep -qxE 'BIND_RELAYER_KEY_MAINNET=ed25519:[1-9A-HJ-NP-Za-km-z]{80,90}' "$tmp"; then
    echo "bind-relayer-key: the key lines are not in their form; nothing changed" >&2
    exit 1
  fi
  local vault account
  vault="$(grep -E '^BIND_VAULT_MAINNET=' "$tmp" | cut -d= -f2)"
  account="$(grep -E '^BIND_RELAYER_MAINNET=' "$tmp" | cut -d= -f2)"
  if [[ -n "$wvault" && "$vault" != "$wvault" ]]; then
    echo "bind-relayer-key: BIND_VAULT_MAINNET would not be WITHDRAW_VAULT_MAINNET; nothing changed" >&2
    exit 5
  fi
  # another sender's account or key (the values compared inside awk, never printed): any name in either list, every
  # comma-separated key of a WITHDRAW_RELAYER_KEYS_<NET> line
  local shared
  shared="$(awk -v accounts="${OTHER_ACCOUNTS[*]}" -v keys="${OTHER_KEYS[*]}" '
    BEGIN { na = split(accounts, A, " "); nk = split(keys, K, " ") }
    { line = $0; sub(/^[[:space:]]*(export[[:space:]]+)?/, "", line); eq = index(line, "="); if (eq == 0) next
      name = substr(line, 1, eq - 1); sub(/[[:space:]]+$/, "", name); value = substr(line, eq + 1); gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      if (name == "BIND_RELAYER_MAINNET") own_account = value
      else if (name == "BIND_RELAYER_KEY_MAINNET") own_key = value
      else {
        for (i = 1; i <= na; i++) if (name == A[i]) other_account[value] = name
        for (i = 1; i <= nk; i++) if (name == K[i]) { n = split(value, parts, ","); for (j = 1; j <= n; j++) { v = parts[j]; gsub(/^[[:space:]]+|[[:space:]]+$/, "", v); if (v != "") other_key[v] = name } }
      } }
    END { if (own_account in other_account) print other_account[own_account]; else if (own_key in other_key) print other_key[own_key] }
  ' "$tmp")"
  if [[ -n "$shared" ]]; then
    echo "bind-relayer-key: the new gas account or key is the one $shared names; this carry needs its own; nothing changed" >&2
    exit 8
  fi
  chmod 600 "$tmp"
  mv -f "$tmp" "$env"
  trap - EXIT
  echo "bind-relayer-key: wrote ${NAMES[*]} to deploy/.env (vault $vault). Next, in this order:"
  echo "bind-relayer-key: 1. apps/helper/deploy/redeploy.sh $(git -C "$root" rev-parse HEAD 2>/dev/null || echo '<this commit>'), so the helper starts with the three lines"
  echo "bind-relayer-key: 2. the owner sends 1 NEAR to $account"
  echo "bind-relayer-key: 3. once it has landed: the helper's live checks, helper-bind-relayer-mainnet among them"
}

main "$@"
