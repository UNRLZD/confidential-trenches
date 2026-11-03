// The EVM pool's deploy script (script/deploy.mjs): forge's build is the one pool-evm-deploy.build.json pins, and the
// script's own signing and addresses match Foundry's cast byte for byte.
//   node --test contracts/pool-evm/test/deploy.test.mjs     (after a forge build: it reads out/)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { BUILD_FILE, CHAINS } from "../../../scripts/live-checks/pool-evm-deploy.mjs";
import { ORDER, addressOf, buildOf, createAddress, main, signTx } from "../script/deploy.mjs";

// The secret key 1: a published test vector (its address 0x7E5F...5Bdf is in every secp256k1 test suite), never money.
const KEY_ONE = new Uint8Array(32);
KEY_ONE[31] = 1;

test("forge's build is the one pool-evm-deploy.build.json pins: lengths, runtimes with immutables zeroed, immutable offsets", () => {
  const pinned = JSON.parse(readFileSync(BUILD_FILE, "utf8")).contracts;
  assert.deepEqual(Object.keys(pinned), ORDER);
  assert.deepEqual(buildOf(), pinned, "rebuild the pin: node contracts/pool-evm/script/deploy.mjs --write-build");
  // the verifier's code is the one the pool's constructor accepts (State.sol WITHDRAWAL_VERIFIER_CODEHASH)
  const state = readFileSync(new URL("../src/State.sol", import.meta.url), "utf8");
  assert.equal(pinned.WithdrawalVerifier.masked, state.match(/WITHDRAWAL_VERIFIER_CODEHASH = (0x[0-9a-f]{64})/)[1]);
  assert.deepEqual(pinned.WithdrawalVerifier.immutables, []);
});

test("every chain deploys the pool, its v4 adapter and the sell delegate; the v3 adapter only where a v3 router is pinned", () => {
  for (const [name, c] of Object.entries(CHAINS)) {
    for (const n of ["WithdrawalVerifier", "PrivacyPoolSimple", "UniswapV4Adapter", "SellDelegate"]) assert.ok(c.contracts.includes(n), `${name} ${n}`);
    assert.equal(c.contracts.includes("UniswapV3Adapter"), !!c.router, name);
    assert.deepEqual(c.contracts, ORDER.filter((n) => c.contracts.includes(n)), `${name} deploys in ORDER`);
  }
});

test("the run key's address and CREATE addresses match cast's", () => {
  assert.equal(addressOf(KEY_ONE), "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf");
  // cast compute-address 0x6ac7ea33f8831ea9dcc53393aaa88b25a785dbf0 --nonce 0 / --nonce 200 (cast 1.7.1)
  assert.equal(createAddress("0x6ac7ea33f8831ea9dcc53393aaa88b25a785dbf0", 0), "0xcd234a471b72ba2f1ccf0a70fcaba648a5eecd8d");
  assert.equal(createAddress("0x6ac7ea33f8831ea9dcc53393aaa88b25a785dbf0", 200), "0xeb7facd118466c9acbcb4ee964a0ac0b0b2ef256");
});

test("a signed transfer and a signed create are cast mktx's bytes (RFC 6979, so equal byte for byte)", () => {
  // cast mktx --private-key <key 1> --chain 84532 --nonce 3 --gas-limit 50000 --gas-price 2000000
  //   --priority-gas-price 1000 0x000000000000000000000000000000000000dead --value 12345
  const transfer = signTx(KEY_ONE, { chainId: 84532n, nonce: 3n, maxPriorityFeePerGas: 1000n, maxFeePerGas: 2000000n, gas: 50000n, to: "0x000000000000000000000000000000000000dead", value: 12345n });
  assert.equal(transfer.raw, "0x02f86c83014a34038203e8831e848082c35094000000000000000000000000000000000000dead82303980c001a09b86467804c129ed441cd881343aaa4d75005c6329a47526c29d2a61b974d17ea0520581702c64faa1588cb70e50a580d456099eb247e60ca373bebe23674928da");
  // cast mktx --private-key <key 1> --chain 46630 --nonce 0 --gas-limit 300000 --gas-price 20000000
  //   --priority-gas-price 0 --create 0x6080604052
  const create = signTx(KEY_ONE, { chainId: 46630n, nonce: 0n, maxPriorityFeePerGas: 0n, maxFeePerGas: 20000000n, gas: 300000n, to: null, data: "0x6080604052" });
  assert.equal(create.raw, "0x02f85a82b62680808401312d00830493e08080856080604052c001a01463c67dd7ff2bea10f237a3fe928206079e2916127e6addd58312edc854878aa01deed5bfceba0333499ac42ce9f659f7d80beac2e115c0a3a2c04f3bdd03ecc8");
});

// main's refusals, before any key is made: answers from a stub RPC
function withChainId(id, f) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const { method } = JSON.parse(init.body);
    if (method !== "eth_chainId") throw new Error(`unexpected ${method}`);
    return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result: id }) };
  };
  return f().finally(() => (globalThis.fetch = real));
}
const RET = ["--return", "0x000000000000000000000000000000000000dead"];

test("a mainnet is refused: Base and Robinhood answer 0x2105 and 0x1237, their deploy is the owner's", async () => {
  for (const [chain, id] of [["base-sepolia", "0x2105"], ["robinhood-testnet", "0x1237"]])
    await withChainId(id, () => assert.rejects(main(["--chain", chain, ...RET, "--rpc", "https://rpc.example", "--no-build"]), /mainnet .*the owner's/));
});

test("an RPC answering another chain's id is refused, a dry run needs --out, and --chain and --return are required", async () => {
  await withChainId("0xb626", () => assert.rejects(main(["--chain", "base-sepolia", ...RET, "--rpc", "https://rpc.example", "--no-build"]), /not base-sepolia's 0x14a34/));
  await assert.rejects(main(["--chain", "base-sepolia", ...RET, "--rpc", "http://127.0.0.1:8545", "--no-build"]), /needs --out/);
  await assert.rejects(main(["--chain", "base", ...RET]), /--chain is one of/);
  await assert.rejects(main(["--chain", "base-sepolia", "--return", "E"]), /--return <address>/);
});
