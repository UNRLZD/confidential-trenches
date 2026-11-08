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
// - The note value and the fee bound are read when the form opens and again at every Withdraw tap. A read that cannot
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
import { type AddressCode, type AmountCheck, type AmountCode, checkAmount, checkRecipient, type RecipientCheck, TOKEN_DECIMALS } from "./checks.ts";

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
} as const;

/** The keys of WITHDRAW_WORDS the owner has not picked: their elements keep data-draft-copy. */
export const WITHDRAW_DRAFT: ReadonlySet<string> = new Set(["to", "amount", "min", "unmatched"]);

/** Sets data-draft-copy on an element drawing `key` when `key` is in `drafts`, and takes it off otherwise. */
export function markDraft(el: HTMLElement, key: string, drafts: ReadonlySet<string>): void {
  if (drafts.has(key)) el.dataset.draftCopy = key;
  else delete el.dataset.draftCopy;
}

/** The quiet time after the last keystroke before a check runs. */
export const CHECK_IDLE_MS = 300;

/** What the form hands to the wallet's withdraw path: both checked, the amount in the token's base units. */
export type CheckedWithdraw = Readonly<{ recipient: string; amount: bigint }>;

export interface WithdrawFormDeps {
  network: NearNetwork;
  /** The network's release pair (the wallet's nearPairNetwork). */
  rpcs: readonly [NearRpc, NearRpc];
  /** The largest UNSPENT note of the vault's scope (./checks.ts withdrawable), in base units. */
  available: () => Promise<bigint>;
  /** The device's own bound on the relay fee, in base units; a rejection leaves it unread. */
  fee: () => Promise<bigint>;
  /** The wallet's withdraw path, given the fee the form drew; absent where the release names no vault or relayer
   *  (./handoff.ts). Its answer, when it gives one, is drawn as data-outcome, except { kind: "fee", fee }: the relayer's
   *  fee is now above the drawn one, so the form draws that fee and goes no further. */
  handoff?: (w: CheckedWithdraw, fee: bigint) => void | Promise<void | { kind: string; fee?: bigint }>;
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
  ready: CheckedWithdraw | null;
}

/** The form's view of both fields, read and checked now. */
export async function evaluate(
  to: string, amount: string, ctx: { network: NearNetwork; rpcs: readonly [NearRpc, NearRpc]; available: bigint | null; fee: bigint | null },
): Promise<FormView> {
  const blankTo = to.trim() === "";
  const blankAmount = amount.trim() === "";
  const a = blankTo ? null : await checkRecipient(to, ctx.network, ctx.rpcs);
  const m = blankAmount ? null : checkAmount(amount, { available: ctx.available, fee: ctx.fee });
  const ready = a?.ok && m?.ok ? Object.freeze({ recipient: a.recipient, amount: m.amount }) : null;
  const state: FormState = blankTo && blankAmount ? "empty" : (a && !a.ok) || (m && !m.ok) ? "refused" : ready ? "ready" : "typing";
  return { state, address: a, amount: m, ready };
}

/** Base units as a plain decimal, no trailing zeros: 120001n -> "0.120001". */
export function formatUnits(units: bigint): string {
  const s = units.toString().padStart(TOKEN_DECIMALS + 1, "0");
  const frac = s.slice(-TOKEN_DECIMALS).replace(/0+$/, "");
  return frac ? `${s.slice(0, -TOKEN_DECIMALS)}.${frac}` : s.slice(0, -TOKEN_DECIMALS);
}

/** The words a refusal draws, by its code. */
export function refusalWords(code: AddressCode | AmountCode, min?: bigint): string {
  if (code === "unread") return WITHDRAW_WORDS.busy;
  if (code === "amount") return WITHDRAW_WORDS["invalid-amount"];
  if (code === "insufficient") return WITHDRAW_WORDS.insufficient;
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
  const field = (key: "to" | "amount"): { input: HTMLInputElement; line: HTMLParagraphElement; label: HTMLLabelElement } => {
    const label = doc.createElement("label");
    const name = doc.createElement("span");
    name.textContent = WITHDRAW_WORDS[key];
    markDraft(name, key, WITHDRAW_DRAFT);
    const input = doc.createElement("input");
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
  form.append(notice, to.label, to.line, amount.label, amount.line, go);

  // read at open, and again on Retry while either is unread; one that cannot be read stays null (unread)
  let ctx: { available: bigint | null; fee: bigint | null } = { available: null, fee: null };
  const load = (): Promise<void> =>
    (drift(), Promise.all([deps.available().catch(() => null), deps.fee().catch(() => null)]).then(([available, fee]) => {
      ctx = { available: typeof available === "bigint" ? available : null, fee: typeof fee === "bigint" ? fee : null };
    }));
  let loaded = load();

  let seq = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let view: FormView = { state: "empty", address: null, amount: null, ready: null };
  const draw = (v: FormView): void => {
    view = v;
    form.dataset.state = v.state;
    line(to.line, v.address && !v.address.ok ? v.address.code : null);
    line(amount.line, v.amount && !v.amount.ok ? v.amount.code : null, v.amount && !v.amount.ok && v.amount.code === "min" ? v.amount.min : undefined);
    go.disabled = v.state !== "ready" || !deps.handoff;
  };
  const line = (p: HTMLParagraphElement, code: AddressCode | AmountCode | null, min?: bigint): void => {
    p.hidden = code === null;
    if (code === null) {
      delete p.dataset.refusal;
      delete p.dataset.draftCopy;
      return void p.replaceChildren();
    }
    p.dataset.refusal = code;
    markDraft(p, code === "unread" ? "busy" : code === "amount" ? "invalid-amount" : code === "insufficient" || code === "min" ? code : "invalid-address", WITHDRAW_DRAFT);
    if (code !== "unread") return void (p.textContent = refusalWords(code, min));
    // Busy · Retry: a tap checks again now
    const again = doc.createElement("button");
    again.type = "button";
    again.dataset.action = "retry";
    again.textContent = refusalWords(code);
    again.addEventListener("click", () => {
      if (ctx.available === null || ctx.fee === null) loaded = load();
      void check();
    });
    p.replaceChildren(again);
  };
  const check = async (): Promise<FormView | null> => {
    const at = ++seq;
    await loaded;
    const v = await evaluate(to.input.value, amount.input.value, { network: deps.network, rpcs: deps.rpcs, ...ctx });
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

  // the tap: the note value and the fee bound read again, both fields checked again; only the same answer goes on
  async function withdraw(): Promise<void> {
    const before = view.ready;
    if (!before || !deps.handoff) return;
    clearTimeout(timer);
    loaded = load();
    const v = await check();
    if (!v?.ready || v.ready.recipient !== before.recipient || v.ready.amount !== before.amount || ctx.fee === null) return;
    const end = await deps.handoff(v.ready, ctx.fee);
    if (end?.kind === "fee" && typeof end.fee === "bigint") {
      ctx = { ...ctx, fee: end.fee };
      await check();
      return;
    }
    if (end) form.dataset.outcome = end.kind;
  }
  draw(view);
  return form;
}
