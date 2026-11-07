import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useSigninSheet } from "../signin/source.tsx";
import { escapeCloses, locksPage, SHEET_START, sheetStep } from "./sheet.ts";
import type { SheetState } from "./sheet.ts";
import "./trade.css";

// The phone trade sheet (card app-phone-trade-sheet; A2.5, app.md:1450; 09-design-brief §6.5, F14; R5 token-390.html
// tradeSheet at design-lock-r5, the shape of UNRLZD's mobile/token/TradeSheet.tsx): the scrim, the grab handle, the
// caller's head row, then the box (TradeBox with the safety grid as its footer, as on desktop), in a sheet that scrolls
// on its own. The scrim, the handle and Escape close it. The box is mounted at the first open and only hidden on a close
// (sheet.ts), so every state the box draws (States.tsx), its route strip and its fill toast survive a close and a
// reopen; S8.12 keeps the sheet open (R5 token-390.html: "the sheet stays open", owner round 16). No dialog, no confirm.

/** The phone layout's media query (token.css, shell.css: the phone below 768 px). */
const PHONE = "(max-width: 767.98px)";

/** The sheet's state and its two moves, for the page that opens it. */
export function useTradeSheet(): { state: SheetState; open: () => void; close: () => void } {
  const [state, setState] = useState(SHEET_START);
  const open = useCallback(() => setState((s) => sheetStep(s, "open")), []);
  const close = useCallback(() => setState((s) => sheetStep(s, "close")), []);
  return { state, open, close };
}

/** `label` names the dialog (`Buy SYM`); `closeLabel` names the grab handle; `head` is the row above the box. */
export function TradeSheet({ state, onClose, label, closeLabel, head, children }: { state: SheetState; onClose: () => void; label: string; closeLabel: string; head: ReactNode; children: ReactNode }) {
  // the sign-in sheet opens over this one: its Escape closes only that
  const { open: signinOpen } = useSigninSheet();
  useEffect(() => {
    if (!state.open) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && escapeCloses(state.open, signinOpen) && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [state.open, signinOpen, onClose]);
  // only the phone page draws the sheet: a window that grows past it (a tablet turned sideways) closes it, so the
  // desktop page is never left locked under a sheet it does not draw
  useEffect(() => {
    if (!state.open) return;
    const phone = window.matchMedia(PHONE);
    const left = () => !phone.matches && onClose();
    phone.addEventListener("change", left);
    return () => phone.removeEventListener("change", left);
  }, [state.open, onClose]);
  const lock = locksPage(state);
  useEffect(() => {
    if (!lock) return;
    const was = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = was;
    };
  }, [lock]);
  if (!state.mounted) return null;
  return (
    <div className="tsh" data-sheet="trade" data-open={state.open}>
      <div className="tsh-scrim" onClick={onClose} />
      <div className="tsh-box" role="dialog" aria-modal="true" aria-label={label}>
        <button type="button" className="tsh-grab" aria-label={closeLabel} onClick={onClose}><i /></button>
        {head}
        {children}
      </div>
    </div>
  );
}
