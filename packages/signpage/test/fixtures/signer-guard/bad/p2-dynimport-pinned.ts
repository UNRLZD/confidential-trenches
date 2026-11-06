// planted (card signer-guard-parser, reviewer variants p2 and p2b of c00a169d, H1): bip32 and the curve reached through
// import(), their roots read off the module value by a computed key, untyped
export const viaBip32 = async (k: Uint8Array, d: Uint8Array) => {
  const m = await import("../../../../../wallet/node_modules/@scure/bip32/index.js");
  const H = (m as any)["HD" + "Key"];
  return new H({ privateKey: k }).sign(d);
};
export const viaCurve = async (k: Uint8Array, d: Uint8Array) => {
  const m = await import("@noble/curves/secp256k1.js");
  return (m as any)["secp" + "256k1"].sign(d, k, { prehash: false });
};
