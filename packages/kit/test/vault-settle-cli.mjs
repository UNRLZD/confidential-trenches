// The kit's settle as one CLI run, for contracts/vault/tests/settle.rs's kit_settle (near-sandbox): reads one JSON
// object on stdin, runs vaultSettleOwn once against the given RPCs, and prints one JSON line. Test keys only (the
// sandbox's accounts): the signer's key is used inside this process to sign the kit's call, and never printed.
//   stdin: { rpc: [url, url], vault, scope, signer: { account_id, secret_key }, spends: [{ nullifierHash, refundPrecommitment,
//            ref, parent }], notes: [the store's notes from an earlier run] }   (every number a decimal string)
//   stdout: { outcomes: [...], notes: [...the store after the run], sent: [tx hashes] }
import { createHash, createPrivateKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";
// near-tx.mjs only (it imports nothing): the sandbox suite runs this file, so it reaches no script outside the vault's
import { b58decode, b58encode, functionCallTx } from "../../../contracts/vault/scripts/near-tx.mjs";
import { vaultSettleOwn } from "../src/index.ts";

const input = JSON.parse(readFileSync(0, "utf8"));
const str = (_, v) => (typeof v === "bigint" ? String(v) : v);
const post = async (url, method, params) => {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "kit-settle", method, params }) });
  return r.json();
};
const raw = b58decode(input.signer.secret_key.replace(/^ed25519:/, ""));
const pub = raw.subarray(32);
const privateKey = createPrivateKey({ key: { kty: "OKP", crv: "Ed25519", d: Buffer.from(raw.subarray(0, 32)).toString("base64url"), x: Buffer.from(pub).toString("base64url") }, format: "jwk" });
const signer = input.signer.account_id;
const sent = [];
// the device's own NEAR gas: the signer signs the kit's call as one FunctionCall and sends it
async function send(c) {
  const url = input.rpc[0];
  const ak = await post(url, "query", { request_type: "view_access_key", account_id: signer, public_key: `ed25519:${b58encode(pub)}`, finality: "final" });
  const block = await post(url, "block", { finality: "final" });
  const tx = functionCallTx({ signer, publicKey: pub, nonce: BigInt(ak.result.nonce) + 1n, receiver: c.receiverId, blockHash: b58decode(block.result.header.hash), method: c.methodName, args: c.args, gas: c.gas, deposit: c.deposit });
  const h = createHash("sha256").update(tx).digest();
  const signed = Buffer.concat([tx, Buffer.from([0]), sign(null, h, privateKey)]);
  const r = await post(url, "send_tx", { signed_tx_base64: signed.toString("base64"), wait_until: "FINAL" });
  if (r.error) throw new Error(`send_tx: ${JSON.stringify(r.error).slice(0, 300)}`);
  const hash = b58encode(h);
  sent.push(hash);
  return hash;
}
// every number back to a BigInt, the leaf's too: the kit compares a held leaf with the spend row's (review F3)
const leafOf = (l) => (l === undefined ? undefined : { value: BigInt(l.value), label: BigInt(l.label), commitment: BigInt(l.commitment), leafIndex: BigInt(l.leafIndex) });
const notes = (input.notes ?? []).map((n) => ({ ...n, scope: BigInt(n.scope), precommitment: BigInt(n.precommitment), leaf: leafOf(n.leaf) }));
const store = {
  async list() {
    return notes;
  },
  async add(n) {
    if (notes.some((x) => x.precommitment === n.precommitment)) throw new Error("that precommitment is already in the store");
    notes.push(n);
    return n;
  },
};
const rpcs = input.rpc.map((url, i) => ({ name: `sandbox-${i}`, query: (params) => post(url, "query", params) }));
const spends = input.spends.map((s) => ({ nullifierHash: BigInt(s.nullifierHash), refundPrecommitment: BigInt(s.refundPrecommitment), ref: s.ref, parent: s.parent }));
const r = await vaultSettleOwn({ vault: input.vault, scope: BigInt(input.scope), rpcs, spends, send, store });
console.log(JSON.stringify({ outcomes: r.outcomes, notes, sent }, str));
