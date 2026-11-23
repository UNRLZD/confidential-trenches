// Card avatar-letters-for-a-bare-sign: a token whose symbol is a bare "$" drew a blank avatar. The helper served JENSEN
// (solana:3a53XX4aZcFQx5kJ5iw2v8BWbdVpMTgXsWnMto2Zzray, symbol "$" in Jupiter's token list, read 23 Nov 19:4xZ) with
// icon true and its logo answered 204, so the avatar fell back to its letters; the "$" the letters drop left none, and
// discover-matches-the-main-app failed "no logo and no initials" at 1440, 1024 and 390 px (merge queue run 45248229006,
// test-browser (4), 19:28:06Z). A symbol the drop or the clean-up empties draws its own first two characters.
import assert from "node:assert/strict";
import { test } from "node:test";
import { avatarLetters } from "../src/screens/market/letters.ts";

test("a symbol draws its first two letters, a leading $ dropped, in compatibility form with no combining marks", () => {
  assert.equal(avatarLetters("BONK"), "BO");
  assert.equal(avatarLetters("$WIF"), "WI");
  assert.equal(avatarLetters("Ｐｅｐｅ"), "Pe");
  assert.equal(avatarLetters("éx"), "éx");
  assert.equal(avatarLetters("́ab"), "ab");
  assert.equal(avatarLetters("🐸frog"), "🐸f");
});

test("a symbol the $ drop or the clean-up leaves empty draws its own first two characters, never a blank avatar", () => {
  assert.equal(avatarLetters("$"), "$");
  assert.equal(avatarLetters("$$"), "$");
  assert.equal(avatarLetters("́̂"), "́̂");
  for (const s of ["$", "$$", "́", "⃝⃝⃝"]) assert.notEqual(avatarLetters(s), "", s);
});
