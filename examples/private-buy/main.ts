// A private buy from any app, through Blindfill's kit alone: everything here comes from `@blindfill/kit`, the kit's
// public entry, by the same calls our terminal makes (`pnpm run check:imports` refuses any other way in). The 12 words,
// the keys, the notes and the proofs stay on the signing page (SIGN_HOST); this page only asks it and reads its answers.
// Open it as /?token=<mint>&amount=<SOL>: Solana's pool releases `amount` to a fresh wallet that buys the token.
import { createSignpageClient, SIGNPAGE_CLIENT_CODES, type SignpageClientSnapshot, type Stage } from "@blindfill/kit";

const SIGN_HOST = "https://confidential.unrealized.trade/";
const END: readonly Stage[] = ["filled", "part_filled", "not_landed", "refused"];
const log = (line: string) => document.body.append(Object.assign(document.createElement("pre"), { textContent: line }));

async function privateBuy(token: string, amount: string): Promise<void> {
  // 1. The signing page's client: a hidden frame of SIGN_HOST, READY once the page has answered with its state.
  const client = createSignpageClient({ url: SIGN_HOST, host: { window, document, mount: document.body } });
  const snap = await new Promise<SignpageClientSnapshot>((ready) => {
    const read = (s: SignpageClientSnapshot) => (s.status === "ready" && s.state ? ready(s) : log(`signing page: ${s.status}`));
    client.subscribe(read);
    read(client.snapshot());
  });
  if (!snap.state?.signed_in) return log(`Sign in at ${SIGN_HOST} first.`);

  // 2. Solana's pool, from the device's own notes: a buy spends one ready proof, so at most `tap_max`.
  const pool = snap.state.pools?.find((p) => p.chain === "solana");
  if (!pool?.tap_max) return log("No proof ready in the Solana pool yet.");
  log(`pool: ${pool.balance} ${pool.asset}, one buy up to ${pool.tap_max} ${pool.asset}`);

  // 3. The buy, and its stages and route facts under its id (posted from the page, so none arrives before these listen).
  const buy = client.request("pool.buy", { chain: "solana", token, amount, slippage_bps: 300 });
  client.onRoute((id, route) => {
    if (id === buy.id) log(`route: ${JSON.stringify(route)}`);
  });
  const end = new Promise<Stage>((ended) =>
    client.onProgress((id, stage) => {
      if (id !== buy.id) return;
      log(`stage: ${stage}`);
      if (END.includes(stage)) ended(stage);
    }),
  );

  // 4. The answer comes once the buy is signed and sent. It may come past the client's window (client_timeout) while
  // the page still runs the buy, so the end is read from the stages: "filled" once the page has read the fill on chain.
  const answer = await buy.outcome;
  if (answer.ok) for (const tx of answer.result.txs) log(`tx: ${tx.chain} ${tx.hash}`);
  else if (answer.error.code !== SIGNPAGE_CLIENT_CODES.timeout) log(`refused: ${answer.error.code}`);
  else log("no answer in the client's window: the page may still run it");
  if (answer.ok || answer.error.code === SIGNPAGE_CLIENT_CODES.timeout) log(`end: ${await end}`);
  client.destroy();
}

const q = new URLSearchParams(location.search);
const token = q.get("token");
const amount = q.get("amount");
if (token && amount) void privateBuy(token, amount);
else log("Open this page as /?token=<mint>&amount=<SOL>");
