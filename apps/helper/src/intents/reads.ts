// POST /v1/intents's chain reads on the release's two NEAR providers (carry.ts IntentsReads): every read on both, and
// a read that fails or disagrees decides nothing.
import type { HelperSignedIntent } from "@blindfill/kit";
import type { Rpc } from "../bind/send.ts";
import { agreedBlock, viewAt } from "../withdraw/fee.ts";
import { INTENTS_CONTRACT, type IntentsReads } from "./carry.ts";

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const NS = /^(0|[1-9][0-9]{0,19})$/;

export function intentsReads(rpcs: readonly [Rpc, Rpc], now: () => number = Date.now): IntentsReads {
  return {
    async finalMs() {
      const ms = await Promise.all(
        rpcs.map(async (r) => {
          const a = await r("block", { finality: "final" });
          const ns = isObj(a) && isObj(a.header) ? a.header.timestamp_nanosec : undefined;
          if (typeof ns !== "string" || !NS.test(ns)) throw new Error("final block: no timestamp_nanosec");
          return BigInt(ns) / 1_000_000n;
        }),
      );
      return ms[0]! > ms[1]! ? ms[0]! : ms[1]!;
    },
    async simulate(signed: HelperSignedIntent) {
      try {
        const b = await agreedBlock(rpcs, now);
        // viewAt: both providers ran the view at block b and answered the same bytes; a refusal is an error on either.
        // The answer (read on rpc.mainnet.fastnear.com and near.drpc.org for {signed: []} at blocks 223501912-3,
        // 2026-11-07 18:12Z): {intents_executed, logs, min_deadline, state}, with invariant_violated only when one is
        // violated. Ours ran when it executed exactly the one intent and violated nothing.
        const out = await viewAt(rpcs, b, INTENTS_CONTRACT, "simulate_intents", { signed: [signed] });
        return isObj(out) && Array.isArray(out.intents_executed) && out.intents_executed.length === 1 && (out.invariant_violated === null || out.invariant_violated === undefined);
      } catch {
        return false;
      }
    },
    async storage(token, account) {
      const b = await agreedBlock(rpcs, now);
      const s = await viewAt(rpcs, b, token, "storage_balance_of", { account_id: account });
      if (s === null) return "none";
      if (isObj(s) && typeof s.total === "string" && /^(0|[1-9][0-9]{0,38})$/.test(s.total)) return "registered";
      throw new Error("storage_balance_of: neither null nor a balance");
    },
  };
}
