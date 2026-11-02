// The shell's backdrop (card app-harness-signin-e2e; app.md BAR-03, l.1098: no blank frame over 100 ms across a hop).
// The APP_HOST frame is transparent until its document first paints, and the shell makes a new frame on every close of
// its layer (src/shell.ts), so for that moment the window showed this page's bare Canvas. Under the frame this draws
// the app's own boot frame (apps/terminal/index.html #boot and its shell.css rules) as plain shapes: the ink, and on a
// desktop width the screen's panel and the footer's rule, on a phone width the header's rule and the tab bar. The
// app's first paint covers it. No words, no images, no input: it is drawn once and never changes but for the width.
// DOM by createElement and the CSSOM only, as the rest of the shell (the CSP allows no inline style).

/** The app's widths: below 768 css px the phone form, from 1024 the desktop zoomed by viewport / 1920 in [0.72, 1]. */
const PHONE = "(max-width: 767.98px)";
const FIT = "(min-width: 1024px)";
/** A length of the 1920 design at the app's fit zoom (apps/terminal/src/shell/fit.ts), as CSS. */
const z = (px: number, fit: boolean): string => (fit ? `clamp(${px * 0.72}px, ${(px / 1920) * 100}vw, ${px}px)` : `${px}px`);

export function drawBackdrop(doc: Document): HTMLElement {
  const view = doc.defaultView!;
  const box = (style: Partial<CSSStyleDeclaration>): HTMLElement => {
    const e = doc.createElement("div");
    Object.assign(e.style, { position: "absolute", ...style });
    return e;
  };
  const root = doc.createElement("div");
  root.id = "backdrop";
  root.setAttribute("aria-hidden", "true");
  Object.assign(root.style, { position: "fixed", inset: "0", background: "#0a0a0a", pointerEvents: "none" });
  const panel = box({ background: "#0f0f0f", border: "1px solid #1f1f1f" });
  const rule = box({ left: "0", right: "0", height: "1px", background: "#151515" });
  const head = box({ top: "55px", left: "0", right: "0", height: "1px", background: "rgba(255,255,255,.05)" });
  const tabs = box({ left: "0", right: "0", bottom: "0", height: "68px", background: "rgb(9,9,9)", boxShadow: "inset 0 1px 0 rgba(255,255,255,.06)" });
  root.append(panel, rule, head, tabs);
  const phone = view.matchMedia(PHONE);
  const fit = view.matchMedia(FIT);
  const lay = (): void => {
    const p = phone.matches;
    const f = fit.matches;
    for (const e of [panel, rule]) e.style.display = p ? "none" : "block";
    for (const e of [head, tabs]) e.style.display = p ? "block" : "none";
    // desktop: header 60, the screen's title row 44 and gap 10, padding 8, footer 32 (shell.css .tb, .ft; discover.css .dsc)
    Object.assign(panel.style, {
      top: `calc(${z(60, f)} + ${z(54, f)})`,
      left: z(8, f),
      right: z(8, f),
      bottom: `calc(${z(32, f)} + ${z(8, f)})`,
      borderRadius: z(10, f),
    });
    rule.style.bottom = `calc(${z(32, f)} - 1px)`;
  };
  lay();
  phone.addEventListener("change", lay);
  fit.addEventListener("change", lay);
  return root;
}
