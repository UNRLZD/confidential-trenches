// Writes test/vectors/deposit-delegate.json, the shared vector of card wallet-deposit-delegate: U_{1,0} of the public
// test seed (64 bytes of 0x42, the seed of test/vectors/deposit-account.json's test_u) signs its testnet deposit call
// through depositDelegate, from U's reads replayed out of deposit-account.json (replayDepositReads: the good account's
// answers with its key edited to U's). Ed25519 is deterministic (RFC 8032), so the bytes are fixed. Offline; no
// network, no key beyond the public test seed.   node test/record-deposit-delegate.mjs   (from packages/wallet)
import { writeFileSync } from "node:fs";
import { base58 } from "@scure/base";
import { NEAR_NETWORKS } from "../src/deposit/account.ts";
import { depositDelegate } from "../src/deposit/delegate.ts";
import { depositId } from "../src/derive/keys.ts";
import { replayDepositReads } from "./replay-deposit-reads.ts";

const seed = new Uint8Array(64).fill(0x42);
const u = depositId(seed, 1n, 0);
const publicKey = `ed25519:${base58.encode(u.publicKey)}`;
u.secretKey.fill(0);
const input = { s: "1", i: 0, network: "testnet", amount: "25000000", precommitment: "1234567890123456789012345678901234567890", window: 120 };
const net = NEAR_NETWORKS.testnet;
const out = await depositDelegate(
  seed, 1n, 0,
  { network: "testnet", amount: BigInt(input.amount), precommitment: BigInt(input.precommitment), window: input.window },
  replayDepositReads("testnet", publicKey),
);
const read = { nonce: 121445688000168, height: 222541714 }; // keys_good's nonce; the lowest of the six recorded heights
const vector = {
  made_by: "test/record-deposit-delegate.mjs: depositDelegate on U_{1,0} of the public test seed (64 bytes of 0x42), reads replayed",
  input: { ...input, read },
  signed_delegate: out.signed_delegate,
  expect: {
    sender_id: u.id,
    receiver_id: net.token,
    vault: net.vault,
    public_key: publicKey,
    nonce: String(read.nonce + 1),
    max_block_height: String(read.height + input.window),
    method_name: "ft_transfer_call",
    args: JSON.stringify({ receiver_id: net.vault, amount: input.amount, msg: JSON.stringify({ precommitment: input.precommitment, depositor: u.id }) }),
    gas: "180000000000000",
    deposit: "1",
  },
};
writeFileSync(new URL("./vectors/deposit-delegate.json", import.meta.url), JSON.stringify(vector, null, 1) + "\n");
