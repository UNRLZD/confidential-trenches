// node --test scripts/live-checks/evm-quote-token-priced-from-our-reads.test.mjs: the check replays its recorded answers
// (evm-quote-token-priced-from-our-reads.answers.json, each one's source in its _about): this card's helper passes;
// the base before it fails, a row of ours named at the vendor's rate's age; a coin with too few vendor answers is no
// verdict, never a pass; a non-200 fails.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  CHAINS,
  COINS,
  HOLD_MS,
  judge,
  MIN_VENDOR,
  POLL_MS,
  read,
} from "./evm-quote-token-priced-from-our-reads.mjs";

const A = JSON.parse(
  readFileSync(
    new URL(
      "./evm-quote-token-priced-from-our-reads.answers.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

test("the recorded good answer, this card's helper on mainnet reads: PASS", () => {
  const r = judge(A.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
});

test("the recorded bad answer, the base before the card: FAIL, a row named at the vendor's rate's age", () => {
  const r = judge(A.bad);
  assert.equal(r.ok, false, r.lines.join("\n"));
  assert.match(
    r.lines.find((l) => l.startsWith("BAD")),
    /name it \(evm-vendor-price;desc="usd read \d+ ms ago"\)$/,
  );
});

test("planted, each chain: one answer naming the vendor's price age fails; a 503 fails; too few vendor answers is no verdict", () => {
  for (const chain of CHAINS) {
    const aged = structuredClone(A.good);
    const x = aged.chains[chain].reads.find((y) =>
      /evm-vendor-read/.test(y.timing),
    );
    x.timing = `${x.timing}, evm-vendor-price;desc="usd read 9000 ms ago"`;
    assert.equal(judge(aged).ok, false, `${chain}: aged`);
    const s = structuredClone(A.good);
    s.chains[chain].reads.at(-1).status = 503;
    assert.equal(judge(s).ok, false, `${chain}: a 503`);
    const few = structuredClone(A.good);
    few.chains[chain].reads = few.chains[chain].reads
      .filter((y) => /evm-vendor-read/.test(y.timing))
      .slice(0, MIN_VENDOR - 1);
    assert.equal(judge(few).ok, null, `${chain}: too few`);
  }
  assert.equal(judge({ chains: {} }).ok, null);
});

test("read: each chain's coin read every POLL_MS for HOLD_MS", async () => {
  let t = Date.parse("2026-11-19T14:40:00Z");
  const asked = [];
  const fetchFn = async (url) => {
    asked.push(new URL(url).searchParams.get("token"));
    return new Response(JSON.stringify({ trades: [], src: "coingecko" }), {
      status: 200,
      headers: {
        "server-timing": `evm-vendor-read;desc="rows read 1000 ms ago"`,
      },
    });
  };
  const r = await read(
    "http://h",
    fetchFn,
    async (ms) => void (t += ms),
    () => t,
  );
  for (const chain of CHAINS)
    assert.equal(r.chains[chain].reads.length, HOLD_MS / POLL_MS + 1, chain);
  assert.deepEqual(
    [...new Set(asked)],
    CHAINS.map((c) => COINS[c]),
  );
  assert.equal(judge(r).ok, true);
});
