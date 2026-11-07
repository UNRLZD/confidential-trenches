import { busy } from "./model.ts";
import type { Phase } from "./model.ts";

// The toast over the phone token page (card app-quick-buy-one-tap; 09-design-brief F14 step 2: a chip's buy shows
// Sending, then Landing, then the fill, one tap, no sheet). A chip's buy runs with the sheet closed, so the page draws
// it: the running buy and its end (the reason, with Retry) while the sheet is closed; the open sheet's button draws them
// there. The fill toast (S8.12) shows open or closed, as the box's own did. A toast closed by a tap, or the fill's own
// timeout, stays closed for that buy only.

export type ToastView = "run" | "fill" | "end" | null;

export function toastView(p: Phase, dismissed: string | null, sheetOpen: boolean): ToastView {
  if (p.k === "ready" || p.id === dismissed) return null;
  if (p.k === "filled") return "fill";
  if (sheetOpen) return null;
  return busy(p) ? "run" : "end";
}
