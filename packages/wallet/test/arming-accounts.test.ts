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
  readArmingRegistration,
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

test("registered on both: register_deposit is still the minimum (card relayer-cost-guards, audit V-03: the relayer carries only the minimum, so A cannot bounce its payout by unregistering)", async () => {
  const r = await readArmingRegistration(rec.good, "mainnet", pair("mainnet", { reg: "reg_set" }));
  assert.deepEqual(r, { account: rec.good, registered: true, min: MIN, registerDeposit: MIN });
  // withdrawRequest's registerDepositOf gives the same for a registered A
  assert.equal(await armingRegisterDepositOf("mainnet", pair("mainnet", { reg: "reg_set" }))(rec.good, NEAR_NETWORKS.mainnet.usdc), MIN);
});

test("not registered on both: register_deposit = storage_balance_bounds().min, mainnet and testnet", async () => {
  for (const net of ["mainnet", "testnet"] as const) {
    const o = net === "mainnet" ? {} : { reg: "reg_null_testnet", bounds: "bounds_testnet" };
    const r = await readArmingRegistration(rec.test_a, net, pair(net, o));
    assert.deepEqual(r, { account: rec.test_a, registered: false, min: MIN, registerDeposit: MIN }, net);
  }
});

test("register_deposit is storage_balance_bounds().min, never max: max 2 × min and max null on both sides", async () => {
  for (const max of [String(2n * MIN), null]) {
    const edit = (r: Read, j: any) => r === "bounds" && setBytes(j, { min: String(MIN), max }); // edited: max, both sides
    const r = await readArmingRegistration(rec.test_a, "mainnet", pair("mainnet", { edit }));
    assert.equal(r.registerDeposit, MIN, `max ${max}`);
    assert.equal(r.min, MIN, `max ${max}`);
  }
});

test("the two RPCs disagree: refused, nothing decided", async () => {
  // registered on one, null on the other, either way round
  const set = { reg: "reg_set" } as Opts;
  const nul = { reg: "reg_set", edit: (r: Read, j: any) => r === "reg" && setBytes(j, null) } as Opts; // edited: GOOD's answer to null
  await refused(readArmingRegistration(rec.good, "mainnet", pair("mainnet", set, nul)), "disagree", /registered/);
  await refused(readArmingRegistration(rec.good, "mainnet", pair("mainnet", nul, set)), "disagree", /registered/);
  // edited: the dRPC side's min one yocto higher
  const up = { edit: (r: Read, j: any) => r === "bounds" && setBytes(j, { min: String(MIN + 1n), max: String(MIN + 1n) }) };
  await refused(readArmingRegistration(rec.test_a, "mainnet", pair("mainnet", {}, up)), "disagree", /minimum/);
});

test("one RPC down: refused, either side and either read", async () => {
  await refused(readArmingRegistration(rec.test_a, "mainnet", pair("mainnet", { down: true }, {})), "rpc", /did not answer/);
  await refused(readArmingRegistration(rec.test_a, "mainnet", pair("mainnet", {}, { down: true })), "rpc", /did not answer/);
  // only the bounds read lost on one side, with A registered on both
  const lost: NearRpc = { ...replay("mainnet", "b", { reg: "reg_set" }) };
  const inner = lost.query;
  lost.query = async (p) => ((p as { method_name: string }).method_name === "storage_balance_bounds" ? Promise.reject(new Error("timeout")) : inner(p));
  await refused(readArmingRegistration(rec.good, "mainnet", [replay("mainnet", "a", { reg: "reg_set" }), lost]), "rpc", /bounds read/);
});

test("an error answer or a malformed value is refused, never read as unregistered", async () => {
  // the real panic answer of storage_balance_of on both sides, then on one
  await refused(readArmingRegistration(rec.test_a, "mainnet", pair("mainnet", { reg: "reg_panic" })), "rpc", /failed/);
  await refused(readArmingRegistration(rec.test_a, "mainnet", pair("mainnet", {}, { reg: "reg_panic" })), "rpc", /failed/);
  // edited: a JSON-RPC error, a value that is neither null nor a storage balance, bytes that are not JSON, no min
  const edits: [string, (r: Read, j: any) => void, RegExp][] = [
    ["rpc error", (r, j) => r === "reg" && ((j.error = { name: "HANDLER_ERROR" }), delete j.result), /failed/],
    ["a top-level error next to a null result", (r, j) => r === "reg" && (j.error = { name: "HANDLER_ERROR" }), /failed/],
    ["0", (r, j) => r === "reg" && setBytes(j, 0), /neither null/],
    ["available not U128", (r, j) => r === "reg" && setBytes(j, { total: String(MIN), available: "-1" }), /neither null/],
    ["no available", (r, j) => r === "reg" && setBytes(j, { total: String(MIN) }), /neither null/],
    ["total not U128", (r, j) => r === "reg" && setBytes(j, { total: "1.5", available: "0" }), /neither null/],
    ["total above 2^128", (r, j) => r === "reg" && setBytes(j, { total: String(1n << 128n), available: "0" }), /neither null/],
    ["not JSON", (r, j) => r === "reg" && (j.result.result = [0x7b]), /not JSON/],
    ["no bytes", (r, j) => r === "reg" && delete j.result.result, /no bytes/],
    ["a byte above 255 that wraps to \"null\"", (r, j) => r === "reg" && (j.result.result = [0x16e, 0x75, 0x6c, 0x6c]), /no bytes/],
    ["total with a leading zero", (r, j) => r === "reg" && setBytes(j, { total: "0" + String(MIN), available: "0" }), /neither null/],
    ["min with a leading zero", (r, j) => r === "bounds" && setBytes(j, { min: "0" + String(MIN), max: null }), /no min/],
    ["min a number", (r, j) => r === "bounds" && setBytes(j, { min: 1250000000000000000000, max: null }), /no min/],
    ["min above 2^128", (r, j) => r === "bounds" && setBytes(j, { min: String(1n << 128n), max: null }), /no min/],
  ];
  for (const [what, edit, re] of edits) await refused(readArmingRegistration(rec.test_a, "mainnet", pair("mainnet", {}, { edit })), "rpc", re).catch((e) => assert.fail(`${what}: ${e}`));
});

test("the RPC pair must be one FastNEAR URL and the network's dRPC URL, exactly", async () => {
  const net = NEAR_NETWORKS.mainnet;
  // the pair the other way round is fine
  const r = await readArmingRegistration(rec.test_a, "mainnet", [replay("mainnet", "b"), replay("mainnet", "a")]);
  assert.equal(r.registerDeposit, MIN);
  // the other FastNEAR URL is fine
  assert.equal((await readArmingRegistration(rec.test_a, "mainnet", [replay("mainnet", "a", { name: net.fastnear[1] }), replay("mainnet", "b")])).registerDeposit, MIN);
  const bad: [string, NearRpc, NearRpc][] = [
    ["two FastNEAR URLs, one operator", replay("mainnet", "a"), replay("mainnet", "b", { name: net.fastnear[1] })],
    ["dRPC twice", replay("mainnet", "b"), replay("mainnet", "b")],
    ["a testnet RPC on mainnet", replay("mainnet", "a"), replay("mainnet", "b", { name: NEAR_NETWORKS.testnet.drpc })],
    ["a URL off the list", replay("mainnet", "a"), replay("mainnet", "b", { name: net.drpc + "/" })],
  ];
  for (const [what, x, y] of bad) await refused(readArmingRegistration(rec.test_a, "mainnet", [x, y]), "input", /exactly/).catch((e) => assert.fail(`${what}: ${e}`));
  await refused(readArmingRegistration(rec.test_a, "mainnet", [replay("mainnet", "a")] as unknown as [NearRpc, NearRpc]), "input");
});

test("A must be a lowercase 64-hex implicit id, and the network one of the kit's", async () => {
  for (const a of [rec.test_a.toUpperCase(), "alice.near", rec.test_a.slice(1), `${rec.test_a}0`, 7 as unknown as string])
    await refused(readArmingRegistration(a, "mainnet", pair("mainnet")), "input", /64-hex/);
  for (const n of ["devnet", "toString", "__proto__", "constructor"])
    await refused(readArmingRegistration(rec.test_a, n as NearNetwork, pair("mainnet")), "input", /network/);
});

test("each request names only A or the token, at final", async () => {
  const seen: unknown[] = [];
  await readArmingRegistration(rec.test_a, "mainnet", pair("mainnet", { seen }));
  assert.equal(seen.length, 4);
  for (const p of seen as { account_id: string; method_name: string; args_base64: string }[]) {
    assert.equal(p.account_id, VAULT_CONSTANTS.TOKEN);
    assert.deepEqual(decode(p.args_base64), p.method_name === "storage_balance_of" ? { account_id: rec.test_a } : {});
    assert.deepEqual(Object.keys(p).sort(), ["account_id", "args_base64", "finality", "method_name", "request_type"]);
  }
});

test("armingRegisterDepositOf is withdrawRequest's registerDepositOf", async () => {
  const f: WithdrawRequestArgs["registerDepositOf"] = armingRegisterDepositOf("mainnet", pair("mainnet"));
  assert.equal(await f(rec.test_a, VAULT_CONSTANTS.TOKEN), MIN);
  assert.equal(await armingRegisterDepositOf("mainnet", pair("mainnet", { reg: "reg_set" }))(rec.good, VAULT_CONSTANTS.TOKEN), MIN); // registered: still the minimum (V-03)
  await refused(armingRegisterDepositOf("mainnet", pair("mainnet", {}, { down: true }))(rec.test_a, VAULT_CONSTANTS.TOKEN), "rpc");
  // the withdrawal's token must be the token the read is made on, and nothing is read otherwise
  const seen: unknown[] = [];
  for (const [net, token] of [["mainnet", NEAR_NETWORKS.testnet.usdc], ["testnet", NEAR_NETWORKS.mainnet.usdc], ["mainnet", undefined]] as const)
    await refused(armingRegisterDepositOf(net, pair(net, { seen }))(rec.test_a, token as unknown as string), "input", /token/);
  assert.equal(seen.length, 0);
});

test("a stale final: answers more than HEIGHT_SPREAD_MAX blocks apart are refused; within it they are read", async () => {
  // the recorded four answers span 222686288-222686290: 27 back on a puts them 30 apart, 400 back is a stale final
  const back = (n: number): Opts => ({ edit: (_r, j) => (j.result.block_height -= n) });
  const a = await readArmingRegistration(rec.test_a, "mainnet", [replay("mainnet", "a", back(27)), replay("mainnet", "b", back(0))]);
  assert.equal(typeof a.registerDeposit, "bigint");
  await refused(readArmingRegistration(rec.test_a, "mainnet", [replay("mainnet", "a", back(400)), replay("mainnet", "b", back(0))]), "disagree", /spread/);
  await refused(readArmingRegistration(rec.test_a, "mainnet", [replay("mainnet", "a", { edit: (_r, j) => delete j.result.block_height }), replay("mainnet", "b")]), "rpc", /block height/);
});
