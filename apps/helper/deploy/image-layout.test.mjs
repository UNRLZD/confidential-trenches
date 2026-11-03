// node --test apps/helper/deploy/image-layout.test.mjs: the helper image's files, laid out on disk the way compose.yaml
// builds the image (its build context and Dockerfile, the context's .dockerignore, each stage's COPY lines and its
// `pnpm install`), and then every helper module imported there with the image's working directory, as `node
// src/server.ts` would. A module that needs a file or a package the image lacks fails here, before a deploy (card
// helper-image-workspace: on main a5097ca, src/withdraw/checks.ts failed with ERR_MODULE_NOT_FOUND).
// Only the RUN lines that hold `pnpm install` run here, with this machine's pnpm, which must be packageManager's.
// The install reads this repository's own pnpm store first (npm_config_store_dir, npm_config_prefer_offline): the
// repository's `pnpm install --frozen-lockfile` has just filled it with every package the lockfile names, so on a
// machine with no route out (a reviewer's) the same install, from the same lockfile and its integrity hashes, needs no
// network. A package the store lacks is still fetched. It stays a default test, with the same assertions: it is the
// helper's only guard against an image that cannot start, and it costs about a second.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, globSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { IMAGE_INPUTS } from "./image-inputs.mjs";

const DEPLOY = path.dirname(fileURLToPath(import.meta.url));
const ROOT = execFileSync("git", ["-C", DEPLOY, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const STORE = execFileSync("pnpm", ["store", "path"], { cwd: ROOT, encoding: "utf8" }).trim();

/** compose.yaml's build of the helper service: the context folder and the Dockerfile in it. */
export function composeBuild(yml) {
  const block = /^ {2}helper:\n {4}build:\n((?: {6}.*\n|\s*#.*\n)+)/m.exec(yml);
  assert.ok(block, "compose.yaml: no build block under services.helper");
  const field = (k) => new RegExp(`^ {6}${k}:\\s*(\\S+)\\s*$`, "m").exec(block[1])?.[1];
  const context = path.resolve(DEPLOY, field("context") ?? ".");
  return { context, dockerfile: path.resolve(context, field("dockerfile") ?? "Dockerfile") };
}

/** One .dockerignore line as a regex, with Docker's rules: `*` and `?` stay in one folder, `**` crosses folders. */
function globRe(p) {
  let r = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "*" && p[i + 1] === "*") {
      i++;
      if (p[i + 1] === "/") {
        i++;
        r += "(?:.*/)?";
      } else r += ".*";
    } else if (c === "*") r += "[^/]*";
    else if (c === "?") r += "[^/]";
    else r += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${r}$`);
}

/** The context's .dockerignore as a test: a path is left out when the last line that matches it, or a folder above it, is not a `!` line. */
export function ignoreRules(text) {
  const rules = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => ({ keep: l.startsWith("!"), re: globRe(l.replace(/^!/, "").replace(/^\/+|\/+$/g, "")) }));
  return (file) => {
    const parts = file.split("/");
    let out = false;
    for (const { keep, re } of rules) {
      for (let k = parts.length; k >= 1; k--) {
        if (re.test(parts.slice(0, k).join("/"))) {
          out = !keep;
          break;
        }
      }
    }
    return out;
  };
}

/** The Dockerfile's instructions, continuation lines joined, comments left out. */
function instructions(text) {
  return text
    .replace(/\\\r?\n/g, " ")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => {
      const [op, ...rest] = l.split(/\s+/);
      return { op: op.toUpperCase(), args: rest, text: l.slice(op.length).trim() };
    });
}

/**
 * Lays out every stage of the Dockerfile in `out`, one folder per stage, from the context's files that .dockerignore
 * lets in (the tracked ones: the server builds a fresh checkout). Returns the last stage's folder, working directory
 * and CMD.
 */
export function layout({ context, dockerfile }, out) {
  const ignored = ignoreRules(existsSync(path.join(context, ".dockerignore")) ? readFileSync(path.join(context, ".dockerignore"), "utf8") : "");
  const files = execFileSync("git", ["-C", context, "ls-files", "-z", "."], { encoding: "utf8" })
    .split("\0")
    .filter((f) => f && !ignored(f) && existsSync(path.join(context, f)));
  const stages = [];
  const sources = new Set();
  const byName = new Map();
  let st;
  for (const { op, args, text } of instructions(readFileSync(dockerfile, "utf8"))) {
    if (op === "FROM") {
      st = { dir: path.join(out, `stage${stages.length}`), cwd: "/", cmd: null };
      mkdirSync(st.dir, { recursive: true });
      stages.push(st);
      const as = args.findIndex((a) => a.toUpperCase() === "AS");
      if (as >= 0) byName.set(args[as + 1], st);
    } else if (op === "WORKDIR") {
      st.cwd = path.posix.resolve(st.cwd, args[0]);
      mkdirSync(path.join(st.dir, st.cwd), { recursive: true });
    } else if (op === "COPY") {
      const from = args.find((a) => a.startsWith("--from="))?.slice("--from=".length);
      const rest = args.filter((a) => !a.startsWith("--"));
      const dest = rest.pop();
      const destAbs = path.posix.resolve(st.cwd, dest);
      for (const src of rest) {
        const s = src.replace(/\/+$/, "").replace(/^\.\//, "");
        if (from !== undefined) {
          const fromStage = byName.get(from) ?? stages[Number(from)];
          assert.ok(fromStage, `COPY --from=${from}: no such stage`);
          const at = path.join(fromStage.dir, s);
          assert.ok(existsSync(at), `COPY --from=${from} ${src}: not in that stage`);
          const target = lstatSync(at).isDirectory() || dest.endsWith("/") ? path.join(st.dir, destAbs, lstatSync(at).isDirectory() ? "" : path.basename(s)) : path.join(st.dir, destAbs);
          cpSync(at, target, { recursive: true, verbatimSymlinks: true });
          continue;
        }
        sources.add(s);
        const matched = files.filter((f) => f === s || s === "." || f.startsWith(`${s}/`));
        assert.ok(matched.length, `COPY ${src}: nothing in the build context (left out by .dockerignore, or missing)`);
        for (const f of matched) {
          const isDir = s === "." || f !== s;
          const rel = isDir ? (s === "." ? f : f.slice(s.length + 1)) : dest.endsWith("/") || rest.length > 1 ? path.basename(f) : "";
          const target = path.join(st.dir, destAbs, rel);
          mkdirSync(path.dirname(target), { recursive: true });
          cpSync(path.join(context, f), target);
        }
      }
    } else if (op === "RUN") {
      for (const seg of text.split("&&").map((x) => x.trim())) {
        if (!/^pnpm install\b/.test(seg)) continue;
        execFileSync("sh", ["-c", seg], { cwd: path.join(st.dir, st.cwd), stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CI: "true", npm_config_store_dir: STORE, npm_config_prefer_offline: "true" } });
      }
    } else if (op === "CMD") {
      st.cmd = JSON.parse(text);
    }
  }
  const last = stages.at(-1);
  return { dir: last.dir, cwd: path.join(last.dir, last.cwd), cmd: last.cmd, sources: [...sources] };
}

let tmp;
let image;
let build;
before(() => {
  const pm = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).packageManager;
  const have = execFileSync("pnpm", ["--version"], { encoding: "utf8" }).trim();
  assert.equal(`pnpm@${have}`, pm, "this machine's pnpm must be the root packageManager's, as the image's corepack pins it");
  tmp = mkdtempSync(path.join(tmpdir(), "helper-image-"));
  build = composeBuild(readFileSync(path.join(DEPLOY, "compose.yaml"), "utf8"));
  image = layout(build, tmp);
});
after(() => tmp && rmSync(tmp, { recursive: true, force: true }));

test("every helper module in the image imports from the image's working directory, as `node src/server.ts` runs", () => {
  assert.deepEqual(image.cmd, ["node", "src/server.ts"]);
  const modules = globSync("src/**/*.ts", { cwd: image.cwd }).sort();
  assert.ok(modules.includes(path.join("src", "server.ts")), modules.join());
  assert.ok(modules.includes(path.join("src", "withdraw", "checks.ts")), modules.join());
  const script = `const out = {};
for (const m of ${JSON.stringify(modules)}) {
  try { await import(new URL(m, "file://" + process.cwd() + "/").href); out[m] = "ok"; }
  catch (e) { out[m] = (e && e.code ? e.code + ": " : "") + String(e && e.message).split("\\n")[0]; }
}
console.log(JSON.stringify(out));`;
  const env = { PATH: process.env.PATH, NODE_ENV: "production" };
  const got = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], { cwd: image.cwd, env, encoding: "utf8" }));
  assert.deepEqual(got, Object.fromEntries(modules.map((m) => [m, "ok"])));
});

test("the image holds the helper, the kit and their libraries only: no test, fixture, deploy file or dev dependency", () => {
  // every file outside node_modules (a walk that follows no link)
  const own = [];
  const walk = (rel) => {
    for (const e of readdirSync(path.join(image.dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (e.name !== "node_modules") walk(r);
      } else own.push(r);
    }
  };
  walk("");
  const allowed = /^app\/(apps\/helper|packages\/kit)\/(package\.json|src\/.+)$/;
  assert.deepEqual(own.filter((f) => !allowed.test(f)), []);
  assert.deepEqual(own.filter((f) => /\.test\.|\/fixtures\/|(^|\/)\.env|\.pem$/.test(f)), []);
  // every dev dependency of the root, the helper and the kit, at its pinned version, is absent from the store
  const at = path.join(image.dir, "app/node_modules/.pnpm");
  const store = existsSync(at) ? readdirSync(at) : [];
  const dev = ["package.json", "apps/helper/package.json", "packages/kit/package.json"].flatMap((p) =>
    Object.entries(JSON.parse(readFileSync(path.join(ROOT, p), "utf8")).devDependencies ?? {}).map(([n, v]) => `${n.replace("/", "+")}@${v}`),
  );
  assert.ok(dev.length >= 5, dev.join());
  assert.deepEqual(dev.filter((d) => store.some((s) => s === d || s.startsWith(`${d}_`))), []);
  assert.ok(store.some((s) => s.startsWith("@noble+curves@2.4.0")), store.join());
});

test("the build context's .dockerignore keeps out secrets, the repo's history, tests and every other package", () => {
  const ignored = ignoreRules(readFileSync(path.join(build.context, ".dockerignore"), "utf8"));
  const rel = (p) => path.relative(build.context, path.join(ROOT, p)).split(path.sep).join("/");
  for (const p of [".env", "apps/helper/deploy/.env", "apps/helper/src/.env", "apps/helper/src/withdraw/.env.local", "key.pem", ".git/config", "node_modules/x/index.js", "apps/helper/node_modules/x", "apps/terminal/src/main.tsx", "packages/wallet/src/index.ts", "packages/kit/test/a.test.ts", "packages/kit/zk/withdraw.zkey", "apps/helper/src/server.test.ts", "apps/helper/src/withdraw/fixtures/withdraw-request.json", "apps/helper/tsconfig.json"])
    assert.equal(ignored(rel(p)), true, `${p} must stay out`);
  for (const p of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "apps/helper/package.json", "apps/helper/src/server.ts", "apps/helper/src/withdraw/withdraw.vkey", "packages/kit/package.json", "packages/kit/src/index.ts"])
    assert.equal(ignored(rel(p)), false, `${p} must be in`);
});

test("IMAGE_INPUTS is the image's inputs: every COPY source, the Dockerfile and .dockerignore lie under it, and each entry covers one", () => {
  const rel = (abs) => path.relative(ROOT, abs).split(path.sep).join("/");
  const inputs = [...image.sources.map((s) => rel(path.join(build.context, s))), rel(build.dockerfile), rel(path.join(build.context, ".dockerignore"))];
  const under = (p, i) => p === i || p.startsWith(`${i}/`);
  assert.deepEqual(inputs.filter((p) => !IMAGE_INPUTS.some((i) => under(p, i))), [], "a COPY source outside IMAGE_INPUTS");
  assert.deepEqual(IMAGE_INPUTS.filter((i) => !inputs.some((p) => under(p, i))), [], "an IMAGE_INPUTS entry that is no input");
});
