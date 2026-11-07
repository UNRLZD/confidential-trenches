// The one-use arming accounts A_{l,j} and the registration read before a withdrawal to A is proved (card
// wallet-arming-accounts; wallet.md §2.2 l.65, l.71-89, §2.5 step 4 l.649, §A.8; markets.md H3.4 check 7; at research
// 8e9352d).   node --test test/arming-accounts.test.ts   (from packages/wallet)
// The derivation is checked against the §A.8 vector set and against a second route that shares no crypto code with the
// code under test: node:crypto's PBKDF2, HKDF and ed25519, with the info bytes written out here from the paper's
// encoding. The registration answers are real answers on two operators (test/vectors/arming-accounts.json, written by
// the read-only test/record-arming-accounts.mjs, 2026-11-02T07:10Z; each answer names the account it is for). A test
// that needs an answer the chain does not give today (two RPCs that disagree, a malformed value) edits one field of a
// recorded answer and says which; an RPC that is down throws, as nearRpc does.
import assert from "node:assert/strict";
import { createPrivateKey, createPublicKey, hkdfSync, pbkdf2Sync, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, test } from "node:test";
import { VAULT_CONSTANTS } from "@blindfill/kit";
import { base58 } from "@scure/base";
import {
  type ArmingRefusalCode,
  ArmingRegistrationRefused,
  armingAccount,
  armingRegisterDepositOf,
} from "../src/arming/accounts.ts";
import { NEAR_NETWORKS, type NearNetwork, type NearRpc } from "../src/deposit/account.ts";
import { P, wordsToSeed64 } from "../src/derive/index.ts";
import type { WithdrawRequestArgs } from "../src/withdraw/request.ts";

// ---------- the derivation ----------
type Id = { name: string; kind: string; l?: string; j?: number; info?: string; id: string };
const a8 = JSON.parse(readFileSync(new URL("./vectors/a8.json", import.meta.url), "utf8")) as { inputs: { entropy: string; passphrase: string }; l: string; ids: Id[] };
// The first BIP-39 reference vector: entropy of 16 zero bytes (a8.json inputs) is these 12 words.
const WORDS = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

// The second route: BIP-39's seed (PBKDF2-HMAC-SHA512, 2048 rounds, salt "mnemonic" + passphrase), then
// HKDF-SHA512(seed, "blindfill/v1", "onetime/arm" ‖ l as 32 B big-endian ‖ j as 4 B big-endian, 32) (W:71-89), then the
// RFC 8032 public key of that seed, all by node:crypto.
const SEED2 = pbkdf2Sync(WORDS.normalize("NFKD"), "mnemonic" + a8.inputs.passphrase, 2048, 64, "sha512");
const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex"); // RFC 8410's PrivateKeyInfo prefix
function infoArm(l: bigint, j: number): Buffer {
  const lb = Buffer.from(l.toString(16).padStart(64, "0"), "hex");
  const jb = Buffer.alloc(4);
  jb.writeUInt32BE(j);
  return Buffer.concat([Buffer.from("onetime/arm", "ascii"), lb, jb]);
}
function armBySecondRoute(l: bigint, j: number): { info: string; id: string } {
  const info = infoArm(l, j);
  const seed = Buffer.from(hkdfSync("sha512", SEED2, Buffer.from("blindfill/v1", "ascii"), info, 32));
  const priv = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, seed]), format: "der", type: "pkcs8" });
  const spki = createPublicKey(priv).export({ format: "der", type: "spki" });
  seed.fill(0);
  return { info: info.toString("hex"), id: Buffer.from(spki.subarray(spki.length - 32)).toString("hex") };
}

const L = BigInt("0x" + a8.l);
const vec = (name: string): Id => {
  const v = a8.ids.find((x) => x.name === name);
  assert.ok(v, `a8.json has ${name}`);
  return v;
};

test("the words are the A.8 entropy, and the second route's seed is the code's", () => {
  assert.equal(a8.inputs.entropy, "00".repeat(16));
  assert.equal(Buffer.from(wordsToSeed64(WORDS)).toString("hex"), SEED2.toString("hex"));
});

test("A_{l,0} and A_{l,1} equal the A.8 vector set and the second route", () => {
  const seed = wordsToSeed64(WORDS);
  for (const [name, j] of [["A_{l,0}", 0], ["A_{l,1}", 1]] as const) {
    const v = vec(name);
    assert.equal(v.kind, "arm");
    assert.equal(v.l, a8.l);
    assert.equal(v.j, j);
    const two = armBySecondRoute(L, j);
    if (v.info !== undefined) assert.equal(two.info, v.info, `${name} info`);
    assert.equal(two.info.length, 47 * 2, "the info is 47 bytes (W:82)");
    assert.equal(two.id, v.id, `${name}: second route = A.8`);
    const a = armingAccount(seed, L, j);
    assert.equal(a.account, v.id, `${name}: the code = A.8`);
    assert.equal(a.publicKey, `ed25519:${base58.encode(Buffer.from(v.id, "hex"))}`);
    assert.match(a.account, /^[0-9a-f]{64}$/);
  }
});

test("64 random (l, j): the code and the second route agree", () => {
  const seed = wordsToSeed64(WORDS);
  for (let k = 0; k < 64; k++) {
    const l = BigInt("0x" + randomBytes(32).toString("hex")) % P;
    const j = k < 2 ? [0, 0xffffffff][k]! : randomBytes(4).readUInt32BE();
    assert.equal(armingAccount(seed, l, j).account, armBySecondRoute(l, j).id, `l=${l.toString(16)} j=${j}`);
  }
});

test("only the public side comes back", () => {
  const a = armingAccount(wordsToSeed64(WORDS), L, 0);
  assert.deepEqual(Object.keys(a).sort(), ["account", "publicKey"]);
});

test("bad inputs are refused", () => {
  const seed = wordsToSeed64(WORDS);
  assert.throws(() => armingAccount(seed, P, 0), /field element/);
  assert.throws(() => armingAccount(seed, -1n, 0), /field element/);
  assert.throws(() => armingAccount(seed, L, -1), /counter/);
  assert.throws(() => armingAccount(seed, L, 2 ** 32), /counter/);
  assert.throws(() => armingAccount(seed.subarray(0, 32), L, 0), /64 bytes/);
});

// ---------- the registration read ----------
type Answer = { url: string; json: unknown };
const rec = JSON.parse(readFileSync(new URL("./vectors/arming-accounts.json", import.meta.url), "utf8")) as {
  good: string;
  test_a: string;
  answers: Record<string, { for: string; a: Answer; b: Answer }>;
};
const ANS = rec.answers;
const MIN = 1_250_000_000_000_000_000_000n; // 0.00125 N, USDC's recorded storage_balance_bounds().min (D16)
const clone = <T>(x: T): T => structuredClone(x);
const decode = (b64: string) => JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
const setBytes = (j: any, v: unknown) => (j.result.result = [...Buffer.from(JSON.stringify(v))]);

type Read = "reg" | "bounds";
type Side = "a" | "b";
type Opts = { reg?: string; bounds?: string; down?: boolean; edit?: (r: Read, j: any) => void; name?: string; seen?: unknown[] };
// A provider that answers from the recording: `reg` and `bounds` name the answers, `edit` changes a copy. A request the
// recording does not fit is a fault of the test, never a refusal the code made: each one is kept and fails its test.
const wrong: string[] = [];
afterEach(() => assert.deepEqual(wrong.splice(0), [], "every request fit the recording"));
const fits = (ok: boolean, what: string) => {
  if (!ok) wrong.push(what);
  assert.ok(ok, what);
};
function replay(network: NearNetwork, side: Side, o: Opts = {}): NearRpc {
  const net = NEAR_NETWORKS[network];
  return {
    name: o.name ?? (side === "a" ? net.fastnear[0] : net.drpc),
    async query(params) {
      o.seen?.push(params);
      if (o.down) throw new Error("fetch failed");
      const p = params as { request_type: string; account_id: string; method_name: string; args_base64: string; finality: string };
      fits(p.request_type === "call_function" && p.account_id === net.usdc && p.finality === "final", `a view on ${network}'s token at final`);
      const r: Read = p.method_name === "storage_balance_of" ? "reg" : "bounds";
      const name = r === "reg" ? (o.reg ?? "reg_null") : (o.bounds ?? "bounds");
      if (r === "reg" && name !== "reg_panic") fits(decode(p.args_base64).account_id === ANS[name]!.for, `the ${name} answer is for the account asked`);
      const j = clone(ANS[name]![side].json) as any;
      o.edit?.(r, j);
      return j;
    },
  };
}
const pair = (network: NearNetwork, a: Opts = {}, b: Opts = a) => [replay(network, "a", a), replay(network, "b", b)] as const;
async function refused(p: Promise<unknown>, code: ArmingRefusalCode, re?: RegExp) {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof ArmingRegistrationRefused, String(e));
    assert.equal(e.code, code, e.message);
    if (re) assert.match(e.message, re);
    return true;
  });
}

test("the recording: GOOD is registered, TEST_A is A_{l,0} of the A.8 seed, and both RPCs are two operators", () => {
  assert.equal(rec.test_a, vec("A_{l,0}").id);
  assert.equal(ANS.reg_null!.for, rec.test_a);
  assert.equal(ANS.reg_set!.for, rec.good);
  for (const [n, v] of Object.entries(ANS)) {
    const net = n.endsWith("_testnet") ? NEAR_NETWORKS.testnet : NEAR_NETWORKS.mainnet;
    assert.equal(v.a.url, net.fastnear[0], n);
    assert.equal(v.b.url, net.drpc, n);
  }
});

const depositOf = (network: NearNetwork, rpcs: readonly [NearRpc, NearRpc], a = rec.test_a) => armingRegisterDepositOf(network, rpcs)(a, NEAR_NETWORKS[network].usdc);

test("register_deposit is storage_balance_bounds().min for any A, registered or not, read without naming A (card relayer-cost-guards, audit V-03 and review F2)", async () => {
  for (const net of ["mainnet", "testnet"] as const) {
    const o: Opts = net === "mainnet" ? {} : { bounds: "bounds_testnet" };
    const seen: unknown[] = [];
    // GOOD is registered and TEST_A is not: the same minimum, from the same two reads
    assert.equal(await depositOf(net, pair(net, { ...o, seen }), rec.good), MIN, net);
    assert.equal(await depositOf(net, pair(net, { ...o, seen }), rec.test_a), MIN, net);
    assert.equal(seen.length, 4, `${net}: one bounds read per RPC per call`);
    for (const p of seen as { account_id: string; method_name: string; args_base64: string }[]) {
      assert.equal(p.method_name, "storage_balance_bounds", `${net}: the device never asks storage_balance_of`);
      assert.equal(p.account_id, NEAR_NETWORKS[net].usdc);
      assert.deepEqual(decode(p.args_base64), {}, `${net}: no read names an A`);
      assert.deepEqual(Object.keys(p).sort(), ["account_id", "args_base64", "finality", "method_name", "request_type"]);
    }
  }
});

test("register_deposit is storage_balance_bounds().min, never max: max 2 × min and max null on both sides", async () => {
  for (const max of [String(2n * MIN), null]) {
    const edit = (r: Read, j: any) => r === "bounds" && setBytes(j, { min: String(MIN), max }); // edited: max, both sides
    assert.equal(await depositOf("mainnet", pair("mainnet", { edit })), MIN, `max ${max}`);
  }
});

test("the two RPCs disagree on the minimum: refused, nothing decided", async () => {
  // edited: the dRPC side's min one yocto higher
  const up = { edit: (r: Read, j: any) => r === "bounds" && setBytes(j, { min: String(MIN + 1n), max: String(MIN + 1n) }) };
  await refused(depositOf("mainnet", pair("mainnet", {}, up)), "disagree", /minimum/);
});

test("one RPC down: refused, either side", async () => {
  await refused(depositOf("mainnet", pair("mainnet", { down: true }, {})), "rpc", /did not answer/);
  await refused(depositOf("mainnet", pair("mainnet", {}, { down: true })), "rpc", /did not answer/);
});

test("an error answer or a malformed minimum is refused", async () => {
  // edited: a JSON-RPC error, bytes that are not JSON, no bytes, no min in its one form
  const edits: [string, (r: Read, j: any) => void, RegExp][] = [
    ["rpc error", (r, j) => r === "bounds" && ((j.error = { name: "HANDLER_ERROR" }), delete j.result), /failed/],
    ["a top-level error next to a result", (r, j) => r === "bounds" && (j.error = { name: "HANDLER_ERROR" }), /failed/],
    ["not JSON", (r, j) => r === "bounds" && (j.result.result = [0x7b]), /not JSON/],
    ["no bytes", (r, j) => r === "bounds" && delete j.result.result, /failed/],
    ["a byte above 255", (r, j) => r === "bounds" && (j.result.result = [0x17b, 0x7d]), /failed/],
    ["min with a leading zero", (r, j) => r === "bounds" && setBytes(j, { min: "0" + String(MIN), max: null }), /no min/],
    ["min a number", (r, j) => r === "bounds" && setBytes(j, { min: 1250000000000000000000, max: null }), /no min/],
    ["min above 2^128", (r, j) => r === "bounds" && setBytes(j, { min: String(1n << 128n), max: null }), /no min/],
  ];
  for (const [what, edit, re] of edits) await refused(depositOf("mainnet", pair("mainnet", {}, { edit })), "rpc", re).catch((e) => assert.fail(`${what}: ${e}`));
});

test("the RPC pair must be one FastNEAR URL and the network's dRPC URL, exactly", async () => {
  const net = NEAR_NETWORKS.mainnet;
  // the pair the other way round is fine, and so is the other FastNEAR URL
  assert.equal(await depositOf("mainnet", [replay("mainnet", "b"), replay("mainnet", "a")]), MIN);
  assert.equal(await depositOf("mainnet", [replay("mainnet", "a", { name: net.fastnear[1] }), replay("mainnet", "b")]), MIN);
  const bad: [string, NearRpc, NearRpc][] = [
    ["two FastNEAR URLs, one operator", replay("mainnet", "a"), replay("mainnet", "b", { name: net.fastnear[1] })],
    ["dRPC twice", replay("mainnet", "b"), replay("mainnet", "b")],
    ["a testnet RPC on mainnet", replay("mainnet", "a"), replay("mainnet", "b", { name: NEAR_NETWORKS.testnet.drpc })],
    ["a URL off the list", replay("mainnet", "a"), replay("mainnet", "b", { name: net.drpc + "/" })],
  ];
  for (const [what, x, y] of bad) await refused(depositOf("mainnet", [x, y]), "input", /exactly/).catch((e) => assert.fail(`${what}: ${e}`));
  await refused(depositOf("mainnet", [replay("mainnet", "a")] as unknown as [NearRpc, NearRpc]), "input");
});

test("armingRegisterDepositOf is withdrawRequest's registerDepositOf; the withdrawal's token must be the network's", async () => {
  const f: WithdrawRequestArgs["registerDepositOf"] = armingRegisterDepositOf("mainnet", pair("mainnet"));
  assert.equal(await f(rec.test_a, VAULT_CONSTANTS.TOKEN), MIN);
  // the withdrawal's token must be the token the read is made on, and nothing is read otherwise
  const seen: unknown[] = [];
  for (const [net, token] of [["mainnet", NEAR_NETWORKS.testnet.usdc], ["testnet", NEAR_NETWORKS.mainnet.usdc], ["mainnet", undefined]] as const)
    await refused(armingRegisterDepositOf(net, pair(net, { seen }))(rec.test_a, token as unknown as string), "input", /token/);
  assert.equal(seen.length, 0);
  for (const n of ["devnet", "toString", "__proto__", "constructor"])
    await refused(armingRegisterDepositOf(n as NearNetwork, pair("mainnet"))(rec.test_a, VAULT_CONSTANTS.TOKEN), "input", /network/);
});

test("a stale final: answers more than HEIGHT_SPREAD_MAX blocks apart are refused; within it they are read", async () => {
  // the recorded bounds answers are at 222686290 on both: 30 back on a is within the spread, 400 back is a stale final
  const back = (n: number): Opts => ({ edit: (_r, j) => (j.result.block_height -= n) });
  assert.equal(await depositOf("mainnet", [replay("mainnet", "a", back(30)), replay("mainnet", "b", back(0))]), MIN);
  await refused(depositOf("mainnet", [replay("mainnet", "a", back(400)), replay("mainnet", "b", back(0))]), "disagree", /spread/);
  await refused(depositOf("mainnet", [replay("mainnet", "a", { edit: (_r, j) => delete j.result.block_height }), replay("mainnet", "b")]), "rpc", /block height/);
});
