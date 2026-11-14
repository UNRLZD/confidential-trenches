// The welcome's state (whether it opens, where a key or swipe leads) and every word it draws (shell/Welcome.tsx). The
// words are in the shape of the screens' words.ts: each with where it came from;
// a word the owner has not picked is `draft: true`, drawn with data-draft-copy. The owner asked for it on 14 Nov ~06:00Z
// ("a welcome pop-up ... 3-4 slides ... what is the architecture, how it works, risk and notice ... don't over
// explain") and picks on the words pages (round 1 https://claude.ai/artifact/WZMM7eSuntvTFEqr6aAwAw, round 2
// https://claude.ai/artifact/WiqGMdcAGrL8beVtPzW32u, round 3 https://claude.ai/artifact/2A2c9tfhLEXYTdRpNYhHLh). The
// art draws no words (loop/loop.ts).
// "1 / 4" and the 12 in "12 words" are data. None names an address, a proof, a fresh wallet or a speed.

export interface Word {
  text: string;
  source: string;
  draft: boolean;
}

const PAGE = "owner ask 14 Nov ~06:00Z; shown on the round 1 to 3 pages, not picked on its own";
const draft = (text: string): Word => ({ text, source: PAGE, draft: true });
const ok = (text: string, source: string): Word => ({ text, source, draft: false });

const S1 = 'owner 14 Nov 07:17Z, typed on the words page https://claude.ai/artifact/WZMM7eSuntvTFEqr6aAwAw (slide 1 note); kept as written 07:58Z ("as written, we build the product as its full potential")';
const R3 = "owner 14 Nov 09:54Z, slide 4 B on the round 3 page https://claude.ai/artifact/2A2c9tfhLEXYTdRpNYhHLh";
const R2 = (pick: string) => `owner 14 Nov 09:31Z, ${pick} on the round 2 page https://claude.ai/artifact/WiqGMdcAGrL8beVtPzW32u`;

export const WELCOME_WORDS = {
  // the owner's own words (round 22, 26 Oct: no market as the product's limit)
  s1Title: ok("Welcome to Confidential Trenches", S1),
  s1Body: ok("Built on top of NEAR Intents, CT allows you to trade confidentially any token, on any chain without any limit and compromise.", S1),
  s2Title: ok("Only you can sign", R2("slide 2 A")),
  s2Body: ok(
    "Your money sits in contracts with no admin, no upgrade and no pause, so nobody else can freeze or move it, us included. Every key lives on your device. Our server pays the fees and can't change a byte of what you sign.",
    R2("slide 2 A"),
  ),
  s3Title: ok("Any token in, any chain out", R2("slide 3 B")),
  s3Body: ok(
    "BTC, ETH, SOL, USDC, most of what NEAR Intents carries. Send it in and it becomes one balance you can trade from on any chain, then withdraw to any address in the token you pick.",
    R2("slide 3 B"),
  ),
  s4Title: ok("Real money, early code", R3),
  s4Body: ok(
    "Confidential Trenches is two weeks old and hasn't been run at scale. There's no admin key anywhere, so there's no undo for a mistake, yours or ours. Put in only what you can afford to lose, and keep your 12 words on paper, because we never see them and can't hand them back.",
    R3,
  ),
  feedback: draft("Feedback on GitHub"),
  // the controls
  skip: draft("Skip"),
  back: draft("Back"),
  next: draft("Next"),
  start: draft("Start trading"),
  close: ok("Close", "owner 1 Nov 16:45Z (Keep the drafts); the close icon's accessible name only (never drawn), as src/screens/deposit/words.ts close"),
} as const satisfies Record<string, Word>;

export type WelcomeWordId = keyof typeof WELCOME_WORDS;

/** The app's own storage key (as src/screens/signin/hint.ts's ct-signin-hint): "1" once the welcome was closed. */
export const WELCOME_KEY = "ct-welcome";
export const SLIDES = 4;
/** A swipe moves a slide past this many px across. */
export const SWIPE_PX = 48;

type Store = Pick<Storage, "getItem" | "setItem">;
const store = (): Store | null => {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
};

/** Whether the welcome opens: only when the store reads and holds no closed mark. */
export function shouldWelcome(s: Store | null = store()): boolean {
  if (!s) return false;
  try {
    return s.getItem(WELCOME_KEY) !== "1";
  } catch {
    return false;
  }
}

export function markWelcomed(s: Store | null = store()): void {
  try {
    s?.setItem(WELCOME_KEY, "1");
  } catch {
    // nothing to keep it in: shouldWelcome reads the same store and shows nothing either
  }
}

/** The slide a key or a swipe leads to, or null to stay. */
export function stepTo(i: number, by: -1 | 1): number | null {
  const j = i + by;
  return j < 0 || j >= SLIDES ? null : j;
}
