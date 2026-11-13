// The exit tool's EVM pools on a fork of mainnet (card exit-evm-pools-with-the-words): anvil forks Base or Robinhood
// mainnet with the deployed pool, a note of 12 words made for the run (never kept) is deposited on the fork, and the tool's own
// exit (src/evm-out.ts exitEvm) takes it out with only the words. Two RPCs: anvil and a pass-through to it on another
// port (two URLs, so the tool's two-provider rule holds; on a fork both read one chain). No real money moves: every
// balance is the fork's, set by anvil_setBalance.
//   node packages/exit/scripts/evm-fork.ts <base|robinhood>     PASS exit 0, FAIL exit 1
// The steps: G empty, so the exit stops and names G and the amount (the note stays); then G funded, so the note leaves
// to the typed address; then a run again finds nothing left.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { entropyToWords, EVM_CHAIN_IDS, EVM_POOLS, evmExitGasAddress, evmPoolScopeOf, noteSecrets, wordsToSeed64, type EvmRpc } from "@blindfill/kit/core";
import { solanaJsonRpc, type VaultProver } from "@blindfill/kit";
import { EXIT_EVM_RPCS, exitEvm } from "../src/evm-out.ts";
import { exitSetupFiles } from "../src/setup.ts";

const chain = process.argv[2] as "base" | "robinhood";
if (chain !== "base" && chain !== "robinhood") throw new Error("usage: evm-fork.ts <base|robinhood>");
// the fork's upstream: a node that serves the state of its head (publicnode's Base refuses a fork's state reads, 403;
// mainnet.base.org throttles the pool's log pages, 429) and pages the pool's logs from its deploy block
const UPSTREAM = process.env.FORK_URL ?? { base: EXIT_EVM_RPCS.base[1], robinhood: EXIT_EVM_RPCS.robinhood[0] }[chain];
const PORT = chain === "base" ? 18545 : 18645;
const pin = EVM_POOLS[chain]!;
const chainId = EVM_CHAIN_IDS[chain];
const DEPOSIT = 1_000_000_000_000_000n; // 0.001 ETH, the ladder's smallest chunk
const TO = "0x5555555555555555555555555555555555555555";
const DEPOSITOR = "0x6666666666666666666666666666666666666666";

const anvil = spawn("anvil", ["--fork-url", UPSTREAM, "--port", String(PORT), "--chain-id", String(chainId), "--retries", "30", "--fork-retry-backoff", "2000", "--silent"], { stdio: "inherit" });
const proxy = createServer((req, res) => {
  const body: Buffer[] = [];
  req.on("data", (c: Buffer) => body.push(c));
  req.on("end", () => {
    fetch(`http://127.0.0.1:${PORT}`, { method: "POST", headers: { "content-type": "application/json" }, body: Buffer.concat(body) })
      .then(async (r) => {
        res.writeHead(r.status, { "content-type": "application/json" });
        res.end(Buffer.from(await r.arrayBuffer()));
      })
      .catch(() => {
        res.writeHead(502);
        res.end();
      });
  });
}).listen(PORT + 1);
const stop = (code: number): never => {
  anvil.kill();
  proxy.close();
  process.exit(code);
};

const urls: [string, string] = [`http://127.0.0.1:${PORT}`, `http://localhost:${PORT + 1}`];
const rpcs = urls.map((u) => solanaJsonRpc(u, { timeoutMs: 60_000 })) as [EvmRpc, EvmRpc];
const call = (method: string, params: unknown[]): Promise<any> => rpcs[0](method, params);
const word = (v: bigint): string => v.toString(16).padStart(64, "0");
// the pool's selectors: deposit(uint256,uint256) and usedPrecommitments(uint256) (cast sig)
const DEPOSIT_SEL = "e2bbb158";
const USED_SEL = "a1cc748b";
/** The run's prover: snarkjs on the hash-checked setup files, as the kit's own Node proof loads it
 *  (packages/kit/test/prove-e2e.test.ts); the command gives the tool its own. */
async function forkProver(): Promise<VaultProver> {
  const snarkjs = createRequire(import.meta.url)("snarkjs") as { groth16: { fullProve(i: unknown, w: Uint8Array, z: Uint8Array, l: undefined, x: undefined, o: { singleThread: boolean }): Promise<{ proof: unknown; publicSignals: string[] }> } };
  const files = await exitSetupFiles(["withdraw.wasm", "withdraw.zkey"]);
  return {
    async load() {},
    async prove(_c, input) {
      const t = performance.now();
      const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, files.get("withdraw.wasm")!, files.get("withdraw.zkey")!, undefined, undefined, { singleThread: true });
      return { proof: proof as never, publicSignals, proveMs: Math.round(performance.now() - t) };
    },
  };
}
const balance = async (a: string): Promise<bigint> => BigInt(await call("eth_getBalance", [a, "latest"]));
const eth = (wei: bigint): string => `${Number(wei) / 1e18} ETH`;
let failed = false;
const check = (ok: boolean, line: string): void => {
  console.log(`${ok ? "ok  " : "FAIL"} ${line}`);
  if (!ok) failed = true;
};

try {
  for (let k = 0; ; k++) {
    try {
      await call("eth_chainId", []);
      break;
    } catch {
      if (k > 60) throw new Error("anvil did not start");
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  const head = BigInt(await call("eth_blockNumber", []));
  console.log(`${chain}: anvil fork of ${UPSTREAM} at block ${head}, pool ${pin.pool} (deploy block ${pin.fromBlock})`);
  const code = await call("eth_getCode", [pin.pool, "latest"]);
  check(typeof code === "string" && code.length > 2, `the pinned pool has code on the fork (${(code.length - 2) / 2} bytes)`);

  // fresh words for this run, made here and never kept: a note no real deposit on the pool can share
  const words = entropyToWords(crypto.getRandomValues(new Uint8Array(16)));
  const seed = wordsToSeed64(words);
  const scope = evmPoolScopeOf(pin.pool, chainId);
  // the words' first deposit note on this pool, deposited by any sender (the pool reads no sender)
  const pre = noteSecrets(seed, { kind: "deposit", s: scope, i: 0 }).precommitment;
  await call("anvil_setBalance", [DEPOSITOR, "0xde0b6b3a7640000"]);
  await call("anvil_impersonateAccount", [DEPOSITOR]);
  const used = await call("eth_call", [{ to: pin.pool, data: `0x${USED_SEL}${word(pre)}` }, "latest"]);
  check(BigInt(used) === 0n, "the note's precommitment is unused on the pool");
  const dep = await call("eth_sendTransaction", [{ from: DEPOSITOR, to: pin.pool, value: `0x${DEPOSIT.toString(16)}`, data: `0x${DEPOSIT_SEL}${word(DEPOSIT)}${word(pre)}`, gas: "0x200000" }]);
  let depR = await call("eth_getTransactionReceipt", [dep]);
  for (let k = 0; depR === null && k < 30; k++) {
    await new Promise((r) => setTimeout(r, 1000));
    depR = await call("eth_getTransactionReceipt", [dep]);
  }
  check(depR?.status === "0x1", `deposit of ${eth(DEPOSIT)} to the run's words' first note: ${dep}`);
  // a few blocks on, so the deposit sits under a block the RPCs both hold
  await call("anvil_mine", ["0x3"]);

  const g = evmExitGasAddress(seed);
  const prover = await forkProver();
  await call("anvil_setBalance", [g, "0x0"]);
  await call("anvil_setBalance", [TO, "0x0"]);
  const lines: string[] = [];
  const ctx = { seed, to: TO, rpcs: urls, say: (l: string) => (lines.push(l), console.log(`  | ${l}`)) };

  // 1. G empty: the exit names G and the amount, and the note stays
  const r1 = await exitEvm(chain, ctx, { rpcs, prover });
  check(r1.txs.length === 0 && r1.sent === "0" && r1.left === DEPOSIT.toString(), `G empty: nothing sent, the note left (${JSON.stringify(r1)})`);
  check(lines.some((l) => l.includes(g) && /send it at least [0-9.]+ ETH/.test(l)), `G empty: the tool names G ${g} and the amount it needs`);

  // 2. G funded: the note leaves to TO
  await call("anvil_setBalance", [g, "0x2386f26fc10000"]); // 0.01 ETH
  const r2 = await exitEvm(chain, ctx, { rpcs, prover });
  const got = await balance(TO);
  check(r2.txs.length === 2 && r2.left === "0" && BigInt(r2.sent) === got, `G funded: release and onward send (${JSON.stringify(r2)})`);
  check(got > 0n && got <= DEPOSIT && got > (DEPOSIT * 99n) / 100n, `TO holds ${eth(got)} of the ${eth(DEPOSIT)} note (W's gas the rest)`);
  for (const h of r2.txs) {
    const rs = await Promise.all(rpcs.map((r) => r("eth_getTransactionReceipt", [h]) as Promise<any>));
    check(rs.every((x) => x?.status === "0x1"), `tx ${h}: status 1 on both RPCs`);
  }

  // 3. again: nothing left
  const r3 = await exitEvm(chain, ctx, { rpcs, prover });
  check(r3.txs.length === 0 && r3.left === "0", `run again: nothing left (${JSON.stringify(r3)})`);
} catch (e) {
  console.log(`FAIL ${e instanceof Error ? e.stack : String(e)}`);
  failed = true;
}
console.log(failed ? "FAIL" : "PASS");
stop(failed ? 1 : 0);
