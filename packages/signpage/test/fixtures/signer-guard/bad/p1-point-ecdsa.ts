// planted (card signer-guard-parser, reviewer variant p1 of c00a169d, H1b): an ECDSA signature made from the curve's
// Point and its scalar field (Point.BASE.multiply, Point.Fn), with no sign of the curve's; secp256k1.verify accepts it
import { secp256k1 } from "@noble/curves/secp256k1.js";
const big = (b: Uint8Array) => BigInt("0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(""));
export const sign = (d: bigint, digest: Uint8Array, k: bigint) => {
  const P = secp256k1.Point;
  const F = P.Fn;
  const r = F.create(P.BASE.multiply(k).toAffine().x);
  const s = F.mul(F.inv(k), F.add(big(digest), F.mul(r, d)));
  return { r, s };
};
export const point = (b: Uint8Array) => secp256k1.Point.fromBytes(b).multiply(2n);
