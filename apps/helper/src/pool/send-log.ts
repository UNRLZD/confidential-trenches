// One log line per pool send (card sol-pool-buy-lands-on-mainnet): POST /v1/pool/solana/send, /v1/pool/evm/send and
// /v1/pool/evm/sell each write one line when they answer, so a send that did not land can be read without the user's
// browser. The line holds codes, counts and times only: never a signature, an address, a nullifier, a bundle id, the
// caller's address or any text a block engine or an RPC wrote (M374 (1), M369 (H1)). A Solana simulation's error is the
// one exception, as simErrText below keeps it: the error's shape with every free text dropped.

/** What a sender adds to its answer for the log line; the route reads it and never sends it to the caller. */
export type PoolSendNote = {
  /** The pool instruction's tag (Solana: 2 a release, 3 a release and buy). */
  tag?: 2 | 3;
  /** How it went out: a Jito bundle-only send, or a plain send to the RPCs. */
  via?: "jito" | "plain";
  /** A Jito first send that no region took: every region busy, one refused it, or every region failed on transport
   *  (then the plain send). */
  first?: "busy" | "throttled" | "refused" | "transport" | "queued";
  /** The region (its host's first label) whose block engine took the first send. */
  region?: string;
  /** Whether that engine named the bundle it made (its x-bundle-id header). */
  bundle?: boolean;
  /** The send's end as the two providers read it, where the answer waited for it. */
  end?: "filled" | "failed" | "expired" | "unknown";
  /** Rebroadcasts the region took, and those it did not (its second taken, a refusal, a timeout). */
  rebroadcasts?: number;
  misses?: number;
  /** The block engine's word on the bundle after a send that did not fill (getInflightBundleStatuses), or unread. */
  status?: "landed" | "pending" | "failed" | "invalid" | "unread";
  /** A simulation's error, simErrText's. */
  err?: string;
  /** The engine's word on the bundle about 3 s after the first send (unread, or none when another carry was in progress). */
  engine3?: "landed" | "pending" | "failed" | "invalid" | "unread";
  /** The plain copies the providers took (sent at once beside the bundle). */
  plain?: number;
  /** How long the transaction's own blockhash stayed valid after it arrived, ms; `>n` when still valid at the end. */
  hashMs?: string;
  /** For a send that did not fill: the same bytes simulated at the end on a fresh blockhash, ok or simErrText's. */
  endSim?: string;
  /** A tag 3's Jito tip as W signed it, lamports (card owners-solana-buy-lands). */
  tip?: string;
};

/** The error's code word and, for not_landed, its end; "sent" for a 200 whose end the answer did not wait for. */
function outcomeOf(status: number, body: unknown, note: PoolSendNote | undefined): string {
  const code = (body as { error?: { code?: unknown } } | null)?.error?.code;
  if (typeof code === "string" && /^[a-z_]{1,32}$/.test(code)) return code;
  if (status === 200) return note?.end ?? "sent";
  return "other";
}

const word = /^[a-z0-9_-]{1,32}$/;

/** The line: `pool send <chain> <net> <route> outcome=<code> status=<n> ms=<n>`, then the note's fields that are set. */
export function poolSendLine(l: { chain: "solana" | "evm" | "unknown"; net: string; route: "send" | "sell" | "pieces"; status: number; body: unknown; ms: number; note?: PoolSendNote }): string {
  const n = l.note ?? {};
  const out = [`pool send ${l.chain} ${word.test(l.net) ? l.net : "?"} ${l.route}`, `outcome=${outcomeOf(l.status, l.body, l.note)}`, `status=${l.status}`, `ms=${Math.max(0, Math.round(l.ms))}`];
  if (n.tag !== undefined) out.push(`tag=${n.tag}`);
  if (n.tip !== undefined && /^\d{1,20}$/.test(n.tip)) out.push(`tip=${n.tip}`);
  if (n.via !== undefined) out.push(`via=${n.via}`);
  if (n.first !== undefined) out.push(`first=${n.first}`);
  if (n.region !== undefined && word.test(n.region)) out.push(`region=${n.region}`);
  if (n.bundle !== undefined) out.push(`bundle=${n.bundle ? "named" : "unnamed"}`);
  if (n.end !== undefined) out.push(`end=${n.end}`);
  if (n.rebroadcasts !== undefined) out.push(`rebroadcasts=${n.rebroadcasts}`);
  if (n.misses !== undefined) out.push(`misses=${n.misses}`);
  if (n.engine3 !== undefined) out.push(`engine3=${n.engine3}`);
  if (n.status !== undefined) out.push(`engine=${n.status}`);
  if (n.plain !== undefined) out.push(`plain=${n.plain}`);
  if (n.hashMs !== undefined && /^>?\d{1,9}$/.test(n.hashMs)) out.push(`hash_ms=${n.hashMs}`);
  // ok, unread, or a shape simErrText gives back unchanged (variant names, keys, two small integers, "?"); else dropped
  if (n.endSim !== undefined && (n.endSim === "ok" || n.endSim === "unread" || isErrShape(n.endSim))) out.push(`end_sim=${n.endSim}`);
  if (n.err !== undefined) out.push(`err=${n.err}`);
  return out.join(" ");
}

/** A region's name for the line: the first label of its block engine's host ("frankfurt"), else "?". */
export function regionName(url: string): string {
  try {
    const label = new URL(url).hostname.split(".")[0] ?? "";
    return word.test(label) ? label : "?";
  } catch {
    return "?";
  }
}

// A Solana TransactionError (JSON as simulateTransaction gives it) names an account only by its index in the message
// (InstructionError [index, ...], InsufficientFundsForRent { account_index }, ProgramExecutionTemporarilyRestricted
// { account_index }); its words are the enum's variant names. The one free text a variant may carry is a program's
// (BorshIoError's string, a program's own message), so every string that is not a variant name (CamelCase letters,
// each capital followed by lower case, at most 48) and every key that is neither that nor snake_case is dropped as "?".
const VARIANT = /^(?:[A-Z][a-z]+)+$/;
const KEY = /^(?:(?:[A-Z][a-z]+)+|[a-z]+(?:_[a-z]+)*)$/;
// Its numbers are an instruction or account index (a u8) and a program's code; a real error holds two at most (an
// index and a code). So at most two are kept, each 0 to 65,535, the rest "?": 32 bits, too few to spell a signature, an
// address or a nullifier in integers.
const NUMBERS = 2;
const NUMBER_MAX = 65_535;
function shape(v: unknown, depth: number, kept: { n: number }): unknown {
  if (depth > 4) return "?";
  if (typeof v === "number") return Number.isInteger(v) && v >= 0 && v <= NUMBER_MAX && kept.n++ < NUMBERS ? v : "?";
  if (typeof v === "string") return v.length <= 48 && VARIANT.test(v) ? v : "?";
  if (Array.isArray(v)) return v.slice(0, 4).map((x) => shape(x, depth + 1, kept));
  if (typeof v === "object" && v !== null) return Object.fromEntries(Object.entries(v).slice(0, 4).map(([k, x]) => [k.length <= 48 && KEY.test(k) ? k : "?", shape(x, depth + 1, kept)]));
  return "?";
}
/** Whether `t` is already one of simErrText's shapes (reshaping it changes nothing). */
function isErrShape(t: string): boolean {
  try {
    return t.length <= 120 && /^["{[]/.test(t) && simErrText(JSON.parse(t)) === t;
  } catch {
    return false;
  }
}
/** A Solana simulation's err for the line: its shape (variant names, indexes, codes), free text dropped, at most 120
 *  characters, with no space so the line stays one field a word. */
export function simErrText(err: unknown): string {
  return JSON.stringify(shape(err, 0, { n: 0 })).replace(/\s/g, "").slice(0, 120);
}
