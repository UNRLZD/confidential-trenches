// The phone trade sheet's open state (card app-phone-trade-sheet; A2.5, app.md:1450; 09-design-brief §6.5 and F14). The
// sheet's box is mounted at its first open and stays mounted when the sheet closes: a buy still Sending or Landing, its
// route strip and its fill toast live in the box, so a close and a reopen show the trade where it is, never a fresh
// Ready box beside a buy that still runs. A closed sheet is only hidden.

export interface SheetState {
  /** The box has been drawn once; it stays drawn from then on. */
  mounted: boolean;
  open: boolean;
}

export const SHEET_START: SheetState = { mounted: false, open: false };

/** The next state: an open mounts the box and shows it; a close hides it and keeps it mounted. */
export function sheetStep(s: SheetState, ev: "open" | "close"): SheetState {
  if (ev === "open") return s.open && s.mounted ? s : { mounted: true, open: true };
  return s.open ? { mounted: s.mounted, open: false } : s;
}

/** Escape closes the trade sheet only while it is open and no sheet is over it (the sign-in sheet takes its own Escape). */
export const escapeCloses = (open: boolean, over: boolean): boolean => open && !over;

/** The page behind stops scrolling only while the sheet is open. */
export const locksPage = (s: SheetState): boolean => s.open;
