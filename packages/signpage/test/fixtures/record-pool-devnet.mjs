// Records the devnet pool's answers that test/pool-deposit.test.ts replays (card signpage-pool-notes): the pool account,
// page 0 of each tree, the deploy run's precommitment mark and the Rent sysvar (scripts/live-checks/pool-sol-deploy.devnet.json), each as
// both devnet RPCs answer it at finalized commitment, with the slot each answered at. Public accounts only; no key.
//   node packages/signpage/test/fixtures/record-pool-devnet.mjs > packages/signpage/test/fixtures/pool-devnet.json
import { solanaProgramAddress } from "../../../kit/src/checks/solana/message.ts";

const RPCS = ["https://api.devnet.solana.com", "https://solana-devnet.api.onfinality.io/public"];
const PROGRAM = "5V9iJECfs9q9zZTXvNco7oREqkZFvrtuKqKm74GgJWMZ";
const POOL = "2S5wpE7U7GoJRVqox1dXmTQm38SmseG8A4F9eReWwYwr";
const PRE = "13d795c96f00c2a5ea68c15e29ba995b6914a00da16e14d9ce596fd57921bc6a";
const enc = new TextEncoder();
const hexBytes = (h) => Uint8Array.from(h.match(/../g), (x) => parseInt(x, 16));
const page = (tree) => solanaProgramAddress([enc.encode("page"), Uint8Array.of(tree), new Uint8Array(4)], PROGRAM);
const mark = solanaProgramAddress([enc.encode("pre"), hexBytes(PRE)], PROGRAM);
const addresses = { pool: POOL, state0: page(0), label0: page(1), mark, rent: "SysvarRent111111111111111111111111111111111" };

async function call(url, method, params) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(`${url} ${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}

const out = { at: new Date().toISOString(), program: PROGRAM, pool: POOL, rpcs: RPCS, addresses, answers: [] };
for (const url of RPCS) {
  const r = await call(url, "getMultipleAccounts", [Object.values(addresses), { commitment: "finalized", encoding: "base64" }]);
  const accounts = Object.fromEntries(Object.keys(addresses).map((k, i) => [k, r.value[i] && { owner: r.value[i].owner, lamports: r.value[i].lamports, data: r.value[i].data }]));
  out.answers.push({ rpc: url, slot: r.context.slot, accounts });
}
process.stdout.write(JSON.stringify(out, null, 2) + "\n");
