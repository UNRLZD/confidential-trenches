// Tests of deploy/unplug.sh, the unplug drill's off switch (card helper-unplug-off), against a `docker` on PATH that
// records every call and models each service's containers (a file per service holding running or exited).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = new URL("./unplug.sh", import.meta.url).pathname;
const COMMIT = "a".repeat(40);

// the fake docker: `compose ps [-a] -q [--status running] <svc>`, `compose stop -t N <svc>...`, `compose start <svc>`,
// `inspect -f <fmt> <id>`; STUCK names a service a stop leaves running, NEVER_READY keeps the helper's health starting
const FAKE = `#!/usr/bin/env bash
S="$FAKE_STATE"
echo "$*" >> "$S/calls"
[[ -n "$NO_DAEMON" ]] && { echo "Cannot connect to the Docker daemon" >&2; exit 1; }
if [[ "$1" == compose && "$2" == ps ]]; then
  shift 2; all=; run=; svc=
  while [[ $# -gt 0 ]]; do case "$1" in -a) all=1 ;; -q) ;; --status) shift; run=1 ;; *) svc="$1" ;; esac; shift; done
  [[ -f "$S/$svc" ]] || exit 0
  st="$(cat "$S/$svc")"
  if [[ -n "$run" || -z "$all" ]]; then [[ "$st" == running ]] && echo "id-$svc"; else echo "id-$svc"; fi
  exit 0
fi
if [[ "$1" == compose && "$2" == stop ]]; then
  shift 4
  for svc in "$@"; do [[ -f "$S/$svc" && "$svc" != "$STUCK" ]] && echo exited > "$S/$svc"; done
  exit 0
fi
if [[ "$1" == compose && "$2" == start ]]; then
  [[ -f "$S/$3" ]] && echo running > "$S/$3"
  exit 0
fi
if [[ "$1" == inspect ]]; then
  [[ -n "$NEVER_READY" ]] && echo starting || echo healthy
  exit 0
fi
echo "fake docker: unexpected $*" >&2
exit 9
`;

function run(args, { services = { helper: "running", caddy: "running" }, env = `HELPER_COMMIT=${COMMIT}\nHELPER_RELEASE=7\nJUPITER_API_KEY=planted\n`, shell = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "unplug-"));
  try {
    const deploy = join(dir, "deploy");
    const bin = join(dir, "bin");
    const state = join(dir, "state");
    for (const d of [deploy, bin, state]) spawnSync("mkdir", ["-p", d]);
    copyFileSync(SCRIPT, join(deploy, "unplug.sh"));
    chmodSync(join(deploy, "unplug.sh"), 0o755);
    if (env !== null) writeFileSync(join(deploy, ".env"), env);
    writeFileSync(join(bin, "docker"), FAKE);
    chmodSync(join(bin, "docker"), 0o755);
    for (const [s, st] of Object.entries(services)) writeFileSync(join(state, s), `${st}\n`);
    const r = spawnSync("bash", [join(deploy, "unplug.sh"), ...args], {
      encoding: "utf8",
      env: { PATH: `${bin}:/usr/bin:/bin`, FAKE_STATE: state, ...shell },
      timeout: 30_000,
    });
    const read = (f) => (existsSync(f) ? readFileSync(f, "utf8") : "");
    return {
      code: r.status,
      out: r.stdout + r.stderr,
      calls: read(join(state, "calls")).trim().split("\n").filter(Boolean),
      states: Object.fromEntries(Object.keys(services).map((s) => [s, read(join(state, s)).trim()])),
      envAfter: env === null ? null : read(join(deploy, ".env")),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("off stops the helper and Caddy, removes nothing, leaves deploy/.env byte for byte, and reads both back as stopped", () => {
  const env = `HELPER_COMMIT=${COMMIT}\nHELPER_RELEASE=7\nJUPITER_API_KEY=planted\n`;
  const r = run(["off"], { env });
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.states, { helper: "exited", caddy: "exited" });
  assert.ok(r.calls.includes("compose stop -t 30 helper caddy"), r.calls.join("\n"));
  assert.ok(!r.calls.some((c) => /\b(down|rm|kill|up)\b/.test(c)), `no container removed or made: ${r.calls.join("; ")}`);
  assert.equal(r.envAfter, env);
  assert.match(r.out, /unplug: helper stopped\nunplug: caddy stopped\nunplug: off, no server of the stack runs/);
  assert.doesNotMatch(r.out, /planted/);
});

test("off fails, naming the service, when a container still runs after the stop", () => {
  const r = run(["off"], { shell: { STUCK: "caddy" } });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /still running after the stop: caddy/);
});

test("on starts the helper, waits for its ready health, then starts Caddy", () => {
  const r = run(["on"], { services: { helper: "exited", caddy: "exited" } });
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.states, { helper: "running", caddy: "running" });
  const order = r.calls.filter((c) => /^compose start|^inspect/.test(c));
  assert.deepEqual(order, ["compose start helper", "inspect -f {{.State.Health.Status}} id-helper", "compose start caddy"]);
  assert.match(r.out, new RegExp(`on, the helper ready at ${COMMIT} behind Caddy`));
});

test("on leaves Caddy stopped when the helper is not ready inside UNPLUG_READY_S", () => {
  const r = run(["on"], { services: { helper: "exited", caddy: "exited" }, shell: { NEVER_READY: "1", UNPLUG_READY_S: "1" } });
  assert.equal(r.code, 1, r.out);
  assert.equal(r.states.caddy, "exited");
  assert.ok(!r.calls.includes("compose start caddy"), r.calls.join("; "));
  assert.match(r.out, /not ready after 1 s; Caddy left stopped/);
});

test("on refuses when no helper container exists, naming redeploy.sh, and starts nothing", () => {
  const r = run(["on"], { services: { caddy: "exited" } });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /redeploy\.sh <commit>/);
  assert.ok(!r.calls.some((c) => c.startsWith("compose start")), r.calls.join("; "));
});

test("a missing or malformed HELPER_COMMIT, a bad argument or a bad UNPLUG_READY_S changes nothing (exit 2, no docker call)", () => {
  for (const [args, opts] of [
    [["off"], { env: null }],
    [["off"], { env: "HELPER_COMMIT=main\n" }],
    [["stop"], {}],
    [["off", "now"], {}],
    [["on"], { shell: { UNPLUG_READY_S: "0" } }],
  ]) {
    const r = run(args, opts);
    assert.equal(r.code, 2, `${args.join(" ")}: ${r.out}`);
    assert.deepEqual(r.calls, [], `${args.join(" ")}: ${r.calls.join("; ")}`);
  }
});

test("HELPER_COMMIT from the shell is taken as compose takes it (the local proof's stack has no deploy/.env)", () => {
  const r = run(["status"], { env: null, shell: { HELPER_COMMIT: COMMIT } });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /unplug: helper running\nunplug: caddy running/);
});

test("a Docker that does not answer is never read as a stack that is off: status, off and on each exit 1 (the first proof run, Docker not running: status said \"helper none\", exit 0)", () => {
  for (const cmd of ["status", "off", "on"]) {
    const r = run([cmd], { shell: { NO_DAEMON: "1" } });
    assert.equal(r.code, 1, `${cmd}: ${r.out}`);
    assert.doesNotMatch(r.out, /unplug: (helper|caddy) none|off, no server/, `${cmd}: ${r.out}`);
  }
});
