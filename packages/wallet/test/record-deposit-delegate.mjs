// Writes test/vectors/deposit-delegate.json, the shared vector of card wallet-deposit-delegate: U_{1,0} of the public
// test seed (64 bytes of 0x42, the seed of test/vectors/deposit-account.json's test_u) signs its deposit call from a
// read written here by hand. Ed25519 is deterministic (RFC 8032), so the bytes are fixed. Offline; no network, no key
// beyond the public test seed.   node test/record-deposit-delegate.mjs   (from packages/wallet)
import { writeFileSync } from "node:fs";
import { base58 } from "@scure/base";
import { depositId } from "../src/derive/keys.ts";
import { signDepositDelegate } from "../src/deposit/delegate.ts";

const seed = new Uint8Array(64).fill(0x42);
const u = depositId(seed, 1n, 0);
const input = {
  s: "1",
  i: 0,
  network: "mainnet",
  vault: "vault.confidential.unrlzd.near",
  amount: "25000000",
  precommitment: "1234567890123456789012345678901234567890",
  window: 120,
  read: { account: u.id, publicKey: `ed25519:${base58.encode(u.publicKey)}`, nonce: 222541000000005, balance: "25000000", height: 222541714 },
};
const read = { ...input.read, balance: BigInt(input.read.balance), codeHash: "unused", halted: false, pendingPause: "unread" };
const out = signDepositDelegate(seed, 1n, 0, { vault: input.vault, network: "mainnet", amount: BigInt(input.amount), precommitment: BigInt(input.precommitment), window: input.window }, read);
const vector = {
  made_by: "test/record-deposit-delegate.mjs: signDepositDelegate on U_{1,0} of the public test seed (64 bytes of 0x42)",
  input,
  signed_delegate: out.signed_delegate,
  expect: {
    sender_id: u.id,
    receiver_id: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", // gitleaks:allow (a public account id)
    public_key: input.read.publicKey,
    nonce: String(input.read.nonce + 1),
    max_block_height: String(input.read.height + input.window),
    method_name: "ft_transfer_call",
    args: JSON.stringify({ receiver_id: input.vault, amount: input.amount, msg: JSON.stringify({ precommitment: input.precommitment, depositor: u.id }) }),
    gas: "180000000000000",
    deposit: "1",
  },
};
writeFileSync(new URL("./vectors/deposit-delegate.json", import.meta.url), JSON.stringify(vector, null, 1) + "\n");
