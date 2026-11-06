// Card signer-guard-parser: a planted signer file the guard reads as one of its SIGNER_DEFS. Its signer is a typed-arrow
// const, which the name guard's `export const NAME (: type)? =` read stopped short of at the type's `=>`.
export const fixtureSignSell: (secretKey: Uint8Array, built: { chain: string }) => Uint8Array = (secretKey) => secretKey.slice(0, 1);
// a builder as a function expression is a signer too; a predicate is not
export const fixtureBuildSell = function (q: { chain: string }) {
  return q;
};
export const fixtureIsQuotedSell = (s: unknown) => s !== undefined;
export function isSignedSell(s: unknown): boolean {
  return s !== undefined;
}
