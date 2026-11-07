import { encode } from "uqr";

// The deposit address's QR, as R5 draws it (design/proto/assets/marks.js at design-lock-r5, made as UNRLZD's
// shell/funds/Qr.tsx): uqr at error correction H with a one-module border, one unit square per dark module, drawn as one
// SVG path in the text colour (deposit.css .qr). It encodes the address the checked quote holds and nothing else.

/** The QR of `text`: its width in modules and the path of its dark modules. */
export function qrOf(text: string): { n: number; d: string } {
  const { size, data } = encode(text, { ecc: "H", border: 1 });
  let d = "";
  data.forEach((row, y) => row.forEach((dark, x) => void (dark && (d += `M${x} ${y}h1v1h-1z`))));
  return { n: size, d };
}
