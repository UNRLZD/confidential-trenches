// Card kit-on-npm: scripts/publish.mjs refuses before npm runs with no Keychain item named, on a failed pack-check, a HEAD off origin/main, a tree
// that is not HEAD's, a version already on the registry and a registry answer it cannot read, and with no token; when
// it runs npm, the token is only in a mode-600 npmrc that is gone after, also when npm fails, and never in its log.
//   node --test test/publish-script.test.mjs      (from packages/kit)
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { test } from "node:test";
import { npmEnv, publish, PublishRefused } from "../scripts/publish.mjs";

const TOKEN = "npm_" + "x".repeat(36); // a stand-in, no real token
const HEAD = "a".repeat(40);
const SERVICE = "kit-npm-test"; // a stand-in item name

function deps(over = {}) {
  const seen = { logs: [], npm: [], tokenReads: 0 };
  const d = {
    packCheck: async (out) => ({ ok: true, lines: ["ok  packed"], tarball: `${out}/blindfill-kit-0.1.0.tgz`, integrity: "sha512-Zm9v" }),
    git: (args) => {
      if (args[0] === "rev-parse") return args[1] === "HEAD" ? HEAD : "b".repeat(40);
      if (args[0] === "status") return "";
      return "";
    },
    manifest: async () => ({ status: 404, body: '{"error":"Not found"}' }),
    readToken: (service) => (seen.tokenReads++, assert.equal(service, SERVICE), TOKEN),
    npm: (args, opts) => {
      const rc = args[args.indexOf("--userconfig") + 1];
      seen.npm.push({ args, cwd: opts.cwd, env: opts.env, rc, rcText: readFileSync(rc, "utf8"), rcMode: statSync(rc).mode & 0o777 });
    },
    version: () => "0.1.0",
    log: (s) => seen.logs.push(s),
    ...over,
  };
  return { d, seen };
}

async function refused(over, re) {
  const { d, seen } = deps(over);
  await assert.rejects(publish({ d, keychainService: SERVICE }), (e) => e instanceof PublishRefused && re.test(e.message));
  assert.equal(seen.npm.length, 0, "npm never ran");
  return seen;
}

test("no --keychain-service, or a name that is not one: refused before anything runs", async () => {
  for (const keychainService of [undefined, "", "a b", "x;rm"]) {
    const { d, seen } = deps({ packCheck: async () => assert.fail("pack-check ran") });
    await assert.rejects(publish({ d, keychainService }), (e) => e instanceof PublishRefused && /--keychain-service <name> is required/.test(e.message));
    assert.equal(seen.tokenReads + seen.npm.length, 0);
  }
});

test("a failed pack-check: refused before git, the registry or the Keychain", async () => {
  const seen = await refused({ packCheck: async () => ({ ok: false, lines: ["BAD plain node import"], tarball: "/x.tgz" }), git: () => assert.fail("git ran") }, /pack-check failed/);
  assert.equal(seen.tokenReads, 0);
});

test("HEAD not on origin/main: refused", async () => {
  const git = (args) => {
    if (args[0] === "merge-base") throw new Error("exit 1");
    return args[0] === "rev-parse" ? HEAD : "";
  };
  const seen = await refused({ git }, /is not on origin\/main/);
  assert.equal(seen.tokenReads, 0);
});

test("a tree that differs from HEAD under the kit, the wallet's source or the lockfile: refused", async () => {
  const calls = [];
  const git = (args) => (calls.push(args), args[0] === "status" ? " M packages/wallet/src/derive/keys.ts" : args[0] === "rev-parse" ? HEAD : "");
  await refused({ git }, /the tree differs from HEAD in 1 paths/);
  assert.deepEqual(calls.find((a) => a[0] === "status"), ["status", "--porcelain", "--", "packages/kit", "packages/wallet/src", "pnpm-lock.yaml"]);
  assert.deepEqual(calls[0], ["fetch", "--quiet", "origin", "main"]);
});

test("the version already on the registry: refused", async () => {
  const manifest = async () => ({ status: 200, body: JSON.stringify({ name: "@blindfill/kit", versions: { "0.1.0": {} } }) });
  const seen = await refused({ manifest }, /@blindfill\/kit@0\.1\.0 is already on the registry/);
  assert.equal(seen.tokenReads, 0);
});

test("a registry answer that is neither the manifest nor a 404: refused", async () => {
  await refused({ manifest: async () => ({ status: 503, body: "" }) }, /answered 503/);
});

test("no token in the Keychain, or an empty one: refused", async () => {
  await refused({ readToken: () => { throw new Error("security: item not found"); } }, /no npm token in the Keychain under kit-npm-test/);
  await refused({ readToken: () => "" }, /no npm token/);
});

for (const dryRun of [true, false]) {
  test(`${dryRun ? "--dry-run" : "a publish"}: npm publish of pack-check's tarball, the token only in a mode-600 npmrc gone after`, async () => {
    const { d, seen } = deps();
    const env = { PATH: "/usr/bin", npm_config_registry: "https://evil.example/", NPM_CONFIG_USERCONFIG: "/home/x/.npmrc" };
    const r = await publish({ dryRun, d, env, keychainService: SERVICE });
    assert.equal(r.version, "0.1.0");
    assert.equal(seen.npm.length, 1);
    const [call] = seen.npm;
    assert.match(call.args[1], /\/pack\/blindfill-kit-0\.1\.0\.tgz$/);
    assert.deepEqual(call.args.slice(2, 4), ["--access", "public"]);
    assert.equal(call.args.includes("--dry-run"), dryRun);
    assert.equal(call.rcText, `registry=https://registry.npmjs.org/\n//registry.npmjs.org/:_authToken=${TOKEN}\n`);
    assert.equal(call.rcMode, 0o600);
    assert.equal(call.env.npm_config_registry, undefined);
    assert.equal(call.env.NPM_CONFIG_USERCONFIG, call.rc);
    assert.equal(existsSync(call.rc), false, "the npmrc is deleted");
    assert.equal(existsSync(call.cwd), false, "the temp folder is deleted");
    assert.ok(!seen.logs.join("\n").includes(TOKEN), "the token is never logged");
    assert.match(seen.logs.at(-1), dryRun ? /^dry run: @blindfill\/kit@0\.1\.0 not published$/ : /kit-on-npm\.mjs --integrity sha512-Zm9v$/);
  });
}

test("npm fails: the npmrc is still deleted and the error names no token", async () => {
  let rc = "";
  const { d } = deps({
    npm: (args) => {
      rc = args[args.indexOf("--userconfig") + 1];
      throw new Error(`Command failed: npm ${args.join(" ")}`);
    },
  });
  await assert.rejects(publish({ d, keychainService: SERVICE }), (e) => !String(e.message).includes(TOKEN));
  assert.ok(rc);
  assert.equal(existsSync(rc), false);
});

test("npmEnv drops every npm_config_* a parent set and points npm at the temp npmrc", () => {
  assert.deepEqual(npmEnv({ HOME: "/h", npm_config_registry: "x", NPM_CONFIG__AUTH: "y" }, "/t/npmrc"), { HOME: "/h", NPM_CONFIG_USERCONFIG: "/t/npmrc" });
});
