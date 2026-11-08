// One relayer answer's bytes, read with a cap (card wallet-refund-move): the bind's answer (./delegate.ts) and the
// refund move's (./refund.ts) are each read through it, so a hostile answer of any length costs at most `max` bytes.
/** The body's bytes, refused once they pass `max` (a declared or a streamed length), without reading the rest. */
export async function readCapped(res: Response, max: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > max) throw new Error(`relayer: an answer over ${max} B`);
  if (res.body === null) return new Uint8Array(0);
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel();
      throw new Error(`relayer: an answer over ${max} B`);
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
