#!/usr/bin/env node
// A pool buy and sell end to end in H-app on Solana devnet (card app-a2-e2e; app.md 5.2 AE-11). The real terminal (its
// build), the real kit (the terminal's own client), the real signing page (its testnet build: the devnet pool it pins,
// DEVNET_TABLE) and its in-browser prover, on the shipped names (startHarness realNames). The browser reaches two real
// hosts and no other: the devnet RPC and the helper (its devnet RPC, its pool fee and its POST /v1/pool/solana/send).
// The steps are packages/signpage/scripts/pool-flow-devnet.mjs's, run in the browser:
//   1. sign in the no-PRF way (a virtual authenticator with no PRF): SIGN_HOST draws the 12 words, which this run keeps
//      at ~/.ct-devnet-runs/app-a2-e2e-<time>.words (folder 0700, file 0600, never printed) so the account's devnet
//      money stays reachable after the run, then Saved;
//   2. the header's Deposit opens the sheet, which asks pool.address for each pool's chain with no asset: Solana's
//      answer is U, the pool's one-time address (the testnet build quotes nothing: pool-deposit-address.ts);
//   3. U is funded from outside the run: it prints one line `fund: <U> <lamports> devnet` (exactly the deposit's need: the
//      rung, the mark's rent, two page entries and the fee, pool-flow-devnet.mjs's NEED, from the rent both RPCs give)
//      and waits up to 10 minutes for that balance on both devnet RPCs at finalized, else ends "not funded". The run
//      holds no key and reads no key file; before it prints anything it refuses any cluster but devnet (both RPCs'
//      genesis hash);
//   4. pool.deposit of 0.01 SOL, sent to the kit's frame of SIGN_HOST as the kit's own message (the testnet build has
//      no screen that sends it: the sheet's deposit needs a 1Click quote, mainnet only);
//   5. the token page of the devnet coin (its market row: market-token.json, a recorded mainnet answer with the devnet
//      mint, since the helper's market data is mainnet only; the one read that is not live) shows the pool's proof
//      making, then Proof ready; the run types the line's Max into the amount and taps Buy once;
//   6. the box reaches Filled; the wallet W the buy filled holds the coin, read on both devnet RPCs;
//   7. the box's Sell side opens once the signing page's state holds the position; 100% is sold in one tap and the box
//      reaches Filled; W then holds none of the coin on both RPCs, and every transaction the page sent is read back on
//      both (err null, confirmed).
// Nothing here signs or sends: SIGN_HOST signs, proves and sends; the run only reads. What is left on U, W or in the
// pool after the run stays there.
//   node apps/terminal/test/e2e/buy/run.mjs [--record <file>] [--shots <dir>] [--plant free|no-buy|no-sell]
//     PASS exit 0, FAIL exit 1, error exit 2. --plant free stops once U is answered, before the fund line (the free
//     part: no money); no-buy stops before the buy's tap, no-sell before the sell's (the red runs).
// Needs the terminal's build (pnpm --filter terminal build) and the installed Chrome (scripts/browsers.mjs).
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { addAuthenticator, HOSTS, REAL, SIGNPAGE, startHarness, TERMINAL } from "../../harness/harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(TERMINAL, "../..");
export const DEVNET_RPC = "https://api.devnet.solana.com";
export const HELPER_RPC = `https://${REAL.api}/v1/rpc/solana-devnet`;
/** The devnet coin the devnet runs buy (scripts/live-checks/sol-w-sweep.md: venue pump-curve). */
export const MINT = "AoU3FWPvuFo7WLtP186k6U2hLZ3e44PGeJdFQHVJnw6P";
const RUNG = 10_000_000n;
const FEE = 5_000n;
const WAIT_MS = 20_000;
const PROOF_MS = 6 * 60_000;
const FILL_MS = 90_000;
const PRICE_MS = 7 * 60_000;
const HELD_MS = 60_000;
const FUND_MS = 10 * 60_000;
/** Solana devnet's genesis hash (getGenesisHash on api.devnet.solana.com); any other cluster is refused. */
export const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

// ------------------------------------------------------------------------------------------------ the verdict
/** The run's verdict lines from its record. */
export function judge(rec) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  if (rec.error) say(false, `error: ${rec.error}`);
  say(rec.signedIn === true, `signed in the no-PRF way, 12 words kept: ${rec.words ?? 0}`);
  say(typeof rec.u === "string" && rec.u.length >= 32, `pool.address answered U for Solana: ${rec.u ?? "none"}`);
  say(rec.funded?.ok === true, `U funded ${rec.funded?.lamports ?? "-"} lamports, read back on both RPCs`);
  say(rec.deposit?.ok === true && ["sent", "filled"].includes(rec.deposit?.stage), `pool.deposit answered ${JSON.stringify(rec.deposit ?? null)}`);
  say(rec.box?.path === "pool", `the trade box on the pool path: ${rec.box?.path ?? "none"}`);
  say(rec.box?.proofReady === true, `Proof ready drawn (${rec.box?.proofMs ?? "-"} ms after the deposit answered)`);
  say(rec.buy?.taps === 1, `the buy tapped once: ${rec.buy?.taps ?? 0}`);
  say(rec.buy?.asks === 1 && rec.buy?.kind === "pool.buy", `one pool.buy sent: ${rec.buy?.asks ?? 0} ${rec.buy?.kind ?? ""}`);
  say(/^Filled\b/.test(rec.buy?.end ?? ""), `the box ended "${rec.buy?.end ?? "none"}"`);
  const txs = rec.txs ?? [];
  const buyTxs = txs.filter((t) => t.step === "buy");
  say(buyTxs.length >= 1, `the buy's transactions sent: ${buyTxs.length}`);
  const [a, b] = rec.heldAfterBuy ?? [];
  say(typeof rec.w === "string" && a === b && /^\d+$/.test(a ?? "") && BigInt(a) > 0n, `the buy's wallet ${rec.w ?? "none"} holds ${a ?? "-"} / ${b ?? "-"} of the coin on the two RPCs`);
  say(rec.sell?.taps === 1, `the sell tapped once: ${rec.sell?.taps ?? 0}`);
  say(rec.sell?.asks === 1, `one sell sent: ${rec.sell?.asks ?? 0} ${rec.sell?.kind ?? ""}`);
  say(/^Filled\b/.test(rec.sell?.end ?? ""), `the sell box ended "${rec.sell?.end ?? "none"}"`);
  const sellTxs = txs.filter((t) => t.step === "sell");
  say(sellTxs.length >= 1, `the sell's transactions sent: ${sellTxs.length}`);
  say(Array.isArray(rec.heldAfterSell) && rec.heldAfterSell.length === 2 && rec.heldAfterSell.every((x) => x === "0"), `after the sell W holds ${(rec.heldAfterSell ?? ["-", "-"]).join(" / ")} on the two RPCs`);
  say(txs.length > 0 && txs.every((t) => t.reads?.length === 2 && t.reads.every((r) => r.err === null && (r.status === "confirmed" || r.status === "finalized"))), `every transaction read back ok on both RPCs: ${txs.map((t) => `${t.step} ${t.sig.slice(0, 8)} ${(t.reads ?? []).map((r) => r.status ?? "none").join("/")}`).join(", ") || "none"}`);
  say(rec.pages === 1, `one page from first frame to last: ${rec.pages}`);
  say((rec.dialogs ?? 0) === 0, `no dialog: ${rec.dialogs ?? 0}`);
  say((rec.csp ?? []).length === 0, `CSP violations: ${(rec.csp ?? []).join("; ") || "none"}`);
  say((rec.hosts ?? []).every((h) => ALLOWED.has(h)), `hosts reached: ${(rec.hosts ?? []).join(", ")}`);
  return { ok: !lines.some((l) => l.startsWith("BAD")), lines };
}
const ALLOWED = new Set([REAL.app, REAL.sign, REAL.api, new URL(DEVNET_RPC).hostname]);

// ------------------------------------------------------------------------------------------------ devnet reads and the fund wait
/** One read, asked again after a rate limit (HTTP 429 or a JSON-RPC 429: the public devnet RPC limits per connection;
 *  the first paid run lost its post-buy read to one, 10 Nov 21:30Z), up to RATE_TRIES times with a growing pause. */
export async function rpc(url, method, params, { tries = RATE_TRIES, pauseMs = 1_500, fetchFn = fetch } = {}) {
  for (let i = 1; ; i++) {
    const r = await fetchFn(url, { method: "POST", headers: { "content-type": "application/json", origin: `https://${REAL.sign}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const j = r.status === 429 ? { error: { code: 429 } } : await r.json();
    if (j.error?.code === 429 && i < tries) {
      await new Promise((ok) => setTimeout(ok, pauseMs * i));
      continue;
    }
    if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error).slice(0, 160)}`);
    return j.result;
  }
}
const RATE_TRIES = 8;
const both = (method, params) => Promise.all([DEVNET_RPC, HELPER_RPC].map((u) => rpc(u, method, params)));
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function b58(bytes) {
  let n = BigInt(`0x${Buffer.from(bytes).toString("hex") || "0"}`);
  let s = "";
  while (n > 0n) (s = B58[Number(n % 58n)] + s), (n /= 58n);
  for (const b of bytes) if (b === 0) s = `1${s}`; else break;
  return s;
}
export function unb58(s) {
  let n = 0n;
  for (const c of s) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error("not base58");
    n = n * 58n + BigInt(i);
  }
  const hex = n.toString(16);
  const body = Buffer.from(hex.length % 2 ? `0${hex}` : hex, "hex");
  const zeros = s.match(/^1*/)[0].length;
  return Buffer.concat([Buffer.alloc(zeros), n === 0n ? Buffer.alloc(0) : body]);
}
/** Refuses a run on any cluster but devnet: both RPCs' genesis hashes, as read, must be devnet's. */
export function devnetOnly(hashes) {
  if (hashes.length !== 2 || !hashes.every((h) => h === DEVNET_GENESIS)) throw new Error(`not devnet: genesis ${hashes.join(" / ")}`);
}
/** U's balance reaching `need` on both RPCs at finalized, bounded by FUND_MS: the funding signatures, or null. */
async function fundedBy(u, need) {
  const by = Date.now() + FUND_MS;
  while (Date.now() < by) {
    const bal = await both("getBalance", [u, { commitment: "finalized" }]).catch(() => null);
    if (bal && bal.every((x) => BigInt(x.value) >= need)) {
      const [sigs] = await both("getSignaturesForAddress", [u, { commitment: "finalized" }]);
      return sigs.map((x) => x.signature);
    }
    await new Promise((r) => setTimeout(r, 3_000));
  }
  return null;
}
/** U's need, as pool-flow-devnet.mjs's NEED: the rung, the mark's rent (17 B), two page entries (72 B each), the fee. */
async function needOf() {
  const ask = async (n) => {
    const [a, b] = await both("getMinimumBalanceForRentExemption", [n]);
    if (a !== b) throw new Error("the RPCs give different rent");
    return BigInt(a);
  };
  return RUNG + (await ask(17)) + ((await ask(144)) - (await ask(0))) + FEE;
}
async function readBack(sig) {
  const st = (await both("getSignatureStatuses", [[sig], { searchTransactionHistory: true }])).map((x) => x.value[0]);
  return st.map((x) => ({ status: x?.confirmationStatus ?? null, err: x ? x.err : "none" }));
}
/** The wallet the buy filled: the owner whose MINT balance the buy's transactions raised, as each RPC reads them. */
async function buyWallet(sigs) {
  const per = await Promise.all([DEVNET_RPC, HELPER_RPC].map(async (u) => {
    for (const sig of sigs) {
      const tx = await rpc(u, "getTransaction", [sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]);
      const amt = (list, owner) => BigInt(list?.find((b) => b.mint === MINT && b.owner === owner)?.uiTokenAmount.amount ?? "0");
      const up = (tx?.meta?.postTokenBalances ?? []).filter((b) => b.mint === MINT).map((b) => b.owner).find((o) => amt(tx.meta.postTokenBalances, o) > amt(tx.meta.preTokenBalances, o));
      if (up) return up;
    }
    return null;
  }));
  if (!per[0] || per[0] !== per[1]) throw new Error(`the buy's wallet reads ${per.join(" / ")} on the two RPCs`);
  return per[0];
}
/** MINT held by `owner` (its base units, a string) as each of the two RPCs reads it at confirmed. */
async function heldOn(owner) {
  return Promise.all([DEVNET_RPC, HELPER_RPC].map(async (u) => {
    const r = await rpc(u, "getTokenAccountsByOwner", [owner, { mint: MINT }, { encoding: "jsonParsed", commitment: "confirmed" }]);
    return String(r.value.reduce((n, a) => n + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n));
  }));
}

// ------------------------------------------------------------------------------------------------ the testnet SIGN_HOST
/** SIGN_HOST's testnet build in a fresh folder: build-app.mjs --network testnet (run as a child, never imported), the
 *  page's own _headers with the devnet RPC added to connect-src (the shipped policy names the mainnet RPCs only; this
 *  folder is the run's alone), and the prover's setup files at assets/zk/<sha256>.<ext>, as SIGN_HOST serves them. */
export function testnetSign() {
  const out = mkdtempSync(path.join(tmpdir(), "ct-a2e-sign-"));
  const r = spawnSync(process.execPath, [path.join(SIGNPAGE, "scripts", "build-app.mjs"), "--out", out, "--network", "testnet"], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`build-app --network testnet failed: ${`${r.stderr}${r.stdout}`.trim().slice(-400)}`);
  const headers = readFileSync(path.join(SIGNPAGE, "public", "_headers"), "utf8");
  const devnet = headers.replace("connect-src 'self' ", `connect-src 'self' ${DEVNET_RPC} `);
  if (devnet === headers) throw new Error("SIGN_HOST's _headers has no connect-src 'self' to add the devnet RPC to");
  writeFileSync(path.join(out, "_headers"), devnet);
  const zk = path.join(REPO, "packages", "kit", "zk");
  mkdirSync(path.join(out, "assets", "zk"), { recursive: true });
  for (const f of readdirSync(zk).filter((f) => /\.(wasm|zkey|vkey)$/.test(f))) {
    const sha = createHash("sha256").update(readFileSync(path.join(zk, f))).digest("hex");
    copyFileSync(path.join(zk, f), path.join(out, "assets", "zk", `${sha}${path.extname(f)}`));
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ the browser side
// In every document before its scripts: CSP violations, and in APP_HOST's frame every answer the kit's frame of
// SIGN_HOST posts (pool.address's U, pool.deposit's and pool.buy's answers, their progress), reported through __ct.
const PROBE = ({ app, sign }) => {
  const report = (e) => {
    try {
      /** @type {any} */ (window).__ct({ ...e, host: location.hostname });
    } catch {}
  };
  addEventListener("securitypolicyviolation", (e) => report({ kind: "csp", directive: e.effectiveDirective, blocked: String(e.blockedURI).slice(0, 80) }));
  // SIGN_HOST (the shell that frames the terminal, or a frame the kit mounts): every request APP_HOST's kit posts it,
  // kind, id and side only (the kit's message is flat: { ...params, v, id, type })
  if (location.hostname === sign) {
    addEventListener("message", (e) => {
      const d = e.data;
      if (e.origin === `https://${app}` && d && typeof d === "object" && d.v === 1 && typeof d.type === "string" && typeof d.id === "string" && !("ok" in d)) report({ kind: "ask", type: d.type, id: d.id, side: typeof d.side === "string" ? d.side : null });
    }, true);
    return;
  }
  if (location.hostname !== app) return;
  addEventListener("message", (e) => {
    const d = e.data;
    if (!d || typeof d !== "object" || d.v !== 1) return;
    if (d.ok === true && d.result && typeof d.result.address === "string" && d.result.chain) report({ kind: "address", chain: d.result.chain, address: d.result.address });
    else if (typeof d.id === "string" && ("ok" in d || d.type === "progress")) report({ kind: "answer", id: d.id, ok: d.ok ?? null, type: d.type ?? null, stage: d.result?.stage ?? d.stage ?? null, code: d.error?.code ?? null });
  });
};

/** One trade's timing from the run's own clock: the tap, its first send leaving the page, each answer SIGN_HOST posted
 *  (its stage, ms after the tap), and when the run read the end label; the transaction's block time is added from the
 *  chain after the run (blockTime, in seconds). */
function timing(tapAt, sentAt, answers, end) {
  return {
    sentMs: sentAt ? sentAt - tapAt : null,
    answers: answers.filter((e) => e.kind === "answer").map((e) => ({ ms: e.at - tapAt, type: e.type, stage: e.stage, ok: e.ok })),
    endMs: Date.now() - tapAt,
    end,
    tapAt: new Date(tapAt).toISOString(),
  };
}

export async function run({ plant = null, shots = null } = {}) {
  const rec = { started: new Date().toISOString(), plant, txs: [], csp: [], hosts: [], dialogs: 0 };
  devnetOnly(await both("getGenesisHash", []));
  rec.stub = `market read for ${MINT} answered by the run, shape from apps/terminal/test/e2e/buy/market-token.json`;
  const signRoot = testnetSign();
  const h = await startHarness({ realNames: true, through: [new URL(DEVNET_RPC).hostname, REAL.api], edit: (s) => void (s[HOSTS.sign] = { root: signRoot, spa: true }) });
  const events = [];
  const hosts = new Set();
  // every transaction the browser sends: a sendTransaction on either devnet RPC, or the helper's pool send ({pool, tx})
  const sent = [];
  /** the helper's pool send answers still being read */
  const answers = [];
  let step = "signin";
  try {
    // the recorded answer keeps its mint as "<mint>" (a mint beside "token" reads as a key to gitleaks' generic rule)
    const market = readFileSync(path.join(HERE, "market-token.json"), "utf8").trim().replaceAll("<mint>", MINT);
    const { context } = await h.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
    await context.route(`https://${REAL.api}/v1/market/token?chain=solana&token=${MINT}`, (r) => r.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": `https://${REAL.app}` }, body: market }));
    await context.exposeBinding("__ct", (_s, e) => events.push({ ...e, at: Date.now() }));
    await context.addInitScript(PROBE, { app: REAL.app, sign: REAL.sign });
    // a host counts as reached once it answered (the footer's NEAR RPCs are asked and fail as not found)
    context.on("response", (r) => {
      try {
        hosts.add(new URL(r.url()).hostname);
      } catch {}
    });
    // a transaction sent to an RPC is named by its first signature, as sent; one the helper carries (POST
    // /v1/pool/solana/send: slot 0, the fee payer's, is zero until the helper signs) by the signature its 200 answers
    const add = (sig) => sig && !/^1+$/.test(sig) && !sent.some((x) => x.sig === sig) && sent.push({ step, sig });
    // when each step's first send left the page (an RPC sendTransaction or the helper's pool send), for the timing split
    const sentAt = {};
    const mark = () => (sentAt[step] ??= Date.now());
    const isPoolSend = (r) => r.method() === "POST" && new URL(r.url()).hostname === REAL.api && new URL(r.url()).pathname === "/v1/pool/solana/send";
    context.on("request", (r) => {
      if (r.method() !== "POST") return;
      if (isPoolSend(r)) return void mark();
      try {
        const b = JSON.parse(r.postData() ?? "");
        if (b?.method === "sendTransaction" && typeof b.params?.[0] === "string") mark(), add(b58(Buffer.from(b.params[0], "base64").subarray(1, 65)));
      } catch {}
    });
    context.on("response", (r) => {
      if (!isPoolSend(r.request()) || r.status() !== 200) return;
      const at = step;
      answers.push(r.json().then((j) => typeof j?.signature === "string" && !sent.some((x) => x.sig === j.signature) && sent.push({ step: at, sig: j.signature }), () => {}));
    });
    const page = await context.newPage();
    page.on("dialog", (d) => (rec.dialogs++, void d.dismiss()));
    await addAuthenticator(page, { hasPrf: false });
    const app = page.frameLocator("iframe#app");
    const vis = (sel) => app.locator(`${sel} >> visible=true`).first();
    const top = (sel) => page.locator(sel).first();
    const shot = async (name) => shots && (await page.screenshot({ path: path.join(shots, `a2e-${name}-1440.png`) }));

    // 1. sign in, the words kept for the sell's card
    await page.goto(`https://${REAL.app}/token/solana/${MINT}`, { waitUntil: "commit" });
    await page.waitForURL((u) => u.hostname === REAL.sign, { timeout: WAIT_MS });
    await app.locator(':root[data-signpage="ready"]').waitFor({ state: "attached", timeout: WAIT_MS });
    await shot("0-signed-out");
    await vis('[data-header="S1.1"] button, button[data-header="S1.1"]').click();
    await vis('.sgn-opt[data-way="passkey"]').click();
    await top('#screen:not([hidden]) #signin[data-signin="signed-out"] button[data-action="create"]').click();
    const list = top('#screen:not([hidden]) #signin[data-signin="backup"] [data-words="12"]');
    await list.waitFor({ timeout: WAIT_MS });
    const words = (await list.locator("li").allInnerTexts()).map((t) => t.trim().split(/\s+/).pop());
    rec.words = words.length;
    const dir = path.join(homedir(), ".ct-devnet-runs");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    // the record names the file, never its folder (scripts/live-checks/record-names.mjs: no user folder in a record)
    rec.wordsFile = `app-a2-e2e-${rec.started.replace(/[:.]/g, "-")}.words`;
    writeFileSync(path.join(dir, rec.wordsFile), `${words.join(" ")}\n`, { mode: 0o600, flag: "wx" });
    await page.waitForTimeout(600); // past SIGN_HOST's 500 ms guard on Saved
    await top('#signin[data-signin="backup"] button[data-action="saved"]').click();
    await vis('[data-header="S1.3"], [data-header="S1.4"]').waitFor({ timeout: WAIT_MS });
    rec.signedIn = true;
    await shot("1-signed-in");

    // 2. the sheet's pool.address: U
    step = "address";
    await vis('button:has-text("Deposit")').click();
    const until = Date.now() + WAIT_MS;
    while (!events.some((e) => e.kind === "address" && e.chain === "solana") && Date.now() < until) await page.waitForTimeout(200);
    rec.u = events.find((e) => e.kind === "address" && e.chain === "solana")?.address ?? null;
    await shot("2-sheet");
    await vis(".dep-x").click();
    await app.locator(".dep-box").waitFor({ state: "detached", timeout: WAIT_MS });
    if (!rec.u) throw new Error("no pool.address answer for Solana");

    // 4. pool.deposit of 0.01 SOL, the kit's message to its own SIGN_HOST frame (asked once unfunded in the free part:
    // the page reads U short and answers not_funded, nothing sent, pool-deposit.ts)
    const appFrame = page.frames().find((x) => x.url().startsWith(`https://${REAL.app}/`));
    if (!appFrame) throw new Error("no APP_HOST frame");
    const depositAsk = () => appFrame.evaluate(
      ({ sign, ms }) =>
        new Promise((ok) => {
          // the kit's peer: its own frame of SIGN_HOST, or the shell that frames the terminal (the kit's `parent`)
          const frame = [...document.querySelectorAll("iframe")].find((x) => x.src.startsWith(`https://${sign}/`));
          const peer = frame?.contentWindow ?? (window.parent !== window ? window.parent : null);
          if (!peer) return ok({ ok: false, code: "no kit peer" });
          const id = crypto.randomUUID();
          const t = setTimeout(() => ok({ ok: false, code: "timeout" }), ms);
          addEventListener("message", (e) => {
            if (e.source !== peer || e.data?.id !== id || !("ok" in e.data)) return;
            clearTimeout(t);
            ok(e.data.ok ? { ok: true, stage: e.data.result.stage, txs: e.data.result.txs.length } : { ok: false, code: e.data.error?.code ?? null });
          });
          peer.postMessage({ v: 1, id, type: "pool.deposit", chain: "solana", amount: "0.01" }, `https://${sign}`);
        }),
      { sign: REAL.sign, ms: 120_000 },
    );
    if (plant === "free") {
      step = "deposit";
      rec.deposit = await depositAsk();
      throw new Error(`planted: the free part ends at U, its deposit asked unfunded (no fund line)`);
    }

    // 3. U funded from outside the run, exactly its need, read at finalized on both RPCs
    step = "fund";
    const need = await needOf();
    console.log(`fund: ${rec.u} ${need} devnet`);
    const fundSigs = await fundedBy(rec.u, need);
    if (!fundSigs) throw new Error(`not funded: ${rec.u} short of ${need} lamports after ${FUND_MS / 60_000} minutes`);
    rec.funded = { ok: true, lamports: String(need) };
    for (const sig of fundSigs) rec.txs.push({ step: "fund", sig });

    step = "deposit";
    const depositAt = Date.now();
    rec.deposit = await depositAsk();
    if (!rec.deposit.ok) throw new Error(`pool.deposit answered ${JSON.stringify(rec.deposit)}`);

    // 5. the trade box: the pool path, the proof made in this browser, then Buy at the line's Max
    step = "proof";
    const box = vis('[data-testid="trade-box"]');
    await box.waitFor({ timeout: WAIT_MS });
    rec.box = { path: await box.getAttribute("data-path") };
    await shot("3-proof-making");
    await vis('[data-testid="trade-proof"][data-proof="ready"]').waitFor({ timeout: PROOF_MS });
    rec.box.proofReady = true;
    rec.box.proofMs = Date.now() - depositAt;
    rec.box.path = await box.getAttribute("data-path");
    // Max needs the device's own SOL/USD read, used for 60 s from its publish (kit price/pool-usd.ts); devnet's Pyth
    // SOL/USD feed publishes about every 5 minutes (read 9 Nov 20:44:58Z, then 20:50:05Z), so the line waits for one
    const lineEl = vis('[data-testid="trade-max"]');
    const priceBy = Date.now() + PRICE_MS;
    let line = "";
    let max = null;
    while (Date.now() < priceBy) {
      line = (await lineEl.innerText()).replace(/\s+/g, " ").trim();
      max = line.match(/Max \$([\d,.]+)/)?.[1]?.replaceAll(",", "") ?? null;
      if (max) break;
      await page.waitForTimeout(500);
    }
    rec.box.line = line;
    rec.box.priceMs = Date.now() - depositAt;
    if (!max) throw new Error(`no Max on the line in ${PRICE_MS / 1000} s: "${line}"`);
    await vis(".trb-amount input").fill(max);
    await page.waitForTimeout(300);
    await shot("4-proof-ready");
    rec.buy = { taps: 0, asks: 0, amountUsd: max };
    if (plant === "no-buy") throw new Error("planted: the buy is cut (no tap)");
    step = "buy";
    const asksBefore = events.filter((e) => e.kind === "ask").length;
    const answersBefore = events.length;
    await vis('[data-testid="trade-cta"]').click();
    const tapAt = Date.now();
    rec.buy.taps = 1;
    const cta = vis('[data-testid="trade-cta"]');
    const end = Date.now() + FILL_MS;
    let label = "";
    while (Date.now() < end) {
      label = (await cta.innerText()).replace(/\s+/g, " ").trim();
      if (/^(Filled|Failed|Not landed)/.test(label) || (await vis(".trb-state, [data-testid='trade-state']").count()) > 0 && /Failed|Not landed/.test(label)) break;
      await page.waitForTimeout(250);
    }
    rec.buy.end = label;
    rec.buy.timing = timing(tapAt, sentAt.buy, events.slice(answersBefore), label);
    const asks = events.filter((e) => e.kind === "ask").slice(asksBefore).filter((e) => e.type.startsWith("pool.buy") || e.type === "buy");
    rec.buy.asks = asks.length;
    rec.buy.kind = asks[0]?.type ?? null;
    await shot("5-filled");
    if (!/^Filled\b/.test(label)) throw new Error(`the buy ended "${label}"`);

    // 7. the buy's wallet W and what it holds, read on both RPCs
    step = "held";
    await Promise.allSettled(answers);
    rec.w = await buyWallet(sent.filter((x) => x.step === "buy").map((x) => x.sig));
    rec.heldAfterBuy = await heldOn(rec.w);

    // 8. the sell side, once the signing page's state holds the position: 100% sold in one tap, back into the pool
    const side = vis('[data-testid="trade-side-sell"]');
    const heldBy = Date.now() + HELD_MS;
    while (Date.now() < heldBy && (await side.isDisabled())) await page.waitForTimeout(500);
    rec.sell = { taps: 0, asks: 0 };
    if (await side.isDisabled()) throw new Error(`no position to sell ${HELD_MS / 1000} s after Filled`);
    await side.click();
    await vis('[data-testid="sell-box"] .trb-input').fill("100");
    const sellCta = vis('[data-testid="sell-cta"]');
    const sellBy = Date.now() + WAIT_MS;
    while (Date.now() < sellBy && (await sellCta.isDisabled())) await page.waitForTimeout(250);
    await shot("6-sell");
    if (plant === "no-sell") throw new Error("planted: the sell is cut (no tap)");
    step = "sell";
    const sellAsksBefore = events.filter((e) => e.kind === "ask").length;
    const sellAnswersBefore = events.length;
    await sellCta.click();
    const sellTapAt = Date.now();
    rec.sell.taps = 1;
    const sellEnd = Date.now() + FILL_MS;
    let sellLabel = "";
    while (Date.now() < sellEnd) {
      sellLabel = (await sellCta.innerText()).replace(/\s+/g, " ").trim();
      if (/^(Filled|Failed|Not landed)/.test(sellLabel)) break;
      await page.waitForTimeout(250);
    }
    rec.sell.end = sellLabel;
    rec.sell.timing = timing(sellTapAt, sentAt.sell, events.slice(sellAnswersBefore), sellLabel);
    const sellAsks = events.filter((e) => e.kind === "ask").slice(sellAsksBefore).filter((e) => e.type === "pool.sell" || (e.type === "buy" && e.side === "sell"));
    rec.sell.asks = sellAsks.length;
    rec.sell.kind = sellAsks[0]?.type ?? null;
    await shot("7-sold");

    // 9. W holds none of the coin, read on both RPCs
    step = "after";
    rec.heldAfterSell = await heldOn(rec.w);
    rec.pages = context.pages().length;
  } catch (e) {
    rec.error = String(e?.message ?? e).slice(0, 300);
  } finally {
    // 10. every transaction the page sent, and U's funding, read back on both RPCs
    await Promise.allSettled(answers);
    for (const s of sent) if (!rec.txs.some((t) => t.sig === s.sig)) rec.txs.push(s);
    for (const t of rec.txs) t.reads = await readBack(t.sig).catch((e) => [{ status: null, err: String(e?.message).slice(0, 80) }]);
    rec.csp = events.filter((e) => e.kind === "csp").map((e) => `${e.host} ${e.directive} ${e.blocked}`);
    rec.hosts = [...hosts].sort();
    rec.pages ??= null;
    await h.close();
    rmSync(signRoot, { recursive: true, force: true });
  }
  return rec;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : null);
  const shots = opt("--shots");
  if (shots) mkdirSync(shots, { recursive: true });
  try {
    const rec = await run({ plant: opt("--plant"), shots });
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(rec, null, 2)}\n`);
    const v = judge(rec);
    console.log(rec.stub);
    for (const l of v.lines) console.log(l);
    for (const t of rec.txs) console.log(`Tx: solana-devnet ${t.sig} (${t.step})`);
    for (const side of ["buy", "sell"]) if (rec[side]?.timing) console.log(`timing ${side}: ${JSON.stringify(rec[side].timing)}`);
    console.log(v.ok ? "PASS a pool buy and sell end to end in H-app on devnet" : "FAIL");
    process.exit(v.ok ? 0 : 1);
  } catch (e) {
    console.error(`error: ${e?.message ?? e}`);
    process.exit(2);
  }
}
