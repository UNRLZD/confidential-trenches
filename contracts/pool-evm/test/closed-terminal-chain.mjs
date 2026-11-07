// SPDX-License-Identifier: Apache-2.0
// Loaded with node --import before script/deploy.mjs's own CLI by test/closed-terminal.test.mjs: globalThis.fetch
// becomes a mock Base Sepolia chain that mines each transaction as it is sent (fee: gas used x base fee plus the tip,
// and a flat L1 fee), the run's "waiting for <wei>" line funds the run key with exactly that, and once the line of the
// first deploy is printed the chain holds every answer until this process gets SIGHUP (the test closes the terminal
// there). What the chain saw is written to $CT_STATE after every transaction: each landed one's to and value, and the
// balances of the run key and of $CT_RETURN.
import { readFileSync, writeFileSync } from "node:fs";
import { BUILD, bytes, hex, keccak } from "../../../scripts/live-checks/pool-evm-deploy.mjs";

const STATE = process.env.CT_STATE;
const RET = process.env.CT_RETURN.toLowerCase();
const OUT = new URL("../out/", import.meta.url);
const art = (n) => JSON.parse(readFileSync(new URL(`${n}.sol/${n}.json`, OUT), "utf8"));
const NAMES = Object.keys(BUILD.contracts);
const BASE = 5_000_000n;
const TIP = 1_000_000n;
const L1 = 400n;

// a minimal RLP: decode a signed EIP-1559 transaction, encode [address, nonce] for CREATE's address
function dec(b, i = 0) {
  const p = b[i];
  if (p < 0x80) return [b.subarray(i, i + 1), i + 1];
  if (p < 0xb8) return [b.subarray(i + 1, i + 1 + p - 0x80), i + 1 + p - 0x80];
  if (p < 0xc0) {
    const ll = p - 0xb7;
    const l = Number(BigInt(hex(b.subarray(i + 1, i + 1 + ll))));
    return [b.subarray(i + 1 + ll, i + 1 + ll + l), i + 1 + ll + l];
  }
  let l, s;
  if (p < 0xf8) (l = p - 0xc0), (s = i + 1);
  else {
    const ll = p - 0xf7;
    l = Number(BigInt(hex(b.subarray(i + 1, i + 1 + ll))));
    s = i + 1 + ll;
  }
  const out = [];
  for (let j = s; j < s + l; ) {
    const [x, n] = dec(b, j);
    out.push(x);
    j = n;
  }
  return [out, s + l];
}
const num = (u) => (u.length ? BigInt(hex(u)) : 0n);
const created = (from, nonce) => {
  const n = nonce === 0n ? "80" : nonce < 0x80n ? nonce.toString(16).padStart(2, "0") : "81" + nonce.toString(16).padStart(2, "0");
  const body = "94" + from.slice(2) + n;
  return "0x" + keccak("0x" + (0xc0 + body.length / 2).toString(16) + body).slice(-40);
};

const c = { block: 100, bal: new Map(), nonce: new Map(), code: new Map(), receipts: new Map(), landed: [], deployer: null };
const g = (m, k) => m.get(k.toLowerCase()) ?? 0n;
const save = () => writeFileSync(STATE, JSON.stringify({ deployer: c.deployer, landed: c.landed, key: String(g(c.bal, c.deployer ?? "0x")), ret: String(g(c.bal, RET)) }));
let hold = null;
const see = (line) => {
  const m = line.match(/^deploy: waiting for (\d+) wei/);
  if (m && c.deployer) c.bal.set(c.deployer, g(c.bal, c.deployer) + BigInt(m[1]));
  // a signal's listener holds no process open: a timer does, until the signal comes
  if (!hold && line.startsWith("deploy: WithdrawalVerifier 0x")) {
    hold = new Promise((r) => {
      const open = setInterval(() => {}, 1000);
      process.once("SIGHUP", () => (clearInterval(open), r()));
    });
  }
};
for (const k of ["log", "error"]) {
  const real = console[k].bind(console);
  console[k] = (...a) => (see(a.join(" ")), real(...a));
}
const ok = (result) => ({ ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result }) });
const err = (message) => ({ ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, error: { code: -32000, message } }) });
globalThis.fetch = async (url, init) => {
  if (hold) await hold;
  // each answer a turn of the event loop later, as a real RPC's: a failed write to the terminal is heard meanwhile
  await new Promise((r) => setTimeout(r, 2));
  const { method, params } = JSON.parse(init.body);
  switch (method) {
    case "eth_chainId": return ok("0x14a34");
    case "eth_blockNumber": return ok("0x" + c.block.toString(16));
    case "eth_getBlockByNumber": return ok({ baseFeePerGas: "0x" + BASE.toString(16), number: "0x" + c.block.toString(16) });
    case "eth_maxPriorityFeePerGas": return ok("0x" + TIP.toString(16));
    case "eth_estimateGas": return ok(params[0].to ? "0x5208" : "0x" + (600000).toString(16));
    case "eth_call": return ok("0x" + L1.toString(16).padStart(64, "0"));
    case "eth_getTransactionCount": {
      const a = params[0].toLowerCase();
      if (a !== RET) c.deployer ??= a;
      return ok("0x" + g(c.nonce, a).toString(16));
    }
    case "eth_getBalance": return ok("0x" + g(c.bal, params[0]).toString(16));
    case "eth_getCode": return ok(c.code.get(params[0].toLowerCase()) ?? "0x");
    case "eth_getTransactionReceipt": return ok(c.receipts.get(params[0]) ?? null);
    case "eth_sendRawTransaction": {
      const hash = keccak(params[0]);
      if (c.receipts.has(hash)) return err("already known");
      const [f] = dec(bytes(params[0]), 1);
      const t = { nonce: num(f[1]), tip: num(f[2]), maxFee: num(f[3]), gas: num(f[4]), to: f[5].length ? hex(f[5]) : null, value: num(f[6]), data: hex(f[7]) };
      if (t.nonce !== g(c.nonce, c.deployer)) return err("nonce too low");
      const used = t.to ? 21000n : (t.gas * 10n) / 12n;
      const price = BASE + (t.tip < t.maxFee - BASE ? t.tip : t.maxFee - BASE);
      const fee = used * price + L1;
      if (g(c.bal, c.deployer) < t.value + t.gas * t.maxFee + L1) return err("insufficient funds for gas * price + value");
      c.bal.set(c.deployer, g(c.bal, c.deployer) - t.value - fee);
      let ca = null;
      if (t.to) c.bal.set(t.to, g(c.bal, t.to) + t.value);
      else {
        const n = NAMES.find((x) => t.data.startsWith(art(x).bytecode.object));
        c.code.set((ca = created(c.deployer, t.nonce)), art(n).deployedBytecode.object);
      }
      c.nonce.set(c.deployer, t.nonce + 1n);
      c.block++;
      c.receipts.set(hash, { status: "0x1", blockNumber: "0x" + c.block.toString(16), contractAddress: ca, effectiveGasPrice: "0x" + price.toString(16), from: c.deployer, gasUsed: "0x" + used.toString(16), l1Fee: "0x" + L1.toString(16) });
      c.landed.push({ to: t.to, value: String(t.value) });
      save();
      return ok(hash);
    }
  }
  throw new Error(`mock: ${method}`);
};
