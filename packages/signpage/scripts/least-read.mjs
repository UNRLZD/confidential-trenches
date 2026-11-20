#!/usr/bin/env node
// The signing page's own least read (src/cash-to-pool.ts readOneClickLeast, card cash-to-pool-least-signed), run once
// per pool chain over mainnet 1Click through the helper's proxy, for scripts/live-checks/cash-to-pool-least-signed.mjs,
// which may reach no Blindfill code past the kit's entry (check:imports) and so runs this as a child. Each chain's read
// is held at the price given for it; every ask it makes is kept with 1Click's answer as sent, signature and all (the
// live check leaves the signatures out before it records anything).
//   node packages/signpage/scripts/least-read.mjs '{"solana":{"price":"7271","expo":-2},...}'
// prints one JSON line: { <chain>: { asks: [{ amount, status, text }], least } | { asks, error } }. Reads only: dry
// quotes name no account of anyone's, nothing is made or sent.
import "../../../scripts/net-window.mjs";
import { readOneClickLeast } from "../src/cash-to-pool.ts";

const prices = JSON.parse(process.argv[2] ?? "{}");
const out = {};
for (const [chain, price] of Object.entries(prices)) {
  const asks = [];
  const recording = async (u, init) => {
    const amount = JSON.parse(String(init.body)).amount;
    try {
      const r = await fetch(u, init);
      const text = await r.text();
      asks.push({ amount, status: r.status, text });
      return new Response(text, { status: r.status });
    } catch (e) {
      asks.push({ amount, status: 0, text: `no answer: ${e?.name ?? "failed"}` });
      throw e;
    }
  };
  const verdict = await readOneClickLeast(chain, recording, Date.now(), { price: () => price }).then(
    (least) => ({ least: least.toString() }),
    (e) => ({ error: String(e?.message ?? e) }),
  );
  out[chain] = { asks, ...verdict };
}
process.stdout.write(`${JSON.stringify(out)}\n`);
