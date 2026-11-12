// The one way a live check reads a tape the helper still fills (card token-page-data-complete-and-fast): a cold Base or
// Robinhood tape past the helper's open bound answers 200 with what it holds and `filling: true` while its reads go on
// (apps/helper/src/data/evm/swaps.ts trades), and the token page shows it loading and reads it again (apps/terminal/src/
// screens/token/trades.ts followTape). A check reads such a tape again every FILL_POLL_MS until the mark goes, a read
// fails, or FILLED_MS from its first answer, and fails a tape still filling then, so no check goes green on a tape that
// never fills.
// Runs: once, no check of its own: the tape reader the checks share (tape-read.test.mjs holds it)

/** A filling tape is filled within this of its first answer [design: over twice the slowest measured, ten cold Base
 *  tapes and their charts opened at once on the public providers from the Mac: at a 12 s bound (2026-11-11 17:47Z)
 *  eight filled 1.0 to 20.2 s after their first answer; at the 8 s bound (17:56Z) three filled 4.3 to 5.9 s after it,
 *  and ten Robinhood ones answered whole by 7.8 s]. */
export const FILLED_MS = 45_000;
export const FILL_POLL_MS = 2_000;

/** Whether a tape's body is marked filling. */
export function fillingOf(body) {
  try {
    return JSON.parse(body).filling === true;
  } catch {
    return false;
  }
}

/** Reads the tape again (`get()`: { status, body }) until it is no longer filling, a read fails, or `filledMs`: the
 *  last read as { status, filling, shape, ms, reads, body? }, its `ms` from the first answer. */
export async function readFilled(get, shapeOf, { sleep = (ms) => new Promise((ok) => setTimeout(ok, ms)), filledMs = FILLED_MS, pollMs = FILL_POLL_MS } = {}) {
  const t0 = performance.now();
  let last = { status: 200, filling: true, ms: 0, reads: 0 };
  while (last.status === 200 && last.filling && performance.now() - t0 < filledMs) {
    await sleep(pollMs);
    const b = await get();
    last = { status: b.status, filling: b.status === 200 && fillingOf(b.body), shape: b.status === 200 ? shapeOf(b.body) : null, ms: Math.round(performance.now() - t0), reads: last.reads + 1, ...(b.status !== 200 ? { body: String(b.body ?? "").slice(0, 120) } : {}) };
  }
  return last;
}

/** The verdict on a filling tape's reads again (`filled`, readFilled's answer): ok only when a 200 tape with no mark
 *  came within FILLED_MS, and the line that says so. */
export function filledVerdict(filled) {
  const f = filled;
  const ok = f?.status === 200 && f.filling === false && f.shape === "tape" && Number.isSafeInteger(f.ms) && f.ms <= FILLED_MS;
  const text =
    f === undefined ? "filling, never read again"
    : f.status !== 200 ? `${f.status} ${f.body ?? ""} on read ${f.reads} after filling`
    : f.filling ? `still filling ${f.ms} ms after its first read (${f.reads} reads), past ${FILLED_MS} ms`
    : `filled ${f.ms} ms after its first read (${f.reads} reads)${f.ms > FILLED_MS ? `, past ${FILLED_MS} ms` : ""}${f.shape !== "tape" ? ` ${f.shape}` : ""}`;
  return { ok, text };
}
