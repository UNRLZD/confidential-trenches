// node --test scripts/live-checks/signpage-pool-pins.test.mjs: the live check's verdict replays recorded runs
// (signpage-pool-pins.answers.json), each read on 9 Nov by signpage-pool-pins.mjs collect() (card
// sol-pools-mainnet-pin, which added reads 4 and 5, and read 4's pin from SOL_POOLS.mainnet's own literal):
//   good: --harness at 18:03:36Z, card sol-pools-mainnet-pin's signing page bundle (signBuilt) and public/_headers as
//         SIGN_HOST's: the bundle carries no testnet pin and SOL_POOLS.mainnet's literal once, its program EN1Wb2iW… and
//         table BShWZ8Fb… the deploy record's and its fee payer CPWhFyFL…, the page's Solana pair (publicnode and the
//         helper's route) agreed on the Rent sysvar (5,080 lamports per byte, factor 1), the CSP names both, the helper
//         at a5ffb026 answered that program, its pool 7ijWvp3x… and that fee payer with fee 1,300,000, and mainnet-beta
//         and publicnode read the program executable, the fee payer a system account holding 10,000,000 lamports and
//         the lookup table frozen, never deactivated, holding the record's 25 addresses: PASS;
//   bad:  live SIGN_HOST at 18:03:36Z, serving the bundle from before this card (its sha384 is not the checkout's, and it
//         carries no SOL_POOLS.mainnet literal, so neither the helper's answer nor the chain reads match a pin): FAIL.
// Planted from the good run: a testnet pin in the served bundle, a disagreeing Rent read, another pair, a CSP without
// the helper; and for the mainnet pin, a helper that names another fee payer, chain, cluster, program, pool or fee, a
// pin with another fee payer or not the deploy's program or table, a fee payer missing on one RPC or not a system
// account, a program that is not executable or of another loader, another account read, the accounts read on the
// helper's own route, a lookup table with an authority, a deactivation, another owner or other addresses. mainnetPin
// on bundle excerpts: the pin's program a literal, not the deploy object's (mutant A), the literal twice, the deploy
// object missing or twice, and a `feePayer:` literal elsewhere never read as the pin.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge, mainnetPin } from "./signpage-pool-pins.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "signpage-pool-pins.answers.json"), "utf8"));
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const mut = (f) => {
  const rec = structuredClone(ANSWERS.good);
  f(rec);
  return judge(rec);
};
const fails = (r, re) => {
  assert.equal(r.ok, false, r.lines.join("\n"));
  assert.ok(r.lines.some((l) => l.startsWith("BAD") && re.test(l)), r.lines.join("\n"));
};

test("recorded good answer: this card's bundle, no testnet pin, the mainnet pin the helper and two RPCs hold: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
});

test("recorded bad answer: SIGN_HOST serving the bundle from before this card: FAIL", () => {
  fails(judge(ANSWERS.bad), /^BAD SIGN_HOST's \/app\.js is this checkout's signing page bundle: served sha384-/);
  fails(judge(ANSWERS.bad), /^BAD the served bundle carries SOL_POOLS\.mainnet's pin: SOL_POOLS\.mainnet's literal is in the bundle 0 times/);
  fails(judge(ANSWERS.bad), /^BAD the helper signs with the pinned fee payer: CPWh\w+, the bundle's none/);
});

test("planted: a testnet pin served, a failed or one-sided Rent read, another pair, a CSP without the helper", () => {
  fails(mut((r) => (r.signBundle.testnet = ["9Z6Yi2VcXkFWgAV6Nb6kMei78vAAVUEMTqzvFiUZcvG8"])), /mainnet table/);
  fails(mut((r) => (r.rent = { rpcs: r.rent.rpcs, error: "the two providers' Rent differ" })), /agrees on the Rent sysvar: the two providers/);
  fails(mut((r) => (r.rent.rpcs = [r.rent.rpcs[0], r.rent.rpcs[0]])), /page's Solana pair/);
  fails(mut((r) => (r.signCsp = r.signCsp.replace("https://ct-api.unrealized.trade", ""))), /connect-src names both: not https:\/\/ct-api\./);
  fails(mut((r) => (r.signBundle.status = 404)), /HTTP 404/);
});

test("planted: the mainnet pin not the helper's, not served, or not on chain on both RPCs", () => {
  // the helper's fee payer is not the pin's (helper-sol-fee-payer-mainnet's throwaway key): every mainnet release refused
  fails(mut((r) => (r.helperFee.body.fee_payer = "8Rj4ZJubKsa3dB9b63Y4eopdFbuchWPWsjohC8YAnEzL")), /^BAD the helper signs with the pinned fee payer: 8Rj4\w+, the bundle's CPWh/);
  fails(mut((r) => (r.signBundle.pin.feePayer = "9T3RgAVTNgedZhjJyC1UmyisV61pFWoU24LQHnk5W2bb")), /^BAD the helper signs with the pinned fee payer: CPWh\w+, the bundle's 9T3R/);
  fails(mut((r) => (r.signBundle.pin = { error: "SOL_POOLS.mainnet's literal is in the bundle 2 times, not once" })), /^BAD the served bundle carries SOL_POOLS\.mainnet's pin: .* 2 times/);
  fails(mut((r) => (r.helperFee.body.program = "9Z6Yi2VcXkFWgAV6Nb6kMei78vAAVUEMTqzvFiUZcvG8")), /^BAD the helper's mainnet fee answer is the pinned pool's/);
  fails(mut((r) => (r.helperFee = { status: 404, body: { error: "not_found" } })), /^BAD the helper's mainnet fee answer is the pinned pool's: HTTP 404/);
  fails(mut((r) => (r.helperFee.body.fee = "1400000")), /^BAD the helper's fee is solanaPoolFee at that rent: 1400000, not 1300000/);
  fails(mut((r) => (r.signBundle.program = false)), /^BAD the pin's program is the deploy record's/);
  fails(mut((r) => (r.signBundle.pin.program = "So11111111111111111111111111111111111111112")), /^BAD the pin's program is the deploy record's: So11\w+, not EN1W/);
  fails(mut((r) => ((r.signBundle.table = false), (r.signBundle.pin.table = "9Z6Yi2VcXkFWgAV6Nb6kMei78vAAVUEMTqzvFiUZcvG8"))), /^BAD the pin's table is the deploy record's: 9Z6Y\w+, not BShW/);
  // L1-L5: each part of the helper's answer and each account's owner and address is judged on its own
  fails(mut((r) => (r.chain.feePayer[0].owner = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")), /^BAD the fee payer is a system account/);
  fails(mut((r) => (r.helperFee.body.cluster = "devnet")), /^BAD the helper's mainnet fee answer is the pinned pool's: \["solana","devnet"/);
  fails(mut((r) => (r.helperFee.body.chain = "near")), /^BAD the helper's mainnet fee answer is the pinned pool's: \["near","mainnet"/);
  fails(mut((r) => (r.chain.program[0].owner = "BPFLoader2111111111111111111111111111111111")), /^BAD the program is an executable on both/);
  fails(mut((r) => (r.chain.program = r.chain.program.map((a) => ({ ...a, address: "9Z6Yi2VcXkFWgAV6Nb6kMei78vAAVUEMTqzvFiUZcvG8" })))), /^BAD the program is an executable on both/);
  fails(mut((r) => (r.helperFee.body.pool = "92YuYhb4Cj2UM3JxFAWB2kyHcdaPkWCnoNkoUAZZK2cr")), /^BAD the helper's mainnet fee answer is the pinned pool's: .*92YuYhb4/);
  fails(mut((r) => (r.chain.feePayer = r.chain.feePayer.map((a) => ({ ...a, address: "9T3RgAVTNgedZhjJyC1UmyisV61pFWoU24LQHnk5W2bb" })))), /^BAD the fee payer is a system account/);
  fails(mut((r) => (r.chain.feePayer[1] = { url: r.chain.feePayer[1].url, error: "no account" })), /^BAD the fee payer is a system account/);
  fails(mut((r) => (r.chain.program[0].executable = false)), /^BAD the program is an executable on both/);
  fails(mut((r) => (r.chain.rpcs = ["https://api.mainnet-beta.solana.com", "https://ct-api.unrealized.trade/v1/rpc/solana"])), /^BAD the pin's accounts are read on/);
});

test("planted: the pin's lookup table with an authority, a deactivation, another owner or other addresses, or not read on the pin's table", () => {
  const T = /^BAD the pin's lookup table is frozen/;
  fails(mut((r) => (r.chain.table[1].authority = "7Y7omJGVsxTm797X6ytUuskfeQ2kjVs4UK4Hip2hKkvB")), T);
  fails(mut((r) => (r.chain.table[0].deactivationSlot = "467391733")), T);
  fails(mut((r) => (r.chain.table[0].owner = SYSTEM_PROGRAM)), T);
  fails(mut((r) => r.chain.table[1].addresses.pop()), T);
  fails(mut((r) => r.chain.table[0].addresses.reverse()), T);
  fails(mut((r) => (r.chain.table = r.chain.table.map((a) => ({ ...a, address: "9Z6Yi2VcXkFWgAV6Nb6kMei78vAAVUEMTqzvFiUZcvG8" })))), T);
  fails(mut((r) => (r.chain.table[0] = { url: r.chain.table[0].url, address: r.chain.table[0].address, error: "no account" })), T);
  fails(mut((r) => (r.deploy.tableAddresses = undefined)), T);
});

test("mainnetPin: SOL_POOLS.mainnet's own literal once, its program and table the deploy object's, never another feePayer literal", () => {
  const DEPLOY = "kC=Object.freeze({program:`EN1Wb2iWTw7ihNHTNW3SU2DkUCbw7yEEGR7ywWgWn8MF`,table:`BShWZ8FbDPYGpoc1ebj4TiELvVFmBQwW4XMYuLtQoHYZ`})";
  const PIN = "AC=Object.freeze({mainnet:Object.freeze({program:kC.program,feePayer:`CPWhFyFL8naX5W8DEB5XTrEUR2XtkHv7kyXdavpqDTTU`})})";
  const OTHER = "x={feePayer:`9T3RgAVTNgedZhjJyC1UmyisV61pFWoU24LQHnk5W2bb`}";
  const good = { program: "EN1Wb2iWTw7ihNHTNW3SU2DkUCbw7yEEGR7ywWgWn8MF", table: "BShWZ8FbDPYGpoc1ebj4TiELvVFmBQwW4XMYuLtQoHYZ", feePayer: "CPWhFyFL8naX5W8DEB5XTrEUR2XtkHv7kyXdavpqDTTU" };
  assert.deepEqual(mainnetPin(`var ${OTHER},${DEPLOY},${PIN};`), good);
  assert.deepEqual(mainnetPin(`var ${OTHER},${DEPLOY},${PIN};`.replaceAll("kC", "$e")), good, "a minified name with $");
  // mutant A: the pin's program a literal (wSOL), not the deploy object's
  assert.match(mainnetPin(`var ${DEPLOY},${PIN.replace("program:kC.program", "program:`So11111111111111111111111111111111111111112`")};`).error, /literal is in the bundle 0 times/);
  assert.match(mainnetPin(`var ${DEPLOY},${PIN},${PIN.replace("AC=", "BC=")};`).error, /literal is in the bundle 2 times/);
  assert.match(mainnetPin(`var ${PIN};`).error, /kC is defined as a frozen \{program, table\} 0 times/);
  assert.match(mainnetPin(`var ${DEPLOY},${DEPLOY},${PIN};`).error, /kC is defined as a frozen \{program, table\} 2 times/);
  assert.match(mainnetPin(`var ${DEPLOY},${PIN};`.replace("kC=Object", "XkC=Object")).error, /kC is defined .* 0 times/);
  assert.match(mainnetPin(`var ${OTHER};`).error, /0 times/);
});

test("a provider with no usable answer for the pin's accounts is named and not judged: INCONCLUSIVE, never PASS; FAIL beside a wrong answer", () => {
  const quiet = (r) => (r.chain.feePayer[1] = { url: r.chain.feePayer[1].url, address: r.chain.feePayer[1].address, noAnswer: "solana-rpc.publicnode.com: no answer (HTTP 429)" });
  const r = mut(quiet);
  assert.equal(r.ok, false, r.lines.join("\n"));
  assert.equal(r.verdict, "INCONCLUSIVE", r.lines.join("\n"));
  assert.ok(r.lines.some((l) => /^--- solana-rpc\.publicnode\.com: no answer \(HTTP 429\) \(the fee payer is a system account/.test(l)), r.lines.join("\n"));
  const both = mut((x) => (quiet(x), (x.helperFee.body.fee_payer = "8Rj4ZJubKsa3dB9b63Y4eopdFbuchWPWsjohC8YAnEzL")));
  assert.equal(both.verdict, "FAIL", both.lines.join("\n"));
  assert.equal(judge(ANSWERS.good).verdict, "PASS");
});
