// A leftover's carry to Cash on Solana (card leftovers-carry-to-cash): the wallet (U_X = U_{s,i}, or W = W_{sol,l,j})
// sends everything it holds less the one signature's fee to Cash's deposit address in one System transfer, so it is left
// empty (a System account is never left under rent). Its lamports alike on both RPCs; the message checked by the rule
// (rules/pool.ts checkSolanaCashCarry) and simulated on both before the wallet signs; the send recorded (keep) before it
// leaves for both RPCs; then read on both. A reload reads a recorded send first: landed once both read it finalized with
// no error; dead once both are past its blockhash's last valid height with neither knowing it; pending otherwise.
// Every read names the wallet alone or the deposit address. Nothing logs.
import { base58, base64 } from "@scure/base";
import { depositId, freshWallet } from "../../wallet/src/derive/keys.ts";
import { solanaCompileV0 } from "../../kit/src/trade/solana/build.ts";
import { SOLANA_LAMPORTS_PER_SIGNATURE, SOLANA_SYSTEM_PROGRAM } from "../../kit/src/checks/solana/checks.ts";
import type { SolanaRpc } from "../../kit/src/trade/solana/send.ts";
import { checkSolanaCashCarry, signSolana } from "./rules/pool.ts";
import type { CarryEnd, CarryOpen, CarrySender, CarrySource } from "./carry-cash.ts";

export type SolCarryHost = {
  rpcs: readonly [SolanaRpc, SolanaRpc];
  /** The 64-byte seed; zeroed here once the key is derived. */
  seed64(): Promise<Uint8Array>;
  now?(): number;
};

const u32le = (v: number): number[] => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];
const u64le = (v: bigint): number[] => Array.from({ length: 8 }, (_, i) => Number((v >> BigInt(8 * i)) & 255n));
const int = (v: unknown): number => {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) throw new Error("not a count");
  return v;
};

async function lamportsOf(rpc: SolanaRpc, address: string): Promise<bigint> {
  const r = (await rpc("getBalance", [address, { commitment: "finalized" }])) as { value?: unknown } | null;
  return BigInt(int(r?.value));
}

/** The wallet's key, derived for one signature; its address must be the source's. */
function keyOf(seed64: Uint8Array, src: CarrySource): { address: string; secretKey: Uint8Array } {
  if (src.kind === "w") {
    const w = freshWallet(seed64, "sol", BigInt(src.l), src.j);
    return { address: w.address, secretKey: w.secretKey };
  }
  const k = depositId(seed64, BigInt(src.s), src.i);
  return { address: base58.encode(k.publicKey), secretKey: k.secretKey };
}

export function solCashCarrySender(h: SolCarryHost): CarrySender {
  const { rpcs } = h;
  const both = <T>(f: (r: SolanaRpc) => Promise<T>): Promise<[T, T]> => Promise.all([f(rpcs[0]), f(rpcs[1])]);
  const lamports = async (address: string): Promise<bigint | null> => {
    const [a, b] = await both((r) => lamportsOf(r, address));
    return a === b ? a : null;
  };
  // a recorded send: landed, dead or pending
  const verdict = async (open: CarryOpen): Promise<CarryEnd> => {
    const sigs = open.sends.map((s) => s.hash);
    const reads = await both(async (r) => ((await r("getSignatureStatuses", [sigs, { searchTransactionHistory: true }])) as { value?: unknown[] } | null)?.value ?? []);
    for (let i = 0; i < sigs.length; i++) {
      const s = reads.map((v) => v[i] as { err?: unknown; confirmationStatus?: unknown } | null | undefined);
      if (s.every((x) => x && x.err === null && x.confirmationStatus === "finalized")) return "landed";
    }
    if (reads.some((v) => v.some((x) => x !== null && x !== undefined))) return "pending";
    const last = Math.max(...open.sends.map((s) => Number(s.lastValid ?? "0")));
    const heights = await both(async (r) => int(await r("getBlockHeight", [{ commitment: "finalized" }])));
    return heights.every((x) => x > last) ? "dead" : "pending";
  };
  return {
    sendable: async (src) => {
      const l = await lamports(src.address).catch(() => null);
      if (l === null) return null;
      return l > SOLANA_LAMPORTS_PER_SIGNATURE ? l - SOLANA_LAMPORTS_PER_SIGNATURE : 0n;
    },
    send: async (src, open, keep) => {
      let key: Uint8Array | null = null;
      try {
        if (open.sends.length > 0) {
          const v = await verdict(open);
          if (v !== "dead") return v;
          // dead: nothing of it can land; a new send only on a new quote (the sequencer asks again)
          return "dead";
        }
        const amount = BigInt(open.amount);
        const l = await lamports(src.address);
        if (l === null) return "fault";
        if (l - SOLANA_LAMPORTS_PER_SIGNATURE !== amount) return "short";
        const bh = (await rpcs[0]("getLatestBlockhash", [{ commitment: "finalized" }])) as { value?: { blockhash?: unknown; lastValidBlockHeight?: unknown } } | null;
        const blockhash = bh?.value?.blockhash;
        if (typeof blockhash !== "string") return "fault";
        const lastValid = int(bh!.value!.lastValidBlockHeight);
        const ix = { program: SOLANA_SYSTEM_PROGRAM, accounts: [{ key: src.address, signer: true, writable: true }, { key: open.to, signer: false, writable: true }], data: Uint8Array.from([...u32le(2), ...u64le(amount)]) };
        const { message } = solanaCompileV0(src.address, [ix], blockhash, []);
        const wire = new Uint8Array(1 + 64 + message.length);
        wire[0] = 1;
        wire.set(message, 65);
        const fees = await both(async (r) => BigInt(int(((await r("getFeeForMessage", [base64.encode(message), { commitment: "confirmed" }])) as { value?: unknown } | null)?.value)));
        if (fees[0] !== SOLANA_LAMPORTS_PER_SIGNATURE || fees[1] !== SOLANA_LAMPORTS_PER_SIGNATURE) return "fault";
        checkSolanaCashCarry(wire, { wallet: src.address, to: open.to, amount, lamports: l, blockhash });
        const sims = await both(async (r) => ((await r("simulateTransaction", [base64.encode(wire), { encoding: "base64", sigVerify: false, replaceRecentBlockhash: false, commitment: "confirmed" }])) as { value?: { err?: unknown } } | null)?.value);
        if (!sims.every((v) => v !== undefined && v !== null && v.err === null)) return "fault";
        const seed = await h.seed64();
        let k: { address: string; secretKey: Uint8Array };
        try {
          k = keyOf(seed, src);
        } finally {
          seed.fill(0);
        }
        key = k.secretKey;
        if (k.address !== src.address) return "fault";
        const sig = signSolana(key, wire);
        key.fill(0);
        key = null;
        const signed = wire.slice();
        signed.set(sig, 1);
        // recorded before it leaves: a write that fails sends nothing
        await keep({ ...open, sends: [...open.sends, { hash: base58.encode(sig), value: amount.toString(), sentMs: String(h.now?.() ?? Date.now()), lastValid: String(lastValid) }] });
        await Promise.allSettled(rpcs.map((r) => r("sendTransaction", [base64.encode(signed), { encoding: "base64", preflightCommitment: "confirmed" }])));
        return "pending";
      } catch {
        return "fault";
      } finally {
        key?.fill(0);
      }
    },
  };
}
