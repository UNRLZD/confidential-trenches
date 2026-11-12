// The message a vendor answered a refusal with, as the helper passed it on (card helper-says-why-a-vendor-refused): live
// runs 43276439006 and 43289730843 had every 1Click quote answered 400 and no BAD line said why. The live checks that read
// the helper's 1Click proxy keep it in their record and print it on their BAD line. Hostile input: only strings are read,
// every control or line-separator character is a space, and it is cut to SAID_MAX characters.

/** The most of a vendor's message a check keeps, as the helper's own log line (apps/helper/src/proxy/proxy.ts
 *  VENDOR_MESSAGE_MAX). */
export const SAID_MAX = 200;

/** The vendor's message in a JSON body's text: `message` (a string, or strings joined), else `error` as a string or its
 *  `message`; null when it holds none or is not JSON. */
export function saidOf(text) {
  let b;
  try {
    b = typeof text === "string" ? JSON.parse(text) : text;
  } catch {
    return null;
  }
  if (typeof b !== "object" || b === null) return null;
  const m = b.message;
  const e = b.error;
  const raw = typeof m === "string" ? m
    : Array.isArray(m) && m.length > 0 && m.every((x) => typeof x === "string") ? m.slice(0, 8).join("; ")
    : typeof e === "string" ? e
    : typeof e === "object" && e !== null && typeof e.message === "string" ? e.message
    : typeof e === "object" && e !== null && typeof e.code === "string" ? `the helper's ${e.code}`
    : null;
  return raw === null ? null : [...raw.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")].slice(0, SAID_MAX).join("");
}

/** A BAD line's tail for a refusal's message: ` "<message>"`, or "" when there is none. */
export const saidPart = (message) => (typeof message === "string" && message !== "" ? ` ${JSON.stringify(message)}` : "");
