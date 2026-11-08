// Records the mainnet answers test/restore-id-reader.test.ts replays (card wallet-restore-id-reader): read-only `query`
// calls on mainnet's release pair (FastNEAR and dRPC), no key, no secret.
//   node test/record-id-reader.mjs test/vectors/id-reader-mainnet.json   (from packages/wallet)
// Each id is read by nearIdReader twice, once from each provider first, so every view the reader asks of either
// provider is recorded. The ids are public NEAR implicit accounts, each read on mainnet 2026-11-08:
//   - never_used: abab…ab, which no one holds the key of (D15's account): no storage, no account, no token;
//   - used_storage: 9c484fa5…, a NearBlocks USDC holder (read 15:59Z) registered on USDC at a zero balance;
//   - used_account: a8969c04…, an account in block 223638187's chunks with no USDC storage and no intents token;
//   - money_usdc: 5c33c621…, a NearBlocks USDC holder with a balance;
//   - money_intents: 7f4aacbe…, a signer in intents.near's transactions holding tokens there.
import { writeFileSync } from "node:fs";
import { nearRpc } from "../src/deposit/account.ts";
import { nearIdReader } from "../src/restore/id-reader.ts";

export const IDS = {
  never_used: "ab".repeat(32),
  used_storage: "9c484fa5d2d069569ba063fc555c34e621ccd88fdbb0295fc79bad232621c5c1",
  used_account: "a8969c04f2571d010f8ba9fa0b1411e9a06fa0004ee954abcfa66f69bff264e4",
  money_usdc: "5c33c6218d47e00ef229f60da78d0897e1ee9665312550b8afd5f9c7bc6957d2",
  money_intents: "7f4aacbef51f39f90338b106acc1522d6304dd0a9515fe14185f3518be3bb75a",
};
const URLS = ["https://rpc.mainnet.fastnear.com", "https://near.drpc.org"];
const answers = {};
const recording = (url) => {
  const live = nearRpc(url);
  return { name: url, query: async (params) => {
    const a = await live.query(params);
    answers[`${url} ${JSON.stringify(params)}`] = a;
    return a;
  } };
};
const rpcs = [recording(URLS[0]), recording(URLS[1])];
const states = {};
for (const [name, id] of Object.entries(IDS)) {
  states[name] = [];
  for (const f of [0, 1]) states[name].push(await nearIdReader("mainnet", rpcs, { first: () => f, tries: 1 })(id));
}
// the intents branch: money_intents also holds USDC, so the reader stops at ft_balance_of; its intents.near views are
// recorded on their own (the replay serves them for an id whose token views are never_used's)
const extra = {};
for (const url of URLS) {
  const live = nearRpc(url);
  const arg = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
  const tokens = await live.query({ request_type: "call_function", account_id: "intents.near", method_name: "mt_tokens_for_owner", args_base64: arg({ account_id: IDS.money_intents }), finality: "final" });
  const ids = JSON.parse(Buffer.from(tokens.result.result).toString()).map((t) => t.token_id);
  const held = await live.query({ request_type: "call_function", account_id: "intents.near", method_name: "mt_batch_balance_of", args_base64: arg({ account_id: IDS.money_intents, token_ids: ids }), finality: "final" });
  extra[url] = { tokens, held };
}
const out = { recorded_at: new Date().toISOString(), ids: IDS, states, answers, intents: extra };
writeFileSync(process.argv[2], JSON.stringify(out, null, 1) + "\n");
console.log(JSON.stringify(states));
