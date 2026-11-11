// The pool withdraw screen run's page (test/pool-withdraw-screens/run.mjs): the real screen (src/withdraw/pool-form.ts)
// mounted with stub funds, on the chain the query names (?chain=solana or ?chain=base), so every state can be drawn.
// Solana: one 0.05 SOL deposit (the owner's case of 11 Nov 17:53Z) at the mainnet relay fee 1300000 and W's 5000; Base:
// one 0.01 ETH deposit at stand-in fees. The press is handed to window.__handed.
import { drawPoolWithdrawForm, type PoolFunds, type PoolReady } from "../../src/withdraw/pool-form.ts";

const FUNDS: Record<"solana" | "base", PoolFunds> = {
  solana: { notes: [{ id: "a", value: 50_000_000n }], fee: 1_300_000n, wFee: 5_000n, minPart: 1_890_880n },
  base: { notes: [{ id: "a", value: 10_000_000_000_000_000n }], fee: 20_000_000_000_000n, wFee: 1_000_000_000_000n, minPart: 100_000_000_000_000n },
};
const KEYS = { solana: { pool: "4cYEUrtdqrGTMZcsNp7XbYwNNNUBaWKb7fBs6kGMYPYy" }, base: { pool: "0x1111111111111111111111111111111111111111" } };
const chain = new URLSearchParams(location.search).get("chain") === "base" ? "base" : "solana";
const w = window as unknown as { __handed: { chain: string; to: string; amount: string; maxFee: string }[] };
w.__handed = [];
const button = (action: string, label: string, onClick: () => void): HTMLButtonElement => {
  const b = document.createElement("button");
  b.type = "button";
  b.dataset.action = action;
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
};
const root = document.createElement("main");
root.id = "signin";
root.dataset.signin = "pool-withdraw";
root.append(
  drawPoolWithdrawForm(
    document,
    { chain, keys: KEYS[chain], funds: async () => FUNDS[chain], handoff: (r: PoolReady) => void w.__handed.push({ chain: r.chain, to: r.to, amount: String(r.amount), maxFee: String(r.maxFee) }) },
    button,
    (step) => void step(),
  ),
);
document.body.append(root);
