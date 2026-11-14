// Card move-sends-or-says-why (142): a pool list member marked `logs: false` (the signing page's mainnet.base.org, which
// answers every eth_getLogs 429 -32011 "request limit reached", read 14 Nov 13:16Z) is a seat for every other read and is
// never asked an eth_getLogs: a seat on it walks on for that call, and with no free member the call is refused there
// with nothing sent to it, so it is never rested for a page it was never fit for. Red at ccd4cae2e: the seat asked it,
// and its 429 rested it for every read.
//   node --test test/pool-evm-logless-member.test.ts      (from packages/wallet)
import assert from "node:assert/strict";
import { test } from "node:test";
import { evmPair, type EvmRpc } from "../src/pool/evm.ts";

type Fake = EvmRpc & { asked: string[] };
/** A provider: `down` gives no answer at all (a browser's failed fetch), else every method answers its url, and
 *  eth_getLogs a 429's words when `logs429`. */
function provider(url: string, o: { down?: boolean; logs429?: boolean; logs?: false } = {}): Fake {
  const f = Object.assign(
    async (method: string): Promise<unknown> => {
      f.asked.push(method);
      if (o.down) throw Object.assign(new Error("no connection"), { name: "SolanaRpcTransportError", fault: "network" });
      if (method === "eth_getLogs" && o.logs429) throw Object.assign(new Error("request limit reached (http_429)"), { name: "SolanaRpcTransportError", fault: "http_429" });
      return method === "eth_getLogs" ? [] : url;
    },
    { url, asked: [] as string[], ...(o.logs === false ? { logs: false as const } : {}) },
  ) as Fake;
  return f;
}
const LOGS = ["eth_getLogs", [{ fromBlock: "0x1", toBlock: "0x10", address: "0x" + "11".repeat(20) }]] as const;

test("(card move-sends-or-says-why) a logless member seats every other read, never an eth_getLogs, and is never rested for one", async () => {
  const a = provider("https://a.example", { down: true });
  const b = provider("https://b.example", { down: true });
  const c = provider("https://c.example", { logs429: true, logs: false });
  const h = provider("https://h.example");
  const [s0, s1] = evmPair([a, b, c, h]);
  // the two silent members fail over: one seat on c, the other on h
  assert.deepEqual([await s0!("eth_blockNumber", []), await s1!("eth_blockNumber", [])].sort(), ["https://c.example", "https://h.example"]);
  // a log page on each seat: never asked of c; the seat on c walks to a free member or is refused with nothing sent
  await Promise.allSettled([s0!(...LOGS), s1!(...LOGS)]);
  assert.ok(!c.asked.includes("eth_getLogs"), `c asked: ${c.asked.join(", ")}`);
  // c still seats a read at once after the log page: not rested by it
  const again = await Promise.all([s0!("eth_chainId", []), s1!("eth_chainId", [])]);
  assert.ok(again.includes("https://c.example"), `c seats the next read: ${again.join(", ")}`);
});

test("(card move-sends-or-says-why) a logless member alone on its seat: the log page is refused there, naming it, with nothing sent to it", async () => {
  const c = provider("https://c.example", { logs: false });
  const h = provider("https://h.example");
  const [s0] = evmPair([c, h]);
  await assert.rejects(s0!(...LOGS), /c\.example pages no logs/);
  assert.deepEqual(c.asked, []);
});
