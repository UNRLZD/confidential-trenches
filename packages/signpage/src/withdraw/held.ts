// SIGN_HOST's way out of a held deposit (card held-deposit-way-out; docs/plan1/wallet.md §2.4 "Struck" W:467-472 and
// the §2.8 rows W:928-929, W:934): withdraw.open with from_id = the held op's U draws this page, where the user types the
// NEAR account the money goes to. The app never passes the account in.
//
// - The typed account is checked by the withdraw form's one rule (./checks.ts checkRecipient: a NEAR account id, never
//   the vault, intents.near or the token, a named one existing on both RPCs, an implicit one passing unread), after the
//   form's quiet time and again at the tap; only the same answer goes on.
// - Move out hands the checked account to the wallet's move (../../../wallet/src/deposit/moveout.ts moveOutHeld): U's
//   own transaction, registration included when the account reads unregistered on both RPCs. Its answer is drawn as
//   data-outcome: moved, sent, gas (U's NEAR is short: the amount to send to U from the typed account is drawn, and a
//   tap reads again), empty, unread, failed.
// - A move the op already holds (a reload, another tab) is drawn at once with its recorded account, the field read-only,
//   and resumed: the same signed bytes, never a new signature. The resume runs as soon as the page is drawn, on its own
//   (main.ts's run() drops a step while its opening step is busy: review of d791adda, H1), and the tap waits for it.
// - Every answer that names an account (moved, sent, failed) writes that account into the field, read-only: the move's
//   account is the one shown, whatever was typed (a reload, another tab). After failed, the tap signs anew to it.
// - Every word is a draft until the owner picks it (data-draft-copy names its key in HELD_WORDS or WITHDRAW_WORDS);
//   Moved is picked (owner 8 Nov 07:50Z) and has no mark.
// - DOM by createElement and textContent only: the page's CSP requires Trusted Types for every script sink.
import type { NearNetwork, NearRpc } from "../../../kit/src/near/networks.ts";
import type { MoveOutOutcome, MoveOutRecord } from "../../../wallet/src/deposit/moveout.ts";
import { type AddressCode, checkRecipient, type RecipientCheck } from "./checks.ts";
import { CHECK_IDLE_MS, refusalWords, WITHDRAW_WORDS } from "./form.ts";

// DRAFT COPY, new with this card: every word below is the owner's pick to make, but `moved`, which the owner picked
// (owner 8 Nov 07:50Z, card held-move-forgotten-tx) and is drawn with no draft mark.
export const HELD_WORDS = {
  "move-out": "Move out", // the button
  link: "This links your deposit to this account.", // W:469: the move links the 1Click send to the typed account
  moved: "Moved", // owner 8 Nov 07:50Z: final
  sent: "Sending",
  gas: "Send NEAR to the deposit account from the account you typed:", // then the amount and U's id (W:469, W:934: from the typed account only)
  empty: "Nothing to move",
  failed: "Not moved · Retry",
} as const;

export interface HeldDeps {
  network: NearNetwork;
  rpcs: readonly [NearRpc, NearRpc];
  /** The move the op already holds, if any. */
  recorded: () => Promise<MoveOutRecord | undefined>;
  /** The wallet's move: a checked account, or null to resume the recorded one. */
  moveOut: (to: string | null) => Promise<MoveOutOutcome>;
}

type Button = (action: string, label: string, onClick: () => void) => HTMLButtonElement;

/** NEAR from yocto, rounded up to 5 places: what to send. */
export function nearUp(yocto: bigint): string {
  const unit = 10n ** 19n;
  const v = (yocto + unit - 1n) / unit;
  const s = v.toString().padStart(6, "0");
  const frac = s.slice(-5).replace(/0+$/, "");
  return frac ? `${s.slice(0, -5)}.${frac}` : s.slice(0, -5);
}

export function drawHeldMoveOut(doc: Document, deps: HeldDeps, button: Button, run: (step: () => Promise<void>) => void): HTMLElement {
  const page = doc.createElement("div");
  page.dataset.held = "move-out";
  page.dataset.state = "empty";
  const label = doc.createElement("label");
  const name = doc.createElement("span");
  name.textContent = WITHDRAW_WORDS.to;
  name.dataset.draftCopy = "to";
  const input = doc.createElement("input");
  input.type = "text";
  input.dataset.input = "to";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.setAttribute("autocapitalize", "none");
  input.setAttribute("autocorrect", "off");
  label.append(name, input);
  const line = doc.createElement("p");
  line.dataset.for = "to";
  line.hidden = true;
  const link = doc.createElement("p");
  link.dataset.draftCopy = "link";
  link.textContent = HELD_WORDS.link;
  const outcome = doc.createElement("p");
  outcome.dataset.outcomeLine = "";
  outcome.hidden = true;
  const go = button("move-out", HELD_WORDS["move-out"], () => run(move));
  go.dataset.draftCopy = "move-out";
  go.disabled = true;
  page.append(label, line, link, go, outcome);

  let seq = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let ready: string | null = null;
  // the account a move names: drawn read-only, the only one a tap goes on with
  let fixed: string | null = null;
  // the page's own step in flight (the resume): the tap waits for it
  let busy = false;
  const resuming = () => fixed !== null;
  const refuse = (code: AddressCode | null): void => {
    line.hidden = code === null;
    if (code === null) return void (delete line.dataset.refusal, line.replaceChildren());
    line.dataset.refusal = code;
    line.dataset.draftCopy = code === "unread" ? "busy" : "invalid-address";
    line.textContent = refusalWords(code);
  };
  const draw = (c: RecipientCheck | null, blank: boolean): void => {
    ready = c?.ok ? c.recipient : null;
    page.dataset.state = resuming() ? "resume" : blank ? "empty" : c === null ? "typing" : c.ok ? "ready" : "refused";
    refuse(c && !c.ok ? c.code : null);
    go.disabled = busy || (!resuming() && ready === null);
  };
  const check = async (): Promise<RecipientCheck | null> => {
    const at = ++seq;
    const c = await checkRecipient(input.value, deps.network, deps.rpcs).catch(() => ({ ok: false, code: "unread" }) as const);
    if (at !== seq) return null;
    draw(c, input.value.trim() === "");
    return c;
  };
  input.addEventListener("input", () => {
    clearTimeout(timer);
    seq += 1;
    const blank = input.value.trim() === "";
    draw(null, blank);
    if (!blank) timer = setTimeout(() => void check(), CHECK_IDLE_MS);
  });
  const fix = (to: string): void => {
    clearTimeout(timer);
    seq += 1;
    fixed = to;
    input.value = to;
    input.readOnly = true;
    draw(null, false);
  };
  const shown = (o: MoveOutOutcome): void => {
    if (o.kind === "open") {
      // a replaced record (it never ran; card held-move-forgotten-tx): no outcome line, never "not moved"; the account
      // is typed again, its last value checked as if typed
      fixed = null;
      input.readOnly = false;
      page.dataset.outcome = "open";
      outcome.hidden = true;
      outcome.replaceChildren();
      delete outcome.dataset.draftCopy;
      draw(null, input.value.trim() === "");
      if (input.value.trim() !== "") void check();
      return;
    }
    if (o.kind === "moved" || o.kind === "sent" || o.kind === "failed") fix(o.to);
    page.dataset.outcome = o.kind;
    outcome.hidden = false;
    outcome.replaceChildren();
    if (o.kind === "gas") {
      outcome.dataset.draftCopy = "gas";
      const amount = doc.createElement("strong");
      amount.textContent = `${nearUp(o.need)} NEAR`;
      const id = doc.createElement("code");
      id.textContent = o.u;
      outcome.append(HELD_WORDS.gas, " ", amount, " ", id);
      return;
    }
    const key = o.kind === "unread" ? "busy" : o.kind;
    if (key === "moved") delete outcome.dataset.draftCopy;
    else outcome.dataset.draftCopy = key;
    outcome.textContent = o.kind === "unread" ? WITHDRAW_WORDS.busy : HELD_WORDS[o.kind];
  };

  // the tap: the account checked again; only the same answer goes on (a move's account, fixed, is checked again too)
  async function move(): Promise<void> {
    if (busy) return;
    if (fixed !== null) {
      const to = fixed;
      const c = await checkRecipient(to, deps.network, deps.rpcs).catch(() => ({ ok: false, code: "unread" }) as const);
      if (!c.ok || c.recipient !== to) return refuse(c.ok ? null : c.code);
      return shown(await deps.moveOut(to));
    }
    const before = ready;
    if (before === null) return;
    clearTimeout(timer);
    const c = await check();
    if (!c?.ok || c.recipient !== before) return;
    shown(await deps.moveOut(c.recipient));
  }
  // a move the op holds: its account, read-only, resumed now (never a new signature: moveOut(null))
  const resume = async (): Promise<void> => {
    const r = await deps.recorded();
    if (r === undefined) return;
    fix(r.to);
    shown(await deps.moveOut(null));
  };
  busy = true;
  go.disabled = true;
  void resume()
    .catch(() => shown({ kind: "unread" }))
    .finally(() => {
      busy = false;
      go.disabled = !resuming() && ready === null;
    });
  return page;
}
