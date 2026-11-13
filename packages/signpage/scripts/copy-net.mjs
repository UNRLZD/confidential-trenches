// FLOW_COPY (./sol-mainnet-copy.mjs): the pool drivers (pool-flow-devnet.mjs, pool-withdraw-devnet.mjs) run
// the signing page's mainnet build against a local validator that clones mainnet, in place of devnet. What this sets,
// and only this:
// - the page's Solana pair: the copy's one RPC under two names (127.0.0.1 and localhost), read through the page's own
//   testnetRpc, as the testnet build reads its devnet pair;
// - the pool's pin: the mainnet program, with the copy's fee payer (a fresh key the run made; the proof binds the fee
//   payer through its context only, so the program takes any signer there);
// - the helper: its own Solana pool sender (apps/helper/src/pool/solana.ts) on the copy, answering GET /v1/pool/fee,
//   POST /v1/pool/solana/send and POST /v1/pool/solana/pieces (a buy's pieces as one bundle, card
//   buy-spends-several-pieces) as server.ts does, with server.ts's send line (pool/send-log.ts poolSendLine). The copy
//   has no block engine, so the sender's engine is a local stand-in (COPY.engine) that never reaches a real one: "busy"
//   and "refused" answer so; "swallow" takes the bundle and never lands it (what mainnet's engines did with five buys);
//   "lands" sends it to the copy as plain transactions, a bundle's in its order, each read confirmed before the next (a
//   real engine lands a bundle all or none; the copy lands each on its own). Jito's tip floor is not read: the sender
//   tips its default (solana-pieces.ts bundleTip). Every other helper path answers 404 and is logged; any other host is
//   refused;
// - FLOW_COPY's plant "mayhem-drop": every account read of a curve answers it with its Mayhem byte cleared, so the page
//   builds a Mayhem coin's buy with the plain fee recipient in place of the Mayhem one (the chain's own state is
//   unchanged and refuses it);
// - every failed simulation's last log lines are kept (simFails), so a refusal carries the program's own log.
import { readFileSync } from "node:fs";
import { base58 } from "@scure/base";
import { copyRpcsLocal } from "./sol-mainnet-copy-parse.mjs";

export const COPY = process.env.FLOW_COPY ? JSON.parse(readFileSync(process.env.FLOW_COPY, "utf8")) : null;

/** Installs the copy's fetch and returns what the driver wires: its rpcs, pin, helper fetch and holdings reader. */
export async function copyNet({ log, phase = () => "" }) {
  if (!COPY) throw new Error("FLOW_COPY is not set");
  if (!copyRpcsLocal(COPY.rpcs)) throw new Error("copy: the run file names an RPC that is not this machine (127.0.0.1 and localhost only)");
  const { testnetRpc } = await import("../src/pool-testnet.ts");
  const { TRADE_HELPER } = await import("../src/trade.ts");
  const { SOL_POOLS } = await import("../../wallet/src/pool/solana.ts");
  const { POOL_TESTNET } = await import("../../wallet/src/pool/network.ts");
  const { solanaHoldingsAt } = await import("../../wallet/src/pool/buy-wallets.ts");
  const { solanaJsonRpc } = await import("../../kit/src/trade/solana/send.ts");
  const { readSolanaRent, solanaPoolFee } = await import("../../kit/src/trade/solana/pool-buy.ts");
  const { solanaPoolAddresses } = await import("../../kit/src/trade/solana/pool.ts");
  const { solanaPoolSender } = await import("../../../apps/helper/src/pool/solana.ts");
  const { poolSendLine } = await import("../../../apps/helper/src/pool/send-log.ts");
  if (POOL_TESTNET !== false || SOL_POOLS.mainnet === undefined) throw new Error("not the mainnet build's pins");
  const secret = readFileSync(COPY.feePayerKeyFile, "utf8").trim();
  const PIN = Object.freeze({ program: SOL_POOLS.mainnet.program, feePayer: base58.encode(base58.decode(secret).subarray(32)) });
  const hosts = new Set(COPY.rpcs.map((u) => new URL(u).host));
  const helperHost = new URL(TRADE_HELPER).host;
  const native = globalThis.fetch;
  const simFails = [];
  const sendLines = [];
  const sent = [];
  // a bundle's transactions keep the step it was sent in, though the stand-in lands its last ones after the page moved on
  const bundlePhase = new Map();
  const plantCurve = COPY.plant === "mayhem-drop" && COPY.mint ? solanaPoolAddresses(COPY.mint).curve : null;
  const planted = { reads: 0 };
  const clearMayhem = (acc) => {
    if (!acc || !Array.isArray(acc.data) || acc.data[1] !== "base64") return acc;
    const d = Buffer.from(acc.data[0], "base64");
    if (d.length > 81 && d[81] === 1) (d[81] = 0), planted.reads++;
    return { ...acc, data: [d.toString("base64"), "base64"] };
  };
  let helper = null;
  globalThis.fetch = async (u, init) => {
    const url = new URL(String(u));
    if (url.host === helperHost) return helper(url, init);
    if (!hosts.has(url.host)) {
      log(`copy: refused a request to ${url.host} (the copy reaches only its own RPC)`);
      throw new Error(`copy: no request leaves the copy (${url.host})`);
    }
    let body = null;
    try {
      body = JSON.parse(String(init?.body ?? ""));
    } catch {}
    if (body?.method === "sendTransaction") {
      try {
        const signature = base58.encode(Buffer.from(String(body.params?.[0]), "base64").subarray(1, 65));
        sent.push({ phase: bundlePhase.get(signature) ?? phase(), signature });
      } catch {}
    }
    const r = await native(u, init);
    if (body?.method === "simulateTransaction" || (plantCurve && (body?.method === "getMultipleAccounts" || body?.method === "getAccountInfo"))) {
      const j = await r.clone().json().catch(() => null);
      const v = j?.result?.value;
      if (body.method === "simulateTransaction" && v && v.err !== null && v.err !== undefined) {
        simFails.push({ phase: phase(), err: v.err, cu: v.unitsConsumed ?? null, logsTail: (v.logs ?? []).slice(-12) });
        log(`copy: simulation failed in ${phase()}: ${JSON.stringify(v.err)}; ${(v.logs ?? []).slice(-6).join(" | ")}`);
      }
      if (plantCurve && j?.result && body.method !== "simulateTransaction") {
        const keys = body.method === "getMultipleAccounts" ? body.params[0] : [body.params[0]];
        const at = keys.indexOf(plantCurve);
        if (at >= 0) {
          if (body.method === "getMultipleAccounts") j.result.value[at] = clearMayhem(j.result.value[at]);
          else j.result.value = clearMayhem(j.result.value);
          return new Response(JSON.stringify(j), { status: r.status, headers: { "content-type": "application/json" } });
        }
      }
    }
    return r;
  };
  const rpcs = [testnetRpc(COPY.rpcs[0]), testnetRpc(COPY.rpcs[1])];
  // the helper's sender, cluster mainnet, on the copy: its fee is the kit's for the copy's rent, as the host sets it
  const providers = [solanaJsonRpc(COPY.rpcs[0]), solanaJsonRpc(COPY.rpcs[1])];
  const fee = solanaPoolFee(await readSolanaRent(providers));
  const plain = (b64) => providers[0]("sendTransaction", [b64, { encoding: "base64", skipPreflight: true, maxRetries: 0 }]);
  const ENGINE = "http://engine-stand-in.localhost"; // a name only: the stand-in never fetches
  const engine = COPY.engine ?? "lands";
  const engineCalls = [];
  const jito = {
    intervalMs: 1_000,
    send: async (b64) => {
      engineCalls.push({ at: Date.now(), call: "send", mode: engine });
      if (engine === "busy") return { kind: "busy", detail: "the stand-in is busy", throttled: false };
      if (engine === "refused") return { kind: "refused", detail: "the stand-in refused it" };
      if (engine === "lands") await plain(b64);
      return { kind: "ok", region: ENGINE, bundleId: "stand-in" };
    },
    rebroadcast: async (_region, b64) => {
      engineCalls.push({ at: Date.now(), call: "rebroadcast", mode: engine });
      if (engine === "lands") await plain(b64).catch(() => {});
      return { kind: "ok", detail: "the stand-in" };
    },
    status: async () => (engineCalls.push({ at: Date.now(), call: "status", mode: engine }), engine === "lands" ? "landed" : "pending"),
    // a buy's pieces and the helper's tip, one bundle (card buy-spends-several-pieces): kept whole in engineCalls
    sendBundle: async (b64s) => {
      for (const b of b64s) bundlePhase.set(base58.encode(Buffer.from(b, "base64").subarray(1, 65)), phase());
      engineCalls.push({ at: Date.now(), call: "sendBundle", mode: engine, txs: b64s.length, signatures: b64s.map((b) => base58.encode(Buffer.from(b, "base64").subarray(1, 65))) });
      if (engine === "busy") return { kind: "busy", detail: "the stand-in is busy", throttled: false };
      if (engine === "refused") return { kind: "refused", detail: "the stand-in refused it" };
      if (engine === "lands") for (const b of b64s) await landed(await plain(b));
      return { kind: "ok", region: ENGINE, bundleId: "stand-in" };
    },
    rebroadcastBundle: async () => (engineCalls.push({ at: Date.now(), call: "rebroadcastBundle", mode: engine }), { kind: "ok", detail: "the stand-in" }),
  };
  /** A plain copy read confirmed on the copy (the next of a bundle needs it), or failed: up to 30 s. */
  const landed = async (sig) => {
    for (let i = 0; i < 60; i++) {
      const st = (await providers[0]("getSignatureStatuses", [[sig]])).value[0];
      if (st?.err) return;
      if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") return;
      await new Promise((r) => setTimeout(r, 500));
    }
  };
  const sender = solanaPoolSender({ cluster: "mainnet", program: PIN.program, feePayerSecret: secret, fee: String(fee) }, { providers, jito, tipFloor: async () => null, log: (l) => log(`helper: ${l}`) });
  await sender.ready;
  const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  helper = async (url, init) => {
    const method = init?.method ?? "GET";
    let r;
    if (url.pathname === "/v1/pool/fee") {
      const epoch = url.searchParams.get("epoch");
      r = url.searchParams.get("pool") !== sender.pool ? json(404, { error: { code: "not_found" } }) : json(200, await sender.fee(epoch ? Number(epoch) : Date.now()));
    } else if ((url.pathname === "/v1/pool/solana/send" || url.pathname === "/v1/pool/solana/pieces") && method === "POST") {
      const pieces = url.pathname === "/v1/pool/solana/pieces";
      const began = performance.now();
      const body = JSON.parse(String(init.body));
      const a = body?.pool === sender.pool ? await (pieces ? sender.carryPieces(body, "copy") : sender.carry(body, "copy")) : { status: 404, body: { error: { code: "not_found" } } };
      r = json(a.status, a.body, a.retryAfterS === undefined ? {} : { "retry-after": String(a.retryAfterS) });
      const line = poolSendLine({ chain: "solana", net: sender.cluster, route: pieces ? "pieces" : "send", status: a.status, body: a.body, ms: performance.now() - began, note: a.note });
      sendLines.push({ phase: phase(), line });
      log(`helper: ${line}`);
    } else {
      r = json(404, { error: { code: "not_found" } });
      log(`copy helper: ${method} ${url.pathname} is not served on the copy (404)`);
    }
    return r;
  };
  log(`copy: the mainnet build on ${COPY.rpcs.join(" and ")}; pool ${sender.pool}; fee payer ${PIN.feePayer}; fee ${fee}; engine stand-in ${engine}`);
  return { rpcs, pin: PIN, holdings: (r) => solanaHoldingsAt(COPY.rpcs[0]), simFails, sent, planted, fee, sendLines, engine, engineCalls };
}

/** Funds `to` with `lamports` by the copy's own airdrop, read back finalized (the page reads a deposit's source there). */
export async function copyAirdrop(rpc, to, lamports) {
  const sig = await rpc("requestAirdrop", [to, Number(lamports), { commitment: "confirmed" }]);
  for (let i = 0; i < 120; i++) {
    const st = (await rpc("getSignatureStatuses", [[sig]])).value[0];
    if (st?.err) throw new Error(`airdrop to ${to} failed: ${JSON.stringify(st.err)}`);
    if (st?.confirmationStatus === "finalized") return sig;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`airdrop to ${to} not finalized`);
}
