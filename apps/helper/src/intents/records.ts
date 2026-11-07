// The records POST /v1/intents reads (card helper-id-intents; markets.md H4.3, the paragraph "The ids' intents on
// /v1/intents"): what our helper saw of 1Click, and what each signer has cost the relayer.
//
// - A quote record: a live 1Click quote our proxy carried (POST /v1/proxy/oneclick/v0/quote, read with our key), as
//   1Click answered it: its signed deposit address, recipient, refundTo, their types, its depositType and deadline.
//   Only 1Click's answer is read, never the device's request: the answer echoes the request 1Click signed.
// - A seen signer (the gate): a NEAR account that a 1Click status answer our proxy carried shows money delivered to
//   (SUCCESS: the quote's recipient) or refunded to (REFUNDED: its refundTo), for a deposit address we hold a quote
//   record of. The signer is taken from our own record, never from the status answer, so an answer cannot name a
//   signer the quote did not.
// - A signer record: its failed sends (three strike it, kept across a restart as R7 keeps U's count) and its one paid
//   receiver registration.
//
// One directory owned by one process (store/durable.ts: the lock, whole durable writes). Each file is named by the
// sha256 of what it is for, so no caller's text is ever a file name.
import { createHash } from "node:crypto";
import * as nodeFs from "node:fs";
import { openDurableDir, type DurableDir, type StoreFs } from "../store/durable.ts";
import type { TxRef } from "../bind/send.ts";
import { isAccountId } from "../withdraw/checks.ts";

/** The most of a 1Click answer read (quote or status): a few KB each (bind/create.ts STATUS_ANSWER_MAX). */
export const ONECLICK_ANSWER_MAX = 65_536;
/** A quote record is kept this long past its deadline: a refund comes after the deadline, and its status read after it. */
export const QUOTE_KEEP_MS = 30 * 24 * 3_600_000;

export type QuoteRecord = {
  deposit_address: string;
  recipient: string;
  recipient_type: string;
  refund_to: string;
  refund_type: string;
  deposit_type: string;
  /** The quote's own deadline (unix ms). */
  deadline_ms: number;
};

/** Failed sends that strike a signer on this endpoint (bind/send.ts MAX_FAILED_SENDS, R3's three). */
export const STRUCK_AT = 3;

/** The registration the relayer pays a signer, once: pending while its storage_deposit is out, landed once it ran. */
export type Registration = { receiver: string; state: "pending" | "landed"; tx: TxRef | null };
export type SignerRecord = { signer: string; failed: number; registration: Registration | null };

export type IntentsStore = {
  quote(depositAddress: string): QuoteRecord | null;
  putQuote(q: QuoteRecord): void;
  seen(signer: string): boolean;
  /** Marks `signer` seen, durable before it returns. */
  see(signer: string): void;
  signer(signer: string): SignerRecord;
  putSigner(rec: SignerRecord): void;
  close(): void;
};

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const PLAIN = /^[A-Za-z0-9._:-]{1,128}$/;
const h = (s: string) => createHash("sha256").update(s).digest("hex");

function parse(body: string): Record<string, unknown> | null {
  if (typeof body !== "string" || body.length > ONECLICK_ANSWER_MAX) return null;
  try {
    const a: unknown = JSON.parse(body);
    return isObj(a) ? a : null;
  } catch {
    return null;
  }
}

/**
 * A 1Click quote answer's record, or null: a live quote (quoteRequest.dry false) with a plain deposit address, a
 * recipient and a refundTo of at most 128 plain characters, their types, its depositType, and a deadline that parses.
 * `quoteResponse`-shaped: the /v0/quote answer itself, or a status answer's quoteResponse.
 */
export function quoteOf(q: unknown): QuoteRecord | null {
  if (!isObj(q) || !isObj(q.quoteRequest) || !isObj(q.quote)) return null;
  const req = q.quoteRequest;
  const quote = q.quote;
  if (req.dry !== false) return null;
  const fields = [quote.depositAddress, req.recipient, req.recipientType, req.refundTo, req.refundType, req.depositType];
  if (!fields.every((f) => typeof f === "string" && PLAIN.test(f))) return null;
  const deadline = typeof quote.deadline === "string" ? Date.parse(quote.deadline) : NaN;
  if (!Number.isSafeInteger(deadline) || deadline <= 0) return null;
  const [deposit_address, recipient, recipient_type, refund_to, refund_type, deposit_type] = fields as string[];
  return { deposit_address: deposit_address!, recipient: recipient!, recipient_type: recipient_type!, refund_to: refund_to!, refund_type: refund_type!, deposit_type: deposit_type!, deadline_ms: deadline };
}

/** The proxy carried a 1Click /v0/quote answer (`body`, as the device got it): a live quote is recorded. */
export function onQuoteAnswer(body: string, store: Pick<IntentsStore, "quote" | "putQuote">): QuoteRecord | null {
  const q = quoteOf(parse(body));
  if (q === null) return null;
  // a deposit address names one quote: the first record kept, never replaced by a later answer
  if (store.quote(q.deposit_address) !== null) return null;
  store.putQuote(q);
  return q;
}

/**
 * The proxy carried a 1Click /v0/status answer: when it says SUCCESS or REFUNDED for a deposit address we hold a quote
 * record of, the record's recipient (SUCCESS) or refundTo (REFUNDED) is seen, when it is a NEAR account id. The signer
 * seen, or null.
 */
export function onStatusAnswer(body: string, store: Pick<IntentsStore, "quote" | "see">): string | null {
  const a = parse(body);
  if (a === null || (a.status !== "SUCCESS" && a.status !== "REFUNDED") || !isObj(a.quoteResponse) || !isObj(a.quoteResponse.quote)) return null;
  const address = a.quoteResponse.quote.depositAddress;
  if (typeof address !== "string" || !PLAIN.test(address)) return null;
  const rec = store.quote(address);
  if (rec === null) return null;
  const who = a.status === "SUCCESS" ? rec.recipient : rec.refund_to;
  if (!isAccountId(who)) return null;
  store.see(who);
  return who;
}

/** The store under `dir` (one process holds it: store/durable.ts). Quote records past QUOTE_KEEP_MS are swept at open. */
export function createIntentsStore(dir: string, fs: StoreFs = nodeFs, now: () => number = Date.now): IntentsStore {
  return openDurableDir(dir, fs, (d) => storeOn(d, now()));
}

function storeOn(d: DurableDir, at: number): IntentsStore {
  const read = <T>(name: string): T | null => {
    const t = d.text(name);
    if (t === null) return null;
    try {
      return JSON.parse(t) as T;
    } catch {
      return null;
    }
  };
  for (const f of d.names()) {
    if (!/^q-[0-9a-f]{64}\.json$/.test(f)) continue;
    const q = read<QuoteRecord>(f);
    if (q !== null && typeof q.deadline_ms === "number" && q.deadline_ms + QUOTE_KEEP_MS < at) d.remove(f);
  }
  const qName = (a: string) => `q-${h(a)}.json`;
  const gName = (s: string) => `g-${h(s)}.json`;
  const sName = (s: string) => `s-${h(s)}.json`;
  return {
    quote(a) {
      const q = read<QuoteRecord>(qName(a));
      return q !== null && q.deposit_address === a ? q : null;
    },
    putQuote(q) {
      d.held();
      d.createOnce(qName(q.deposit_address), JSON.stringify(q));
    },
    seen: (s) => read<{ signer: string }>(gName(s))?.signer === s,
    see(s) {
      d.held();
      d.createOnce(gName(s), JSON.stringify({ signer: s }));
    },
    signer(s) {
      const name = sName(s);
      if (d.text(name) === null) return { signer: s, failed: 0, registration: null };
      const r = read<SignerRecord>(name);
      // a record there that does not read is struck, its registration used: failing closed, never a fresh count
      return r !== null && r.signer === s && Number.isSafeInteger(r.failed) ? r : { signer: s, failed: STRUCK_AT, registration: { receiver: "", state: "landed", tx: null } };
    },
    putSigner(rec) {
      d.held();
      d.replace(sName(rec.signer), JSON.stringify(rec));
    },
    close: () => d.close(),
  };
}
