// Sign-in with a passkey whose PRF output unlocks the seed (docs/plan1/wallet.md §2.2 :47-56 at research ffcba5e; the
// ceremony and its cases are docs/spec/06b-wallet-webapp.md §1.1 :312-368, with rp.id moved from APP_HOST to SIGN_HOST,
// owner-decisions.md:263). Runs top-level on SIGN_HOST only.
//
// - create and get name rp.id = SIGN_HOST exactly, never a parent domain: a parent rp.id would let another page under it
//   run the same ceremony and get the same PRF output, so the same seed (wallet.md:53-55, S-B1, S-B5).
// - The PRF input is the frozen PRF_INPUT; the 32-byte output goes straight into entropyFromPrf (HKDF-SHA256, salt
//   "confidential-trenches/v1", info "wallet/entropy", 16 B, wallet.md:47) and is wiped; the entropy's 12 words give
//   seed64, the ikm of every HKDF-SHA512 derivation of wallet.md:70-88. Nothing here sends anything anywhere: the PRF
//   output comes in from the OS sheet and never goes out (wallet.md:930, :956).
// - rp.name is UNRLZD (owner brand-1, owner-decisions.md:136); user.name and displayName are CN-44's signed words
//   "Trading account" (09-design-brief.md:2338). user.id is 16 random bytes, the challenge 32 (06b:318-320): no server
//   checks either, the credential only produces the seed.
// - It runs top-level only: in a frame both calls refuse before the sheet is asked (wallet.md:921-922).
// - Every answer of the OS sheet is checked; a passkey without PRF is its own outcome ("no-prf"), never a silent
//   fallback to some other seed: the caller opens the no-PRF path (wallet.md:48; card wallet-typed-words).
import { PRF_INPUT, SIGN_HOST } from "../derive/constants.ts";
import { entropyFromPrf } from "../derive/keys.ts";

export const RP_NAME = "UNRLZD"; // owner brand-1 (owner-decisions.md:136); passkeys keep the name they were made with
export const USER_NAME = "Trading account"; // CN-44, signed (09-design-brief.md:2338)

export type PasskeyOutcome =
  | { kind: "prf"; entropy: Uint8Array; credentialId: Uint8Array } // the seed's 16 bytes; the caller keeps them on SIGN_HOST
  | { kind: "no-prf"; credentialId: Uint8Array | null } // a passkey with no PRF: open the no-PRF path, make nothing here
  | { kind: "cancelled" } // NotAllowedError: the user closed the sheet or it timed out; nothing made (06b:366)
  | { kind: "unsupported" }; // no WebAuthn in this browser: the 12 words only (06b:367)

export interface PasskeyEnv {
  credentials?: CredentialsContainer; // navigator.credentials unless a test says
  hasWebAuthn?: boolean; // typeof PublicKeyCredential !== "undefined" unless a test says
  random?: (b: Uint8Array<ArrayBuffer>) => unknown; // crypto.getRandomValues unless a test says
  hostname?: string; // location.hostname unless a test says
  topLevel?: boolean; // window.top === window unless a test says
}

const prfInput = (): Uint8Array<ArrayBuffer> => new TextEncoder().encode(PRF_INPUT);
const prfExt = () => ({ prf: { eval: { first: prfInput() } } });

function envOf(env: PasskeyEnv) {
  const random = env.random ?? ((b: Uint8Array<ArrayBuffer>) => globalThis.crypto.getRandomValues(b));
  const bytes = (n: number): Uint8Array<ArrayBuffer> => {
    const b = new Uint8Array(n);
    random(b);
    return b;
  };
  const hostname = env.hostname ?? globalThis.location?.hostname;
  // The ceremony runs on SIGN_HOST itself: the browser would refuse rp.id SIGN_HOST elsewhere anyway, and a copy of
  // this code on another page must not even try.
  if (hostname !== SIGN_HOST) throw new Error(`passkey sign-in runs on ${SIGN_HOST} only`);
  // Sign-in runs top-level only, never in a frame (wallet.md:921-922): a framing page could hide the sheet's context.
  const w = globalThis as { window?: { top?: unknown } };
  const topLevel = env.topLevel ?? (w.window !== undefined && w.window.top === w.window);
  if (!topLevel) throw new Error("passkey sign-in runs top-level only, never in a frame");
  const hasWebAuthn = env.hasWebAuthn ?? typeof globalThis.PublicKeyCredential !== "undefined";
  const credentials = env.credentials ?? globalThis.navigator?.credentials;
  return { bytes, hasWebAuthn: hasWebAuthn && !!credentials, credentials: credentials as CredentialsContainer };
}

const isNotAllowed = (e: unknown): boolean => e instanceof Error && e.name === "NotAllowedError";

// The OS sheet's answer is hostile until checked: a public-key credential with a byte id, and a PRF result, if any,
// of exactly 32 bytes.
interface PrfAnswer {
  credentialId: Uint8Array;
  enabled: boolean | undefined;
  first: Uint8Array | null;
}
function readAnswer(cred: Credential | null): PrfAnswer {
  const c = cred as (Credential & { rawId?: unknown; getClientExtensionResults?: () => unknown }) | null;
  if (!c || c.type !== "public-key" || !(c.rawId instanceof ArrayBuffer) || typeof c.getClientExtensionResults !== "function")
    throw new Error("the passkey sheet answered with no public-key credential");
  const ext = (c.getClientExtensionResults() ?? {}) as { prf?: { enabled?: unknown; results?: { first?: unknown } } };
  const prf = ext.prf;
  const enabled = typeof prf?.enabled === "boolean" ? prf.enabled : undefined;
  const raw = prf?.results?.first;
  let first: Uint8Array | null = null;
  if (raw !== undefined) {
    if (raw instanceof ArrayBuffer) first = new Uint8Array(raw);
    else if (ArrayBuffer.isView(raw)) first = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
    else throw new Error("the passkey's PRF result is not bytes");
    if (first.length !== 32) throw new Error("the passkey's PRF result is not 32 bytes");
  }
  return { credentialId: new Uint8Array(c.rawId), enabled, first };
}

// The PRF output to the entropy, then the output is wiped. `first` is a view of the browser's own result buffer, never a
// copy, so the wipe zeroes the one copy this page holds (HKDF reads its input and keeps none).
function unlock(first: Uint8Array, credentialId: Uint8Array): PasskeyOutcome {
  try {
    return { kind: "prf", entropy: entropyFromPrf(first), credentialId };
  } finally {
    first.fill(0);
  }
}

async function getPrf(
  e: ReturnType<typeof envOf>,
  allow: Uint8Array<ArrayBuffer> | null,
): Promise<PasskeyOutcome> {
  let cred: Credential | null;
  try {
    cred = await e.credentials.get({
      publicKey: {
        rpId: SIGN_HOST,
        challenge: e.bytes(32),
        allowCredentials: allow ? [{ type: "public-key", id: allow }] : [],
        userVerification: "required",
        extensions: prfExt(),
      },
    });
  } catch (err) {
    if (isNotAllowed(err)) return { kind: "cancelled" };
    throw err;
  }
  const a = readAnswer(cred);
  if (allow && (a.credentialId.length !== allow.length || a.credentialId.some((x, i) => x !== allow[i])))
    throw new Error("the passkey sheet answered with another credential");
  // get returns no PRF result: this passkey has no PRF (06b:365), its account is a no-PRF one
  return a.first ? unlock(a.first, a.credentialId) : { kind: "no-prf", credentialId: a.credentialId };
}

/** A new passkey on SIGN_HOST with the PRF extension (06b:316-325, its case table :358-367). */
export async function createPasskey(env: PasskeyEnv = {}): Promise<PasskeyOutcome> {
  const e = envOf(env);
  if (!e.hasWebAuthn) return { kind: "unsupported" };
  let cred: Credential | null;
  try {
    cred = await e.credentials.create({
      publicKey: {
        rp: { id: SIGN_HOST, name: RP_NAME },
        user: { id: e.bytes(16), name: USER_NAME, displayName: USER_NAME },
        challenge: e.bytes(32),
        pubKeyCredParams: [
          { type: "public-key", alg: -7 },
          { type: "public-key", alg: -257 },
        ],
        authenticatorSelection: { residentKey: "required", userVerification: "required" },
        attestation: "none",
        extensions: prfExt(),
      },
    });
  } catch (err) {
    if (isNotAllowed(err)) return { kind: "cancelled" };
    throw err;
  }
  const a = readAnswer(cred);
  if (a.first) return unlock(a.first, a.credentialId);
  // PRF on, but this authenticator evaluates it only on a get: one get with this credential (06b:364)
  if (a.enabled === true) return getPrf(e, new Uint8Array(a.credentialId));
  // no prf.enabled, or false: the no-PRF path (06b:365)
  return { kind: "no-prf", credentialId: a.credentialId };
}

/** Sign in with a passkey already on this device or synced to it (06b:327-328): any of SIGN_HOST's passkeys. */
export async function getPasskey(env: PasskeyEnv = {}): Promise<PasskeyOutcome> {
  const e = envOf(env);
  if (!e.hasWebAuthn) return { kind: "unsupported" };
  return getPrf(e, null);
}
