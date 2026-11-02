// sign.ts, the sandbox proof's signer, run as the proof runs it (a child process, JSON on stdin): its output decodes
// with the relayer's own decodeSignedDelegate (apps/helper/src/bind/checks.ts), every field is what was asked, the
// signature verifies over NEP-366's signable message, and checkBindDeposit passes it. Bad input is refused.
//   node --test apps/helper/test/bind-send/sign.test.ts
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { NEP366_PREFIX, VAULT_TOKEN, base58, checkBindDeposit, decodeSignedDelegate, type BindLedger, type BindReads } from "../../src/bind/checks.ts";

const SIGN = path.join(path.dirname(fileURLToPath(import.meta.url)), "sign.ts");
const VAULT = "vault.test.near";
const TOKEN = VAULT_TOKEN;
const T = 1_000_000_000_000n;

function testKey(): { secret_key: string; pub: Buffer; id: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const seed = Buffer.from(privateKey.export({ format: "jwk" }).d as string, "base64url");
  const pub = Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url");
  return { secret_key: `ed25519:${base58(Buffer.concat([seed, pub]))}`, pub, id: pub.toString("hex") };
}

function run(input: unknown): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [SIGN], { input: JSON.stringify(input), encoding: "utf8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const K = testKey();
const BASE = {
  secret_key: K.secret_key,
  sender: K.id,
  token: TOKEN,
  vault: VAULT,
  amount: "2000000",
  precommitment: "21888242871839275222246405745257275088548364400416034343698204186575808495616",
  nonce: "7000001",
  max_block_height: "1200",
};

test("one line {signed_delegate}: every field as asked, the signature over sha256(u32le(2^30+366) || delegate)", () => {
  const r = run(BASE);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.endsWith("\n") && r.stdout.split("\n").length, 2, "not one line");
  const out = JSON.parse(r.stdout) as Record<string, unknown>;
  assert.deepEqual(Object.keys(out), ["signed_delegate"]);
  const b64 = out.signed_delegate as string;
  assert.match(b64, /^[A-Za-z0-9+/]*={0,2}$/);
  const d = decodeSignedDelegate(new Uint8Array(Buffer.from(b64, "base64")));
  assert.equal(d.sender_id, K.id);
  assert.equal(d.receiver_id, TOKEN);
  assert.equal(d.nonce, 7_000_001n);
  assert.equal(d.max_block_height, 1200n);
  assert.deepEqual(Buffer.from(d.public_key), K.pub);
  assert.equal(d.actions.length, 1);
  const a = d.actions[0]!;
  assert.equal(a.kind, "FunctionCall");
  if (a.kind !== "FunctionCall") return;
  assert.equal(a.method_name, "ft_transfer_call");
  assert.equal(a.deposit, 1n);
  assert.equal(a.gas, 180n * T);
  const msg = JSON.stringify({ precommitment: BASE.precommitment, depositor: K.id });
  assert.equal(Buffer.from(a.args).toString("utf8"), JSON.stringify({ receiver_id: VAULT, amount: "2000000", msg }));
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32LE(NEP366_PREFIX);
  const hash = createHash("sha256").update(prefix).update(d.delegate).digest();
  const pk = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: K.pub.toString("base64url") }, format: "jwk" });
  assert.equal(verify(null, hash, pk, d.signature), true, "the signature does not verify");
  const other = Buffer.from(hash);
  other[0]! ^= 1;
  assert.equal(verify(null, other, pk, d.signature), false, "the signature verifies over another message");
});

test("the gas given is the gas signed", () => {
  const r = run({ ...BASE, gas: "203126000000000" });
  assert.equal(r.status, 0, r.stderr);
  const d = decodeSignedDelegate(new Uint8Array(Buffer.from(JSON.parse(r.stdout).signed_delegate, "base64")));
  assert.equal(d.actions[0]!.kind === "FunctionCall" && d.actions[0]!.gas, 203_126_000_000_000n);
});

test("checkBindDeposit passes what sign.ts signs", async () => {
  const r = run(BASE);
  assert.equal(r.status, 0, r.stderr);
  const reads: BindReads = {
    accessKey: async (a, pk) => {
      assert.equal(a, K.id);
      assert.equal(pk, `ed25519:${base58(K.pub)}`);
      return { kind: "key", permission: "FullAccess", nonce: 7_000_000n };
    },
    finalHeight: async () => 1100n,
    ftBalance: async () => 2_000_000n,
    pUsed: async () => false,
  };
  const ledger: BindLedger = { struck: async () => false, boundTo: async () => null, openP: async () => null, inFlight: async () => false };
  const v = await checkBindDeposit(JSON.parse(r.stdout), { vault: VAULT, token: TOKEN, marginK: 20n }, reads, ledger);
  assert.equal(v.ok, true, JSON.stringify(v, (_, x) => (typeof x === "bigint" ? String(x) : x)));
});

test("bad input is refused with exit 1 and nothing on stdout", () => {
  const other = testKey();
  const cases: [string, unknown, RegExp][] = [
    ["not an object", [1], /input: not an object/],
    ["an unknown field", { ...BASE, x: 1 }, /unknown field x/],
    ["a non-ed25519 key", { ...BASE, secret_key: "secp256k1:abc" }, /secret_key/],
    ["a 32-byte key", { ...BASE, secret_key: `ed25519:${base58(K.pub)}` }, /not 64 bytes/],
    ["a public half that is not the seed's", { ...BASE, secret_key: swapPub(K.secret_key, other.pub) }, /public half/],
    ["a named sender", { ...BASE, sender: "alice.near" }, /sender/],
    ["an upper-case hex sender", { ...BASE, sender: K.id.toUpperCase() }, /sender/],
    ["a bad vault id", { ...BASE, vault: "Not An Account" }, /vault/],
    ["a leading zero", { ...BASE, amount: "01" }, /amount/],
    ["a number amount", { ...BASE, amount: 1 }, /amount/],
    ["a nonce of 2^64", { ...BASE, nonce: (1n << 64n).toString() }, /nonce/],
    ["a precommitment of 2^256", { ...BASE, precommitment: (1n << 256n).toString() }, /precommitment/],
  ];
  for (const [name, input, want] of cases) {
    const r = run(input);
    assert.equal(r.status, 1, `${name}: exit ${r.status}`);
    assert.equal(r.stdout, "", `${name}: printed ${r.stdout}`);
    assert.match(r.stderr, want, name);
  }
  const bad = spawnSync(process.execPath, [SIGN], { input: "not json", encoding: "utf8" });
  assert.equal(bad.status, 1);
});

function swapPub(sk: string, pub: Buffer): string {
  const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = 0n;
  for (const c of sk.slice(8)) n = n * 58n + BigInt(B58.indexOf(c));
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  while (bytes.length < 64) bytes.unshift(0);
  return `ed25519:${base58(Buffer.concat([Buffer.from(bytes.slice(0, 32)), pub]))}`;
}
