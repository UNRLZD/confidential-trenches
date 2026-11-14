// SIGN_HOST's one sheet (card signing-views-open-over-the-app): every screen this page draws (sign-in in each way, the
// 12 words, sign-out, the withdraw forms) opens in it, over the APP_HOST frame, instead of as a page of its own. It is
// the terminal's deposit sheet (apps/terminal/src/screens/deposit/deposit.css .dep, .dep-scrim, .dep-box, .dhd, .dep-x,
// .dbody, .dbtn and the phone block), drawn here by createElement and the CSSOM only (the CSP allows no inline style
// and no stylesheet but 'self'): on a desktop width the 440 drawer on the right at the app's fit zoom, on a phone width
// the sheet from the bottom at 88% with its grab, the scrim over the app in both. The close control is the deposit
// sheet's own: the x icon, its accessible name the owner's "Close" (apps/terminal/src/screens/deposit/words.ts close).
// No word is drawn here: the screens' own words stay theirs (src/main.ts WORDS, src/withdraw/).
//
// Everything here is this document's: the APP_HOST frame is a child frame and cannot draw over, read or reach it.

/** The app's widths (src/backdrop.ts): below 768 css px the phone form, from 1024 the desktop at its fit zoom. */
const PHONE = "(max-width: 767.98px)";
const FIT = "(min-width: 1024px)";
const z = (px: number, fit: boolean): string => (fit ? `clamp(${px * 0.72}px, ${(px / 1920) * 100}vw, ${px}px)` : `${px}px`);

/** The deposit sheet's tokens (deposit.css .dep) and the app's text and font tokens (shell.css :root). */
export const T = {
  drawer: "#0c0c0c", panel: "#111111", border: "#1f1f1f", strong: "#2a2a2a", paper: "#f4f4f2", onPaper: "#0a0a0a",
  text1: "#f4f4f2", text2: "#a3a3a3", text3: "#6e6e6e", off: "#181818", sell: "#ff5d4d",
  // The page loads no font file (CSP font-src 'self', no face shipped), so the number font is the device's own: Chrome
  // has no ui-monospace and its bare monospace is Courier, so the stack names each system's mono face before the generic.
  ui: '"Schibsted Grotesk", system-ui, sans-serif',
  num: '"Chivo Mono", ui-monospace, "SF Mono", Menlo, Consolas, "Roboto Mono", "DejaVu Sans Mono", "Liberation Mono", monospace',
} as const;

export interface Sheet {
  /** The layer: the scrim and the sheet, hidden until the shell opens it. */
  layer: HTMLElement;
  /** Where the screens draw. */
  body: HTMLElement;
  /** The close control (the x), shown only while the screen on it may be left. */
  close: HTMLButtonElement;
  /** The scrim over the app. */
  scrim: HTMLElement;
  /** The sheet's box, focused when it opens so Esc reaches this document. */
  box: HTMLElement;
}

const SVG = "http://www.w3.org/2000/svg";

export function drawSheet(doc: Document): Sheet {
  const view = doc.defaultView!;
  const el = (tag: string, style: Partial<CSSStyleDeclaration> = {}): HTMLElement => {
    const e = doc.createElement(tag);
    Object.assign(e.style, style);
    return e;
  };
  const layer = el("section", { position: "fixed", inset: "0", zIndex: "1" });
  layer.id = "screen";
  layer.hidden = true;
  const scrim = el("div", { position: "absolute", inset: "0" });
  scrim.dataset.sheet = "scrim";
  const box = el("aside", { position: "absolute", display: "flex", flexDirection: "column", boxSizing: "border-box", outline: "none", color: T.text1, fontFamily: T.ui });
  box.dataset.sheet = "box";
  box.tabIndex = -1;
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "true");
  const grab = el("div", { justifyContent: "center", height: "21px", paddingTop: "8px", flex: "none", boxSizing: "border-box" });
  const grabBar = el("i", { width: "38px", height: "5px", borderRadius: "3px", background: "#333", display: "block" });
  grab.append(grabBar);
  const head = el("div", { flex: "none", display: "flex", alignItems: "center", justifyContent: "flex-end", boxSizing: "border-box" });
  const close = doc.createElement("button");
  close.type = "button";
  close.dataset.sheet = "close";
  close.setAttribute("aria-label", "Close");
  Object.assign(close.style, { display: "flex", alignItems: "center", justifyContent: "center", color: T.text2, border: "0", padding: "0", cursor: "pointer" });
  // the app's x icon (apps/terminal/src/screens/signin/Icon.tsx x, at the deposit sheet's 14 px and stroke 1.4)
  if (typeof doc.createElementNS === "function") {
    const svg = doc.createElementNS(SVG, "svg");
    for (const [k, v] of [["width", "14"], ["height", "14"], ["viewBox", "0 0 12 12"], ["fill", "none"], ["stroke", "currentColor"], ["stroke-width", "1.4"], ["stroke-linecap", "round"], ["aria-hidden", "true"]]) svg.setAttribute(k!, v!);
    const path = doc.createElementNS(SVG, "path");
    path.setAttribute("d", "M2 2l8 8M10 2L2 10");
    svg.append(path);
    close.append(svg);
  }
  head.append(close);
  const body = el("div", { flex: "1", minHeight: "0", overflow: "auto", display: "flex", flexDirection: "column", gap: "12px", boxSizing: "border-box" });
  body.dataset.sheet = "body";
  box.append(grab, head, body);
  layer.append(scrim, box);

  const phone = view.matchMedia?.(PHONE);
  const fit = view.matchMedia?.(FIT);
  const lay = (): void => {
    const p = phone?.matches ?? false;
    const f = fit?.matches ?? false;
    scrim.style.background = p ? "rgba(0,0,0,.6)" : "rgba(5,5,5,.5)";
    Object.assign(box.style, p
      ? { top: "auto", right: "0", bottom: "0", left: "0", width: "auto", height: "88%", borderLeft: "0", background: T.panel, borderRadius: "26px 26px 0 0", boxShadow: "inset 0 1px 0 rgba(255,255,255,.07)", paddingBottom: "8px" }
      : { top: "0", right: "0", bottom: "0", left: "auto", width: z(440, f), height: "auto", borderLeft: `1px solid ${T.border}`, background: T.drawer, borderRadius: "0", boxShadow: "none", paddingBottom: "0" });
    grab.style.display = p ? "flex" : "none";
    Object.assign(head.style, p ? { height: "48px", borderBottom: "0", padding: "0 12px 0 16px" } : { height: z(56, f), borderBottom: `1px solid ${T.border}`, padding: `0 ${z(10, f)} 0 ${z(16, f)}` });
    Object.assign(close.style, p ? { width: "44px", height: "44px", borderRadius: "14px", background: T.off } : { width: z(40, f), height: z(40, f), borderRadius: z(10, f), background: "none" });
    body.style.padding = p ? "4px 16px 16px" : z(16, f);
    for (const e of Array.from(body.querySelectorAll?.("*") ?? [])) dress(e as HTMLElement, p);
  };
  lay();
  phone?.addEventListener("change", lay);
  fit?.addEventListener("change", lay);
  // the screens draw and redraw their own parts (src/main.ts show(), src/withdraw/): each element that comes is dressed,
  // and a button again when its disabled changes, so Withdraw is drawn offered once the form is ready
  const MO = (view as unknown as { MutationObserver?: typeof MutationObserver }).MutationObserver;
  if (MO) {
    new MO((records) => {
      const p = phone?.matches ?? false;
      for (const r of records) {
        if (r.type === "attributes") dress(r.target as HTMLElement, p);
        for (const n of Array.from(r.addedNodes)) {
          if (n.nodeType !== 1) continue;
          dress(n as HTMLElement, p);
          for (const e of Array.from((n as HTMLElement).querySelectorAll("*"))) dress(e as HTMLElement, p);
        }
      }
    }).observe(body, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled"] });
  }
  return { layer, body, close, scrim, box };
}

/** One element of a screen in the deposit sheet's look: its buttons, fields, lines and the 12 words' list. */
export function dress(e: HTMLElement, phone: boolean): void {
  const s = e.style;
  switch (e.tagName) {
    case "MAIN":
      Object.assign(s, { display: "flex", flexDirection: "column", gap: "12px", margin: "0" });
      break;
    case "BUTTON": {
      if (e.dataset.sheet === "close") return;
      if (e.dataset.action === "sendable") {
        // what can be sent (src/withdraw/pool-form.ts): a value the user taps to fill the amount, never a main button
        Object.assign(s, {
          display: "inline-flex", alignItems: "center", width: "auto", height: "auto", minHeight: phone ? "44px" : "36px", padding: "0 12px",
          borderRadius: "10px", border: `1px solid ${T.border}`, background: T.panel, color: T.text1, font: `500 14px ${T.num}`, cursor: "pointer", flex: "none",
        });
        return;
      }
      const quiet = e.dataset.action === "cancel" || (e as HTMLButtonElement).disabled;
      // .dbtn and .dbtn.paper; Cancel and a control not offered as .dbtn.off
      Object.assign(s, {
        height: phone ? "56px" : "52px", borderRadius: phone ? "16px" : "13px", font: `600 ${phone ? 17 : 16}px ${T.ui}`, width: "100%",
        display: "flex", alignItems: "center", justifyContent: "center", border: "0", padding: "0 16px", flex: "none", cursor: "pointer",
        background: quiet ? T.off : T.paper, color: quiet ? (e.dataset.action === "cancel" ? T.text1 : T.text3) : T.onPaper,
      });
      break;
    }
    case "INPUT":
    case "TEXTAREA":
      Object.assign(s, {
        width: "100%", boxSizing: "border-box", background: T.panel, border: `1px solid ${T.border}`, borderRadius: "12px", color: T.text1,
        font: `15px ${e.tagName === "TEXTAREA" ? T.num : T.ui}`, padding: "12px 14px", outline: "none", resize: "none",
      });
      if (e.tagName === "INPUT") s.height = phone ? "52px" : "48px";
      break;
    case "OL":
      Object.assign(s, { display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: "8px", margin: "0", padding: "0", listStylePosition: "inside", counterReset: "none" });
      break;
    case "LI":
      Object.assign(s, { background: T.panel, border: `1px solid ${T.border}`, borderRadius: "10px", padding: "10px 8px", font: `14px ${T.num}`, color: T.text1, minWidth: "0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" });
      break;
    case "P":
    case "DD":
      Object.assign(s, { margin: "0", font: `14px/1.45 ${T.ui}`, color: T.text2 });
      break;
    case "LABEL":
    case "DT":
    case "SPAN":
      if (e.closest?.("li")) return;
      Object.assign(s, { font: `500 13px ${T.ui}`, color: T.text2 });
      break;
    case "DL":
      Object.assign(s, { margin: "0", display: "grid", gridTemplateColumns: "auto 1fr", gap: "6px 12px" });
      break;
    case "A":
      Object.assign(s, { color: T.text1, font: `14px ${T.ui}` });
      break;
  }
}
