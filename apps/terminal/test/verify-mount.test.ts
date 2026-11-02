// Verify mounted (card app-verify-mount): the release's pins and pairs, the build's network, and the live read
// (src/screens/verify/live.ts) on a test double that answers from a recording (verify-mount/answers.json: the testnet
// vault read on its pair by verify-mount/record.ts). A refused pair, the other network's pair, a failed read and a
// network with no vault each draw every check Unverified, with the reason on the console only.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { nearPairNetwork, nearPairRule, VAULT_TOKEN_CODE_HASH } from "@blindfill/kit";
import { headersFor, MAINNET_RPCS, nearNetwork, networkOf, TESTNET_RPCS } from "../build/network.mjs";
import { liveVerify } from "../src/screens/verify/live.ts";
import type { VerifyView } from "../src/screens/verify/model.ts";
import { buildNetwork, VERIFY_RELEASES, type VerifyRelease } from "../src/screens/verify/release.ts";

const REC = JSON.parse(readFileSync(new URL("./verify-mount/answers.json", import.meta.url), "utf8")) as { rpcs: string[]; view: VerifyView; answers: { url: string; params: unknown; answer: unknown }[] };
const TESTNET = VERIFY_RELEASES.testnet;

/** The test double: answers a request from the recording by its URL and params; any other request fails. */
function recorded(log: string[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const params = JSON.stringify(JSON.parse(String(init?.body)).params);
    log.push(url);
    const hit = REC.answers.find((a) => a.url === url && JSON.stringify(a.params) === params);
    if (!hit) throw new TypeError("fetch failed");
    return new Response(JSON.stringify(hit.answer), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}
const failing: typeof fetch = (async () => {
  throw new TypeError("fetch failed");
}) as typeof fetch;

/** Runs `f` with console.error kept; gives back its result and what was logged. */
async function quiet<T>(f: () => Promise<T>): Promise<{ out: T; logged: string[] }> {
  const logged: string[] = [];
  const was = console.error;
  console.error = (...a: unknown[]) => void logged.push(a.map(String).join(" "));
  try {
    return { out: await f(), logged };
  } finally {
    console.error = was;
  }
}

function assertUnverified(v: VerifyView, rpcs: readonly string[]) {
  assert.equal(v.state, "unverified");
  if (v.state === "loading") return;
  for (const row of [v.code, v.funds]) {
    assert.equal(row.status, "warn");
    for (const c of row.checks) assert.deepEqual([c.status, c.word, c.values], ["warn", "unverified", []], c.id);
  }
  assert.deepEqual([v.code.checks.map((c) => c.id), v.funds.checks.map((c) => c.id)], [["keys", "code"], ["asset", "registration", "tokenCode", "balance"]]);
  assert.deepEqual([v.height, v.blockHash, v.rpcs], ["—", null, [...rpcs]]);
}

test("the testnet pins are what the vault's own reads answered; mainnet names no vault yet", () => {
  // the recording read the vault's code hash, config().asset and the token's code hash on both RPCs at one block, and
  // the view judged each equal to its pin (contracts/vault/deployments/testnet-v1.json and testnet-usdc.json hold the same)
  assert.equal(REC.view.state, "read");
  if (REC.view.state === "loading") return;
  for (const c of [...REC.view.code.checks, ...REC.view.funds.checks]) assert.deepEqual([c.status, c.word], ["ok", null], c.id);
  const k = REC.answers.find((a) => (a.params as { request_type?: string; account_id?: string }).request_type === "view_account" && (a.params as { account_id?: string }).account_id === TESTNET.pins!.vault);
  assert.equal((k?.answer as { result?: { code_hash?: string } }).result?.code_hash, TESTNET.pins!.release);
  assert.equal(TESTNET.pins!.assetRelease, VAULT_TOKEN_CODE_HASH);
  assert.equal(VERIFY_RELEASES.mainnet.pins, null);
});

test("the releases are frozen all the way down: no write reaches a pin, a pair or a network", () => {
  const w = VERIFY_RELEASES as unknown as Record<string, { rpcs: string[]; pins: Record<string, unknown> | null }>;
  assert.throws(() => void (w.testnet!.pins!.vault = "vault.other.testnet"), TypeError);
  assert.throws(() => void (w.testnet!.rpcs[0] = "https://evil.example"), TypeError);
  assert.throws(() => void w.mainnet!.rpcs.push("https://evil.example"), TypeError);
  assert.throws(() => void ((w.mainnet as { pins: unknown }).pins = { vault: "x" }), TypeError);
  assert.throws(() => void (w.testnet = w.mainnet!), TypeError);
  assert.equal(TESTNET.pins!.vault, "vault.bf-vt-20261102t071444.testnet");
});

test("each network's pair is the kit's pair for that network, and the build's CSP names exactly the pair it reads", () => {
  for (const [net, r] of Object.entries(VERIFY_RELEASES)) {
    assert.equal(r.network, net);
    assert.equal(nearPairNetwork(r.rpcs.map((name) => ({ name, query: async () => null }))), net);
  }
  assert.equal(TESTNET_RPCS, TESTNET.rpcs.join(" "));
  for (const u of VERIFY_RELEASES.mainnet.rpcs) assert.ok(MAINNET_RPCS.split(" ").includes(u), u);
  const shipped = readFileSync(new URL("../public/_headers", import.meta.url), "utf8");
  assert.equal(headersFor("mainnet", shipped), shipped);
  const t = headersFor("testnet", shipped);
  const connect = /connect-src ([^;]+);/.exec(t)![1]!.split(" ");
  assert.deepEqual(connect.filter((s) => /rpc|drpc/.test(s)), [...TESTNET.rpcs]);
  assert.equal(t.replace(TESTNET_RPCS, MAINNET_RPCS), shipped);
  assert.throws(() => headersFor("testnet", shipped.replace(MAINNET_RPCS, "https://near.drpc.org")), /exactly once/);
});

test("the build names its network: mainnet when unset, testnet when set, anything else stops the build", () => {
  assert.equal(networkOf(undefined), "mainnet");
  assert.equal(networkOf(""), "mainnet");
  assert.equal(networkOf("testnet"), "testnet");
  assert.throws(() => networkOf("devnet"), /VITE_NEAR_NETWORK must be one of mainnet, testnet: devnet/);
  assert.equal(buildNetwork("testnet"), "testnet");
  assert.equal(buildNetwork(undefined), "mainnet");
  assert.equal(buildNetwork("devnet"), "mainnet");
});

test("the plugin takes the network from Vite's resolved env (a .env file included), not only from the process", () => {
  const was = process.env.VITE_NEAR_NETWORK;
  delete process.env.VITE_NEAR_NETWORK;
  try {
    const shipped = readFileSync(new URL("../public/_headers", import.meta.url), "utf8");
    const run = (env: Record<string, string>) => {
      const out = mkdtempSync(join(tmpdir(), "verify-mount-net-"));
      writeFileSync(join(out, "_headers"), shipped);
      const p = nearNetwork() as unknown as { configResolved(c: unknown): void; writeBundle(): void };
      p.configResolved({ root: out, build: { outDir: "." }, env });
      p.writeBundle();
      return readFileSync(join(out, "_headers"), "utf8");
    };
    assert.equal(run({ VITE_NEAR_NETWORK: "testnet" }), headersFor("testnet", shipped));
    assert.equal(run({}), shipped);
    assert.throws(() => run({ VITE_NEAR_NETWORK: "devnet" }), /VITE_NEAR_NETWORK must be one of mainnet, testnet: devnet/);
  } finally {
    if (was !== undefined) process.env.VITE_NEAR_NETWORK = was;
  }
});

test("each read refuses a redirect: the RPC answers at its own URL or the read fails", async () => {
  const inits: RequestInit[] = [];
  const spy = ((input: string | URL | Request, init?: RequestInit) => (inits.push(init!), recorded()(input, init))) as typeof fetch;
  await quiet(() => liveVerify(TESTNET, spy));
  assert.ok(inits.length > 0);
  for (const i of inits) assert.equal(i.redirect, "error");
});

test("the live read on the release's testnet pair draws the view of what it read, both RPCs asked", async () => {
  const log: string[] = [];
  const { out, logged } = await quiet(() => liveVerify(TESTNET, recorded(log)));
  assert.deepEqual(out, REC.view);
  assert.equal(out.state, "read");
  if (out.state === "loading") return;
  assert.deepEqual([out.code.status, out.funds.status], ["ok", "ok"]);
  assert.deepEqual(out.rpcs, [...TESTNET.rpcs]);
  assert.deepEqual(new Set(log), new Set(TESTNET.rpcs));
  assert.equal(log.length, REC.answers.length);
  assert.deepEqual(logged, []);
});

test("a pair the rule refuses draws every check Unverified, names and reads no RPC, and logs the rule's words only", async () => {
  // two hosts of one operator (FastNEAR runs both), so one read, not two
  const oneOperator: VerifyRelease = { ...TESTNET, rpcs: ["https://test.rpc.fastnear.com", "https://rpc.testnet.near.org"] }; // near-rpc-operators: one operator (the refused pair)
  const log: string[] = [];
  const { out, logged } = await quiet(() => liveVerify(oneOperator, recorded(log)));
  assertUnverified(out, []);
  assert.deepEqual(log, []);
  assert.deepEqual(logged, [nearPairRule("testnet")]);
});

test("the other network's pair is refused for this build's network", async () => {
  const crossed: VerifyRelease = { ...TESTNET, rpcs: VERIFY_RELEASES.mainnet.rpcs };
  const log: string[] = [];
  const { out, logged } = await quiet(() => liveVerify(crossed, recorded(log)));
  assertUnverified(out, []);
  assert.deepEqual(log, []);
  assert.deepEqual(logged, [nearPairRule("testnet")]);
});

test("a read that fails on both RPCs draws every check Unverified, never an earlier read", async () => {
  const first = await quiet(() => liveVerify(TESTNET, recorded()));
  assert.equal(first.out.state, "read");
  const { out, logged } = await quiet(() => liveVerify(TESTNET, failing));
  assertUnverified(out, TESTNET.rpcs);
  assert.deepEqual(logged, ["Verify read no final height on either RPC"]);
});

test("a read one RPC fails keeps the other's answers and marks each check Unverified (the model's S18.3)", async () => {
  const half: typeof fetch = ((input: string | URL | Request, init?: RequestInit) =>
    String(input) === TESTNET.rpcs[1] ? failing(input, init) : recorded()(input, init)) as typeof fetch;
  const { out, logged } = await quiet(() => liveVerify(TESTNET, half));
  assert.equal(out.state, "read");
  if (out.state === "loading") return;
  for (const c of [...out.code.checks, ...out.funds.checks]) assert.deepEqual([c.status, c.word], ["warn", "unverified"], c.id);
  assert.deepEqual(logged, []);
});

test("mainnet with no vault named yet: every check Unverified, no RPC named or read, nothing logged", async () => {
  const log: string[] = [];
  const { out, logged } = await quiet(() => liveVerify(VERIFY_RELEASES.mainnet, recorded(log)));
  assertUnverified(out, []);
  assert.deepEqual(log, []);
  assert.deepEqual(logged, []);
});
