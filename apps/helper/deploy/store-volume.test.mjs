// node --test apps/helper/deploy/store-volume.test.mjs: the relayers' durable store can open in the deployed container
// (card relayer-withdraw-fee). The helper runs read_only, so HELPER_STORE_DIR must be a named volume mounted at exactly
// that path, writable, and the image must make that folder and give it to the node user before USER node: a fresh named
// volume copies the image folder's owner, and a store that cannot open (EROFS, EACCES) stops the helper at start.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HELPER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(HELPER, p), "utf8");

/** What stops the store from opening in the deployed container, one line each; [] when nothing does. */
export function storeProblems(compose, dockerfile) {
  const out = [];
  const service = /^ {2}helper:\n([\s\S]*?)(?=^ {2}[a-z_]+:\n|^\S)/m.exec(compose)?.[1] ?? "";
  if (!/^ {4}read_only: true\s*$/m.test(service)) out.push("compose: the helper is not read_only: true");
  const dir = /^ {6}HELPER_STORE_DIR: (\/\S+)\s*$/m.exec(service)?.[1];
  if (!dir) return [...out, "compose: no absolute HELPER_STORE_DIR in the helper's environment"];
  const list = /^ {4}volumes:\n((?: {6}- .*\n)+)/m.exec(service)?.[1] ?? "";
  const mounts = [...list.matchAll(/^ {6}- (\S+)\s*$/gm)].map((m) => m[1]);
  const named = new Set([...(/^volumes:\n((?: {2}.*\n?)+)/m.exec(compose)?.[1] ?? "").matchAll(/^ {2}([a-z0-9_-]+):/gm)].map((m) => m[1]));
  const store = mounts.map((m) => m.split(":")).find(([, at]) => at === dir);
  if (!store) out.push(`compose: no volume mounted at HELPER_STORE_DIR ${dir}`);
  else {
    if (!named.has(store[0])) out.push(`compose: ${store[0]} is not a named volume of this file`);
    if (store[2] !== undefined && store[2].split(",").includes("ro")) out.push(`compose: the store volume is read-only`);
  }
  // the final stage: its RUN lines before USER node must make the folder and give it to node
  const stage = dockerfile.split(/^FROM\s.*$/m).at(-1) ?? "";
  const user = /^USER\s+node\s*$/m.exec(stage);
  if (!user) return [...out, "Dockerfile: the final stage never runs as USER node"];
  const runs = [...stage.slice(0, user.index).matchAll(/^RUN\s+(.+)$/gm)].map((m) => m[1]);
  const esc = dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!runs.some((r) => new RegExp(`\\bmkdir\\s+(?:-p\\s+)?${esc}(?:\\s|$)`).test(r))) out.push(`Dockerfile: ${dir} is not made before USER node`);
  if (!runs.some((r) => new RegExp(`\\bchown\\s+node(?::node)?\\s+${esc}(?:\\s|$)`).test(r))) out.push(`Dockerfile: ${dir} is not given to node before USER node`);
  return out;
}

test("the deploy files let the store open: read_only helper, a named volume at HELPER_STORE_DIR, the folder node's in the image", () => {
  assert.deepEqual(storeProblems(read("deploy/compose.yaml"), read("Dockerfile")), []);
});

test("planted: each setting the store needs, taken away, is caught", () => {
  const compose = read("deploy/compose.yaml");
  const docker = read("Dockerfile");
  const plant = (text, old, now) => {
    assert.equal(text.split(old).length, 2, `the plant's text is in the file once: ${old}`);
    return text.replace(old, now);
  };
  const cases = [
    [plant(docker, "RUN mkdir -p /app/data && chown node:node /app/data\n", ""), compose, /not made before USER node/],
    [plant(docker, "RUN mkdir -p /app/data && chown node:node /app/data\n", "RUN mkdir -p /app/data\n"), compose, /not given to node/],
    [plant(docker, "RUN mkdir -p /app/data && chown node:node /app/data\nUSER node\n", "USER node\nRUN mkdir -p /app/data && chown node:node /app/data\n"), compose, /not made before USER node/],
    [docker, plant(compose, "    volumes:\n      - helper_data:/app/data\n", ""), /no volume mounted at HELPER_STORE_DIR/],
    [docker, plant(compose, "      HELPER_STORE_DIR: /app/data\n", "      HELPER_STORE_DIR: /app/elsewhere\n"), /no volume mounted at HELPER_STORE_DIR \/app\/elsewhere/],
    [docker, plant(compose, "      HELPER_STORE_DIR: /app/data\n", ""), /no absolute HELPER_STORE_DIR/],
    [docker, plant(compose, "      - helper_data:/app/data\n", "      - helper_data:/app/data:ro\n"), /read-only/],
    [docker, plant(compose, "      - helper_data:/app/data\n", "      - ./data:/app/data\n"), /not a named volume/],
    [docker, plant(compose, "  helper_data: {}\n", ""), /not a named volume/],
    [docker, plant(compose, "    read_only: true\n", ""), /not read_only/],
  ];
  for (const [d, c, why] of cases) assert.match(storeProblems(c, d).join("; "), why);
});
