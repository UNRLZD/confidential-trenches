// The sealed ground run's page (test/sealed-backdrop/run.mjs): the pool withdraw form (Solana, one 0.05 SOL deposit, as
// test/pool-withdraw-screens/entry.ts) in the real sheet, shown as the shell shows it, over the ground the query names:
// ?dir=a or ?dir=b (./directions.ts), or ?dir=now, today's ground (src/backdrop.ts). No frame: a sealed screen has none.
import { drawBackdrop } from "../../src/backdrop.ts";
import { drawSheet } from "../../src/sheet.ts";
import { drawPoolWithdrawForm, type PoolFunds } from "../../src/withdraw/pool-form.ts";
import { drawSealedGround } from "./directions.ts";

const FUNDS: PoolFunds = { notes: [{ id: "a", value: 50_000_000n }], fee: 1_300_000n, wFee: 5_000n, minPart: 1_890_880n };
const dir = new URLSearchParams(location.search).get("dir");
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
root.append(drawPoolWithdrawForm(document, { chain: "solana", keys: { pool: "4cYEUrtdqrGTMZcsNp7XbYwNNNUBaWKb7fBs6kGMYPYy" }, funds: async () => FUNDS, handoff: () => {} }, button, (step) => void step()));
Object.assign(document.body.style, { margin: "0", background: "#0a0a0a" });
const logo = { lit: "/ct-stack-2x.svg", cool: "/ct-stack-2x-cool.svg", phoneLit: "/ct-stack-phone-2x.svg", phoneCool: "/ct-stack-phone-2x-cool.svg" };
document.body.append(dir === "a" || dir === "b" ? drawSealedGround(document, dir, logo) : drawBackdrop(document));
const sheet = drawSheet(document);
document.body.append(sheet.layer);
sheet.layer.hidden = false;
sheet.body.append(root);
