// node --test test/passkey.test.ts (from packages/wallet): the passkey ceremony against a scripted OS sheet.
// Card wallet-passkey-prf: rp.id = SIGN_HOST, the frozen PRF input, the PRF output into wallet.md:47's HKDF and on into
// :70-88's, and every case of 06b:358-367, with "no PRF" its own outcome, never a silent fallback.
// PASSKEY_SRC=<path> runs the same cases on another copy of passkey.ts (the planted bad copy of the red run).
import assert from "node:assert/strict";
import { hkdfSync } from "node:crypto";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import * as d from "../src/derive/index.ts";

const SRC = process.env.PASSKEY_SRC ? pathToFileURL(process.env.PASSKEY_SRC).href : "../src/signin/passkey.ts";
const p: typeof import("../src/signin/passkey.ts") = await import(SRC);

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const PRF_OUT = Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff);
const CRED_ID = Uint8Array.from({ length: 16 }, (_, i) => 0xa0 + i);

type Answer = { rawId?: ArrayBuffer; type?: string; ext?: unknown } | Error | null;
function sheet(answers: { create?: Answer; get?: Answer[] }) {
  const calls: { op: "create" | "get"; options: any }[] = [];
  const gets = [...(answers.get ?? [])];
  const answer = (a: Answer | undefined) => {
    if (a instanceof Error) throw a;
    if (a === null || a === undefined) return null;
    return {
      type: a.type ?? "public-key",
      id: "x",
      rawId: a.rawId ?? CRED_ID.slice().buffer,
      getClientExtensionResults: () => a.ext,
    };
  };
  const credentials = {
    async create(o: any) {
      calls.push({ op: "create", options: o });
      return answer(answers.create) as any;
    },
    async get(o: any) {
      calls.push({ op: "get", options: o });
      if (!gets.length) throw new Error("the test sheet has no more get answers");
      return answer(gets.shift()) as any;
    },
  } as unknown as CredentialsContainer;
  let n = 0;
  const env = { credentials, hasWebAuthn: true, hostname: d.SIGN_HOST, topLevel: true, random: (b: Uint8Array) => b.fill(++n) };
  return { env, calls };
}
const withPrf = (out = PRF_OUT) => ({ prf: { enabled: true, results: { first: out.slice().buffer } } });
const notAllowed = () => Object.assign(new Error("closed"), { name: "NotAllowedError" });
const want = (out: Uint8Array) => new Uint8Array(hkdfSync("sha256", out, "confidential-trenches/v1", "wallet/entropy", 16));

test("create asks for a passkey on SIGN_HOST with the frozen PRF input and the signed names", async () => {
  const s = sheet({ create: { ext: withPrf() } });
  await p.createPasskey(s.env);
  assert.equal(s.calls.length, 1);
  const o = s.calls[0]!.options.publicKey;
  assert.equal(o.rp.id, "sign.confidential.unrealized.trade");
  assert.equal(o.rp.id, d.SIGN_HOST);
  assert.equal(o.rp.name, "UNRLZD");
  assert.equal(o.user.name, "Trading account");
  assert.equal(o.user.displayName, "Trading account");
  assert.equal(o.user.id.length, 16);
  assert.equal(o.challenge.length, 32);
  assert.notEqual(hex(o.user.id), hex(o.challenge.slice(0, 16)));
  assert.deepEqual(o.pubKeyCredParams.map((x: any) => x.alg), [-7, -257]);
  assert.deepEqual(o.authenticatorSelection, { residentKey: "required", userVerification: "required" });
  assert.equal(o.attestation, "none");
  assert.equal(new TextDecoder().decode(o.extensions.prf.eval.first), "confidential-trenches/v1/seed");
  assert.equal(new TextDecoder().decode(o.extensions.prf.eval.first), d.PRF_INPUT);
  assert.deepEqual(Object.keys(o.extensions), ["prf"]);
});

test("a PRF result on create unlocks: entropy is wallet.md:47's HKDF of it, and seed64 feeds :70-88's", async () => {
  const s = sheet({ create: { ext: withPrf() } });
  const r = await p.createPasskey(s.env);
  assert.equal(r.kind, "prf");
  if (r.kind !== "prf") return;
  assert.equal(hex(r.entropy), hex(want(PRF_OUT)));
  assert.equal(hex(r.credentialId), hex(CRED_ID));
  // the 12 words and seed64 of that entropy, and one derivation of each kind from it, as the kit computes them
  const seed64 = d.wordsToSeed64(d.entropyToWords(r.entropy));
  const l = 5n, sol = d.freshWallet(seed64, "sol", l, 0), evm = d.freshWallet(seed64, "evm", l, 0);
  assert.equal(d.walletPath(seed64, "sol", l, 0).path, sol.path);
  const ab = d.hkdfSeed(seed64, d.info.wallet("evm", l, 0), 8);
  const node = new Uint8Array(hkdfSync("sha512", seed64, "blindfill/v1", d.info.wallet("evm", l, 0), 8));
  assert.equal(hex(ab), hex(node));
  assert.match(evm.address, /^0x[0-9a-fA-F]{40}$/);
});

test("PRF enabled on create with no result: one get for this credential, and its result counts (06b:364)", async () => {
  const s = sheet({ create: { ext: { prf: { enabled: true } } }, get: [{ ext: withPrf() }] });
  const r = await p.createPasskey(s.env);
  assert.equal(r.kind, "prf");
  assert.equal(r.kind === "prf" && hex(r.entropy), hex(want(PRF_OUT)));
  assert.deepEqual(s.calls.map((c) => c.op), ["create", "get"]);
  const g = s.calls[1]!.options.publicKey;
  assert.equal(g.rpId, d.SIGN_HOST);
  assert.equal(g.allowCredentials.length, 1);
  assert.equal(hex(g.allowCredentials[0].id), hex(CRED_ID));
  assert.equal(new TextDecoder().decode(g.extensions.prf.eval.first), d.PRF_INPUT);
});

test("PRF enabled on create, then the get answers another credential: refused", async () => {
  const other = new Uint8Array(16).fill(9).buffer;
  const s = sheet({ create: { ext: { prf: { enabled: true } } }, get: [{ rawId: other, ext: withPrf() }] });
  await assert.rejects(p.createPasskey(s.env), /another credential/);
});

test("a passkey without PRF opens the no-PRF path, never a silent fallback (06b:365; card's bad answer)", async () => {
  for (const ext of [{}, { prf: { enabled: false } }, undefined, { prf: {} }]) {
    const s = sheet({ create: { ext } });
    const r = await p.createPasskey(s.env);
    assert.equal(r.kind, "no-prf", `create with extension results ${JSON.stringify(ext)}`);
    assert.equal(r.kind === "no-prf" && hex(r.credentialId!), hex(CRED_ID));
    assert.equal(Object.hasOwn(r, "entropy"), false, "no entropy is made on the no-PRF outcome");
    assert.deepEqual(s.calls.map((c) => c.op), ["create"]);
  }
  const s = sheet({ get: [{ ext: { prf: { enabled: false } } }] });
  const r = await p.getPasskey(s.env);
  assert.equal(r.kind, "no-prf");
  assert.equal(Object.hasOwn(r, "entropy"), false);
});

test("get asks any of SIGN_HOST's passkeys with the PRF input, and its result unlocks the same entropy", async () => {
  const s = sheet({ get: [{ ext: withPrf() }] });
  const r = await p.getPasskey(s.env);
  assert.equal(r.kind === "prf" && hex(r.entropy), hex(want(PRF_OUT)));
  const g = s.calls[0]!.options.publicKey;
  assert.equal(g.rpId, d.SIGN_HOST);
  assert.deepEqual(g.allowCredentials, []);
  assert.equal(g.userVerification, "required");
  assert.equal(g.challenge.length, 32);
  assert.equal(new TextDecoder().decode(g.extensions.prf.eval.first), d.PRF_INPUT);
});

test("the PRF output is wiped once it has made the entropy", async () => {
  const out = PRF_OUT.slice();
  const s = sheet({ get: [{ ext: { prf: { results: { first: out } } } }] });
  const r = await p.getPasskey(s.env);
  assert.equal(r.kind === "prf" && hex(r.entropy), hex(want(PRF_OUT)));
  assert.ok(out.every((x) => x === 0));
});

test("the sheet closed or timed out: cancelled, nothing made; any other error is thrown", async () => {
  assert.deepEqual(await p.createPasskey(sheet({ create: notAllowed() }).env), { kind: "cancelled" });
  assert.deepEqual(await p.getPasskey(sheet({ get: [notAllowed()] }).env), { kind: "cancelled" });
  await assert.rejects(p.createPasskey(sheet({ create: new TypeError("boom") }).env), /boom/);
});

test("no WebAuthn in the browser: unsupported, and the sheet is never asked", async () => {
  const s = sheet({});
  assert.deepEqual(await p.createPasskey({ ...s.env, hasWebAuthn: false }), { kind: "unsupported" });
  assert.deepEqual(await p.getPasskey({ ...s.env, hasWebAuthn: false }), { kind: "unsupported" });
  assert.equal(s.calls.length, 0);
});

test("the sheet's answer is hostile until checked", async () => {
  const bad: [Answer, RegExp][] = [
    [null, /no public-key credential/],
    [{ type: "password", ext: withPrf() }, /no public-key credential/],
    [{ ext: withPrf(new Uint8Array(16)) }, /not 32 bytes/],
    [{ ext: withPrf(new Uint8Array(33)) }, /not 32 bytes/],
    [{ ext: { prf: { results: { first: "00".repeat(32) } } } }, /not bytes/],
  ];
  for (const [a, re] of bad) {
    await assert.rejects(p.createPasskey(sheet({ create: a }).env), re);
    await assert.rejects(p.getPasskey(sheet({ get: [a] }).env), re);
  }
});

test("the ceremony runs on SIGN_HOST only", async () => {
  for (const hostname of ["confidential.unrealized.trade", "unrealized.trade", "evil.sign.confidential.unrealized.trade", undefined]) {
    const s = sheet({ create: { ext: withPrf() }, get: [{ ext: withPrf() }] });
    await assert.rejects(p.createPasskey({ ...s.env, hostname }), /runs on sign\.confidential\.unrealized\.trade only/);
    await assert.rejects(p.getPasskey({ ...s.env, hostname }), /only/);
    assert.equal(s.calls.length, 0);
  }
});

test("in a frame both calls refuse before the sheet is asked (wallet.md:921-922)", async () => {
  for (const topLevel of [false, undefined]) {
    const s = sheet({ create: { ext: withPrf() }, get: [{ ext: withPrf() }] });
    await assert.rejects(p.createPasskey({ ...s.env, topLevel }), /top-level only/);
    await assert.rejects(p.getPasskey({ ...s.env, topLevel }), /top-level only/);
    assert.equal(s.calls.length, 0);
  }
});

test("the PRF output is wiped in the buffer the sheet returned", async () => {
  const buf = PRF_OUT.slice().buffer;
  const s = sheet({ get: [{ ext: { prf: { results: { first: buf } } } }] });
  const r = await p.getPasskey(s.env);
  assert.equal(r.kind === "prf" && hex(r.entropy), hex(want(PRF_OUT)));
  assert.ok(new Uint8Array(buf).every((x) => x === 0), "the ArrayBuffer the sheet returned is zeroed");
});
