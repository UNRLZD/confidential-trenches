/** The two letters a token avatar draws over its gradient (Avatar.tsx): the symbol's first two, a leading "$" dropped
 *  ("$WIF" draws WI), each letter in its compatibility form with no combining marks. A symbol that leaves none draws
 *  its own first two characters (card avatar-letters-for-a-bare-sign: JENSEN's symbol is a bare "$", and with its logo
 *  answering 204 the avatar was blank). */
export function avatarLetters(symbol: string): string {
  const two = (s: string) => Array.from(s).slice(0, 2).join("");
  return two(symbol.replace(/^\$/, "").normalize("NFKC").replace(/\p{M}/gu, "")) || two(symbol);
}
