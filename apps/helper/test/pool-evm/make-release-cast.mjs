// Writes apps/helper/src/pool/fixtures/release-cast.json from cast alone (card helper-evm-sender-2), so the helper's
// check of W's withdraw and buy signatures is held to the pool's own EIP-712 types, never to the helper's code: the
// Withdraw, Buy and EIP712Domain type strings are read out of contracts/pool-evm/src (PrivacyPool.sol,
// PrivacyPoolSimple.sol) at the commit this runs on, and per case cast makes W's signature over the typed data (cast
// wallet sign --data, cast's own EIP-712) and over the digest made here from cast keccak and cast abi-encode (cast wallet
// sign --no-hash: the two must be equal), and the release's calldata (cast calldata). Each case also carries W's
// signatures of the same release changed in one field (another value, nullifier, context, chain, pool, method, and for
// a buy its adapter, data, minOut and token, `coin` in the fixture), each a real signature by W of another message: the helper must refuse
// every one. W is the Hardhat/anvil test mnemonic's index 0, a published test key; the recipient is W.
//   node apps/helper/test/pool-evm/make-release-cast.mjs [--check]   (--check: exit 1 unless the file on disk is equal)
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { evmPoolRouteData, evmPoolVenues } from "@blindfill/kit";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const OUT = join(ROOT, "apps/helper/src/pool/fixtures/release-cast.json");
const MNEMONIC = "test test test test test test test test test test test junk";
const cast = (...a) => execFileSync("cast", a, { encoding: "utf8" }).trim();
const src = (f) => readFileSync(join(ROOT, "contracts/pool-evm/src", f), "utf8");
const withdrawType = /'(Withdraw\(uint256 nullifier[^']*\))'/.exec(src("PrivacyPool.sol"))?.[1];
const domainType = /'(EIP712Domain\([^']*\))'/.exec(src("PrivacyPool.sol"))?.[1];
const buyType = /'(Buy\(address adapter[^']*\))'/.exec(src("PrivacyPoolSimple.sol"))?.[1];
if (!withdrawType || !domainType || !buyType) throw new Error("the pool's sources hold no Withdraw, Buy or EIP712Domain type string");
const fieldsOf = (t) => t.slice(t.indexOf("(") + 1, -1).split(",").map((f) => ({ type: f.split(" ")[0], name: f.split(" ")[1] }));

const WITHDRAW_SIG = "withdraw((address,bytes),(uint256[2],uint256[2][2],uint256[2],uint256[8]),uint256,bytes)";
const BUY_SIG = "buy((address,bytes),(uint256[2],uint256[2][2],uint256[2],uint256[8]),uint256,(address,bytes,uint256,address),bytes)";
const w = cast("wallet", "address", "--mnemonic", MNEMONIC, "--mnemonic-index", "0").toLowerCase();
/** The test pool of apps/helper/src/pool/evm.test.ts, and the deployed Base Sepolia pool (another pool). */
const POOL = "0x00000000000000000000000000000000b1f1f001";
const OTHER_POOL = "0xb239a38af69b68e6c5c305df64985f283b5d5fe5";
const FEE_TO = "0x000000000000000000000000000000000000fee1";
/** evm.test.ts's FEE: the kit's evmPoolFee at depth 2, 1 gwei and a chain fee of 7,917 wei (the test asserts it). */
const FEE = "2880000000000000";
/** pool-evm-core's relayed proof words (evm.test.ts PROOF): pubSignals[1] the nullifier, [2] the value, [7] the context. */
const PROOF = [
  "1184908809424501824094124334635703389819420838650358930182460221215309100428", "1674810211518547383579389468999824331036802579945838824753347570601139960095",
  "12148729561581703603498305712188557019996164318368766524930289868424831942892", "6100911842998281370828191634008720068403404414837215973404343605547688141895",
  "12630600456273860711786747608540226475300782062108280761748478120397194433313", "6992726715744989436705837766215308186697656563125223364054190560139085951922",
  "8508063494074742532827183379746870873369481011703966193630063232707027554966", "20919455320042026876376757481563625984522200275015943875194766111274337098026",
  "13105909549946975585863522008434360009854594135601735263493530461261550723587", "21227852615675029745296729883959330652216006565624513147422074547064789082504",
  "400000000000000000", "16448528108014878343311034841111936001422509689876565747417185086607489003672", "2",
  "3020212885829913070286059975715001976910762802925534191672966365795975638979", "2",
  "8424188727988631066893401000603797288753749629507407262343386519908765608178",
];
const [nullifier, value, context] = [PROOF[9], PROOF[10], PROOF[15]];
const relay = cast("abi-encode", "f(address,address,uint256,uint64,uint256,bytes16)", w, FEE_TO, "10000000000000000", "2000000000000", "1138856091998675893565963822108454610843705949283798736209630132365158946624", "0xc9ebb52422ed595de60e051c69edee1a");
const withdrawal = `(${POOL},${relay})`;
const p = PROOF;
const proof = `([${p[0]},${p[1]}],[[${p[2]},${p[3]}],[${p[4]},${p[5]}]],[${p[6]},${p[7]}],[${p.slice(8).join(",")}])`;
/** The Buy's token, Base Sepolia's USDC; the fixture names it `coin` (a key named token beside a hex value reads as a
 *  secret to gitleaks' generic rule). */
const COIN = "0x036cbd53842c5426634e7929541ec2318f3dcf7e";
// a buy the device's builder makes: Base Sepolia's pinned v4 adapter, native to the coin in one v4 hop (the helper
// carries only a pinned adapter's route the kit's builder encodes, evmBuyRouteOf)
const ROUTE = { venue: "uniswap-v4", currencyIn: "0x0000000000000000000000000000000000000000", hops: [{ currency: COIN, fee: 500, tickSpacing: 10, hooks: "0x0000000000000000000000000000000000000000", hookData: "0x" }] };
const BUY = { adapter: evmPoolVenues()["base-sepolia"].adapters.v4, data: `0x${Buffer.from(evmPoolRouteData("base-sepolia", ROUTE).data).toString("hex")}`, minOut: "2360180", token: COIN };

const tmp = mkdtempSync(join(tmpdir(), "release-cast-"));
let n = 0;
/** W's signature of `message` as `primaryType` under the domain of `chainId` and `pool`, by cast's EIP-712. */
function typed(primaryType, chainId, pool, message) {
  const types = { EIP712Domain: fieldsOf(domainType), [primaryType]: fieldsOf(primaryType === "Buy" ? buyType : withdrawType) };
  const file = join(tmp, `${n++}.json`);
  writeFileSync(file, JSON.stringify({ types, primaryType, domain: { name: "Blindfill", version: "1", chainId, verifyingContract: pool }, message }));
  return cast("wallet", "sign", "--data", "--from-file", "--mnemonic", MNEMONIC, "--mnemonic-index", "0", file);
}
/** The same digest made here from cast's hashes, and W's signature of it with no further hash. */
function digestSigned(primaryType, chainId, pool, m) {
  const domain = cast("keccak", cast("abi-encode", "f(bytes32,bytes32,bytes32,uint256,address)", cast("keccak", domainType), cast("keccak", "Blindfill"), cast("keccak", "1"), String(chainId), pool));
  const struct = primaryType === "Buy"
    ? cast("keccak", cast("abi-encode", "f(bytes32,address,bytes32,uint256,address,uint256,uint256,uint256)", cast("keccak", buyType), m.adapter, cast("keccak", m.data), m.minOut, m.token, m.nullifier, m.context, m.value))
    : cast("keccak", cast("abi-encode", "f(bytes32,uint256,uint256,uint256)", cast("keccak", withdrawType), m.nullifier, m.context, m.value));
  const digest = cast("keccak", `0x1901${domain.slice(2)}${struct.slice(2)}`);
  return { digest, signature: cast("wallet", "sign", "--no-hash", "--mnemonic", MNEMONIC, "--mnemonic-index", "0", digest) };
}
const plus1 = (x) => (BigInt(x) + 1n).toString();
const cases = {};
try {
  for (const [name, method, chainId] of [["withdrawBaseSepolia", "Withdraw", 84532], ["buyBaseSepolia", "Buy", 84532], ["withdrawRobinhoodTestnet", "Withdraw", 46630]]) {
    const proofValues = { nullifier, context, value };
    const message = method === "Buy" ? { ...BUY, ...proofValues } : proofValues;
    const signature = typed(method, chainId, POOL, message);
    const made = digestSigned(method, chainId, POOL, message);
    if (made.signature !== signature) throw new Error(`${name}: cast's EIP-712 signature is not its signature over the digest made here`);
    const callData = method === "Buy"
      ? cast("calldata", BUY_SIG, withdrawal, proof, FEE, `(${BUY.adapter},${BUY.data},${BUY.minOut},${BUY.token})`, signature)
      : cast("calldata", WITHDRAW_SIG, withdrawal, proof, FEE, signature);
    // W's signatures of this release changed in one field: each must be refused
    const other = { nullifier: typed(method, chainId, POOL, { ...message, nullifier: plus1(nullifier) }), context: typed(method, chainId, POOL, { ...message, context: plus1(context) }), value: typed(method, chainId, POOL, { ...message, value: plus1(value) }) };
    other.chain = typed(method, chainId === 84532 ? 46630 : 84532, POOL, message);
    other.pool = typed(method, chainId, OTHER_POOL, message);
    other.method = method === "Buy" ? typed("Withdraw", chainId, POOL, proofValues) : typed("Buy", chainId, POOL, { ...BUY, ...proofValues });
    if (method === "Buy") {
      other.adapter = typed(method, chainId, POOL, { ...message, adapter: BUY.token });
      other.data = typed(method, chainId, POOL, { ...message, data: `${BUY.data}00` });
      other.minOut = typed(method, chainId, POOL, { ...message, minOut: plus1(BUY.minOut) });
      other.coin = typed(method, chainId, POOL, { ...message, token: BUY.adapter });
    }
    const { token, ...fields } = message;
    cases[name] = { method, chainId, pool: POOL, ...fields, ...(token === undefined ? {} : { coin: token }), digest: made.digest, signature, callData, other };
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
const out = `${JSON.stringify({ source: `apps/helper/test/pool-evm/make-release-cast.mjs: the pool's type strings (contracts/pool-evm/src PrivacyPool.sol, PrivacyPoolSimple.sol), every hash, signature and calldata made by ${cast("--version").split("\n")[0]}; W is anvil's account 0, the recipient`, w, withdrawType, buyType, cases }, null, 1)}\n`;
if (process.argv.includes("--check")) {
  if (readFileSync(OUT, "utf8") !== out) {
    console.error(`FAIL: ${OUT} is not what cast makes`);
    process.exit(1);
  }
  console.log(`PASS: ${OUT} is what cast makes`);
} else {
  writeFileSync(OUT, out);
  console.log(`wrote ${OUT}`);
}
