// One console line per step of a buy or a move from Cash (card buy-shows-every-step): where it is, how long each step
// took, its tx, and the exact error when one stops, so a buy that fails on a real device says where.
//
// Each line is `[ct-trace] ` and one JSON object: `op` (the move's or the buy's op id), `part` (the move's part, null
// when the line is not a part's), `step`, `ms` (since the op's first line on this page), and only the fields below.
// What a line may carry is held here, never by the caller: every field is a string of its own shape, anything else is
// dropped, so no caller can print a key, the 12 words, a note's secret or a nullifier's preimage by passing them:
// - tx, address, quote, move: public ids only (a tx hash, a deposit or one-time address, a follow's or a move's op id),
//   already on chain or the page's own;
// - status, stage: a word (1Click's status, a kind's end);
// - amount: a decimal or an integer of base units (what U_X holds, a public balance);
// - error: the message verbatim, cut at ERROR_MAX characters, with any run that could be a secret's (30 or more
//   digits, 64 or more hex characters, 80 or more base58 characters: a field element, a key or a seed) replaced.
// The follow of a part's quote runs under its own op id (`<op>/1click`): `alias` names its move and part, so its lines
// read under the move's.
export const TRACE_TAG = "[ct-trace]";
export const TRACE_STEPS = ["move", "quote", "proof_start", "proof_done", "relay_sent", "vault_payout", "status", "intents", "arrived", "pool_deposit", "follow", "swap", "end"] as const;
export type TraceStep = (typeof TRACE_STEPS)[number];
export type TraceFields = { tx?: string; address?: string; quote?: string; move?: string; status?: string; stage?: string; amount?: string; error?: string };
/** The last line of an op, as its record keeps it (MoveOpRecord.last): the step and, when it stopped, its error. */
export type TraceLast = { step: TraceStep; ms: number; error?: string };

export const ERROR_MAX = 500;
const ID = /^[A-Za-z0-9._:/-]{1,160}$/;
const WORD = /^[A-Za-z_]{1,40}$/;
const AMOUNT = /^\d{1,40}(?:\.\d{1,30})?$/;
const SHAPE: Readonly<Record<keyof TraceFields, RegExp | null>> = { tx: ID, address: ID, quote: ID, move: ID, status: WORD, stage: WORD, amount: AMOUNT, error: null };
const SECRET_RUN = /\d{30,}|[0-9a-fA-F]{64,}|[1-9A-HJ-NP-Za-km-z]{80,}/g;

/** An error's message as a line carries it: verbatim, cut, with any run that could be a secret replaced. */
export function errorText(e: unknown): string {
  const m = e instanceof Error ? `${e.name === "Error" ? "" : `${e.name}: `}${e.message}` : typeof e === "string" ? e : (() => {
    try {
      return JSON.stringify(e) ?? String(e);
    } catch {
      return String(e);
    }
  })();
  return m.replace(SECRET_RUN, "<redacted>").slice(0, ERROR_MAX);
}

let sink: (line: string) => void = (line) => console.info(line);
let clock: () => number = () => Date.now();
/** Tests: where lines go and the clock `ms` is read on; gives back the ones before. */
export function traceTo(to: (line: string) => void, now?: () => number): { to: (line: string) => void; now: () => number } {
  const was = { to: sink, now: clock };
  sink = to;
  if (now) clock = now;
  return was;
}

const START_MAX = 512;
const starts = new Map<string, number>();
const aliases = new Map<string, { op: string; part: number | null }>();
/** Lines under `id` (a part's follow op) read as `op`'s, part `part`. */
export function traceAlias(id: string, op: string, part: number | null): void {
  if (aliases.size >= START_MAX) aliases.delete(aliases.keys().next().value!);
  aliases.set(id, { op, part });
}

/** The op's time 0, when it has none yet: its lines' `ms` count from here (else from its first line). */
export function traceBegin(op: string): void {
  const id = aliases.get(op)?.op ?? op;
  if (starts.has(id)) return;
  if (starts.size >= START_MAX) starts.delete(starts.keys().next().value!);
  starts.set(id, clock());
}

/** Writes one line for `op`; never throws (a trace never stops a buy). Gives the line's step, time and error. */
export function trace(op: string, part: number | null, step: TraceStep, fields: TraceFields = {}): TraceLast {
  const a = aliases.get(op);
  const id = a?.op ?? op;
  const p = a ? a.part : part;
  traceBegin(id);
  const now = clock();
  const ms = Math.max(0, now - starts.get(id)!);
  const line: Record<string, unknown> = { op: ID.test(id) ? id : "?", part: p, step, ms };
  for (const k of Object.keys(SHAPE) as (keyof TraceFields)[]) {
    if (!Object.hasOwn(fields, k)) continue;
    const v = fields[k];
    if (typeof v !== "string") continue;
    const shape = SHAPE[k];
    if (shape === null) line[k] = errorText(v);
    else if (shape.test(v)) line[k] = v;
  }
  try {
    sink(`${TRACE_TAG} ${JSON.stringify(line)}`);
  } catch {
    /* the console never stops a buy */
  }
  return typeof line.error === "string" ? { step, ms, error: line.error } : { step, ms };
}
