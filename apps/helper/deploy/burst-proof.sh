#!/bin/bash
# The burst proof (card helper-answers-through-a-burst): this checkout's helper on mainnet's public providers with no
# vendor key, behind Caddy 2.11.6 (compose.yaml's version, its release binary checked against the release's checksums)
# on the real Caddyfile, then deploy/burst.mjs's page opens through Caddy. It reads where an answer is lost: Caddy's
# upstream failures by reason (addresses masked), the helper's listen queue (its length all along, from /proc/net/tcp*,
# and the kernel's overflow and drop counts), and the helper's own event loop and refusal lines. Linux, node and curl;
# no Docker, so the one hop it lacks is compose's name lookup of `helper` (the copy dials 127.0.0.1). No deploy .env:
#   bash apps/helper/deploy/burst-proof.sh [<pages at once, 300; a comma list runs each in turn>] [<out dir>]
# A size written <pages>x<coins> spreads its pages over that many of the Solana lists' coins (burst.mjs --coins), as the
# test browsers' shards open many token pages, each cold the first time; a plain size opens one coin.
# For the run only, a copy of the Caddyfile serves plain http on a local port, dials the local helper, maps each page's
# X-Burst-Client to X-Forwarded-For (each page its own client, as each live run job is) and, when the real file names
# none, logs Caddy's upstream failures without their request. Nothing here writes a client IP.
set -uo pipefail
ROOT=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
SESSIONS=${1:-300}
OUT=${2:-$(mktemp -d)}
HP=${BURST_HELPER_PORT:-18181}
# the helper and Caddy on two CPUs, as the helper host has (create-server.mjs TYPES: cx23 first, 2 shared vCPUs); the
# page opens run beside them on the rest
CPUS=${BURST_CPUS:-0,1}
PIN=()
command -v taskset >/dev/null && PIN=(taskset -c "$CPUS")
CP=${BURST_CADDY_PORT:-18090}
DEPLOY="$ROOT/apps/helper/deploy"
CV=2.11.6
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)
case "$(uname -s)-$(uname -m)" in Linux-x86_64) CA=linux_amd64 ;; Linux-aarch64) CA=linux_arm64 ;; Darwin-arm64) CA=mac_arm64 ;; *) CA=mac_amd64 ;; esac
CDIR=${XDG_CACHE_HOME:-$HOME/.cache}/ct-burst-caddy-$CV
CADDY=$CDIR/caddy
if [ ! -x "$CADDY" ]; then
  mkdir -p "$CDIR"
  U=https://github.com/caddyserver/caddy/releases/download/v$CV
  curl -fsSL -o "$CDIR/c.tgz" "$U/caddy_${CV}_${CA}.tar.gz" && curl -fsSL -o "$CDIR/sums" "$U/caddy_${CV}_checksums.txt" || { echo "caddy download failed"; exit 2; }
  want=$(awk -v f="caddy_${CV}_${CA}.tar.gz" '$2 == f { print $1 }' "$CDIR/sums")
  got=$( (sha512sum "$CDIR/c.tgz" 2>/dev/null || shasum -a 512 "$CDIR/c.tgz") | cut -d' ' -f1)
  [ -n "$want" ] && [ "$want" = "$got" ] || { echo "caddy checksum mismatch"; rm -f "$CDIR/c.tgz"; exit 2; }
  tar -xzf "$CDIR/c.tgz" -C "$CDIR" caddy && rm -f "$CDIR/c.tgz"
fi
echo "== $("$CADDY" version | cut -d' ' -f1), node $(node --version), commit $(git -C "$ROOT" rev-parse HEAD), $SESSIONS pages, out $OUT"
# the run's Caddyfile: the real one on a local port, its admin on a socket in the out dir, dialing the local helper
perl -pe "s|^\\{\\\$HELPER_SITE:[^}]*\\}|http://127.0.0.1:$CP|; s|admin unix//config/caddy-admin.sock|admin unix/$OUT/caddy-admin.sock|; s|^(\\s*)reverse_proxy helper:8080 \\{\$|\$1reverse_proxy 127.0.0.1:$HP {\\n\$1\\theader_up X-Forwarded-For {http.request.header.X-Burst-Client}|" "$DEPLOY/Caddyfile" >"$OUT/Caddyfile"
grep -q 'include http.log.error' "$OUT/Caddyfile" || perl -0pi -e 's/\n\}\n/\n\tlog burst-errors {\n\t\toutput stderr\n\t\tinclude http.log.error\n\t\tformat filter {\n\t\t\trequest delete\n\t\t}\n\t}\n}\n/' "$OUT/Caddyfile"
HPID=
CPID=
cleanup() { [ -n "$CPID" ] && kill "$CPID" 2>/dev/null; [ -n "$HPID" ] && kill "$HPID" 2>/dev/null; rm -f "$OUT/sampling"; }
trap cleanup EXIT
mkdir -p "$OUT/store"
(cd "$ROOT/apps/helper" && exec env -i PATH="$PATH" HOME="$HOME" HELPER_COMMIT="$(git -C "$ROOT" rev-parse HEAD)" PORT="$HP" HELPER_STORE_DIR="$OUT/store" HELPER_RELEASE=1 \
  PROXY_BUDGET_JUPITER=60,30 PROXY_BUDGET_RELAY=60,30 PROXY_BUDGET_LIFI=60,30 PROXY_BUDGET_ONECLICK=60,30 ${PIN[@]+"${PIN[@]}"} node src/server.ts) >"$OUT/helper.log" 2>&1 &
HPID=$!
echo "== waiting for the helper's ready (at most 300 s)"
for _ in $(seq 1 150); do curl -fsS "http://127.0.0.1:$HP/v1/health" 2>/dev/null | grep -q '"ready":true' && break; kill -0 $HPID 2>/dev/null || break; sleep 2; done
curl -fsS "http://127.0.0.1:$HP/v1/health" | grep -o '"ready":[a-z]*' || { echo "helper not up"; tail -5 "$OUT/helper.log"; exit 2; }
${PIN[@]+"${PIN[@]}"} "$CADDY" run --adapter caddyfile --config "$OUT/Caddyfile" >"$OUT/caddy.log" 2>&1 &
CPID=$!
for _ in $(seq 1 20); do curl -fsS -o /dev/null "http://127.0.0.1:$CP/v1/health" 2>/dev/null && break; sleep 0.5; done
HEX=$(printf '%04X' "$HP")
overflows() { awk '/^TcpExt:/ { if (!n) { split($0, k); n = 1 } else { for (i = 2; i <= NF; i++) if (k[i] == "ListenOverflows" || k[i] == "ListenDrops") printf "%s=%s ", k[i], $i } }' /proc/net/netstat 2>/dev/null; }
echo "somaxconn $(cat /proc/sys/net/core/somaxconn 2>/dev/null || sysctl -n kern.ipc.somaxconn)"
A=$(overflows)
sleep 15
echo "idle 15 s (the box's own drops): $A-> $(overflows)"
LC="$ROOT/scripts/live-checks/helper-answers-through-a-burst.mjs"
for SIZE in ${SESSIONS//,/ }; do
  N=${SIZE%x*}
  COINS=1
  [ "$SIZE" != "$N" ] && COINS=${SIZE#*x}
  echo "== $N pages at once, over $COINS coins"
  echo "before: $(overflows)"
  touch "$OUT/sampling"
  # the helper's listen socket, every 200 ms: its accept queue now and its bound (ss: Recv-Q, Send-Q), its connections
  (
    while [ -e "$OUT/sampling" ]; do
      echo "$(ss -Hltn "sport = :$HP" | awk '{ print $2, $3 }' | head -1) est $(ss -Htn state established "sport = :$HP" | wc -l)"
      sleep 0.2
    done
  ) >"$OUT/listen-$SIZE.txt" &
  SAMPLER=$!
  # the card's live check, run as the burst starts against the same Caddy, its answer recorded (live-<pages>.json)
  LCPID=
  if [ -f "$LC" ]; then
    (sleep 0.3 && node "$LC" --base "http://127.0.0.1:$CP" --record "$OUT/live-$SIZE.json" >"$OUT/live-$SIZE.txt" 2>&1) &
    LCPID=$!
  fi
  node "$DEPLOY/burst.mjs" --base "http://127.0.0.1:$CP" --sessions "$N" --coins "$COINS" --client-header X-Burst-Client | tee "$OUT/burst-$SIZE.json"
  rm -f "$OUT/sampling"
  wait $SAMPLER 2>/dev/null
  echo "after: $(overflows)"
  # the connections Caddy closed to the helper in the last minute (TIME_WAIT, Caddy's side): each one a connect the next
  # request paid for
  echo "caddy's closed connections to the helper (time-wait): $(ss -Htn state time-wait "dport = :$HP" | wc -l)"
  echo "listen queue: longest $(awk '{ if ($1 > m) m = $1; b = $2 } END { printf "%d of %d", m, b }' "$OUT/listen-$SIZE.txt"), connections to the helper at most $(awk '{ if ($4 > m) m = $4 } END { print m + 0 }' "$OUT/listen-$SIZE.txt")"
  if [ -n "$LCPID" ]; then
    wait "$LCPID" 2>/dev/null
    echo "-- the live check in the burst:"
    cat "$OUT/live-$SIZE.txt"
  fi
  sleep 20
done
# the helper names its event loop's longest hold once a minute (server.ts loopHeldLine): one more minute for its line
sleep 61
echo "== caddy's upstream failures by reason (addresses masked):"
grep -o '"msg":"[^"]*"' "$OUT/caddy.log" | sed -E 's/([0-9]{1,3}\.){3}[0-9]{1,3}(:[0-9]+)?/<addr>/g' | sort | uniq -c | sort -rn | head -8
echo "== caddy log lines with a client address field (want 0): $(grep -cE 'remote_ip|client_ip' "$OUT/caddy.log")"
echo "== the helper's event loop and refusal lines:"
grep -E 'event loop|refused' "$OUT/helper.log" | sort | uniq -c | sort -rn | head -8
echo "== done"
