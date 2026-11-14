// The one check the agent makes before it taps Confirm: no amount on the sheet is above --max.

/** The number at the start of a value such as "12.5 USDC" or "$12.50"; null when there is none. */
export function amountOf(value) {
  const m = /^\$?\s*([0-9]+(?:\.[0-9]+)?)\b/.exec(String(value).replace(/,/g, "").trim());
  return m ? Number(m[1]) : null;
}

/**
 * May the agent tap Confirm on a sheet whose `lines` are [label, value]? Every Amount line must read at most `max`; one
 * that is not a number ("All") is read as `balance`, what it sends. Answers { ok, why }.
 */
export function confirmOk(sheet, { max, balance }) {
  for (const [k, v] of sheet.lines.filter(([k]) => /amount/i.test(k))) {
    const n = amountOf(v) ?? (balance == null ? null : Number(balance));
    if (n === null || !Number.isFinite(n)) return { ok: false, why: `${k} ${v} is not an amount the agent can read` };
    if (n > max) return { ok: false, why: `${k} ${v} is above --max ${max}` };
  }
  return { ok: true, why: "" };
}
