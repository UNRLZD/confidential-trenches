// SIGN_HOST's top-level pool withdraw screen (card signpage-pool-withdraw-form): the app's pool.withdraw names only the
// chain (the kit's schema: Open & { chain }), and the user types where the money goes (To) and how much arrives there
// (Amount) here, never in the app. Like the vault's withdraw form (./form.ts), whose states, idle check and DOM rules
// it keeps:
//
// - To, checked per chain: on Solana 32 bytes of base58 (the rules' SOL_KEY), never the pool, its program, the
//   relayer's fee payer or a key the runtime keeps read-only (SOLANA_RESERVED_KEYS: the sysvars and builtin programs,
//   System among them; a send to any of them is never the user's and can never land); on Base and Robinhood 0x and 40 hex digits (EVM_ADDRESS), its EIP-55 checksum
//   right when it mixes cases, never the zero address or the pool.
// - Amount: a decimal in the pool asset's decimals, refused above what the pool's notes can send ("Insufficient": the
//   ready pool balance, poolWithdrawable: each note less the epoch's fee and W's fee), under the smallest part ("Min"),
//   or when no plan of parts pays it exactly without leaving a change no withdraw could ever send: then the line names
//   the nearest amounts that can be sent (review #232 HIGH 2).
// - Before the press, with both fields passed: the To line (the address that gets the money) and the Max fee line (one
//   epoch fee and W's own send fee per part), so nothing is signed that was not shown; the run stops before its first
//   part when its plan costs more.
// - The notes and the fee are read when the screen opens and again at the press; the press checks both fields again
//   and hands over only an answer equal to the one drawn.
// - A send owed whose network fee rose past the Max fee drawn (card signpage-withdraw-own-spend): the screen shows the
//   fee it needs now and one button that draws the Max fee again at exactly that fee (owedFees, redraw); the press hands
//   over the fee shown, never one read after.
// - Every word but To and Amount was kept as drafted (owner 8 Nov 07:55Z, the 8 Nov words page: pw.*) and carries no
//   data-draft-copy; those two keep it (POOL_DRAFT).
// - What the screen is for and what can go (card withdraw-form-shows-what-you-can-send): the chain's mark and name at the
//   top (./chain-mark.ts, the app's own), the asset's symbol at the amount, and the amount that can be sent now, a value
//   and its symbol that fills the field when tapped: exactly the largest amount the amount check accepts (poolSendable),
//   so a tap never draws Insufficient or Try. No word is added: values, symbols and marks only.
// - A pasted To carries what a copy carries: every whitespace (spaces, a tab, a line break) and every invisible format
//   character (a zero-width space, a byte-order mark, a direction mark) is taken out before the check, anywhere in it
//   (toCleaned); anything else, a "solana:" link's prefix included, is checked as typed and refused. The To line drawn
//   before the press shows the address the check passed, the one handed over.
// - DOM by createElement and textContent only: the page's CSP requires Trusted Types for every script sink.
import { keccak_256 } from "@noble/hashes/sha3.js";
import { base58 } from "@scure/base";
import { nearestPlannable, plannableAmounts, planPoolWithdraw, poolWithdrawable, type WithdrawSource } from "../pool-withdraw.ts";
import { EVM_ADDRESS, SOL_KEY, SOLANA_RESERVED_KEYS, type PoolChain } from "../rules/pool.ts";
import { POOL_CHAIN_MARK } from "./chain-mark.ts";
import { CHECK_IDLE_MS, markDraft, WITHDRAW_WORDS } from "./form.ts";

// Kept as drafted, owner 8 Nov 07:55Z: withdraw, invalid-address, invalid-amount, insufficient, busy (the vault form's own),
// min, max-fee, try and or, fee-rose and fee-redraw. DRAFT COPY: To and Amount, the two labels the page does not hold.
export const POOL_WITHDRAW_WORDS = {
  to: WITHDRAW_WORDS.to,
  amount: WITHDRAW_WORDS.amount,
  withdraw: WITHDRAW_WORDS.withdraw,
  "invalid-address": WITHDRAW_WORDS["invalid-address"],
  "invalid-amount": WITHDRAW_WORDS["invalid-amount"],
  insufficient: WITHDRAW_WORDS.insufficient,
  min: "Min ", // the vault form's "Min $X" with the pool asset's amount: Min 0.00189 SOL; owner 8 Nov 07:55Z, kept
  busy: WITHDRAW_WORDS.busy,
  "max-fee": "Max fee", // the signing page's line for a checked pool payload (rules/pool.ts drawPool); owner 8 Nov 07:55Z, kept
  // an amount no plan sends exactly: the nearest that can be, "Try 0.5 or 0.6 SOL" (one side alone: "Try 0.5 SOL")
  try: "Try ", // owner 8 Nov 07:55Z, kept (pw.tryOne, pw.tryTwo)
  or: " or ", // owner 8 Nov 07:55Z, kept
  // a send owed whose fee rose past the Max fee drawn: "Network fee rose. New max fee: 0.000015 SOL." and its button
  "fee-rose": "Network fee rose. New max fee: ", // owner 8 Nov 07:55Z, kept (pw.feeRose)
  "fee-redraw": "Send at new fee", // owner 8 Nov 07:55Z, kept (pw.feeRoseSend)
} as const;

/** The keys of POOL_WITHDRAW_WORDS the owner has not picked: their elements keep data-draft-copy. */
export const POOL_DRAFT: ReadonlySet<string> = new Set(["to", "amount"]);

/** Each chain's pool asset, as the screen names it. */
export const POOL_ASSET: Readonly<Record<PoolChain, { symbol: string; decimals: number }>> = Object.freeze({
  solana: Object.freeze({ symbol: "SOL", decimals: 9 }),
  base: Object.freeze({ symbol: "ETH", decimals: 18 }),
  robinhood: Object.freeze({ symbol: "ETH", decimals: 18 }),
});

/** The pool's own addresses no withdraw may send to (the pin's). */
export type PoolKeys = { pool: string; program?: string; feePayer?: string };
/** What the screen reads at open and at the press: the notes it may spend, the epoch fee, W's own send fee and the
 *  smallest part. */
export type PoolFunds = { notes: readonly WithdrawSource[]; fee: bigint; wFee: bigint; minPart: bigint };

export type PoolAddressCode = "address";
export type PoolAmountCode = "amount" | "insufficient" | "min" | "unread" | "unplannable";
export type PoolAddressCheck = { ok: true; to: string } | { ok: false; code: PoolAddressCode };
export type PoolAmountCheck = { ok: true; amount: bigint; parts: number; maxFee: bigint } | { ok: false; code: PoolAmountCode; min?: bigint; below?: bigint; above?: bigint };
export type PoolFormState = "empty" | "typing" | "refused" | "ready";
export type PoolReady = Readonly<{ chain: PoolChain; to: string; amount: bigint; maxFee: bigint }>;
export type PoolFormView = { state: PoolFormState; address: PoolAddressCheck | null; amount: PoolAmountCheck | null; ready: PoolReady | null };

const EVM_ZERO = "0x0000000000000000000000000000000000000000";

/** EIP-55: the checksummed spelling of a 0x address (hex digit i upper case when nibble i of keccak256(lower) >= 8). */
export function eip55(address: string): string {
  const lower = address.slice(2).toLowerCase();
  const h = keccak_256(new TextEncoder().encode(lower));
  return "0x" + [...lower].map((c, i) => (((h[i >> 1]! >> (i % 2 === 0 ? 4 : 0)) & 15) >= 8 ? c.toUpperCase() : c)).join("");
}

/** Every whitespace and every invisible format character (Unicode Cf: zero-width space and joiners, the byte-order mark,
 *  the soft hyphen, the direction marks): what a paste carries around or inside an address. No address holds one. */
const UNSEEN = /[\p{White_Space}\p{Cf}]/gu;

/** A typed or pasted To with what a copy carries taken out (UNSEEN), anywhere in it; nothing else is changed. */
export const toCleaned = (raw: string): string => raw.replace(UNSEEN, "");

/** To, on the pool's chain. */
export function checkPoolTo(chain: PoolChain, raw: string, keys: PoolKeys): PoolAddressCheck {
  const to = toCleaned(raw);
  const no: PoolAddressCheck = { ok: false, code: "address" };
  if (chain === "solana") {
    if (!SOL_KEY(to) || base58.encode(base58.decode(to)) !== to) return no;
    // nor a key the runtime keeps read-only (a sysvar or a builtin program, System among them): nothing lands there
    if ([keys.pool, keys.program, keys.feePayer].includes(to) || SOLANA_RESERVED_KEYS.includes(to)) return no;
    return { ok: true, to };
  }
  if (!EVM_ADDRESS.test(to)) return no;
  const hex = to.slice(2);
  if (hex !== hex.toLowerCase() && hex !== hex.toUpperCase() && eip55(to) !== to) return no;
  const lower = to.toLowerCase();
  if (lower === EVM_ZERO || lower === keys.pool.toLowerCase()) return no;
  return { ok: true, to: eip55(to) };
}

/** A decimal in `decimals` digits as base units; null when it is not one. */
export function parseUnits(raw: string, decimals: number): bigint | null {
  const m = /^(\d{1,30})(?:\.(\d+))?$/.exec(raw.trim());
  if (!m || (m[2] !== undefined && m[2].length > decimals)) return null;
  return BigInt(m[1]!) * 10n ** BigInt(decimals) + BigInt((m[2] ?? "").padEnd(decimals, "0") || "0");
}

/** Base units as a plain decimal, no trailing zeros. */
export function formatUnits(units: bigint, decimals: number): string {
  const s = units.toString().padStart(decimals + 1, "0");
  const frac = s.slice(-decimals).replace(/0+$/, "");
  return frac ? `${s.slice(0, -decimals)}.${frac}` : s.slice(0, -decimals);
}

/** Amount, against the funds read: null funds are unread. */
export function checkPoolAmount(chain: PoolChain, raw: string, funds: PoolFunds | null): PoolAmountCheck {
  const amount = parseUnits(raw, POOL_ASSET[chain].decimals);
  if (amount === null || amount === 0n) return { ok: false, code: "amount" };
  if (funds === null) return { ok: false, code: "unread" };
  if (amount > poolWithdrawable(funds.notes, funds)) return { ok: false, code: "insufficient" };
  if (amount < funds.minPart) return { ok: false, code: "min", min: funds.minPart };
  const plan = planPoolWithdraw(funds.notes, amount, funds);
  if (plan === null) return { ok: false, code: "unplannable", ...nearestPlannable(funds.notes, amount, funds) };
  return { ok: true, amount, parts: plan.length, maxFee: BigInt(plan.length) * (funds.fee + funds.wFee) };
}

/** What can be sent now: the largest amount checkPoolAmount accepts, so not above poolWithdrawable (the Insufficient rule)
 *  and plannable (no Try); the largest plannable one when that is less. 0n when no amount can be. */
export function poolSendable(funds: PoolFunds): bigint {
  const most = poolWithdrawable(funds.notes, funds);
  let top = 0n;
  for (const [lo, hi] of plannableAmounts(funds.notes, funds)) {
    const x = hi < most ? hi : most;
    if (lo <= most && x > top) top = x;
  }
  return top >= funds.minPart && planPoolWithdraw(funds.notes, top, funds) !== null ? top : 0n;
}

/** The screen's view of both fields, checked now. */
export function evaluatePool(chain: PoolChain, to: string, amount: string, keys: PoolKeys, funds: PoolFunds | null): PoolFormView {
  const blankTo = toCleaned(to) === "";
  const blankAmount = amount.trim() === "";
  const a = blankTo ? null : checkPoolTo(chain, to, keys);
  const m = blankAmount ? null : checkPoolAmount(chain, amount, funds);
  const ready = a?.ok && m?.ok ? Object.freeze({ chain, to: a.to, amount: m.amount, maxFee: m.maxFee }) : null;
  const state: PoolFormState = blankTo && blankAmount ? "empty" : (a && !a.ok) || (m && !m.ok) ? "refused" : ready ? "ready" : "typing";
  return { state, address: a, amount: m, ready };
}

/** The words a refusal draws. */
export function poolRefusalWords(chain: PoolChain, code: PoolAddressCode | PoolAmountCode, min?: bigint, near: { below?: bigint; above?: bigint } = {}): string {
  const { symbol, decimals } = POOL_ASSET[chain];
  if (code === "unplannable") {
    const sides = [near.below, near.above].filter((x): x is bigint => x !== undefined).map((x) => formatUnits(x, decimals));
    return sides.length === 0 ? POOL_WITHDRAW_WORDS["invalid-amount"] : `${POOL_WITHDRAW_WORDS.try}${sides.join(POOL_WITHDRAW_WORDS.or)} ${symbol}`;
  }
  if (code === "unread") return POOL_WITHDRAW_WORDS.busy;
  if (code === "amount") return POOL_WITHDRAW_WORDS["invalid-amount"];
  if (code === "insufficient") return POOL_WITHDRAW_WORDS.insufficient;
  if (code === "min") return `${POOL_WITHDRAW_WORDS.min}${formatUnits(min ?? 0n, decimals)} ${symbol}`;
  return POOL_WITHDRAW_WORDS["invalid-address"];
}

export interface PoolWithdrawFormDeps {
  chain: PoolChain;
  keys: PoolKeys;
  /** The notes, the epoch fee and the smallest part, read on the device (a rejection leaves them unread). */
  funds(): Promise<PoolFunds>;
  /** The withdraw run; absent while the chain has no flow on this page. */
  handoff?: (r: PoolReady) => void | Promise<void>;
  /** The sends owed whose network fee rose past the Max fee drawn: each op id with the fee it now needs (lamports). */
  owedFees?: () => Promise<readonly { opId: string; need: bigint }[]>;
  /** Draws the Max fee again for that op at `need` (the fee shown): its owed send goes on with that ceiling. */
  redraw?: (opId: string, need: bigint) => Promise<void>;
}

type Button = (action: string, label: string, onClick: () => void) => HTMLButtonElement;

/** Draws the screen into `doc`; `button` is the page's own (the activation guard), `run` its step runner. */
export function drawPoolWithdrawForm(doc: Document, deps: PoolWithdrawFormDeps, button: Button, run: (step: () => Promise<void>) => void): HTMLElement {
  const { chain } = deps;
  const { symbol, decimals } = POOL_ASSET[chain];
  const form = doc.createElement("div");
  form.dataset.withdraw = "pool";
  form.dataset.chain = chain;
  form.dataset.state = "empty";
  // one column, no wider than the app's drawer: each field's name over its input, the symbol beside the amount's
  Object.assign(form.style, { display: "flex", flexDirection: "column", alignItems: "stretch", gap: "12px", maxWidth: "440px" });
  const field = (key: "to" | "amount") => {
    const label = doc.createElement("label");
    Object.assign(label.style, { display: "flex", flexWrap: "wrap", alignItems: "center", gap: "6px 8px" });
    const name = doc.createElement("span");
    name.textContent = POOL_WITHDRAW_WORDS[key];
    markDraft(name, key, POOL_DRAFT);
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
    if (key === "amount") {
      // the asset's symbol at the amount
      const unit = doc.createElement("span");
      unit.dataset.symbol = symbol;
      unit.textContent = symbol;
      Object.assign(unit.style, { flex: "none" });
      label.append(unit);
    }
    const line = doc.createElement("p");
    line.dataset.for = key;
    line.hidden = true;
    return { input, line, label };
  };
  // the chain: its mark in the app's round black badge, then its name
  const mark = POOL_CHAIN_MARK[chain];
  const head = doc.createElement("div");
  head.dataset.mark = chain;
  Object.assign(head.style, { display: "flex", alignItems: "center", gap: "8px", minHeight: "44px" });
  const badge = doc.createElement("span");
  Object.assign(badge.style, { display: "block", flex: "none", width: "20px", height: "20px", padding: `${Math.round(20 * mark.inset)}px`, boxSizing: "border-box", borderRadius: "50%", background: "#000", overflow: "hidden" });
  const logo = doc.createElement("img");
  logo.src = mark.logo;
  logo.alt = "";
  Object.assign(logo.style, { display: "block", width: "100%", height: "100%", objectFit: "contain" });
  badge.append(logo);
  const chainName = doc.createElement("span");
  chainName.textContent = mark.name;
  head.append(badge, chainName);
  const to = field("to");
  const amount = field("amount");
  // what can be sent now, a value and its symbol, drawn once the funds are read; a tap puts it in the amount. Its row
  // carries `hidden`, so a style given to the button itself (display) can never show it before the funds are read.
  const canRow = doc.createElement("div");
  canRow.dataset.row = "sendable";
  canRow.hidden = true;
  const sendable = doc.createElement("button");
  sendable.type = "button";
  sendable.dataset.action = "sendable";
  Object.assign(sendable.style, { minHeight: "44px", minWidth: "44px", padding: "0 12px", fontVariantNumeric: "tabular-nums" });
  canRow.append(sendable);
  // the lines shown before the press: where the money lands and the most the relayer takes
  const shown = doc.createElement("dl");
  shown.dataset.lines = "pool-withdraw";
  shown.hidden = true;
  const go = button("withdraw", POOL_WITHDRAW_WORDS.withdraw, () => run(withdraw));
  if (!deps.handoff) go.dataset.pending = "pool-withdraw";
  // a send owed whose fee rose: its line and its button, above the fields, once read
  const rose = doc.createElement("div");
  rose.dataset.lines = "fee-rose";
  rose.hidden = true;
  form.append(head, rose, to.label, to.line, amount.label, canRow, amount.line, shown, go);
  if (deps.owedFees && deps.redraw) {
    const redraw = deps.redraw;
    const owedFees = deps.owedFees;
    // the line drawn from a fresh read; the press reads again first (fold 2, review LOW 4): a fee that changed since
    // is drawn anew for the next press, a send no longer owed takes the line away, and only the fee shown is handed over
    const draw = (list: readonly { opId: string; need: bigint }[]): void => {
      const first = list[0];
      if (!first) {
        rose.replaceChildren();
        rose.hidden = true;
        return;
      }
      const p = doc.createElement("p");
      p.textContent = `${POOL_WITHDRAW_WORDS["fee-rose"]}${formatUnits(first.need, decimals)} ${symbol}.`;
      const again = button("fee-redraw", POOL_WITHDRAW_WORDS["fee-redraw"], () => {
        if (again.disabled) return;
        again.disabled = true;
        run(async () => {
          try {
            const now = (await owedFees()).find((x) => x.opId === first.opId);
            if (now?.need !== first.need) return draw(await owedFees());
            await redraw(first.opId, first.need);
            draw(await owedFees());
          } catch {
            again.disabled = false;
          }
        });
      });
      rose.replaceChildren(p, again);
      rose.hidden = false;
    };
    void owedFees().then(draw, () => {});
  }

  let funds: PoolFunds | null = null;
  const drawSendable = (): void => {
    const can = funds === null ? null : poolSendable(funds);
    canRow.hidden = can === null;
    sendable.disabled = !can;
    Object.assign(sendable.style, { opacity: can ? "" : "0.5", cursor: can ? "pointer" : "default" }); // 0: shown, not offered
    sendable.textContent = can === null ? "" : `${formatUnits(can, decimals)} ${symbol}`;
    if (can === null) delete sendable.dataset.value;
    else sendable.dataset.value = String(can);
  };
  const load = (): Promise<void> => deps.funds().then((f) => void (funds = f), () => void (funds = null)).then(drawSendable);
  let loaded = load();
  let seq = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let view: PoolFormView = { state: "empty", address: null, amount: null, ready: null };
  const line = (p: HTMLParagraphElement, c: PoolAddressCheck | PoolAmountCheck | null): void => {
    const code = c && !c.ok ? c.code : null;
    p.hidden = code === null;
    if (code === null) {
      delete p.dataset.refusal;
      delete p.dataset.draftCopy;
      return void p.replaceChildren();
    }
    p.dataset.refusal = code;
    markDraft(p, code === "unread" ? "busy" : code === "amount" ? "invalid-amount" : code === "address" ? "invalid-address" : code === "unplannable" ? "try" : code, POOL_DRAFT);
    const min = c && !c.ok && "min" in c ? c.min : undefined;
    const near = c && !c.ok && c.code === "unplannable" ? (c as { below?: bigint; above?: bigint }) : {};
    if (code !== "unread") return void (p.textContent = poolRefusalWords(chain, code, min, near));
    const again = doc.createElement("button");
    again.type = "button";
    again.dataset.action = "retry";
    again.textContent = poolRefusalWords(chain, code);
    again.addEventListener("click", () => {
      loaded = load();
      void check();
    });
    p.replaceChildren(again);
  };
  const draw = (v: PoolFormView): void => {
    view = v;
    form.dataset.state = v.state;
    line(to.line, v.address);
    line(amount.line, v.amount);
    shown.replaceChildren();
    shown.hidden = v.ready === null;
    if (v.ready) {
      for (const [key, value] of [["to", v.ready.to], ["max-fee", `${formatUnits(v.ready.maxFee, decimals)} ${symbol}`]] as const) {
        const dt = doc.createElement("dt");
        dt.textContent = POOL_WITHDRAW_WORDS[key];
        markDraft(dt, key, POOL_DRAFT);
        const dd = doc.createElement("dd");
        dd.textContent = value;
        dd.dataset.line = key;
        dd.style.overflowWrap = "anywhere"; // a whole address on a phone: it wraps, never wider than the screen
        shown.append(dt, dd);
      }
    }
    go.disabled = v.state !== "ready" || !deps.handoff;
  };
  const check = async (): Promise<PoolFormView | null> => {
    const at = ++seq;
    await loaded;
    const v = evaluatePool(chain, to.input.value, amount.input.value, deps.keys, funds);
    if (at !== seq) return null;
    draw(v);
    return v;
  };
  const typed = (): void => {
    clearTimeout(timer);
    seq += 1;
    const blank = toCleaned(to.input.value) === "" && amount.input.value.trim() === "";
    draw({ state: blank ? "empty" : "typing", address: null, amount: null, ready: null });
    if (!blank) timer = setTimeout(() => void check(), CHECK_IDLE_MS);
  };
  to.input.addEventListener("input", typed);
  amount.input.addEventListener("input", typed);
  // the tap on what can be sent: that amount in the field, checked now against the same funds
  sendable.addEventListener("click", () => {
    if (funds === null || sendable.disabled) return;
    amount.input.value = formatUnits(poolSendable(funds), decimals);
    clearTimeout(timer);
    void check();
  });

  // the press: the funds read again, both fields checked again; only the answer drawn goes on
  async function withdraw(): Promise<void> {
    const before = view.ready;
    if (!before || !deps.handoff) return;
    clearTimeout(timer);
    loaded = load();
    const v = await check();
    if (!v?.ready || v.ready.to !== before.to || v.ready.amount !== before.amount || v.ready.maxFee !== before.maxFee) return;
    await deps.handoff(v.ready);
  }
  draw(view);
  return form;
}
