// Signs one deposit call as U's device does (vault paper 2.10 (b)), for the near-sandbox proof of the deposit relayer's
// send (contracts/vault/tests/relayer_send.rs). A test tool: it reads a test key from stdin and is never run on a
// network that holds money.
//   echo '{"secret_key":"ed25519:<base58 of 64 bytes>","sender":"<64-hex>","token":"..","vault":"..","amount":"1000000",
//          "precommitment":"7","nonce":"1","max_block_height":"200"}' | node apps/helper/test/bind-send/sign.ts
// stdout, one line: {"signed_delegate":"<standard base64>"}: a NEP-366 SignedDelegateAction, sender U, receiver the
// token, one FunctionCall ft_transfer_call with args JSON.stringify({receiver_id: vault, amount, msg}),
// msg = JSON.stringify({precommitment, depositor: U}), 1 yocto and the gas given (default 180 Tgas), signed ed25519 over
// sha256(u32le(2^30 + 366) || borsh(DelegateAction)).
//
// The encoder is apps/helper/src/bind/checks.test.ts's (le, str, encode), copied: an app reaches Blindfill only through
// @blindfill/kit's entry, so packages/wallet's encoder is not imported.
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";

/** NEP-366's signable prefix: 2^30 + 366. */
export const NEP366_PREFIX = 2 ** 30 + 366;
const DEFAULT_GAS = "180000000000000";

export type SignInput = {
  secret_key: string;
  sender: string;
  token: string;
  vault: string;
  amount: string;
  precommitment: string;
  nonce: string;
  max_block_height: string;
  gas?: string;
};

const le = (n: bigint, len: number): Buffer => {
  const b = Buffer.alloc(len);
  for (let i = 0; i < len; i++) b[i] = Number((n >> BigInt(8 * i)) & 0xffn);
  return b;
};
const str = (s: string | Uint8Array): Buffer => {
  const b = typeof s === "string" ? Buffer.from(s, "utf8") : Buffer.from(s);
  return Buffer.concat([le(BigInt(b.length), 4), b]);
};

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58Decode(s: string): Buffer {
  let n = 0n;
  for (const c of s) {
    const v = B58.indexOf(c);
    if (v < 0) throw new Error("secret_key: not base58");
    n = n * 58n + BigInt(v);
  }
  const out: number[] = [];
  while (n > 0n) {
    out.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const c of s) {
    if (c !== "1") break;
    out.unshift(0);
  }
  return Buffer.from(out);
}

/** A canonical unsigned decimal below 2^bits. */
function dec(v: unknown, what: string, bits: number): bigint {
  if (typeof v !== "string" || !/^(0|[1-9][0-9]*)$/.test(v) || v.length > 80) throw new Error(`${what}: not a canonical decimal`);
  const n = BigInt(v);
  if (n >= 1n << BigInt(bits)) throw new Error(`${what}: not below 2^${bits}`);
  return n;
}

const ACCOUNT = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

export function signDeposit(input: unknown): { signed_delegate: string } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new Error("input: not an object");
  const i = input as Record<string, unknown>;
  const allowed = new Set(["secret_key", "sender", "token", "vault", "amount", "precommitment", "nonce", "max_block_height", "gas"]);
  for (const k of Object.keys(i)) if (!allowed.has(k)) throw new Error(`input: unknown field ${k}`);
  const sk = i.secret_key;
  if (typeof sk !== "string" || !sk.startsWith("ed25519:")) throw new Error("secret_key: not ed25519:<base58>");
  const raw = base58Decode(sk.slice("ed25519:".length));
  if (raw.length !== 64) throw new Error("secret_key: not 64 bytes (32 seed + 32 public)");
  const seed = raw.subarray(0, 32);
  const pub = raw.subarray(32);
  // the seed alone (PKCS#8 for Ed25519, RFC 8410), so the public half is derived and then compared
  const priv = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
  const derived = Buffer.from(createPublicKey(priv).export({ format: "jwk" }).x as string, "base64url");
  if (!derived.equals(pub)) throw new Error("secret_key: its public half is not the seed's");

  const sender = i.sender;
  if (typeof sender !== "string" || !/^[0-9a-f]{64}$/.test(sender)) throw new Error("sender: not a 64-hex implicit account");
  for (const k of ["token", "vault"] as const) {
    const v = i[k];
    if (typeof v !== "string" || !ACCOUNT.test(v)) throw new Error(`${k}: not a NEAR account id`);
  }
  const token = i.token as string;
  const vault = i.vault as string;
  const amount = dec(i.amount, "amount", 128);
  const precommitment = dec(i.precommitment, "precommitment", 256);
  const nonce = dec(i.nonce, "nonce", 64);
  const mbh = dec(i.max_block_height, "max_block_height", 64);
  const gas = dec(i.gas ?? DEFAULT_GAS, "gas", 64);

  const msg = JSON.stringify({ precommitment: precommitment.toString(), depositor: sender });
  const args = JSON.stringify({ receiver_id: vault, amount: amount.toString(), msg });
  const action = Buffer.concat([Buffer.from([2]), str("ft_transfer_call"), str(args), le(gas, 8), le(1n, 16)]);
  const delegate = Buffer.concat([str(sender), str(token), le(1n, 4), action, le(nonce, 8), le(mbh, 8), Buffer.from([0]), pub]);
  const hash = createHash("sha256").update(le(BigInt(NEP366_PREFIX), 4)).update(delegate).digest();
  const signed = Buffer.concat([delegate, Buffer.from([0]), sign(null, hash, priv)]);
  return { signed_delegate: signed.toString("base64") };
}

if (import.meta.main) {
  try {
    const input: unknown = JSON.parse(readFileSync(0, "utf8"));
    process.stdout.write(JSON.stringify(signDeposit(input)) + "\n");
  } catch (e) {
    process.stderr.write(`sign.ts: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  }
}
