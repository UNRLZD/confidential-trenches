// What sits behind a sealed screen (the withdraw forms, the 12 words): the APP_HOST frame is out of the page there
// (src/frame-cover.ts), so the window shows SIGN_HOST's own ground under the sheet's scrim. Two directions for the owner's
// pick, drawn as src/backdrop.ts draws (createElement and the CSSOM only: the CSP allows no inline style), in the brand's
// own system: the ink, the paper's dots and the stacked dot logo (apps/terminal/src/shell/Logo.tsx, its lit layer over its
// cool layer). No word, no picture of any app's screen: the page serves any app. Neither is wired into src/main.ts until
// the pick; the one picked moves into src/backdrop.ts.
//   A, "mark": a quiet dot grid on the ink, the logo centred in the room the sheet leaves, a soft fall-off to the edges.
//   B, "light": the paper's dots lit from behind the sheet, larger and brighter near it and fading out across the ink, as
//      the logo's own dots are shaded; the logo small where the app's header carries it, so the eye keeps its place.

/** The app's widths (src/backdrop.ts). */
const PHONE = "(max-width: 767.98px)";
const FIT = "(min-width: 1024px)";
const z = (px: number, fit: boolean): string => (fit ? `clamp(${px * 0.72}px, ${(px / 1920) * 100}vw, ${px}px)` : `${px}px`);
/** The sheet's drawer width on a desktop (src/sheet.ts: the deposit sheet's 440 at the fit zoom). */
const DRAWER = 440;
const INK = "#0a0a0a";
const DOT = (a: number): string => `rgba(244,244,242,${a})`;

/** The logo's files: the stacked dot words, lit and cool, at the desktop and phone cuts. */
export interface LogoFiles {
  lit: string;
  cool: string;
  phoneLit: string;
  phoneCool: string;
}

export type Direction = "a" | "b";

export function drawSealedGround(doc: Document, dir: Direction, logo: LogoFiles): HTMLElement {
  const view = doc.defaultView!;
  const el = (tag: string, style: Partial<CSSStyleDeclaration>): HTMLElement => {
    const e = doc.createElement(tag);
    Object.assign(e.style, style);
    return e;
  };
  const root = el("div", { position: "fixed", inset: "0", background: INK, pointerEvents: "none", overflow: "hidden" });
  root.id = "backdrop";
  root.dataset.ground = dir;
  root.setAttribute("aria-hidden", "true");
  const field = el("div", { position: "absolute", inset: "0" });
  const glow = el("div", { position: "absolute", inset: "0" });
  const mark = el("div", { position: "absolute", display: "block" });
  const img = (src: string): HTMLImageElement => {
    const i = doc.createElement("img");
    i.alt = "";
    i.src = src;
    Object.assign(i.style, { position: "absolute", inset: "0", width: "100%", height: "100%", display: "block" });
    return i;
  };
  const cool = img(logo.cool);
  const lit = img(logo.lit);
  mark.append(cool, lit);
  root.append(field, glow, mark);
  const phone = view.matchMedia(PHONE);
  const fit = view.matchMedia(FIT);
  const lay = (): void => {
    const p = phone.matches;
    const f = fit.matches;
    cool.src = p ? logo.phoneCool : logo.cool;
    lit.src = p ? logo.phoneLit : logo.lit;
    // where the light sits (B): at the sheet's edge, mid height on a desktop, at the sheet's top on a phone
    const source = p ? "50% 12%" : `calc(100% - ${z(DRAWER, f)}) 50%`;
    if (dir === "a") {
      Object.assign(field.style, {
        backgroundImage: `radial-gradient(circle, ${DOT(0.14)} 1px, transparent 1.5px)`,
        backgroundSize: "14px 14px",
        backgroundPosition: "7px 7px",
      });
      Object.assign(glow.style, { background: `radial-gradient(ellipse 70% 70% at ${p ? "50% 6%" : `calc((100% - ${z(DRAWER, f)}) / 2) 50%`}, transparent 0%, ${INK} 100%)` });
      // the logo centred in the room the sheet leaves (left of the drawer; the strip over the 88% sheet on a phone): 2x its header cut on a desktop, its phone cut at 60% of the width on a phone
      const w = p ? Math.min(0.6 * view.innerWidth, 240) : 480;
      const h = p ? (w * 46) / 228 : (w * 51) / 240;
      Object.assign(mark.style, {
        width: `${w}px`,
        height: `${h}px`,
        left: p ? `calc(50% - ${w / 2}px)` : `calc((100% - ${z(DRAWER, f)}) / 2 - ${w / 2}px)`,
        top: p ? `calc(6vh - ${h / 2}px)` : `calc(50% - ${h / 2}px)`,
        opacity: "0.9",
      });
    } else {
      // two dot layers, the larger one held close to the light and the finer one wider, so the dots grow toward it
      Object.assign(field.style, {
        backgroundImage: `radial-gradient(circle, ${DOT(0.3)} 1.7px, transparent 2.2px)`,
        backgroundSize: "12px 12px",
        maskImage: `radial-gradient(ellipse ${p ? "90% 30%" : "45% 70%"} at ${source}, #000 0%, transparent 100%)`,
      });
      Object.assign(glow.style, {
        backgroundImage: `radial-gradient(circle, ${DOT(0.12)} 0.9px, transparent 1.4px), radial-gradient(ellipse ${p ? "120% 40%" : "70% 90%"} at ${source}, rgba(244,244,242,.07) 0%, transparent 70%)`,
        backgroundSize: "12px 12px, 100% 100%",
        backgroundPosition: "6px 6px, 0 0",
        maskImage: `radial-gradient(ellipse ${p ? "160% 60%" : "90% 120%"} at ${source}, #000 0%, transparent 100%)`,
      });
      // the logo where the app's header carries it (shell.css .ctlogo at 52.5%), lit
      const w = p ? 120 : 126;
      const h = p ? (w * 46) / 228 : (w * 51) / 240;
      Object.assign(mark.style, { width: `${w}px`, height: `${h}px`, left: p ? "16px" : z(16, f), top: p ? "14px" : z(14, f), opacity: "1" });
    }
  };
  lay();
  phone.addEventListener("change", lay);
  fit.addEventListener("change", lay);
  return root;
}
