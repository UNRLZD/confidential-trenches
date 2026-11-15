// Records near-cash-pays-any-amount's good answer (read only; nothing signed or sent): this branch's helper quoter
// (apps/helper/src/withdraw/fee.ts createFeeQuoter) on the live mainnet pair with the release's relayer accounts as
// HELPER_HOST names them, the pair's final height right after, and this branch's SIGN_HOST build
// (scripts/signpage-built.mjs). Run from the repo root:
//   node scripts/live-checks/near-cash-pays-any-amount.record.ts <out.json>
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nearRpc, RPC_TIMEOUT_MS } from "../../apps/helper/src/bind/send.ts";
import type { Rpc } from "../../apps/helper/src/near/pages.ts";
import { createFeeQuoter } from "../../apps/helper/src/withdraw/fee.ts";
import { signBuilt } from "../signpage-built.mjs";
import { facts, finalHeight, HELPER, PAIR, USDC } from "./near-cash-pays-any-amount.mjs";

const out = process.argv[2];
if (!out) throw new Error("usage: near-cash-pays-any-amount.record.ts <out.json>");
// the release's relayer, as HELPER_HOST answers it (the check holds only the window, relayer-withdraw-fee the accounts)
const live = (await (await fetch(`${HELPER}/v1/withdraw/fee?token=${USDC}`)).json()) as { relayer_account: string; fee_recipient: string };
const pair = PAIR.map((u) => nearRpc(u, fetch, RPC_TIMEOUT_MS)) as unknown as readonly [Rpc, Rpc];
const q = createFeeQuoter({ priceRpcs: pair, networks: { mainnet: { rpcs: pair, relayer: { relayer_account: live.relayer_account, fee_recipient: live.fee_recipient } } } });
const quote = JSON.stringify(await q.quote(USDC));
const height = await finalHeight();
const dir = signBuilt();
const index = readFileSync(join(dir, "index.html"), "utf8");
const js = readFileSync(join(dir, "public", "app.js"), "utf8");
writeFileSync(out, `${JSON.stringify(facts({ quote, height, index, js }))}\n`);
console.log(`recorded ${out}: quote ${quote}, height ${height}`);
