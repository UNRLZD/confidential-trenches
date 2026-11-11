// card sol-pool-buy-lands-on-mainnet: one log line per pool send, codes and counts only.
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { handler } from "../server.ts";
import type { SolanaPoolSender } from "./solana.ts";
import type { EvmPoolSender } from "./evm.ts";
import { poolSendLine, regionName, simErrText } from "./send-log.ts";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const SIG = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW";
const ADDR = "7ijWvp3xEk5yUfGYQJfgoabReCTpSyZhiWjmCt3TQDz8";

test("the line: outcome, status, ms and the note's fields, nothing else", () => {
  const l = poolSendLine({ chain: "solana", net: "mainnet", route: "send", status: 503, body: { error: { code: "not_landed" } }, ms: 43_637.4, note: { tag: 3, via: "jito", region: "frankfurt", bundle: true, end: "expired", rebroadcasts: 40, misses: 2, status: "failed" } });
  assert.equal(l, "pool send solana mainnet send outcome=not_landed status=503 ms=43637 tag=3 via=jito region=frankfurt bundle=named end=expired rebroadcasts=40 misses=2 engine=failed");
  assert.equal(poolSendLine({ chain: "solana", net: "mainnet", route: "send", status: 200, body: { signature: SIG }, ms: 900, note: { tag: 3, end: "filled" } }), "pool send solana mainnet send outcome=filled status=200 ms=900 tag=3 end=filled");
  // a plain send answers before its end: sent
  assert.equal(poolSendLine({ chain: "evm", net: "base", route: "sell", status: 200, body: { hash: `0x${"ab".repeat(32)}` }, ms: 12 }), "pool send evm base sell outcome=sent status=200 ms=12");
  // a code that is not one of ours, a net or a region that is not a word: never copied
  assert.match(poolSendLine({ chain: "unknown", net: ADDR.toUpperCase() + " x", route: "send", status: 500, body: { error: { code: SIG } }, ms: 1, note: { region: "a b" } }), /^pool send unknown \? send outcome=other status=500 ms=1$/);
});

test("a simulation's error keeps its variant names, indexes and codes; any free text is dropped", () => {
  assert.equal(simErrText({ InstructionError: [3, { Custom: 6001 }] }), '{"InstructionError":[3,{"Custom":6001}]}');
  assert.equal(simErrText("AccountNotFound"), '"AccountNotFound"');
  assert.equal(simErrText({ InsufficientFundsForRent: { account_index: 4 } }), '{"InsufficientFundsForRent":{"account_index":4}}');
  // a program's own words (BorshIoError's string), an address, a signature: never in the line
  for (const text of [ADDR, SIG, "Unknown", "failed to deserialize account data"]) {
    const t = simErrText({ InstructionError: [2, { BorshIoError: text }] });
    assert.ok(!t.includes(ADDR) && !t.includes(SIG) && !t.includes(" "), t);
  }
  assert.equal(simErrText({ InstructionError: [2, { BorshIoError: ADDR }] }), '{"InstructionError":[2,{"BorshIoError":"?"}]}');
  assert.equal(simErrText({ [ADDR]: 1 }), '{"?":1}');
  assert.ok(simErrText({ InstructionError: [1, { A: { B: { C: { D: { E: 1 } } } } }] }).length <= 120);
});

test("a simulation's error keeps at most two numbers, each at most 65,535: an RPC cannot spell a signature or an address in integers", () => {
  // what a real error holds: an instruction index and a program's code, or one account index
  assert.equal(simErrText({ InstructionError: [255, { Custom: 65_535 }] }), '{"InstructionError":[255,{"Custom":65535}]}');
  // a number over 16 bits, a negative one, a third one: dropped
  assert.equal(simErrText({ InstructionError: [2, { Custom: 65_536 }] }), '{"InstructionError":[2,{"Custom":"?"}]}');
  assert.equal(simErrText({ InstructionError: [-1, { Custom: 2 ** 53 - 1 }] }), '{"InstructionError":["?",{"Custom":"?"}]}');
  assert.equal(simErrText({ InstructionError: [1, 2, 3, 4], InsufficientFundsForRent: { account_index: 5 } }), '{"InstructionError":[1,2,"?","?"],"InsufficientFundsForRent":{"account_index":"?"}}');
  // 32 bytes in any spread of integers: at most 32 bits of them reach the line
  const bytes = Array.from({ length: 32 }, (_, k) => 200 + k);
  const kept = (t: string) => (t.match(/\d+/g) ?? []).length;
  for (const err of [{ A: bytes }, { A: [bytes.slice(0, 4), bytes.slice(4, 8)], B: { C: bytes.slice(8, 12), D: bytes.slice(12, 16) } }]) assert.ok(kept(simErrText(err)) <= 2, simErrText(err));
});

test("a region's name is its host's first label", () => {
  assert.equal(regionName("https://frankfurt.mainnet.block-engine.jito.wtf/api/v1/transactions?bundleOnly=true"), "frankfurt");
  assert.equal(regionName("not a url"), "?");
});

async function post(port: number, path: string, body: string): Promise<{ status: number; text: string }> {
  return new Promise((ok, no) => {
    const r = request({ host: "127.0.0.1", port, path, method: "POST", headers: { "content-type": "application/json" } }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => ok({ status: res.statusCode ?? 0, text }));
    });
    r.on("error", no);
    r.end(body);
  });
}

test("each pool send route writes one line when it answers: no signature, address or caller; the note never reaches the caller", async () => {
  const lines: string[] = [];
  const sol = { cluster: "mainnet", carry: async () => ({ status: 503, body: { error: { code: "not_landed" } }, note: { tag: 3, via: "jito", region: "ny", bundle: true, end: "expired", rebroadcasts: 3, misses: 0, status: "failed" } }) } as unknown as SolanaPoolSender;
  const evm = { network: "base", carry: async () => ({ status: 200, body: { hash: `0x${"cd".repeat(32)}` } }), sell: async () => ({ status: 422, body: { error: { code: "simulation_failed", detail: `reverted for ${ADDR}` } } }) } as unknown as EvmPoolSender;
  const h = handler(COMMIT, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 1, new Map([[ADDR, sol]]), new Map([["0xpool", evm]]), undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, (l) => lines.push(l));
  const server = createServer(h).listen(0, "127.0.0.1");
  await new Promise((ok) => server.once("listening", ok));
  const port = (server.address() as AddressInfo).port;
  try {
    const a = await post(port, "/v1/pool/solana/send", JSON.stringify({ pool: ADDR, tx: "AAAA" }));
    assert.equal(a.status, 503);
    assert.equal(a.text, '{"error":{"code":"not_landed"}}', "the note is the log's, not the caller's");
    await post(port, "/v1/pool/evm/send", JSON.stringify({ pool: "0xpool", data: "0x" }));
    await post(port, "/v1/pool/evm/sell", JSON.stringify({ pool: "0xpool" }));
    await post(port, "/v1/pool/solana/send", JSON.stringify({ pool: "another" }));
    await post(port, "/v1/pool/solana/send", "{not json");
  } finally {
    server.close();
  }
  assert.equal(lines.length, 5, lines.join("\n"));
  assert.match(lines[0]!, /^pool send solana mainnet send outcome=not_landed status=503 ms=\d+ tag=3 via=jito region=ny bundle=named end=expired rebroadcasts=3 misses=0 engine=failed$/);
  assert.match(lines[1]!, /^pool send evm base send outcome=sent status=200 ms=\d+$/);
  assert.match(lines[2]!, /^pool send evm base sell outcome=simulation_failed status=422 ms=\d+$/);
  assert.match(lines[3]!, /^pool send unknown \? send outcome=not_found status=404 ms=\d+$/);
  assert.match(lines[4]!, /^pool send unknown \? send outcome=bad_shape status=400 ms=\d+$/);
  for (const l of lines) assert.ok(!l.includes(ADDR) && !l.includes("127.0.0.1") && !/0x[0-9a-f]{8}/.test(l), l);
});

test("the line's reads of why a bundle did not land: engine3, engine, plain, hash_ms and end_sim, in that order; a hash_ms that is not a count is dropped", () => {
  const note = { tag: 3 as const, via: "jito" as const, region: "amsterdam", bundle: true, end: "expired" as const, rebroadcasts: 33, misses: 0, engine3: "invalid" as const, status: "invalid" as const, plain: 31, hashMs: ">67003", endSim: '{"InstructionError":[2,{"Custom":6004}]}' };
  assert.equal(poolSendLine({ chain: "solana", net: "mainnet", route: "send", status: 503, body: { error: { code: "not_landed" } }, ms: 67003, note }), 'pool send solana mainnet send outcome=not_landed status=503 ms=67003 tag=3 via=jito region=amsterdam bundle=named end=expired rebroadcasts=33 misses=0 engine3=invalid engine=invalid plain=31 hash_ms=>67003 end_sim={"InstructionError":[2,{"Custom":6004}]}');
  assert.equal(poolSendLine({ chain: "solana", net: "mainnet", route: "send", status: 200, body: { signature: SIG }, ms: 900, note: { tag: 3, end: "filled", plain: 2, hashMs: "41000" } }), "pool send solana mainnet send outcome=filled status=200 ms=900 tag=3 end=filled plain=2 hash_ms=41000");
  assert.doesNotMatch(poolSendLine({ chain: "solana", net: "mainnet", route: "send", status: 200, body: {}, ms: 1, note: { hashMs: ADDR } }), /hash_ms/);
});
