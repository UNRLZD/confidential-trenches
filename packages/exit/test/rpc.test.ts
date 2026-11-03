// The exit tool's read of the vault's four lists, offline: the testnet vault's pages as two public RPCs gave them
// (fixtures/testnet-pages.json, written by scripts/record-pages.ts), replayed. Two RPCs that differ by one byte stop the
// tool, wherever that byte is.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { nearPairNetwork, VaultSyncStopped, VAULT_SYNC_LISTS } from "@blindfill/kit";
import { EXIT_NETWORKS, ExitRpcRefused, exitReadPages, exitRpc } from "../src/rpc.ts";
import { replayRpc, type PagesFile } from "./replay.ts";

const ROOT = new URL("../../../", import.meta.url);
const PAGES: PagesFile = JSON.parse(readFileSync(new URL("fixtures/testnet-pages.json", import.meta.url), "utf8"));
const [A, B] = PAGES.rpcs;

type Answer = { result: { result: number[]; block_height: number; block_hash: string } };
const atBlock = (params: string) => JSON.parse(params).block_id !== undefined;
const viewText = (a: unknown) => Buffer.from((a as Answer).result.result).toString("utf8");
const viewBytes = (a: unknown, text: string) => ((a as Answer).result.result = [...Buffer.from(text, "utf8")]);
const stopped = (code: string) => (e: unknown) => e instanceof VaultSyncStopped && e.code === code;

test("the recorded pages read back whole: every list, at one block, on the release's pair", async () => {
  assert.equal(PAGES.vault, EXIT_NETWORKS.testnet.vault);
  assert.deepEqual([A.url, B.url], [...EXIT_NETWORKS.testnet.rpcs]);
  const r = await exitReadPages({ network: "testnet", rpcs: [replayRpc(A), replayRpc(B)] });
  assert.equal(r.leaves.length, r.stateTree.size);
  assert.equal(r.labels.length, r.labelTree.size);
  assert.ok(r.deposits.length > 0 && r.spends.length > 0, "the recording holds deposits and spends");
  assert.deepEqual(r.deposits.map((d) => d.index), [...r.deposits.keys()]);
  assert.deepEqual(r.spends.map((s) => s.index), [...r.spends.keys()]);
  for (const d of r.deposits) assert.equal(r.labels.includes(d.label), true, `deposit ${d.index}'s label is in labels`);
  assert.equal(r.cursor.leaves, r.stateTree.size);
  assert.equal(r.cursor.vault, EXIT_NETWORKS.testnet.vault);
  // every list was read, page by page, at the one block both final heights allow
  const read = new Set(A.answers.filter(([p]) => atBlock(p)).map(([p]) => JSON.parse(p).method_name));
  for (const list of VAULT_SYNC_LISTS) assert.ok(read.has(list), list);
  for (const [p] of [...A.answers, ...B.answers].filter(([p]) => atBlock(p))) assert.equal(JSON.parse(p).block_id, r.height);
});

test("one byte changed on either RPC, at any byte of any answer read at the block, stops the tool", async () => {
  let runs = 0;
  for (const side of [0, 1] as const) {
    const rec = PAGES.rpcs[side];
    for (const [params, answer] of rec.answers) {
      if (!atBlock(params)) continue; // the final-height probe: only its height is used, the block's reads carry the bytes
      const length = (answer as Answer).result.result.length;
      for (let at = 0; at < length; at++) {
        const edited = replayRpc(rec, (p, a) => {
          if (p === params) (a as Answer).result.result[at] ^= 0x01;
          return a;
        });
        const rpcs = side === 0 ? ([edited, replayRpc(B)] as const) : ([replayRpc(A), edited] as const);
        await assert.rejects(exitReadPages({ network: "testnet", rpcs }), stopped("disagree"), `${JSON.parse(params).method_name} byte ${at} on ${rec.url}`);
        runs++;
      }
    }
  }
  assert.ok(runs > 1000, `${runs} single-byte changes`);
});

test("a row missing, a row added or another block on one RPC stops the tool", async () => {
  const page = (list: string) => B.answers.find(([p]) => atBlock(p) && JSON.parse(p).method_name === list)![0];
  const deposits = page("deposits");
  const missing = replayRpc(B, (p, a) => {
    if (p === deposits) viewBytes(a, JSON.stringify(JSON.parse(viewText(a)).slice(0, -1)));
    return a;
  });
  await assert.rejects(exitReadPages({ network: "testnet", rpcs: [replayRpc(A), missing] }), stopped("disagree"));
  const leaves = page("leaves");
  const added = replayRpc(B, (p, a) => {
    if (p === leaves) viewBytes(a, JSON.stringify([...JSON.parse(viewText(a)), "1"]));
    return a;
  });
  await assert.rejects(exitReadPages({ network: "testnet", rpcs: [replayRpc(A), added] }), stopped("disagree"));
  const fork = replayRpc(B, (p, a) => {
    if (atBlock(p)) (a as Answer).result.block_hash = "11111111111111111111111111111111";
    return a;
  });
  await assert.rejects(exitReadPages({ network: "testnet", rpcs: [replayRpc(A), fork] }), stopped("disagree"));
  const down = replayRpc(B, (p, a) => {
    if (p === leaves) throw new Error("HTTP 503");
    return a;
  });
  await assert.rejects(exitReadPages({ network: "testnet", rpcs: [replayRpc(A), down] }), stopped("rpc"));
});

test("only the release's pair is read: two hosts of one operator, another provider or one RPC twice is refused", async () => {
  const named = (url: string, rec = A) => ({ ...replayRpc(rec), name: url });
  const refused = (e: unknown) => e instanceof ExitRpcRefused;
  // FastNEAR's two testnet hosts are one operator, so the pair is refused
  await assert.rejects(exitReadPages({ network: "testnet", rpcs: [named("https://test.rpc.fastnear.com"), named("https://rpc.testnet.near.org")] }), refused); // near-rpc-operators: one operator (planted, refused)
  await assert.rejects(exitReadPages({ network: "testnet", rpcs: [named("https://rpc.example.org"), replayRpc(B)] }), refused);
  await assert.rejects(exitReadPages({ network: "testnet", rpcs: [replayRpc(A), named(A.url)] }), refused);
  // mainnet's pair on testnet, and testnet's on mainnet
  await assert.rejects(exitReadPages({ network: "testnet", rpcs: [named(EXIT_NETWORKS.mainnet.rpcs[0]), named(EXIT_NETWORKS.mainnet.rpcs[1], B)] }), refused);
  await assert.rejects(exitReadPages({ network: "mainnet", vault: PAGES.vault, rpcs: [replayRpc(A), replayRpc(B)] }), refused);
  // no vault on mainnet yet, and no network but the two
  await assert.rejects(exitReadPages({ network: "mainnet" }), /no vault on mainnet yet/);
  await assert.rejects(exitReadPages({ network: "betanet" as "mainnet" }), refused);
});

test("the pinned pairs and vault are the kit's and the deploy record's", () => {
  for (const network of ["mainnet", "testnet"] as const) {
    const rpcs = EXIT_NETWORKS[network].rpcs.map((url) => exitRpc(url, () => Promise.reject(new Error("offline"))));
    assert.equal(nearPairNetwork(rpcs), network, network);
  }
  const record = JSON.parse(readFileSync(new URL("contracts/vault/deployments/testnet-v1.json", ROOT), "utf8"));
  assert.equal(EXIT_NETWORKS.testnet.vault, record.account_id);
  assert.equal(EXIT_NETWORKS.mainnet.vault, null);
  assert.ok(Object.isFrozen(EXIT_NETWORKS) && Object.isFrozen(EXIT_NETWORKS.testnet) && Object.isFrozen(EXIT_NETWORKS.testnet.rpcs));
});

test("exitRpc posts one JSON-RPC query and refuses a status other than 200", async () => {
  const seen: { url: string; body: unknown }[] = [];
  const ok = (async (url: string, init: RequestInit) => {
    seen.push({ url, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: "x", result: 1 }), { status: 200 });
  }) as unknown as typeof fetch;
  const params = { request_type: "call_function", account_id: "v.testnet", method_name: "state_tree", args_base64: "e30=", finality: "final" };
  assert.deepEqual(await exitRpc("https://near-testnet.drpc.org", ok).query(params), { jsonrpc: "2.0", id: "x", result: 1 });
  assert.deepEqual(seen, [{ url: "https://near-testnet.drpc.org", body: { jsonrpc: "2.0", id: "blindfill-exit", method: "query", params } }]);
  const bad = (async () => new Response("busy", { status: 429 })) as unknown as typeof fetch;
  await assert.rejects(exitRpc("https://near-testnet.drpc.org", bad).query(params), /HTTP 429/);
});
