// node --test apps/helper/deploy/create-server.test.mjs: the create script's --dry-run sends nothing and reads no
// token; its live path, against a recorded-shape fake of the Hetzner API, makes exactly the planned server and never
// prints the token or the root password.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { FIREWALL, PRIMARY_IP, TYPES, cloudInit, errorLine, main, plan, readToken } from "./create-server.mjs";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const TOKEN = "planted-token-0f9e8d7c6b5a";
const ROOTPW = "planted-root-password-1a2b3c";

const capture = () => {
  const out = [];
  return { out, log: (s) => out.push(String(s)), err: (s) => out.push(String(s)) };
};

test("--dry-run makes no network call and reads no token, and prints the whole plan", async () => {
  const c = capture();
  let calls = 0;
  let reads = 0;
  const code = await main(["--commit", COMMIT, "--dry-run"], { fetch: async () => (calls++, new Response("{}")), token: () => (reads++, TOKEN), ...c });
  assert.equal(code, 0);
  assert.equal(calls, 0);
  assert.equal(reads, 0);
  const text = c.out.join("\n");
  for (const want of ['"location": "fsn1"', '"image": "ubuntu-24.04"', '"server_type": "cx23"', `"ipv4": ${PRIMARY_IP.id}`, '"enable_ipv6": false',
    '"port": "80"', '"port": "443"', "#cloud-config", `COMMIT=${COMMIT}`, "docker compose up -d --build", "apt-get install -y docker-ce", "tailscale",
    "dry run: no network call made, no token read"]) assert.ok(text.includes(want), want);
  assert.ok(!text.includes("tailscale up"), "the tailnet join is a manual step");
});

test("the plan: inbound 80 and 443 only (public 22 closed), fsn1 on the primary IP, CX23 first", () => {
  const p = plan(COMMIT);
  assert.deepEqual(FIREWALL.rules.map((r) => `${r.direction} ${r.protocol} ${r.port}`), ["in tcp 80", "in tcp 443", "in udp 443"]);
  assert.equal(TYPES[0], "cx23");
  for (const s of p.servers) {
    assert.equal(s.location, "fsn1");
    assert.deepEqual(s.public_net, { enable_ipv4: true, enable_ipv6: false, ipv4: 159313479 });
    assert.ok(Buffer.byteLength(s.user_data) < 32 * 1024, "Hetzner's user_data limit");
  }
  assert.throws(() => cloudInit("main"), /40-hex/);
});

test("a bad or missing commit is a usage error and sends nothing", async () => {
  for (const argv of [[], ["--commit"], ["--commit", "abc123"], ["--commit", COMMIT.toUpperCase(), "--dry-run"]]) {
    let calls = 0;
    const c = capture();
    assert.equal(await main(argv, { fetch: async () => (calls++, new Response("{}")), token: () => TOKEN, ...c }), 2);
    assert.equal(calls, 0);
  }
});

test("the token comes from HCLOUD_TOKEN only; without it the live run refuses before any call to Hetzner", async () => {
  assert.equal(readToken({ HCLOUD_TOKEN: ` ${TOKEN}\n` }), TOKEN);
  assert.equal(readToken({}), "");
  assert.equal(readToken({ HCLOUD_TOKEN: "  " }), "");
  const { fetch, sent } = fakeApi();
  const c = capture();
  const code = await main(["--commit", COMMIT], { fetch, token: () => readToken({}), sleep: async () => {}, ...c });
  assert.equal(code, 1);
  assert.deepEqual(sent.map((s) => s.url), [`https://raw.githubusercontent.com/UNRLZD/confidential-trenches/${COMMIT}/apps/helper/Dockerfile`]);
  assert.equal(c.out.join("\n"), "refused: HCLOUD_TOKEN is not set; set it to the Hetzner project's API token");
});

test("run as a script without HCLOUD_TOKEN, it refuses after the GitHub check and calls Hetzner never", () => {
  const stub = "globalThis.fetch=async(u)=>{if(String(u).startsWith('https://raw.githubusercontent.com/'))return new Response(null,{status:200});throw new Error('called '+u)}";
  const { HCLOUD_TOKEN: _, ...env } = process.env;
  const r = spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(stub)}`, new URL("./create-server.mjs", import.meta.url).pathname, "--commit", COMMIT], { encoding: "utf8", env, timeout: 30_000 });
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.stderr.trim(), "refused: HCLOUD_TOKEN is not set; set it to the Hetzner project's API token");
});

// a fake Hetzner API: the primary IP free, no server, no firewall; cx23 unavailable, cax11 made
function fakeApi({ assigned = null, existing = [], cx23 = "resource_unavailable" } = {}) {
  const sent = [];
  const fetch = async (url, init = {}) => {
    const method = init.method ?? "GET";
    sent.push({ url, method, body: init.body ? JSON.parse(init.body) : undefined, auth: init.headers?.authorization });
    const j = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.startsWith("https://raw.githubusercontent.com/")) return new Response(null, { status: 200 });
    const path = url.replace("https://api.hetzner.cloud/v1", "");
    if (path === `/primary_ips/${PRIMARY_IP.id}`) return j(200, { primary_ip: { id: PRIMARY_IP.id, ip: PRIMARY_IP.ip, type: "ipv4", assignee_id: assigned, location: { name: "fsn1" } } });
    if (path === "/servers?name=ct-helper") return j(200, { servers: existing });
    if (path === "/firewalls?name=ct-helper-web") return j(200, { firewalls: [] });
    if (path === "/firewalls" && method === "POST") return j(201, { firewall: { id: 77, ...JSON.parse(init.body) }, actions: [] });
    if (path === "/servers" && method === "POST") {
      const b = JSON.parse(init.body);
      if (b.server_type === "cx23" && cx23) return j(412, { error: { code: cx23, message: "server type cx23 unavailable" } });
      return j(201, { server: { id: 99, name: b.name, public_net: { ipv4: { ip: PRIMARY_IP.ip } } }, action: { id: 5, status: "running" }, root_password: ROOTPW, next_actions: [] });
    }
    if (path === "/actions/5") return j(200, { action: { id: 5, status: "success" } });
    return j(404, { error: { code: "not_found", message: path } });
  };
  return { fetch, sent };
}

test("live path: checks the commit, the IP, no duplicate, makes the firewall, skips an unavailable type; no secret printed", async () => {
  const { fetch, sent } = fakeApi();
  const c = capture();
  const code = await main(["--commit", COMMIT], { fetch, token: () => TOKEN, sleep: async () => {}, ...c });
  assert.equal(code, 0, c.out.join("\n"));
  assert.equal(sent[0].url, `https://raw.githubusercontent.com/UNRLZD/confidential-trenches/${COMMIT}/apps/helper/Dockerfile`);
  assert.equal(sent[0].auth, undefined, "the token goes only to Hetzner");
  const posts = sent.filter((s) => s.method === "POST");
  assert.deepEqual(posts.map((s) => s.url.split("/v1")[1] + " " + (s.body.server_type ?? s.body.name)), ["/firewalls ct-helper-web", "/servers cx23", "/servers cax11"]);
  assert.deepEqual(posts[2].body.firewalls, [{ firewall: 77 }]);
  assert.ok(sent.every((s) => s.url.startsWith("https://raw.githubusercontent.com/") || s.auth === `Bearer ${TOKEN}`));
  assert.ok(sent.every((s) => s.method === "GET" || s.method === "HEAD" || s.method === "POST"), "nothing changed or deleted");
  const text = c.out.join("\n");
  assert.ok(!text.includes(TOKEN) && !text.includes(ROOTPW), text);
  assert.match(text, /cx23 in fsn1 unavailable/);
  assert.match(text, /server ct-helper made: id 99, cax11 in fsn1, 91\.99\.5\.177/);
});

test("live path refuses before making anything: the IP already assigned, a ct-helper already there", async () => {
  for (const opt of [{ assigned: 123 }, { existing: [{ id: 5, name: "ct-helper" }] }]) {
    const { fetch, sent } = fakeApi(opt);
    const c = capture();
    assert.equal(await main(["--commit", COMMIT], { fetch, token: () => TOKEN, sleep: async () => {}, ...c }), 1);
    assert.equal(sent.filter((s) => s.method === "POST").length, 0, JSON.stringify(opt));
    assert.match(c.out.join("\n"), /^refused: /m);
  }
});

test("live path stops when every type in fsn1 is unavailable, naming the DNS change", async () => {
  const { fetch } = fakeApi();
  const all = async (url, init) => {
    if (init?.method === "POST" && url.endsWith("/servers")) return new Response(JSON.stringify({ error: { code: "resource_unavailable", message: "no" } }), { status: 412 });
    return fetch(url, init);
  };
  const c = capture();
  assert.equal(await main(["--commit", COMMIT], { fetch: all, token: () => TOKEN, sleep: async () => {}, ...c }), 1);
  assert.match(c.out.join("\n"), /a DNS change of api\.confidential\.unrealized\.trade/);
});

test("importing the script from a process whose argv[1] is not a file runs nothing and does not throw", () => {
  const url = new URL("./create-server.mjs", import.meta.url).href;
  const r = spawnSync(process.execPath, ["-e", `import(${JSON.stringify(url)}).then((m) => process.stdout.write(m.cloudInit(process.argv[1]).split("\\n")[0]))`, COMMIT], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "#cloud-config");
});

// the 1 Nov 04:36Z failure: "create-server: ERROR: fetch failed", with nothing to say where or why
const timedOut = () => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" }) });

test("a connection that fails names the step it was on and the cause code", async () => {
  const { fetch } = fakeApi();
  const failAt = (needle) => async (url, init) => {
    if (url.includes(needle)) throw timedOut();
    return fetch(url, init);
  };
  for (const [needle, step] of [["raw.githubusercontent.com", "1 Dockerfile on GitHub"], ["/primary_ips/", "2 primary IP"], ["/servers?name", "3 server name"], ["/firewalls?name", "4 firewall"]]) {
    const e = await main(["--commit", COMMIT], { fetch: failAt(needle), token: () => TOKEN, sleep: async () => {}, ...capture() }).then(() => null, (x) => x);
    assert.equal(e?.step, step, needle);
    assert.equal(errorLine(e), `create-server: ERROR: fetch failed (step: ${step}, cause: ETIMEDOUT)`);
  }
  assert.equal(errorLine(new Error("boom")), "create-server: ERROR: boom (step: start)");
  assert.ok(!errorLine(timedOut()).includes(TOKEN));
});

test("run as a script, a failed connection prints that line and exits 2", () => {
  const stub = "globalThis.fetch=async()=>{throw Object.assign(new TypeError('fetch failed'),{cause:Object.assign(new Error('x'),{code:'ETIMEDOUT'})})}";
  const r = spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(stub)}`, new URL("./create-server.mjs", import.meta.url).pathname, "--commit", COMMIT], { encoding: "utf8", timeout: 30_000 });
  assert.equal(r.status, 2);
  assert.equal(r.stderr.trim(), "create-server: ERROR: fetch failed (step: 1 Dockerfile on GitHub, cause: ETIMEDOUT)");
});
