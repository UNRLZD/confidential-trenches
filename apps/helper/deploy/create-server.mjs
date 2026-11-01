#!/usr/bin/env node
// Creates the helper server (card helper-host-health) in the Hetzner project confidential-trenches. A person runs it:
// it makes a server that costs money. It never lists or touches another project: the token it reads is the project's
// own, from HCLOUD_TOKEN (the Hetzner CLI's name for it), read inside this process and sent only in the Authorization
// header. Without HCLOUD_TOKEN the live run refuses before any call to Hetzner.
//
//   HCLOUD_TOKEN=... node apps/helper/deploy/create-server.mjs --commit <40 hex> [--dry-run]
//
// --dry-run prints the whole plan (firewall, server type order, location, image, primary IP, the cloud-init text) and
// makes no network call and reads no token.
// The live run, in order, stopping at the first refusal:
//   1. the commit's apps/helper/Dockerfile answers 200 on raw.githubusercontent.com (the server must fetch that commit);
//   2. the primary IP ct-helper-ipv4 is 91.99.5.177 in fsn1 and assigned to nothing;
//   3. no server named ct-helper exists in the project;
//   4. the firewall ct-helper-web (inbound tcp 80, tcp 443 and udp 443 only, so public 22 is closed) is reused when its
//      rules equal these, else made;
//   5. the server is made in fsn1 on that primary IP with that firewall and the cloud-init: CX23 first, then the next
//      type in fsn1 when Hetzner answers that one unavailable. Another location needs a new IP and so a DNS change:
//      the script stops and says so instead.
// The root password Hetzner returns for a server made without an ssh key is dropped unread: admin is over Tailscale.
import "../../../scripts/net-window.mjs";

export const API = "https://api.hetzner.cloud/v1";
export const REPO = "UNRLZD/confidential-trenches";
export const HOST = "api.confidential.unrealized.trade";
export const NAME = "ct-helper";
export const LOCATION = "fsn1";
export const IMAGE = "ubuntu-24.04";
// made on 31 Oct 21:00:59Z (merge note M326 (5)); the A record of HOST points at it
export const PRIMARY_IP = { id: 159313479, name: "ct-helper-ipv4", ip: "91.99.5.177" };
// CX23 (owner-decisions.md:344), then the nearest types in fsn1 by price (markets paper V10-V12)
export const TYPES = ["cx23", "cax11", "cx33", "cpx22"];
// Hetzner's answers that mean "this type cannot be placed now" (hcloud-go hcloud/error.go)
export const UNAVAILABLE = new Set(["resource_unavailable", "placement_error", "invalid_server_type"]);
export const LABELS = { project: "confidential-trenches", card: "helper-host-health" };
const ANY = ["0.0.0.0/0", "::/0"];
export const FIREWALL = {
  name: "ct-helper-web",
  labels: LABELS,
  rules: [
    { direction: "in", protocol: "tcp", port: "80", source_ips: ANY, description: "http, ACME" },
    { direction: "in", protocol: "tcp", port: "443", source_ips: ANY, description: "https" },
    { direction: "in", protocol: "udp", port: "443", source_ips: ANY, description: "https, HTTP/3" },
  ],
};
const SHA = /^[0-9a-f]{40}$/;

/** The server's first boot: Docker and Tailscale (not joined), then the helper built from the repo at the commit. */
export function cloudInit(commit) {
  if (!SHA.test(commit)) throw new Error("commit must be a full 40-hex sha");
  const setup = `#!/bin/bash
set -euo pipefail
COMMIT=${commit}
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl git
# Docker's apt repository (docs.docker.com/engine/install/ubuntu)
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable" > /etc/apt/sources.list.d/docker.list
# Tailscale's apt repository (pkgs.tailscale.com/stable/#ubuntu-noble); installed, not joined: the join is a manual step
curl -fsSL https://pkgs.tailscale.com/stable/ubuntu/noble.noarmor.gpg -o /usr/share/keyrings/tailscale-archive-keyring.gpg
curl -fsSL https://pkgs.tailscale.com/stable/ubuntu/noble.tailscale-keyring.list -o /etc/apt/sources.list.d/tailscale.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin tailscale
# the public repo at exactly the commit
git init -q /opt/ct
git -C /opt/ct fetch -q --depth 1 https://github.com/${REPO} "$COMMIT"
git -C /opt/ct checkout -q --detach FETCH_HEAD
test "$(git -C /opt/ct rev-parse HEAD)" = "$COMMIT"
cd /opt/ct/apps/helper/deploy
HELPER_COMMIT="$COMMIT" docker compose up -d --build
echo "ct-helper: up at $COMMIT"
`;
  const indented = setup.split("\n").map((l) => (l ? `      ${l}` : "")).join("\n");
  return `#cloud-config
write_files:
  - path: /usr/local/sbin/ct-helper-setup.sh
    permissions: "0755"
    content: |
${indented}
runcmd:
  - [/usr/local/sbin/ct-helper-setup.sh]
`;
}

/** The request bodies, one per server type, in the order they are tried. */
export function plan(commit) {
  const user_data = cloudInit(commit);
  return {
    commit,
    host: HOST,
    primary_ip: PRIMARY_IP,
    firewall: FIREWALL,
    servers: TYPES.map((t) => ({
      name: NAME,
      server_type: t,
      location: LOCATION,
      image: IMAGE,
      public_net: { enable_ipv4: true, enable_ipv6: false, ipv4: PRIMARY_IP.id },
      firewalls: ["<the id of firewall ct-helper-web>"],
      labels: LABELS,
      start_after_create: true,
      user_data,
    })),
  };
}

const sameRules = (a, b) => {
  const key = (r) => `${r.direction} ${r.protocol} ${r.port ?? ""} ${[...(r.source_ips ?? [])].sort().join(",")} ${[...(r.destination_ips ?? [])].sort().join(",")}`;
  const ka = a.map(key).sort();
  const kb = b.map(key).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i]);
};

export function readToken(env = process.env) {
  return (env.HCLOUD_TOKEN ?? "").trim();
}

/** The line printed for an error nobody handled: what failed, the step it was on, and the network cause code (e.cause.code). */
export const errorLine = (e) => `create-server: ERROR: ${e?.message ?? e} (step: ${e?.step ?? "start"}${e?.cause?.code ? `, cause: ${e.cause.code}` : ""})`;

/** argv without node and the script; deps are injected by the test. Returns the exit code. A throw carries the step it was on. */
export async function main(argv, deps = {}) {
  const at = { step: "start" };
  try {
    return await run(argv, deps, at);
  } catch (e) {
    if (e && typeof e === "object") e.step = at.step;
    throw e;
  }
}

async function run(argv, deps, at) {
  const { fetch: f = globalThis.fetch, token: getToken = readToken, log = console.log, err = console.error, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = deps;
  const dry = argv.includes("--dry-run");
  const commit = argv.includes("--commit") ? argv[argv.indexOf("--commit") + 1] : undefined;
  if (!commit || !SHA.test(commit)) {
    err("usage: create-server.mjs --commit <40-hex sha> [--dry-run]");
    return 2;
  }
  const p = plan(commit);
  if (dry) {
    const { servers, ...rest } = p;
    const { user_data, ...first } = servers[0];
    log(JSON.stringify({ dry_run: true, ...rest, server_types_in_order: TYPES, server: first }, null, 2));
    log("--- cloud-init (user_data) ---");
    log(user_data);
    log("dry run: no network call made, no token read");
    return 0;
  }

  at.step = "1 Dockerfile on GitHub";
  const raw = await f(`https://raw.githubusercontent.com/${REPO}/${commit}/apps/helper/Dockerfile`, { method: "HEAD" });
  if (raw.status !== 200) {
    err(`refused: ${REPO} at ${commit} has no apps/helper/Dockerfile on GitHub (HTTP ${raw.status}); push the commit first`);
    return 1;
  }
  at.step = "token from HCLOUD_TOKEN";
  const token = getToken();
  if (!token) {
    err("refused: HCLOUD_TOKEN is not set; set it to the Hetzner project's API token");
    return 1;
  }
  const api = async (method, path, body) => {
    const r = await f(`${API}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = await r.json().catch(() => ({}));
    return { status: r.status, ok: r.ok, j };
  };
  const why = (r) => `HTTP ${r.status} ${r.j?.error?.code ?? ""} ${r.j?.error?.message ?? ""}`.trim();

  at.step = "2 primary IP";
  const ip = await api("GET", `/primary_ips/${PRIMARY_IP.id}`);
  const pip = ip.j?.primary_ip;
  if (!ip.ok || !pip) {
    err(`refused: primary IP ${PRIMARY_IP.id} unreadable: ${why(ip)}`);
    return 1;
  }
  if (pip.ip !== PRIMARY_IP.ip || pip.type !== "ipv4" || pip.location?.name !== LOCATION || pip.assignee_id != null) {
    err(`refused: primary IP ${PRIMARY_IP.id} is ${pip.ip} ${pip.type} in ${pip.location?.name}, assigned to ${pip.assignee_id ?? "nothing"}; want ${PRIMARY_IP.ip} ipv4 in ${LOCATION}, assigned to nothing`);
    return 1;
  }
  log(`ok  primary IP ${PRIMARY_IP.name} ${pip.ip} in ${LOCATION}, unassigned`);

  at.step = "3 server name";
  const ex = await api("GET", `/servers?name=${NAME}`);
  if (!ex.ok) {
    err(`refused: cannot list servers named ${NAME}: ${why(ex)}`);
    return 1;
  }
  if ((ex.j.servers ?? []).length) {
    err(`refused: a server named ${NAME} already exists (id ${ex.j.servers[0].id}); nothing made`);
    return 1;
  }

  at.step = "4 firewall";
  let fw;
  const fl = await api("GET", `/firewalls?name=${FIREWALL.name}`);
  if (!fl.ok) {
    err(`refused: cannot read firewalls: ${why(fl)}`);
    return 1;
  }
  if ((fl.j.firewalls ?? []).length) {
    fw = fl.j.firewalls[0];
    if (!sameRules(fw.rules ?? [], FIREWALL.rules)) {
      err(`refused: firewall ${FIREWALL.name} (id ${fw.id}) exists with other rules; nothing made`);
      return 1;
    }
    log(`ok  firewall ${FIREWALL.name} reused (id ${fw.id})`);
  } else {
    const fc = await api("POST", "/firewalls", FIREWALL);
    if (!fc.ok || !fc.j.firewall) {
      err(`refused: firewall not made: ${why(fc)}`);
      return 1;
    }
    fw = fc.j.firewall;
    log(`ok  firewall ${FIREWALL.name} made (id ${fw.id}): inbound tcp 80, tcp 443, udp 443 only`);
  }

  for (const body of p.servers) {
    at.step = `5 server create (${body.server_type})`;
    const r = await api("POST", "/servers", { ...body, firewalls: [{ firewall: fw.id }] });
    if (!r.ok) {
      if (UNAVAILABLE.has(r.j?.error?.code)) {
        log(`--  ${body.server_type} in ${LOCATION} unavailable (${why(r)}); next type`);
        continue;
      }
      err(`refused: server not made: ${why(r)}`);
      return 1;
    }
    // r.j.root_password is never read: admin is over Tailscale
    const s = r.j.server;
    log(`ok  server ${s.name} made: id ${s.id}, ${body.server_type} in ${LOCATION}, ${s.public_net?.ipv4?.ip ?? PRIMARY_IP.ip}`);
    const action = r.j.action;
    for (let i = 0; action && i < 90; i++) {
      at.step = "5 server create action";
      const a = await api("GET", `/actions/${action.id}`);
      const st = a.j?.action?.status;
      if (st === "success") break;
      if (st === "error") {
        err(`server create action failed: ${a.j.action.error?.code ?? ""} ${a.j.action.error?.message ?? ""}`);
        return 1;
      }
      await sleep(2000);
    }
    log(`ok  ${s.name} is starting; cloud-init installs Docker and Tailscale and builds ${commit.slice(0, 12)} (about 5 minutes)`);
    log(`then: node scripts/live-checks/helper-host-health.mjs --commit ${commit}`);
    return 0;
  }
  err(`stopped: no type of ${TYPES.join(", ")} is available in ${LOCATION}. Another location needs a new primary IP there and a DNS change of ${HOST}; nothing else was made (firewall ${FIREWALL.name} stays, it costs nothing)`);
  return 1;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(errorLine(e));
      process.exit(2);
    },
  );
}
