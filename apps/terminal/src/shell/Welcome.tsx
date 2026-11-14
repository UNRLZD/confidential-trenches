import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import stack2xCool from "./brand/ct-stack-2x-cool.svg";
import stack2x from "./brand/ct-stack-2x.svg";
import wmCool from "./brand/wordmark-dots-header-1x-cool.svg";
import wm from "./brand/wordmark-dots-header-1x.svg";
import { startLoop } from "./loop/loop.ts";
import type { Scene } from "./loop/loop.ts";
import { REPO_ISSUES_URL } from "./repo.tsx";
import { markWelcomed, SLIDES, shouldWelcome, stepTo, SWIPE_PX, WELCOME_WORDS } from "./welcome.ts";
import type { WelcomeWordId } from "./welcome.ts";
import "./welcome.css";

// The welcome (owner ask, 14 Nov ~06:00Z): four slides over the app on a person's first visit in this browser, then
// never again. What it is, how it works, the four moves, and the risk with the repo for feedback. It is the one modal
// the owner asked for; nothing in a money flow waits on it. It closes on Skip, the close, Esc, a tap on the scrim or
// Start trading, and each writes WELCOME_KEY, so it does not come back. The arrow keys and a swipe move between slides.
// Its words and its state are welcome.ts (no assets, so node --test reads them). Drawn in document.body, outside
// #root's fit zoom, so its sizes are the screen's own px (desktop card, phone sheet).
// A browser whose storage cannot be read or written never shows it: a welcome it could not remember closing would come
// back on every visit. Every check and test browser starts with it closed (scripts/browsers.mjs); its own run is
// test/welcome/run.mjs, which draws it with `force`.

function W({ id }: { id: WelcomeWordId }) {
  const w = WELCOME_WORDS[id];
  return w.draft ? <span data-draft-copy={id}>{w.text}</span> : <>{w.text}</>;
}

function Brand() {
  return (
    <span className="wlc-brand" role="img" aria-label="Confidential Trenches by $UNRLZD">
      <span className="wlc-stack">
        <img src={stack2xCool} alt="" />
        <img src={stack2x} alt="" />
      </span>
      <span className="wlc-by" aria-hidden="true">
        <span>by</span>
        <span className="wlc-wm">
          <img src={wmCool} alt="" />
          <img src={wm} alt="" />
        </span>
      </span>
    </span>
  );
}

/** Slides 2 to 4: the 5 Nov loop and its two companions (loop/loop.ts), drawn on a canvas; one still frame when the
 *  person asks for reduced motion. Paper dots on ink, no words, so nothing in it is copy. */
function Art({ scene }: { scene: Scene }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const still = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    return startLoop(c, scene, { still });
  }, [scene]);
  return <canvas ref={ref} className="wlc-cv" data-scene={scene} aria-hidden="true" />;
}

const ART: (() => ReactNode)[] = [Brand, () => <Art scene="network" />, () => <Art scene="flow" />, () => <Art scene="words" />];
const TITLES: WelcomeWordId[] = ["s1Title", "s2Title", "s3Title", "s4Title"];
const BODIES: WelcomeWordId[] = ["s1Body", "s2Body", "s3Body", "s4Body"];

export function Welcome({ force = false }: { force?: boolean }) {
  const [open, setOpen] = useState(() => force || shouldWelcome());
  const [i, setI] = useState(0);
  const box = useRef<HTMLElement>(null);
  const x0 = useRef<number | null>(null);
  const close = useCallback(() => {
    markWelcomed();
    setOpen(false);
  }, []);
  const step = useCallback((by: -1 | 1) => setI((n) => stepTo(n, by) ?? n), []);

  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
      else if (e.key === "ArrowRight") step(1);
      else if (e.key === "ArrowLeft") step(-1);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [open, close, step]);
  // focus goes to the dialog itself (Tab then reaches its controls), so no button opens with a focus ring
  useEffect(() => {
    if (open) box.current?.focus({ preventScroll: true });
  }, [open]);

  if (!open || typeof document === "undefined") return null;
  const last = i === SLIDES - 1;
  const Art = ART[i]!;
  const down = (e: ReactPointerEvent) => {
    x0.current = e.clientX;
  };
  const up = (e: ReactPointerEvent) => {
    if (x0.current === null) return;
    const dx = e.clientX - x0.current;
    x0.current = null;
    if (Math.abs(dx) >= SWIPE_PX) step(dx < 0 ? 1 : -1);
  };

  return createPortal(
    <div className="wlc" data-welcome={i + 1}>
      <div className="wlc-scrim" onClick={close} />
      <section className="wlc-box" ref={box} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="wlc-title" onPointerDown={down} onPointerUp={up} onPointerCancel={() => (x0.current = null)}>
        <button type="button" className="wlc-x" aria-label={WELCOME_WORDS.close.text} data-control="welcome-close" onClick={close}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
            <path d="M3 3l8 8M11 3l-8 8" />
          </svg>
        </button>
        <div className={i === 0 ? "wlc-art" : "wlc-art cv"} data-art={i + 1}>
          <Art />
        </div>
        <div className="wlc-body" key={i}>
          <span className="wlc-n num">
            {i + 1} / {SLIDES}
          </span>
          <h2 id="wlc-title">
            <W id={TITLES[i]!} />
          </h2>
          <p>
            <W id={BODIES[i]!} />
            {last && (
              <>
                {" "}
                <a href={REPO_ISSUES_URL} target="_blank" rel="noopener noreferrer" data-control="welcome-feedback">
                  <W id="feedback" />
                </a>
              </>
            )}
          </p>
        </div>
        <div className="wlc-foot">
          <span className="wlc-dots" aria-hidden="true">
            {Array.from({ length: SLIDES }, (_, n) => (
              <i key={n} className={n === i ? "on" : undefined} />
            ))}
          </span>
          <span className="wlc-acts">
            {i === 0 ? (
              <button type="button" className="wlc-btn ghost" data-control="welcome-skip" onClick={close}>
                <W id="skip" />
              </button>
            ) : (
              <button type="button" className="wlc-btn ghost" data-control="welcome-back" onClick={() => step(-1)}>
                <W id="back" />
              </button>
            )}
            {last ? (
              <button type="button" className="wlc-btn acc" data-control="welcome-start" onClick={close}>
                <W id="start" />
              </button>
            ) : (
              <button type="button" className="wlc-btn" data-control="welcome-next" onClick={() => step(1)}>
                <W id="next" />
              </button>
            )}
          </span>
        </div>
      </section>
    </div>,
    document.body,
  );
}
