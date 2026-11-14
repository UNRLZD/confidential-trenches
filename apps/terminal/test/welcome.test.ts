// The welcome (src/shell/Welcome.tsx; owner ask 14 Nov ~06:00Z): it opens only on a first visit whose storage works,
// closes for good, steps within its four slides, and its words keep CT's copy rules (relayed 14 Nov): no address or
// speed, every word with its source. The banned words are push-card's scan, over every file a card changes. The drawn welcome is test/welcome/run.mjs.
import assert from "node:assert/strict";
import { test } from "node:test";
import { markWelcomed, SLIDES, shouldWelcome, stepTo, WELCOME_KEY, WELCOME_WORDS } from "../src/shell/welcome.ts";

const mem = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
};
const broken = { getItem: () => { throw new Error("SecurityError"); }, setItem: () => { throw new Error("QuotaExceededError"); } };

test("a first visit opens it; a close marks the store and it never opens again", () => {
  const s = mem();
  assert.equal(shouldWelcome(s), true);
  markWelcomed(s);
  assert.equal(s.m.get(WELCOME_KEY), "1");
  assert.equal(shouldWelcome(s), false);
});

test("a browser whose storage is missing or throws never shows it (it could not remember a close)", () => {
  assert.equal(shouldWelcome(null), false);
  assert.equal(shouldWelcome(broken), false);
  assert.doesNotThrow(() => markWelcomed(broken));
  assert.doesNotThrow(() => markWelcomed(null));
});

test("keys and swipes step within the four slides and stop at the ends", () => {
  assert.equal(SLIDES, 4);
  assert.equal(stepTo(0, -1), null);
  assert.equal(stepTo(0, 1), 1);
  assert.equal(stepTo(2, 1), 3);
  assert.equal(stepTo(3, 1), null);
  assert.equal(stepTo(3, -1), 2);
});

test("words: each has its source, none names an address or a speed", () => {
  for (const [k, w] of Object.entries(WELCOME_WORDS)) {
    assert.ok(w.text.length > 0 && w.source.length > 0, k);
    const t = w.text.toLowerCase();
    assert.ok(!/0x[0-9a-f]{6}|\.near\b|\b\d+(\.\d+)?\s?(ms|s|sec|seconds|minutes)\b/.test(t), `${k}: an address or a speed`);
  }
});
