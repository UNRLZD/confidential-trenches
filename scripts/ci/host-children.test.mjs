// The child-host gate (host-children.mjs) on planted trees: a child of SIGN_HOST in any served or reached place is
// refused by file and line, plain, escaped, wildcard, in capitals or built in code from SIGN_HOST; prose, written
// release lists, recorded answers and tests are not read, except under a public/ folder; the repo's own tree passes. And the hosts themselves: SIGN_HOST is the main address and the
// passkey's rp.id, APP_HOST and HELPER_HOST are siblings of it, in every place that names them (card hosts-main-on-top).
//   node --test scripts/ci/host-children.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hostChildren, SIGN_HOST } from "./host-children.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const GATE = join(ROOT, "scripts/ci/host-children.mjs");
// (joined, so this file's own text plants a child only where it means to)
const child = (label) => `${label}.${SIGN_HOST}`;
const APP = "ct-app.unrealized.trade";
const HELPER = "ct-api.unrealized.trade";

function tree(files) {
  const dir = mkdtempSync(join(tmpdir(), "host-children-"));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["add", "--", "."], { cwd: dir });
  return dir;
}
const run = (dir) => {
  try {
    return { rc: 0, out: execFileSync(process.execPath, [GATE, dir], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (e) {
    return { rc: e.status, out: `${e.stdout}${e.stderr}` };
  }
};

const GOOD = {
  // SIGN_HOST and URLs built on it, not children of it
  "packages/wallet/src/derive/constants.ts": `export const SIGN_HOST = "${SIGN_HOST}";\nexport const U = \`https://\${SIGN_HOST}/\`;\nexport const V = "https://" + SIGN_HOST;\nexport const W = [SIGN_HOST, "json"].join(".");\nexport const X = "https://".concat(SIGN_HOST);\nconst S = SIGN_HOST;\nexport const Y = \`https://\${S}/\`;\n`,
  "apps/terminal/public/_headers": `/*\n  Content-Security-Policy: connect-src 'self' https://${HELPER} https://${SIGN_HOST}; frame-ancestors https://${SIGN_HOST}\n`,
  "apps/helper/deploy/Caddyfile": `{$HELPER_SITE:${HELPER}} {\n}\n`,
  // a name that only ends like ours, and SIGN_HOST's parent, are not children
  "scripts/live-checks/x.mjs": `export const A = "https://${APP}";\nexport const o = "https://notconfidential.unrealized.trade";\nexport const p = "unrealized.trade";\n`,
  // not read: prose, a written release list, a recorded answer, a test
  "README.md": `Served at ${child("sign")}.\n`,
  "packages/signpage/releases/release-12.json": `{ "SIGN_HOST": "https://${child("sign")}" }\n`,
  "scripts/live-checks/x.answers.json": `{ "url": "https://${child("api")}/v1/health" }\n`,
  "packages/kit/test/client.test.mjs": `const evil = "https://${child("evil")}";\n`,
  "scripts/live-checks/x.run.json": `{ "rpc": "https://${child("api")}/v1/rpc/solana" }\n`,
  "packages/kit/test/fixtures/x.json": `{ "source": "read through https://${child("api")}" }\n`,
  "apps/terminal/test/pads/x.json": `{ "read": "GET https://${child("api")}/v1/market/lists" }\n`,
};

test("the repo's own tree passes", () => {
  const r = run(ROOT);
  assert.equal(r.rc, 0, r.out);
  assert.match(r.out, /^host-children: OK \(\d+ file\(s\) read, no child of confidential\.unrealized\.trade\)/m);
});

test("a tree with SIGN_HOST, its siblings and children only where they are not read passes", () => {
  const dir = tree(GOOD);
  try {
    const r = run(dir);
    assert.equal(r.rc, 0, r.out);
    assert.match(r.out, /host-children: OK \(4 file\(s\) read/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const PLANTED = {
  "packages/wallet/src/derive/a1-old-sign.ts": [`export const SIGN_HOST = "${child("sign")}";\n`, /a1-old-sign\.ts:1: sign\.confidential\.unrealized\.trade is a child/],
  "apps/helper/deploy/a2-Caddyfile": [`# the helper\n{$HELPER_SITE:${child("api")}} {\n}\n`, /a2-Caddyfile:2: api\.confidential\.unrealized\.trade is a child/],
  "apps/terminal/public/a3_headers": [`/*\n  Content-Security-Policy: frame-ancestors https://*.${SIGN_HOST}\n`, /a3_headers:2: \*\.confidential\.unrealized\.trade is a child/],
  "scripts/live-checks/a4-escaped.mjs": [`export const R = /^https:\\/\\/app\\.confidential\\.unrealized\\.trade$/;\n`, /a4-escaped\.mjs:1: app\.confidential\.unrealized\.trade is a child/],
  "apps/terminal/src/a5-caps.ts": [`export const U = "https://APP.CONFIDENTIAL.UNREALIZED.TRADE/";\n`, /a5-caps\.ts:1: app\.confidential\.unrealized\.trade is a child/],
  "apps/terminal/src/a7-data.json": [`{ "helper": "https://${child("api")}" }\n`, /a7-data\.json:1: api\.confidential\.unrealized\.trade is a child/],
  "packages/kit/src/a6-deep.ts": [`// a comment still names it: ${child("x.y")}\n`, /a6-deep\.ts:1: x\.y\.confidential\.unrealized\.trade is a child/],
  "scripts/live-checks/kit-freeze-helper-api.mjs": [`export const OLD = "https://${child("api")}";\n`, /kit-freeze-helper-api\.mjs:1: api\.confidential\.unrealized\.trade is a child/],
  // built in code from the constant: a template literal, a concatenation, a join, an interpolated label on a member
  "packages/signpage/src/a8-template.ts": ["import { SIGN_HOST } from \"@blindfill/kit\";\nexport const H = `https://api.${SIGN_HOST}`;\n", /a8-template\.ts:2: api\.\$\{SIGN_HOST\} is a child/],
  "packages/signpage/src/a9-concat.ts": [`export const H = "https://" + "sign." + SIGN_HOST;\n`, /a9-concat\.ts:1: "sign\." \+ SIGN_HOST is a child/],
  "packages/signpage/src/a10-join.ts": [`export const H = ["app", SIGN_HOST].join(".");\n`, /a10-join\.ts:1: \["app", SIGN_HOST\]\.join\("\."\) is a child/],
  "apps/terminal/src/a11-label.ts": [`export const h = (label: string) => \`\${label}.\${d.SIGN_HOST}\`;\n`, /a11-label\.ts:1: \$\{label\}\.\$\{d\.SIGN_HOST\} is a child/],
  // review F7: a split name, a concat call, an alias, a Python f-string, a shell variable without braces, and a suffix
  // led by a dot (written or built), which lets any child in
  "packages/signpage/src/a13-split.ts": [`export const H = "https://api." + "${SIGN_HOST}";\n`, /a13-split\.ts:1: "https:\/\/api\." \+ "confidential\.unrealized\.trade" is a child/],
  "packages/signpage/src/a14-concat.ts": [`export const H = "https://api.".concat(SIGN_HOST);\n`, /a14-concat\.ts:1: "https:\/\/api\."\.concat\(SIGN_HOST is a child/],
  "packages/signpage/src/a15-concat-args.ts": [`export const H = "".concat("api.", SIGN_HOST);\n`, /a15-concat-args\.ts:1: \.concat\("api\.", SIGN_HOST is a child/],
  "packages/signpage/src/a16-alias.ts": ["const S = SIGN_HOST;\nexport const H = `https://api.${S}`;\n", /a16-alias\.ts:2: api\.\$\{S\} is a child/],
  "scripts/a17-fstring.py": [`HOST = f"api.{SIGN_HOST}"\n`, /a17-fstring\.py:1: api\.\{SIGN_HOST\} is a child/],
  "scripts/deploy/a18-shell.sh": [`HOST="api.$SIGN_HOST"\n`, /a18-shell\.sh:1: api\.\$SIGN_HOST is a child/],
  "apps/helper/src/a19-endswith.ts": [`export const ok = (o: string) => o.endsWith(".${SIGN_HOST}");\n`, /a19-endswith\.ts:1: \.confidential\.unrealized\.trade is a suffix of SIGN_HOST/],
  "apps/helper/src/a20-regex.ts": [`export const R = /^https:\\/\\/[a-z]+\\.confidential\\.unrealized\\.trade$/;\n`, /a20-regex\.ts:1: \.confidential\.unrealized\.trade is a suffix of SIGN_HOST/],
  "apps/helper/src/a21-endswith-built.ts": ["export const ok = (o: string) => o.endsWith(`.${SIGN_HOST}`);\n", /a21-endswith-built\.ts:1: \.\$\{SIGN_HOST\} is a suffix of SIGN_HOST/],
  // test data under a public/ folder is served by Pages, so it is read
  "apps/terminal/public/fixtures/a12.json": [`{ "helper": "https://${child("api")}" }\n`, /public\/fixtures\/a12\.json:1: api\.confidential\.unrealized\.trade is a child/],
};

for (const [path, [body, want]] of Object.entries(PLANTED)) {
  test(`planted: ${path} is refused`, () => {
    const dir = tree({ ...GOOD, [path]: body });
    try {
      const r = run(dir);
      assert.equal(r.rc, 1, r.out);
      assert.match(r.out, want);
      assert.equal(r.out.split("\n").filter((l) => l.startsWith("host-children: REFUSED")).length, 1, r.out);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("the one allowed place holds only its named child: the kit tags' old SIGN_HOST origin", () => {
  const dir = tree({ ...GOOD, "scripts/live-checks/kit-freeze-helper-api.mjs": `export const OLD = ["https://${child("sign")}"];\n` });
  try {
    assert.equal(run(dir).rc, 0);
    assert.deepEqual(hostChildren(dir).refusals, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The hosts in every place that names them: one value each, the same everywhere.
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const csp = (p) => read(p).match(/^\/\*\n\s+Content-Security-Policy: (.+)$/m)[1];
const dir = (policy, name) => policy.split(";").map((d) => d.trim()).find((d) => d.split(" ")[0] === name);

test("SIGN_HOST is the main address and the passkey's rp.id; APP_HOST and HELPER_HOST are its siblings", async () => {
  const wallet = read("packages/wallet/src/derive/constants.ts");
  assert.match(wallet, new RegExp(`^export const SIGN_HOST = "${SIGN_HOST.replaceAll(".", "\\.")}";$`, "m"));
  assert.match(read("packages/wallet/src/signin/passkey.ts"), /rpId: SIGN_HOST,/);
  assert.match(read("packages/wallet/src/signin/passkey.ts"), /rp: \{ id: SIGN_HOST, name: RP_NAME \}/);
  assert.match(read("packages/signpage/src/api.ts"), new RegExp(`^export const APP_ORIGIN = "https://${APP}";$`, "m"));
  assert.match(read("apps/terminal/src/shell/signpage-frame.tsx"), new RegExp(`^export const SIGN_HOST_URL = "https://${SIGN_HOST}/";$`, "m"));
  assert.match(read("packages/kit/src/helper/v1.ts"), new RegExp(`origins: \\["https://${APP}", "https://${SIGN_HOST}"\\]`));
  assert.match(read("apps/helper/deploy/Caddyfile"), new RegExp(`^\\{\\$HELPER_SITE:${HELPER}\\} \\{$`, "m"));
  assert.match(read("apps/helper/deploy/compose.yaml"), new RegExp(`HELPER_SITE: \\$\\{HELPER_SITE:-${HELPER}\\}`));
  assert.match(read("apps/helper/deploy/create-server.mjs"), new RegExp(`^export const HOST = "${HELPER}";$`, "m"));
  for (const p of ["packages/wallet/src/withdraw/relay.ts", "packages/signpage/src/trade.ts"]) assert.match(read(p), new RegExp(`= "https://${HELPER}";`), p);
  // read as text: a file outside Blindfill reaches packages/ only through the kit's entry (check:imports)
  assert.match(read("packages/signpage/scripts/release-list.mjs"), new RegExp(`^export const HOSTS = Object\\.freeze\\(\\{ SIGN_HOST: "https://${SIGN_HOST}", APP_HOST: "https://${APP}" \\}\\);$`, "m"));
  const { ORIGINS } = await import("../live-checks/signpage-release.mjs");
  assert.deepEqual({ ...ORIGINS }, { SIGN_HOST: `https://${SIGN_HOST}`, APP_HOST: `https://${APP}` });
});

test("both CSPs: SIGN_HOST frames APP_HOST only and no page frames it; APP_HOST is framed by SIGN_HOST only", () => {
  const sign = csp("packages/signpage/public/_headers");
  assert.equal(dir(sign, "frame-src"), `frame-src https://${APP}`);
  assert.equal(dir(sign, "frame-ancestors"), "frame-ancestors 'none'");
  assert.ok(dir(sign, "connect-src").split(" ").includes(`https://${HELPER}`));
  const app = csp("apps/terminal/public/_headers");
  assert.equal(dir(app, "frame-ancestors"), `frame-ancestors https://${SIGN_HOST}`);
  assert.equal(dir(app, "frame-src"), "frame-src 'none'");
  const connect = dir(app, "connect-src").split(" ");
  for (const s of [`https://${HELPER}`, `wss://${HELPER}`, `https://${SIGN_HOST}`]) assert.ok(connect.includes(s), s);
  assert.ok(dir(app, "img-src").split(" ").includes(`https://${HELPER}`));
});
