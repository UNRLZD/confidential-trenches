// A throwaway certificate for the harness hosts, made at run time in a new temp dir and deleted by remove(). No key is
// ever committed: the private key exists only in that dir while a run lasts. The browser trusts this one certificate
// by its public-key pin (Chromium's --ignore-certificate-errors-spki-list), inside the test process only: nothing is
// installed in a system trust store.
import { execFileSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** @param {string[]} names DNS names (wildcards allowed) the certificate covers */
export function makeCert(names) {
  const dir = mkdtempSync(path.join(tmpdir(), "ct-harness-cert-"));
  const keyFile = path.join(dir, "key.pem");
  const certFile = path.join(dir, "cert.pem");
  const conf = path.join(dir, "req.cnf");
  writeFileSync(
    conf,
    [
      "[req]",
      "distinguished_name = dn",
      "x509_extensions = ext",
      "prompt = no",
      "[dn]",
      "CN = ct-harness",
      "[ext]",
      `subjectAltName = ${names.map((n) => `DNS:${n}`).join(",")}`,
      "basicConstraints = critical,CA:FALSE",
      "keyUsage = critical,digitalSignature",
      "extendedKeyUsage = serverAuth",
      "",
    ].join("\n"),
  );
  try {
    execFileSync(
      "openssl",
      ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "2",
        "-keyout", keyFile, "-out", certFile, "-config", conf],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`openssl could not make the harness certificate: ${String(e.stderr ?? e.message).trim()}`);
  }
  const cert = readFileSync(certFile);
  const key = readFileSync(keyFile);
  const spki = new X509Certificate(cert).publicKey.export({ type: "spki", format: "der" });
  return {
    dir,
    cert,
    key,
    /** base64 sha256 of the certificate's SubjectPublicKeyInfo, the form Chromium's SPKI list takes */
    spki: createHash("sha256").update(spki).digest("base64"),
    remove: () => rmSync(dir, { recursive: true, force: true }),
  };
}
