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

/** The logo's layers as image addresses: the stacked dot words, lit and cool, at the desktop and phone cuts. */
export interface LogoFiles {
  lit: string;
  cool: string;
  phoneLit: string;
  phoneCool: string;
}

/** The brand's own files as data: images (src/ground-logo.ts): the page loads nothing for its ground. */
export function groundLogo(svg: Readonly<LogoFiles>): LogoFiles {
  const url = (s: string): string => `data:image/svg+xml,${encodeURIComponent(s)}`;
  return { lit: url(svg.lit), cool: url(svg.cool), phoneLit: url(svg.phoneLit), phoneCool: url(svg.phoneCool) };
}

/** The sheet's drawer width on a desktop (src/sheet.ts: the deposit sheet's 440 at the fit zoom). */
const DRAWER = 440;
const INK = "#0a0a0a";

// The ground under a sealed screen (src/frame-cover.ts SEALED: the 12 words, Invalid code, the withdraw forms, held,
// the backup), the owner's pick A (12 Nov 16:17Z, docs/owner-decisions.md in the research repo): the APP_HOST frame is
// out of the page there, so the window shows this page's own ground under the sheet's scrim, in the brand's own system:
// a quiet dot grid on the ink, the stacked dot logo (apps/terminal/src/shell/Logo.tsx, its lit layer over its cool
// layer) centred in the room the sheet leaves, a soft fall-off to the edges. No word, no picture of any app's screen:
// the page serves any app. Hidden until the shell shows it (src/shell.ts: the frame out of the page); over the boot
// frame (drawBackdrop), under the frame and the sheet.
export function drawSealedGround(doc: Document, logo: LogoFiles): HTMLElement {
  const view = doc.defaultView!;
  const el = (tag: string, style: Partial<CSSStyleDeclaration>): HTMLElement => {
    const e = doc.createElement(tag);
    Object.assign(e.style, style);
    return e;
  };
  const root = el("div", { position: "fixed", inset: "0", background: INK, pointerEvents: "none", overflow: "hidden" });
  root.id = "ground";
  root.hidden = true;
  root.setAttribute("aria-hidden", "true");
  const field = el("div", {
    position: "absolute",
    inset: "0",
    backgroundImage: "radial-gradient(circle, rgba(244,244,242,0.14) 1px, transparent 1.5px)",
    backgroundSize: "14px 14px",
    backgroundPosition: "7px 7px",
  });
  const glow = el("div", { position: "absolute", inset: "0" });
  const mark = el("div", { position: "absolute", display: "block", opacity: "0.9" });
  const img = (): HTMLImageElement => {
    const i = doc.createElement("img");
    i.alt = "";
    Object.assign(i.style, { position: "absolute", inset: "0", width: "100%", height: "100%", display: "block" });
    return i;
  };
  const cool = img();
  const lit = img();
  mark.append(cool, lit);
  root.append(field, glow, mark);
  const phone = view.matchMedia(PHONE);
  const fit = view.matchMedia(FIT);
  const lay = (): void => {
    const p = phone.matches;
    const f = fit.matches;
    cool.src = p ? logo.phoneCool : logo.cool;
    lit.src = p ? logo.phoneLit : logo.lit;
    glow.style.background = `radial-gradient(ellipse 70% 70% at ${p ? "50% 6%" : `calc((100% - ${z(DRAWER, f)}) / 2) 50%`}, transparent 0%, ${INK} 100%)`;
    // the logo centred in the room the sheet leaves (left of the drawer; the strip over the 88% sheet on a phone): 2x
    // its header cut on a desktop, its phone cut at 60% of the width on a phone
    const w = p ? Math.min(0.6 * view.innerWidth, 240) : 480;
    const h = p ? (w * 46) / 228 : (w * 51) / 240;
    Object.assign(mark.style, {
      width: `${w}px`,
      height: `${h}px`,
      left: p ? `calc(50% - ${w / 2}px)` : `calc((100% - ${z(DRAWER, f)}) / 2 - ${w / 2}px)`,
      top: p ? `calc(6vh - ${h / 2}px)` : `calc(50% - ${h / 2}px)`,
    });
  };
  lay();
  phone.addEventListener("change", lay);
  fit.addEventListener("change", lay);
  return root;
}
