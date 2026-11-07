// Audit V-01 (Pillow Auditors v1.0, 7 Nov, at 46b16ca4) as a world for the deposit follow with bind.ts itself (card
// wallet-near-prepay-taken): the relayer's storage_prepay(P) puts P on chain before U's call, a stranger who reads it
// sends the 1 USDC minimum naming P first, U's call panics PrecommitmentAlreadyUsed in the vault and USDC refunds U in
// full (contracts/vault/src/deposit.rs:108-110; poc/audit_v01.rs on the shipped bytes).
//
// The chain is a mock behind the testnet pair: U's reads are test/vectors/deposit-account.json's real answers
// (replay-deposit-reads.ts), the vault's pages test/vectors/deposit-bind-pages.json's real testnet pages with the rows
// the world writes, 1Click's status the recorded live answer's quoteResponse with this world's address and U. The relayer
// decodes every body with the helper's own decoder (apps/helper/src/bind/checks.ts) and runs the helper's order: R2's
// prepay_open while U has a prepay no deposit used, then storage_prepay(P), then U's call. The vault's rule is the
// shipped one: the depositor is the message's word, so a stranger may name U (deposit.rs:80-93).
import { readFileSync } from "node:fs";
import { base58 } from "@scure/base";
import { decodeSignedDelegate } from "../../../apps/helper/src/bind/checks.ts";
import { NEAR_NETWORKS, type NearRpc } from "../src/deposit/account.ts";
import { RELEASE_BIND_URL } from "../src/deposit/delegate.ts";
import { DEPOSIT_STATUS_URL, type FollowRpc } from "../src/deposit/follow.ts";
import { replayDepositReads } from "./replay-deposit-reads.ts";

const PAGES = JSON.parse(readFileSync(new URL("./vectors/deposit-bind-pages.json", import.meta.url), "utf8"));
const LIVE = JSON.parse(readFileSync(new URL("../../kit/test/fixtures/oneclick-quotes.json", import.meta.url), "utf8")).live.answer;
export const NET = NEAR_NETWORKS.testnet;
export const ADDR = LIVE.quote.depositAddress as string;
/** The live quote's amountOut: what 1Click delivered to U. */
export const CREDIT = 2_003_117n;
export const DEADLINE = Date.parse(LIVE.quote.deadline);
/** The checked quote's min_amount_out, 1983085. */
export const MIN_OUT = LIVE.quote.minAmountOut as string;
export const ORIGIN = LIVE.quoteRequest.originAsset as string;
/** The vault's MIN_DEPOSIT: the stranger's cheapest take (1 USDC). */
export const ONE_USDC = 1_000_000n;
const publicKeyOf = (u: string) => `ed25519:${base58.encode(Uint8Array.from(u.match(/../g)!, (h) => parseInt(h, 16)))}`;

type Row = { index: number; precommitment: string; label: string; value: string; leaf_index: number; depositor: string };
/** A stranger who reads the relayer's prepays and takes the first one: its message names `depositor` (any account, U too). */
export type Stranger = { depositor: string; value: bigint };
/** One call the relayer heard: U's nonce, its P and amount; what came of it. */
export type Carried = { nonce: bigint; p: bigint; amount: bigint; fate: "landed" | "refunded" | "prepay_open" };

export class V01World {
  readonly u: string;
  height = 275753808n;
  nonce = 275753000000001n;
  rows: Row[] = [];
  /** U's USDC on the token. */
  balance = 0n;
  timeMs = DEADLINE - 3_600_000;
  /** storage_prepay records no deposit has used, by P, and every prepay in order. */
  prepaid = new Set<string>();
  prepays: bigint[] = [];
  carried: Carried[] = [];
  stranger: Stranger | null;
  /** The stranger's own USDC that went into the vault. */
  strangerPaid = 0n;
  constructor(u: string, stranger: Stranger | null) {
    this.u = u;
    this.stranger = stranger;
  }
  tick() {
    this.height++;
  }
  private addRow(p: bigint, depositor: string, value: bigint) {
    const index = this.rows.length;
    this.rows.push({ index, precommitment: p.toString(), label: (1000n + BigInt(index)).toString(), value: value.toString(), leaf_index: 2 * index, depositor });
  }
  private used = (p: bigint) => this.rows.some((r) => r.precommitment === p.toString());

  /** The relayer's POST /v1/bind: R2, then storage_prepay(P) (P on chain: the stranger's turn), then U's call. */
  private bind(body: string): Response {
    const dl = decodeSignedDelegate(new Uint8Array(Buffer.from(JSON.parse(body).signed_delegate, "base64")));
    const fc = dl.actions[0] as { args: Uint8Array };
    const args = JSON.parse(Buffer.from(fc.args).toString());
    const p = BigInt(JSON.parse(args.msg).precommitment);
    const amount = BigInt(args.amount);
    this.height++; // the hop to the relayer and back takes a block
    // R2: one prepay per U that no deposit has used (the helper's prepay_open)
    if ([...this.prepaid].some((k) => k !== p.toString())) {
      this.carried.push({ nonce: dl.nonce, p, amount, fate: "prepay_open" });
      return Response.json({ error: { code: "prepay_open" } }, { status: 409 });
    }
    if (!this.used(p) && !this.prepaid.has(p.toString())) (this.prepaid.add(p.toString()), this.prepays.push(p));
    // P is public now: the stranger's 1 USDC naming P lands first and uses the prepaid record
    if (this.stranger !== null && this.prepaid.has(p.toString())) {
      this.addRow(p, this.stranger.depositor, this.stranger.value);
      this.prepaid.delete(p.toString());
      this.strangerPaid += this.stranger.value;
      this.stranger = null;
    }
    // U's call: the Delegate runs (U's nonce used); the vault refuses a used P and USDC refunds U in full
    this.nonce = dl.nonce;
    if (this.used(p)) this.carried.push({ nonce: dl.nonce, p, amount, fate: "refunded" });
    else {
      this.addRow(p, this.u, amount);
      this.prepaid.delete(p.toString());
      this.balance -= amount;
      this.carried.push({ nonce: dl.nonce, p, amount, fate: "landed" });
    }
    return Response.json({ tx_hash: base58.encode(new Uint8Array(32).fill(this.carried.length)) });
  }

  /** The helper's routes this world answers: 1Click's status (SUCCESS, the live answer) and POST /v1/bind. */
  fetchFn = (async (url: string, init?: RequestInit) => {
    if (url.startsWith(DEPOSIT_STATUS_URL)) {
      const q = structuredClone(LIVE);
      q.quote.depositAddress = ADDR;
      q.quoteRequest.recipient = q.quoteRequest.refundTo = this.u;
      q.quoteRequest.refundType = "INTENTS";
      return Response.json({ correlationId: "f7c38c72-b112-42fd-986f-9705977fcf61", quoteResponse: q, status: "SUCCESS", swapDetails: {}, updatedAt: "2026-10-31T21:06:00.000Z" });
    }
    if (url === RELEASE_BIND_URL) return this.bind(init!.body as string);
    throw new Error(`no route ${url}`);
  }) as typeof fetch;

  rpcs(): [FollowRpc, FollowRpc] {
    const replay = replayDepositReads("testnet", publicKeyOf(this.u));
    const side = (k: 0 | 1, r: NearRpc): FollowRpc => ({
      name: r.name,
      tx: async () => ({ jsonrpc: "2.0", id: "x", error: { name: "HANDLER_ERROR", cause: { name: "TIMEOUT_ERROR" } } }),
      block: async () => ({ jsonrpc: "2.0", id: "x", result: { header: { height: Number(this.height + BigInt(k)), timestamp_nanosec: (BigInt(this.timeMs) * 1_000_000n).toString() } } }),
      query: async (params) => {
        const height = this.height + BigInt(k);
        const at = params.block_id === undefined ? height : BigInt(params.block_id as number);
        if (at > height) return { jsonrpc: "2.0", id: "x", error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_BLOCK" } } };
        const stamp = (j: any) => ((j.result.block_height = Number(at)), (j.result.block_hash = `h${at}`), j);
        if (params.method_name === "deposits" || params.method_name === "state_tree" || params.method_name === "label_tree") {
          const j = structuredClone(PAGES.answers[k === 0 ? "a" : "b"].json);
          if (params.method_name === "deposits") {
            const { from, limit } = JSON.parse(Buffer.from(params.args_base64 as string, "base64").toString());
            j.result.result = [...Buffer.from(JSON.stringify(this.rows.slice(from, from + limit)))];
          } else j.result.result = [...Buffer.from(JSON.stringify({ size: this.rows.length, depth: 20, root: "0" }))];
          return stamp(j);
        }
        if (params.method_name === "mt_balance_of") return stamp({ jsonrpc: "2.0", id: "x", result: { result: [...Buffer.from(JSON.stringify("0"))], logs: [] } });
        const j = stamp((await r.query(params)) as any);
        if (params.request_type === "view_access_key_list") {
          j.result.keys[0].public_key = publicKeyOf(this.u);
          j.result.keys[0].access_key.nonce = Number(this.nonce);
        }
        if (params.method_name === "ft_balance_of") j.result.result = [...Buffer.from(JSON.stringify(this.balance.toString()))];
        return j;
      },
    });
    return [side(0, replay[0]), side(1, replay[1])];
  }
}
