// Sign out's activation guard: Chromium's input protection for its permission and payment sheets
// (InputEventActivationProtector with DefaultInputProtectionPolicy::IsPossiblyUnintendedInteraction,
// default_input_protection_policy.cc:28-63), the same for mouse, touch, pen and keyboard. A press is refused when
//   - it is a repeated key (a key held down before the protection began, :39-41);
//   - it comes within PROTECT_MS of the input before it: every trusted pointerdown or keydown in the window
//     counts, refused or not, so a burst of clicks or keys stays refused until a 500 ms pause (:44-58);
//   - it, or its click, comes within PROTECT_MS of the button drawn, the page shown or the window focused (:60-62).
// A click with no press seen (an assistive tool's click) is its own press. Times are event.timeStamp /
// performance.now(), one clock. 500 ms is the default double-click interval on Windows and in Chromium.
export const PROTECT_MS = 500;

export type Press = { at: number; refused: boolean };

export interface ActivationGuard {
  // the button drawn, the page shown (pageshow, visibilitychange to visible) or the window focused, at `at`
  shown(at: number): void;
  // every trusted pointerdown or keydown in the window, capture phase (before the target sees it); returns the press's
  // verdict for a target that takes it as its press
  input(at: number, repeat: boolean): Press;
  // whether a trusted click at `clickAt` whose press was `press` (null: none seen) acts
  allows(press: Press | null, clickAt: number): boolean;
}

export function activationGuard(now: number): ActivationGuard {
  let shownAt = now;
  let lastInputAt = Number.NEGATIVE_INFINITY;
  return {
    shown(at) {
      shownAt = at;
    },
    input(at, repeat) {
      const refused = repeat || at - lastInputAt < PROTECT_MS;
      lastInputAt = at;
      return { at, refused };
    },
    allows(press, clickAt) {
      const p = press ?? { at: clickAt, refused: clickAt - lastInputAt < PROTECT_MS };
      return !p.refused && p.at - shownAt >= PROTECT_MS && clickAt - shownAt >= PROTECT_MS;
    },
  };
}
