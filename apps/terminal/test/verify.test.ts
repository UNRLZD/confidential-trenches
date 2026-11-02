// Verify's reads and rows (card app-verify-panel; app.md A3.3 and A7, CH-090 to CH-097, CH-120; 09-design-brief S18) on
// recorded reads: test/verify/reads.json is the testnet skeleton vault vault.bf-vs-20261101t012200.testnet read at one
// block on fastnear and drpc by test/verify/record.ts. Every bad case is that recording with one answer planted.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { nearPairRule, type VaultSyncRpc } from "@blindfill/kit";
import { readVerify, VERIFY_READS, verifyQuery } from "../src/screens/verify/read.ts";
import type { VerifyPins, VerifyReads } from "../src/screens/verify/read.ts";
import { verifyView } from "../src/screens/verify/model.ts";
import type { VerifyCheck, VerifyView } from "../src/screens/verify/model.ts";
import { DRAFTS, WORDS } from "../src/screens/verify/words.ts";

const REC = JSON.parse(readFileSync(new URL("./verify/reads.json", import.meta.url), "utf8")) as VerifyReads & { vault: string; asset: string };
const PINS: VerifyPins = {
  vault: "vault.bf-vs-20261101t012200.testnet",
  asset: "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af",
  // contracts/vault/deployments/testnet-skeleton.json code_hash; the testnet USDC's code hash as both RPCs read it
  release: "GGfTdwuLbonERu3vKnpLF828eyWZ4DxS24kpLp67PmSn",
  assetRelease: "EoAUFWELjD9gYzsjKDXYRmHDHf1RJ95jaKNSYE6v9b2z",
  assetSymbol: "USDC",
  assetDecimals: 6,
};
const H = REC.height;
const URL_OF = ["https://test.rpc.fastnear.com", "https://near-testnet.drpc.org"] as const; // the testnet pair, each RPC named by the URL it reads
const clone = (): VerifyReads => JSON.parse(JSON.stringify(REC));
const bytes = (v: unknown) => [...Buffer.from(JSON.stringify(v))];
/** Sets one call_function answer's value on the RPCs named (both unless given). */
function plantCall(r: VerifyReads, id: string, value: unknown, on = [0, 1]): VerifyReads {
  for (const i of on) (r.rpcs[i].answers as any)[id].result.result = bytes(value);
  return r;
}
const ready = (v: VerifyView) => {
  assert.notEqual(v.state, "loading");
  return v as Exclude<VerifyView, { state: "loading" }>;
};
const check = (v: VerifyView, id: string): VerifyCheck => {
  const r = ready(v);
  const c = [...r.code.checks, ...r.funds.checks].find((x) => x.id === id);
  assert.ok(c, `no check ${id}`);
  return c;
};
const value = (c: VerifyCheck, k: string) => c.values.find((x) => x.k === k)?.v;

test("the recording: both RPCs at one block, every read answered", () => {
  assert.equal(REC.rpcs.length, 2);
  assert.deepEqual(REC.rpcs.map((r) => r.name), [...URL_OF]);
  for (const r of REC.rpcs) for (const id of VERIFY_READS) assert.equal((r.answers[id] as any).result.block_height, H, `${r.name} ${id}`);
});

test("CH-090 S18.2: the recorded skeleton reads ok on every check, and shows what it read", () => {
  const v = ready(verifyView(REC, PINS));
  assert.equal(v.state, "read");
  assert.equal(v.code.status, "ok");
  assert.equal(v.funds.status, "ok");
  assert.deepEqual(v.code.checks.map((c) => c.id), ["keys", "code"]);
  assert.deepEqual(v.funds.checks.map((c) => c.id), ["asset", "registration", "tokenCode", "balance"]);
  for (const c of [...v.code.checks, ...v.funds.checks]) assert.equal(c.status, "ok", c.id);
  assert.equal(value(check(v, "keys"), "keys"), "0");
  assert.equal(value(check(v, "code"), "codeHash"), "GGfTdw…67PmSn");
  assert.equal(value(check(v, "code"), "release"), "GGfTdw…67PmSn");
  assert.equal(value(check(v, "asset"), "asset"), "3e2210…fcb8af");
  assert.equal(value(check(v, "registration"), "registration"), "0.00125 NEAR");
  assert.equal(value(check(v, "tokenCode"), "codeHash"), "EoAUFW…6v9b2z");
  assert.equal(value(check(v, "balance"), "balance"), "0 USDC");
  assert.equal(value(check(v, "balance"), "deposited"), "0 USDC");
  assert.equal(value(check(v, "balance"), "surplus"), "0 USDC");
  assert.equal(v.height, "275,831,776");
  assert.equal(v.blockHash, "FCjusy…bWxZNM");
  assert.deepEqual(v.rpcs, [...URL_OF]);
});

test("S18.1: no reads yet is loading", () => {
  assert.deepEqual(verifyView(null, PINS), { state: "loading" });
});

test("CH-091: a key on the vault turns the keys check and the code row red", () => {
  const r = clone();
  const key = { public_key: "ed25519:11111111111111111111111111111111", access_key: { nonce: 0, permission: "FullAccess" } };
  for (const x of r.rpcs) (x.answers.keys as any).result.keys = [key];
  const v = ready(verifyView(r, PINS));
  assert.equal(check(v, "keys").status, "danger");
  assert.equal(value(check(v, "keys"), "keys"), "1");
  assert.equal(v.code.status, "danger");
  assert.equal(v.funds.status, "ok");
});

test("CH-097 S18.9: a code hash other than the release turns the code row red", () => {
  const v = ready(verifyView(REC, { ...PINS, release: "11111111111111111111111111111111" }));
  assert.equal(check(v, "code").status, "danger");
  assert.equal(value(check(v, "code"), "release"), "111111…111111");
  assert.equal(v.code.status, "danger");
  const r = clone();
  for (const x of r.rpcs) (x.answers.account as any).result.code_hash = "11111111111111111111111111111111";
  assert.equal(ready(verifyView(r, PINS)).code.status, "danger", "the read hash differs, the pin is the release");
});

test("CH-120: not registered on the token turns the funds row red", () => {
  const v = ready(verifyView(plantCall(clone(), "registration", null), PINS));
  assert.equal(check(v, "registration").status, "danger");
  assert.equal(v.funds.status, "danger");
  assert.equal(v.code.status, "ok");
  assert.equal(value(check(v, "registration"), "registration"), "—");
  assert.equal(check(verifyView(plantCall(clone(), "registration", { total: "0", available: "0" }), PINS), "registration").status, "danger", "a zero storage deposit is not a registration");
});

test("the token's code hash other than its pin, or config() naming another asset, turns the funds row red", () => {
  const v = ready(verifyView(REC, { ...PINS, assetRelease: "11111111111111111111111111111111" }));
  assert.equal(check(v, "tokenCode").status, "danger");
  assert.equal(v.funds.status, "danger");
  const cfg = JSON.parse(Buffer.from((REC.rpcs[0].answers.config as any).result.result).toString());
  const w = ready(verifyView(plantCall(clone(), "config", { ...cfg, asset: "usdc.fakes.testnet" }), PINS));
  assert.equal(check(w, "asset").status, "danger");
  assert.equal(value(check(w, "asset"), "asset"), "usdc.fakes.testnet");
  assert.equal(w.funds.status, "danger");
});

test("CH-096 S18.8 and CH-093: the balance against deposited - spent + returned, exact, with the surplus", () => {
  const at = (balance: string, totals: object) => ready(verifyView(plantCall(plantCall(clone(), "totals", totals), "balance", balance), PINS));
  const t = { deposited: "10000000", spent: "4000000", returned: "1000000" };
  const ok = at("9000000", t);
  assert.equal(check(ok, "balance").status, "ok");
  assert.equal(value(check(ok, "balance"), "balance"), "9 USDC");
  assert.equal(value(check(ok, "balance"), "deposited"), "10 USDC");
  assert.equal(value(check(ok, "balance"), "spent"), "4 USDC");
  assert.equal(value(check(ok, "balance"), "returned"), "1 USDC");
  assert.equal(value(check(ok, "balance"), "surplus"), "2 USDC");
  assert.equal(check(at("7000000", t), "balance").status, "ok", "equal is backed");
  const short = at("6999999", t);
  assert.equal(check(short, "balance").status, "danger");
  assert.equal(value(check(short, "balance"), "surplus"), "-0.000001 USDC");
  assert.equal(short.funds.status, "danger");
  const big = "340282366920938463463374607431768211455";
  assert.equal(check(at(big, { deposited: big, spent: "0", returned: "0" }), "balance").status, "ok", "u128 max with no float");
});

test("CH-095 S18.4: the RPCs giving different answers at one block is RPCs disagree, both rows amber at least", () => {
  const r = clone();
  (r.rpcs[1].answers.keys as any).result.keys = [{ public_key: "ed25519:11111111111111111111111111111111", access_key: { nonce: 0, permission: "FullAccess" } }];
  const v = ready(verifyView(r, PINS));
  assert.equal(v.state, "disagree");
  assert.equal(check(v, "keys").status, "warn");
  assert.equal(check(v, "keys").word, "disagree");
  assert.deepEqual(check(v, "keys").values.filter((x) => x.k === "keys").map((x) => [x.rpc, x.v]), [[URL_OF[0], "0"], [URL_OF[1], "1"]]);
  assert.equal(v.code.status, "warn");
  assert.equal(v.funds.status, "warn", "both rows amber");
  const b = clone();
  plantCall(b, "balance", "5", [0]);
  assert.equal(check(verifyView(b, PINS), "balance").word, "disagree");
});

test("CH-095: a different block hash at the same height is RPCs disagree", () => {
  const r = clone();
  for (const id of VERIFY_READS) (r.rpcs[1].answers[id] as any).result.block_hash = "11111111111111111111111111111111";
  const v = ready(verifyView(r, PINS));
  assert.equal(v.state, "disagree");
  assert.equal(v.code.status, "warn");
  assert.equal(v.funds.status, "warn");
  assert.equal(v.blockHash, null, "no one block hash to show");
});

test("S18.3: an unread answer is Unverified on its check only, its row amber", () => {
  const r = clone();
  (r.rpcs[1].answers as any).totals = { error: "fetch failed" };
  const v = ready(verifyView(r, PINS));
  assert.equal(v.state, "read");
  assert.equal(check(v, "balance").status, "warn");
  assert.equal(check(v, "balance").word, "unverified");
  assert.equal(v.funds.status, "warn");
  assert.equal(v.code.status, "ok");
  for (const plant of [
    (x: VerifyReads) => ((x.rpcs[0].answers.keys as any).result.block_height = H - 1),
    (x: VerifyReads) => ((x.rpcs[0].answers.keys as any).error = { name: "HANDLER_ERROR" }),
    (x: VerifyReads) => ((x.rpcs[0].answers.keys as any).result.keys = "none"),
    (x: VerifyReads) => delete (x.rpcs[0].answers as any).keys,
  ]) {
    const y = clone();
    plant(y);
    const w = ready(verifyView(y, PINS));
    assert.equal(check(w, "keys").word, "unverified");
    assert.equal(w.code.status, "warn");
  }
  // a view's bytes with a leading UTF-8 BOM are not its JSON: kept and refused, as every decode of checked bytes here is
  const bom = clone();
  for (const x of bom.rpcs) (x.answers.config as any).result.result.unshift(0xef, 0xbb, 0xbf);
  const b = ready(verifyView(bom, PINS));
  assert.equal(check(b, "asset").word, "unverified", "a BOM before config()'s JSON");
  assert.equal(b.funds.status, "warn");
  const z = plantCall(clone(), "balance", "1.5");
  assert.equal(check(verifyView(z, PINS), "balance").word, "unverified", "a balance that is not a whole number is not read");
});

test("readVerify: the seven reads on both RPCs at the lower final height, failures kept, never thrown", async () => {
  const sent: [string, Record<string, unknown>][] = [];
  const rpc = (i: number, lead = 0, fail?: string): VaultSyncRpc => ({
    name: URL_OF[i],
    async query(p) {
      sent.push([URL_OF[i], p]);
      const id = VERIFY_READS.find((k) => JSON.stringify({ ...verifyQuery(k, PINS, { block_id: H }), block_id: undefined }) === JSON.stringify({ ...p, block_id: undefined, finality: undefined }));
      if (!id) throw new Error(`unexpected query ${JSON.stringify(p)}`);
      if (fail === id && p.block_id !== undefined) throw new Error("fetch failed");
      const a = JSON.parse(JSON.stringify(REC.rpcs[i].answers[id]));
      if (p.finality === "final") a.result.block_height += lead;
      return a;
    },
  });
  const r = await readVerify([rpc(0, 7), rpc(1, 0, "totals")], PINS);
  assert.equal(r.height, H, "the lower of the two final heights");
  const reads = sent.filter(([, p]) => p.block_id !== undefined);
  assert.equal(reads.length, 14);
  for (const [, p] of reads) assert.equal(p.block_id, H);
  for (const n of URL_OF) assert.deepEqual(reads.filter(([x]) => x === n).map(([, p]) => p).sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : 1), VERIFY_READS.map((k) => verifyQuery(k, PINS, { block_id: H })).sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
  assert.deepEqual(r.rpcs[1].answers.totals, { error: "fetch failed" });
  assert.equal(check(verifyView(r, PINS), "balance").word, "unverified");
  assert.equal(check(verifyView(r, PINS), "keys").status, "ok");
  await assert.rejects(readVerify([rpc(0), rpc(0)], PINS), new Error(nearPairRule()), "one provider twice is not the rule's pair");
});

test("readVerify refuses the pairs every money path refuses: two hosts of one operator, an unknown host, a pair across networks", async () => {
  const URLS = { fast: "https://test.rpc.fastnear.com", fastAlt: "https://rpc.testnet.near.org", drpc: "https://near-testnet.drpc.org", mainDrpc: "https://near.drpc.org", other: "https://rpc.example.org" };
  let sent = 0;
  const rpc = (name: string): VaultSyncRpc => ({ name, async query() { sent++; throw new Error("a refused pair is never queried"); } });
  for (const [why, a, b] of [
    ["two hosts of one operator", URLS.fast, URLS.fastAlt],
    ["a host the rule does not name", URLS.fast, URLS.other],
    ["a pair across networks", URLS.fast, URLS.mainDrpc],
    ["dRPC alone, twice", URLS.drpc, URLS.drpc],
  ] as const) {
    await assert.rejects(readVerify([rpc(a), rpc(b)], PINS), new Error(nearPairRule()), why); // the rule's own words, nothing new
  }
  assert.equal(sent, 0, "a refused pair is refused before any read");
  const good = (name: string): VaultSyncRpc => ({ name, query: async (p) => { const id = VERIFY_READS.find((k) => JSON.stringify({ ...verifyQuery(k, PINS, { block_id: H }), block_id: undefined }) === JSON.stringify({ ...p, block_id: undefined, finality: undefined })); return REC.rpcs[0].answers[id!]; } });
  for (const pair of [[URLS.fast, URLS.drpc], [URLS.drpc, URLS.fastAlt]] as const) assert.equal((await readVerify([good(pair[0]), good(pair[1])], PINS)).height, H, pair.join(" + "));
});

test("verifyQuery: the view calls of app.md A7, at the block given", () => {
  const at = { block_id: H };
  const arg = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64");
  assert.deepEqual(verifyQuery("keys", PINS, at), { request_type: "view_access_key_list", account_id: PINS.vault, block_id: H });
  assert.deepEqual(verifyQuery("account", PINS, at), { request_type: "view_account", account_id: PINS.vault, block_id: H });
  assert.deepEqual(verifyQuery("config", PINS, at), { request_type: "call_function", account_id: PINS.vault, method_name: "config", args_base64: arg({}), block_id: H });
  assert.deepEqual(verifyQuery("totals", PINS, at), { request_type: "call_function", account_id: PINS.vault, method_name: "totals", args_base64: arg({}), block_id: H });
  assert.deepEqual(verifyQuery("balance", PINS, at), { request_type: "call_function", account_id: PINS.asset, method_name: "ft_balance_of", args_base64: arg({ account_id: PINS.vault }), block_id: H });
  assert.deepEqual(verifyQuery("registration", PINS, at), { request_type: "call_function", account_id: PINS.asset, method_name: "storage_balance_of", args_base64: arg({ account_id: PINS.vault }), block_id: H });
  assert.deepEqual(verifyQuery("token", PINS, at), { request_type: "view_account", account_id: PINS.asset, block_id: H });
});

test("WORDS: every word carries its source; no draft is left (owner 2 Nov 06:08Z, all approved); no claim words", () => {
  for (const [k, w] of Object.entries(WORDS)) assert.ok(w.text.length > 0 && w.source.length > 0, k);
  for (const k of ["close", "asset"] as const) assert.equal(WORDS[k].draft, false, k);
  assert.deepEqual([...DRAFTS], []);
  const claim = /\b(verified|safe|secure|backed|guarantee|trustless|all there|matches|proven|solvent)\b/i;
  for (const [k, w] of Object.entries(WORDS)) assert.doesNotMatch(w.text, claim, k);
  for (const w of Object.values(WORDS)) assert.doesNotMatch(w.text, /[.!?]$/, "labels, not sentences");
});
