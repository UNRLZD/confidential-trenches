// SIGN_HOST's top-level withdraw form (card signpage-withdraw-form; docs/plan1/wallet.md §2.8 withdraw.open W:927,
// app.md CH-075 to CH-078 A:996-999 and AM-09 A:1272, at research 3a705af): the user types where the money goes (To)
// and how much (Amount); ./checks.ts refuses a bad address or amount before any proof, and only a form whose both
// fields pass, checked again at the tap, hands {recipient, amount} to the wallet's withdraw path. The app never passes
// an address in: withdraw.open carries no address (the kit's schema), and the form starts empty.
//
// - States (data-state on the form): empty (both fields blank), typing (a field filled, nothing refused, not yet
//   ready, a check waiting or reading), refused (a field refused: data-refusal on that field's line names the code),
//   ready (both pass). A check runs CHECK_IDLE_MS after the last keystroke, so a half-typed name is not refused and
//   the two RPCs are not read on every key; a check's answer is drawn only while it is the newest.
// - Cash goes out whole (card cash-withdraws-everything-to-any-chain): the amount is sent from every UNSPENT note, one
//   withdrawal per note in order (./checks.ts planCashWithdraw). Max, drawn once the notes and the fee are read, is the
//   whole of Cash less a fee per note (cashSendable); a tap puts it in the amount. At the tap each withdrawal is a step
//   drawn under the form (data-steps, one line each with its amount and its state), and the run stops at the first
//   that does not leave the vault, the rest still in Cash.
// - Where it goes (Part B, ./onward.ts): a row of chains above To, NEAR first and picked; on SIGN_HOST's build (mainnet,
//   where 1Click pays out) also Solana and Base, each by its name. On NEAR To is a NEAR account (./checks.ts); on
//   another chain an address there (onwardTo), and each withdrawal goes through its own checked 1Click quote.
// - The notes and the fee bound are read when the form opens and again at every Withdraw tap. A read that cannot
//   answer is "unread": the field shows S12.10's Busy · Retry, a tap reads what is unread and checks again, and nothing
//   goes on meanwhile.
// - Withdraw is drawn in every state and acts only when ready: it reads the note value and the fee bound again, checks
//   both fields again (the address on both RPCs) and hands over only an answer equal to the one drawn, with the fee it
//   drew. With no hand-off given (a build whose release names no relayer: ./handoff.ts) it is drawn and not offered (data-pending, as
//   New account is on the sign-in choices). The hand-off's outcome is drawn as data-outcome; a hand-off that found the
//   relayer's fee above the drawn one ({ kind: "fee" }) gives the new fee, which is drawn (both fields checked at it)
//   and nothing goes on until the next tap.
// - A vault withdrawal the page's settle pass left "unmatched" is shown above the fields (data-notice), read at open and
//   at every tap's reads.
// - A word the owner has not picked is drawn with data-draft-copy naming its key in WITHDRAW_WORDS (WITHDRAW_DRAFT
//   lists them); the rest were kept as drafted (owner 8 Nov 07:55Z) and carry no mark.
// - DOM by createElement and textContent only: the page's CSP requires Trusted Types for every script sink.
import type { NearNetwork, NearRpc } from "../../../kit/src/near/networks.ts";
import type { WithdrawPart, WithdrawSource } from "../pool-withdraw.ts";
import { POOL_CHAIN_MARK } from "./chain-mark.ts";
import { isOnward, onwardTo, WITHDRAW_CHAINS, type WithdrawChain } from "./onward.ts";
import { type AddressCode, type AmountCheck, type AmountCode, cashSendable, checkAmount, checkRecipient, type RecipientCheck, TOKEN_DECIMALS } from "./checks.ts";

// Withdraw, Invalid address, Invalid amount, Insufficient and Busy · Retry were kept as drafted (owner 8 Nov 07:55Z, the 8 Nov
// words page: pw.withdraw, pw.invalidAddress, pw.invalidAmount, pw.insufficient, pw.busy), so their elements carry no
// data-draft-copy.
// DRAFT COPY: every other word here is drawn with data-draft-copy until the owner picks it, each with its source on its line.
export const WITHDRAW_WORDS = {
  to: "To", // CN-24, signed for the APP drawer's field (09-design-brief.md:1391); new on SIGN_HOST
  amount: "Amount", // CN-24, the same
  withdraw: "Withdraw", // F4 step 1 (09-design-brief.md:1781); owner 8 Nov 07:55Z, kept
  "invalid-address": "Invalid address", // S12.5 (09-design-brief.md:1401); owner 8 Nov 07:55Z, kept
  "invalid-amount": "Invalid amount", // brief: an amount that is not a number, after S12.5; owner 8 Nov 07:55Z, kept
  insufficient: "Insufficient", // S12.6 (09-design-brief.md:1402); owner 8 Nov 07:55Z, kept
  min: "Min $", // S12.7's draft "Min $X" (09-design-brief.md:1403), X the smallest amount above the fee
  busy: "Busy · Retry", // S12.10 (09-design-brief.md:1405), for a check the RPCs could not answer; owner 8 Nov 07:55Z, kept
  unmatched: "Withdrawal unmatched", // new, card wallet-withdraw-move-out: a settle pass's drift note left RESERVED; the owner picks
  try: "Try ", // above what the note sends, "Try 9.88 USDC" (card withdraw-form-shows-what-you-can-send): pw.tryOne, owner 8 Nov 07:55Z, kept
  or: " or ", // no plan sends the amount: "Try 4.5 or 5 USDC", the pool form's pw.tryTwo; owner 8 Nov 07:55Z, kept
  max: "Max", // what Cash can send, "Max 19.76 USDC": the pool form's and the trade box's word, owner 12 Nov 13:03Z, kept
  "step-waiting": "Waiting", // new, card cash-withdraws-everything-to-any-chain: a withdrawal not started; the owner picks
  "step-sending": "Sending", // new, the same: a withdrawal on its way out of the vault; the owner picks
  "step-sent": "Sent", // new, the same: a withdrawal that left the vault for the typed account; the owner picks
  "step-back": "Back in Cash", // new, the same: a withdrawal that did not leave (expired, refunded, a fee that rose); the owner picks
  "step-stopped": "Stopped", // new, the same: a withdrawal that ended any other way; the owner picks
} as const;

/** The keys of WITHDRAW_WORDS the owner has not picked: their elements keep data-draft-copy. */
export const WITHDRAW_DRAFT: ReadonlySet<string> = new Set(["to", "amount", "min", "unmatched"]);
/** The Cash run's step words (card cash-withdraws-everything-to-any-chain), all new: each drawn with data-draft-copy until
 *  the owner picks it. A set of their own, so the vault form's set stays the one the 8 Nov picks left. */
export const STEP_DRAFT: ReadonlySet<string> = new Set(["step-waiting", "step-sending", "step-sent", "step-back", "step-stopped"]);

/** Sets data-draft-copy on an element drawing `key` when `key` is in `drafts`, and takes it off otherwise. */
export function markDraft(el: HTMLElement, key: string, drafts: ReadonlySet<string>): void {
  if (drafts.has(key)) el.dataset.draftCopy = key;
  else delete el.dataset.draftCopy;
}

/** The quiet time after the last keystroke before a check runs. */
export const CHECK_IDLE_MS = 300;

/** One withdrawal: both checked, the amount in the token's base units (the wallet's withdraw path, one note). */
export type CheckedWithdraw = Readonly<{ recipient: string; amount: bigint }>;
/** What the form hands over: the account, the whole amount and its plan, one withdrawal per note in order. */
export type CheckedCashWithdraw = Readonly<{ recipient: string; amount: bigint; parts: readonly WithdrawPart[]; chain?: WithdrawChain }>;
/** A step's state as the run reports it: "sending" when it starts, then its end (../handoff.ts HandoffEnd's kind), or
 *  "failed" when it threw. */
export type StepReport = (i: number, kind: string) => void;

export interface WithdrawFormDeps {
  network: NearNetwork;
  /** The network's release pair (the wallet's nearPairNetwork). */
  rpcs: readonly [NearRpc, NearRpc];
  /** The UNSPENT notes of the vault's scope (./checks.ts cashNotes), each id and value in base units. */
  cash: () => Promise<readonly WithdrawSource[]>;
  /** The largest UNSPENT note of the vault's scope (./checks.ts withdrawable): what one withdrawal carries. The form
   *  reads `cash`; this is the one-note read a single hand-off's caller sizes by. */
  available: () => Promise<bigint>;
  /** The device's own bound on the relay fee, in base units; a rejection leaves it unread. */
  fee: () => Promise<bigint>;
  /** The wallet's withdraw path, one withdrawal per part in order (./handoff.ts cashWithdrawRun), given the fee the
   *  form drew and the step report; absent where the release names no vault or relayer. Its answer, when it gives one,
   *  is drawn as data-outcome, except { kind: "fee", fee }: the relayer's fee is now above the drawn one, so the form
   *  draws that fee and goes no further. */
  handoff?: (w: CheckedCashWithdraw, fee: bigint, step: StepReport) => void | Promise<void | { kind: string; fee?: bigint }>;
  /** How many vault withdrawals the page's last settle pass left "unmatched" (./handoff.ts withdrawSettle: a spend of
   *  the note whose change is not this device's, the note kept RESERVED); read at open and at every tap's reads. */
  unmatched?: () => number;
}

export type FormState = "empty" | "typing" | "refused" | "ready";
export interface FormView {
  state: FormState;
  /** null while the field is blank. */
  address: RecipientCheck | null;
  amount: AmountCheck | null;
  ready: CheckedCashWithdraw | null;
}

/** The form's view of both fields, read and checked now. */
export async function evaluate(
  to: string, amount: string, ctx: { network: NearNetwork; rpcs: readonly [NearRpc, NearRpc]; notes: readonly WithdrawSource[] | null; fee: bigint | null; chain?: WithdrawChain },
): Promise<FormView> {
  const chain = ctx.chain ?? "near";
  const blankTo = to.trim() === "";
  const blankAmount = amount.trim() === "";
  const onward = isOnward(chain) ? onwardTo(chain, to) : null;
  const a: RecipientCheck | null = blankTo ? null : isOnward(chain) ? (onward === null ? { ok: false, code: "not-account" } : { ok: true, recipient: onward }) : await checkRecipient(to, ctx.network, ctx.rpcs);
  const m = blankAmount ? null : checkAmount(amount, { notes: ctx.notes, fee: ctx.fee });
  const ready = a?.ok && m?.ok ? Object.freeze({ recipient: a.recipient, amount: m.amount, parts: Object.freeze(m.parts.map((p) => Object.freeze({ ...p }))), ...(chain === "near" ? {} : { chain }) }) : null;
  const state: FormState = blankTo && blankAmount ? "empty" : (a && !a.ok) || (m && !m.ok) ? "refused" : ready ? "ready" : "typing";
  return { state, address: a, amount: m, ready };
}

/** Base units as a plain decimal, no trailing zeros: 120001n -> "0.120001". */
export function formatUnits(units: bigint): string {
  const s = units.toString().padStart(TOKEN_DECIMALS + 1, "0");
  const frac = s.slice(-TOKEN_DECIMALS).replace(/0+$/, "");
  return frac ? `${s.slice(0, -TOKEN_DECIMALS)}.${frac}` : s.slice(0, -TOKEN_DECIMALS);
}

/** The words a refusal draws, by its code; `above` is the nearest plannable amount above (unplannable only). */
export function refusalWords(code: AddressCode | AmountCode, min?: bigint, below?: bigint, above?: bigint): string {
  if (code === "unread") return WITHDRAW_WORDS.busy;
  if (code === "unplannable") {
    const sides = [...new Set([below, above].filter((x): x is bigint => x !== undefined))];
    return sides.length === 0 ? WITHDRAW_WORDS["invalid-amount"] : `${WITHDRAW_WORDS.try}${sides.map(formatUnits).join(WITHDRAW_WORDS.or)} USDC`;
  }
  if (code === "amount") return WITHDRAW_WORDS["invalid-amount"];
  // above what the note can send: what can be, in the pool form's nearest-amounts words with the asset's symbol
  if (code === "insufficient") return below ? `${WITHDRAW_WORDS.try}${formatUnits(below)} USDC` : WITHDRAW_WORDS.insufficient;
  if (code === "min") return `${WITHDRAW_WORDS.min}${formatUnits(min ?? 0n)}`;
  return WITHDRAW_WORDS["invalid-address"];
}

type Button = (action: string, label: string, onClick: () => void) => HTMLButtonElement;

/**
 * Draws the form into `doc` and returns its element. `button` is the page's own (src/main.ts), so Withdraw gets the
 * page's activation guard. `run` is the page's step runner (one step at a time, an error shown as the page's error).
 */
export function drawWithdrawForm(doc: Document, deps: WithdrawFormDeps, button: Button, run: (step: () => Promise<void>) => void): HTMLElement {
  const form = doc.createElement("div");
  form.dataset.withdraw = "form";
  form.dataset.state = "empty";
  // the pool form's spacing (src/withdraw/pool-form.ts): one column, 12 px between rows, each field's name over its input
  Object.assign(form.style, { display: "flex", flexDirection: "column", alignItems: "stretch", gap: "12px", maxWidth: "440px" });
  const field = (key: "to" | "amount"): { input: HTMLInputElement; line: HTMLParagraphElement; label: HTMLLabelElement } => {
    const label = doc.createElement("label");
    Object.assign(label.style, { display: "flex", flexWrap: "wrap", alignItems: "center", gap: "6px 8px" });
    const name = doc.createElement("span");
    name.textContent = WITHDRAW_WORDS[key];
    markDraft(name, key, WITHDRAW_DRAFT);
    Object.assign(name.style, { flexBasis: "100%" });
    const input = doc.createElement("input");
    Object.assign(input.style, { flex: "1 1 0", minWidth: "0" });
    input.type = "text";
    input.dataset.input = key;
    input.autocomplete = "off";
    input.spellcheck = false;
    input.setAttribute("autocapitalize", "none");
    input.setAttribute("autocorrect", "off");
    if (key === "amount") input.inputMode = "decimal";
    label.append(name, input);
    const line = doc.createElement("p");
    line.dataset.for = key;
    line.hidden = true;
    return { input, line, label };
  };
  const to = field("to");
  const amount = field("amount");
  const go = button("withdraw", WITHDRAW_WORDS.withdraw, () => run(withdraw));
  if (!deps.handoff) go.dataset.pending = "withdraw-relay";
  const notice = doc.createElement("p");
  notice.dataset.notice = "unmatched";
  markDraft(notice, "unmatched", WITHDRAW_DRAFT);
  notice.textContent = WITHDRAW_WORDS.unmatched;
  const drift = (): void => void (notice.hidden = !((deps.unmatched?.() ?? 0) > 0));
  drift();
  // what Cash can send now (Max), drawn once the notes and the fee are read; a tap puts it in the amount. Its row carries
  // `hidden`, as the pool form's does, so no style on the button can show it before the reads.
  const canRow = doc.createElement("div");
  canRow.dataset.row = "sendable";
  canRow.hidden = true;
  const sendable = doc.createElement("button");
  sendable.type = "button";
  sendable.dataset.action = "sendable";
  Object.assign(sendable.style, { minHeight: "44px", minWidth: "44px", padding: "0 12px", fontVariantNumeric: "tabular-nums" });
  canRow.append(sendable);
  // the run's steps, one line per withdrawal, drawn at the tap
  const steps = doc.createElement("ol");
  steps.dataset.steps = "cash-withdraw";
  steps.hidden = true;
  Object.assign(steps.style, { margin: "0", paddingLeft: "20px", fontVariantNumeric: "tabular-nums" });
  // where it goes: NEAR, and on the build 1Click pays out on, each onward chain
  let chain: WithdrawChain = "near";
  const chains = doc.createElement("div");
  chains.dataset.row = "chains";
  Object.assign(chains.style, { display: "flex", flexWrap: "wrap", gap: "8px" });
  const picks = (deps.network === "mainnet" ? WITHDRAW_CHAINS : (["near"] as const)).map((c) => {
    const b = doc.createElement("button");
    b.type = "button";
    b.dataset.action = "chain";
    b.dataset.chain = c;
    b.textContent = c === "near" ? "NEAR" : POOL_CHAIN_MARK[c].name;
    Object.assign(b.style, { minHeight: "44px", padding: "0 12px" });
    b.addEventListener("click", () => {
      if (chain === c) return;
      chain = c;
      drawChains();
      typed();
    });
    return b;
  });
  const drawChains = (): void => {
    for (const b of picks) b.setAttribute("aria-pressed", String(b.dataset.chain === chain));
    form.dataset.chain = chain;
  };
  chains.append(...picks);
  drawChains();
  form.append(notice, chains, to.label, to.line, amount.label, canRow, amount.line, go, steps);

  // read at open, and again on Retry while either is unread; one that cannot be read stays null (unread)
  let ctx: { notes: readonly WithdrawSource[] | null; fee: bigint | null } = { notes: null, fee: null };
  const drawSendable = (): void => {
    const can = ctx.notes === null || ctx.fee === null ? null : cashSendable(ctx.notes, ctx.fee);
    canRow.hidden = can === null;
    sendable.disabled = !can;
    Object.assign(sendable.style, { opacity: can ? "" : "0.5", cursor: can ? "pointer" : "default" }); // 0: shown, not offered
    sendable.textContent = can === null ? "" : `${WITHDRAW_WORDS.max} ${formatUnits(can)} USDC`;
    if (can === null) delete sendable.dataset.value;
    else sendable.dataset.value = String(can);
  };
  const load = (): Promise<void> =>
    (drift(), Promise.all([deps.cash().catch(() => null), deps.fee().catch(() => null)]).then(([notes, fee]) => {
      ctx = { notes: Array.isArray(notes) ? notes : null, fee: typeof fee === "bigint" ? fee : null };
      drawSendable();
    }));
  let loaded = load();

  let seq = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let view: FormView = { state: "empty", address: null, amount: null, ready: null };
  const draw = (v: FormView): void => {
    view = v;
    form.dataset.state = v.state;
    line(to.line, v.address && !v.address.ok ? v.address.code : null);
    const m = v.amount && !v.amount.ok ? v.amount : null;
    line(amount.line, m ? m.code : null, m?.code === "min" ? m.min : undefined, m?.code === "insufficient" || m?.code === "unplannable" ? m.below : undefined, m?.code === "unplannable" ? m.above : undefined);
    go.disabled = v.state !== "ready" || !deps.handoff;
  };
  const line = (p: HTMLParagraphElement, code: AddressCode | AmountCode | null, min?: bigint, below?: bigint, above?: bigint): void => {
    p.hidden = code === null;
    if (code === null) {
      delete p.dataset.refusal;
      delete p.dataset.draftCopy;
      return void p.replaceChildren();
    }
    p.dataset.refusal = code;
    markDraft(p, code === "unread" ? "busy" : code === "amount" ? "invalid-amount" : (code === "insufficient" || code === "unplannable") && (below ?? above) !== undefined ? "try" : code === "unplannable" ? "invalid-amount" : code === "insufficient" || code === "min" ? code : "invalid-address", WITHDRAW_DRAFT);
    if (code !== "unread") return void (p.textContent = refusalWords(code, min, below, above));
    // Busy · Retry: a tap checks again now
    const again = doc.createElement("button");
    again.type = "button";
    again.dataset.action = "retry";
    again.textContent = refusalWords(code);
    again.addEventListener("click", () => {
      if (ctx.notes === null || ctx.fee === null) loaded = load();
      void check();
    });
    p.replaceChildren(again);
  };
  const check = async (): Promise<FormView | null> => {
    const at = ++seq;
    await loaded;
    const v = await evaluate(to.input.value, amount.input.value, { network: deps.network, rpcs: deps.rpcs, ...ctx, chain });
    if (at !== seq) return null; // a newer keystroke or check: this answer is stale
    draw(v);
    return v;
  };
  const typed = (): void => {
    clearTimeout(timer);
    seq += 1; // any check in flight is stale now
    const blank = to.input.value.trim() === "" && amount.input.value.trim() === "";
    draw({ state: blank ? "empty" : "typing", address: null, amount: null, ready: null });
    if (!blank) timer = setTimeout(() => void check(), CHECK_IDLE_MS);
  };
  to.input.addEventListener("input", typed);
  amount.input.addEventListener("input", typed);
  // the tap on Max: that amount in the field, checked now against the same reads
  sendable.addEventListener("click", () => {
    if (ctx.notes === null || ctx.fee === null || sendable.disabled) return;
    amount.input.value = formatUnits(cashSendable(ctx.notes, ctx.fee));
    clearTimeout(timer);
    void check();
  });

  // one line per withdrawal: its amount and its state, every word marked while the owner has not picked it
  const stepWord = (kind: string): keyof typeof WITHDRAW_WORDS =>
    kind === "waiting" ? "step-waiting" : kind === "sending" ? "step-sending" : kind === "arrived" || kind === "landed" ? "step-sent" : kind === "expired" || kind === "refunded" || kind === "fee" ? "step-back" : "step-stopped";
  let stepLines: HTMLElement[] = [];
  const drawSteps = (parts: readonly WithdrawPart[]): void => {
    const lines = parts.map((p, i) => {
      const li = doc.createElement("li");
      li.dataset.step = String(i);
      const value = doc.createElement("span");
      value.textContent = `${formatUnits(p.part)} USDC`;
      const state = doc.createElement("span");
      state.dataset.stepWord = "";
      Object.assign(state.style, { marginLeft: "8px" });
      li.append(value, state);
      return li;
    });
    steps.replaceChildren(...lines);
    steps.hidden = lines.length === 0;
    stepLines = lines;
    lines.forEach((_, i) => mark(i, "waiting"));
  };
  const mark = (i: number, kind: string): void => {
    const li = stepLines[i];
    if (!li) return;
    li.dataset.stepState = kind;
    const word = li.children[1] as HTMLElement | undefined;
    if (!word) return;
    const key = stepWord(kind);
    word.textContent = WITHDRAW_WORDS[key];
    markDraft(word, key, STEP_DRAFT);
  };

  // the tap: the note value and the fee bound read again, both fields checked again; only the same answer goes on
  async function withdraw(): Promise<void> {
    const before = view.ready;
    if (!before || !deps.handoff) return;
    clearTimeout(timer);
    loaded = load();
    const v = await check();
    // the same account, amount and plan as drawn: a note spent or added since is a new plan, drawn for the next tap
    const plan = (r: CheckedCashWithdraw): string => r.parts.map((p) => `${p.noteId}:${p.part}`).join(",");
    if (!v?.ready || v.ready.recipient !== before.recipient || v.ready.chain !== before.chain || v.ready.amount !== before.amount || plan(v.ready) !== plan(before) || ctx.fee === null) return;
    drawSteps(v.ready.parts);
    let end: void | { kind: string; fee?: bigint } = undefined;
    try {
      end = await deps.handoff(v.ready, ctx.fee, mark);
    } finally {
      // what is left in Cash, read again for Max and the next tap's check; a fee that rose is drawn over the fee read
      const rose = end?.kind === "fee" && typeof end.fee === "bigint" ? end.fee : null;
      loaded = load().then(() => {
        if (rose === null) return;
        ctx = { ...ctx, fee: rose };
        drawSendable();
      });
    }
    if (end?.kind === "fee" && typeof end.fee === "bigint") {
      await check();
      return;
    }
    if (end) form.dataset.outcome = end.kind;
  }
  draw(view);
  return form;
}
