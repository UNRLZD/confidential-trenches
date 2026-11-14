#!/usr/bin/env node
// node examples/agent/main.mjs run --token <t> --amount <usd> --max <usd> --to <address> [--deposit <usd>] [--slippage-bps <n>]
import { run } from "./agent.mjs";

const a = process.argv.slice(3);
const opt = (k) => (a.includes(k) ? a[a.indexOf(k) + 1] : undefined);
try {
  if (process.argv[2] !== "run" || !opt("--token") || !opt("--to") || !opt("--amount") || !opt("--max")) {
    throw new Error("usage: main.mjs run --token <t> --amount <usd> --max <usd> --to <address> [--deposit <usd>] [--slippage-bps <n>]");
  }
  await run({ token: opt("--token"), to: opt("--to"), amount: opt("--amount"), deposit: opt("--deposit"), max: Number(opt("--max")), slippageBps: Number(opt("--slippage-bps") ?? 300) });
} catch (e) {
  console.error(`agent: ${e.message}`);
  process.exitCode = 1;
}
