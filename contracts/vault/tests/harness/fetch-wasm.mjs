#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Fetches the mainnet contracts tests/fixtures/real-wasm.json pins (the real USDC and intents.near at DF) for the
// sandbox harness. Reads only: no transaction is signed or sent.
//   node contracts/vault/tests/harness/fetch-wasm.mjs     prints one `<ENV>=<path>` line per pin, for run.sh
// A cached file is used as it is when its sha256 is the pin. Otherwise, on each of the fixture's two RPCs: view_account
// and view_code at final, and the bytes refused unless their size and sha256 are the pin and base58(sha256) is the pin's
// code hash and both views' hash; then the two RPCs' bytes must be equal. The cache is outside the checkout
// (BLINDFILL_WASM_CACHE, default ~/.cache/blindfill-vault-harness); the bytes are never committed.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const fixture = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../fixtures/real-wasm.json'), 'utf8'));
const cache = process.env.BLINDFILL_WASM_CACHE || join(homedir(), '.cache', 'blindfill-vault-harness');
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58(buf) {
  let n = BigInt('0x' + (buf.toString('hex') || '0'));
  let out = '';
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of buf) {
    if (b !== 0) break;
    out = '1' + out;
  }
  return out;
}
const sha256 = (b) => createHash('sha256').update(b).digest('hex');

async function query(rpc, params) {
  const res = await fetch(rpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'harness', method: 'query', params }),
    signal: AbortSignal.timeout(60_000),
  });
  const body = await res.json().catch(() => null);
  // an RPC error, or a reply with no result, is never an answer
  if (!res.ok || !body || body.error || typeof body.result !== 'object' || body.result === null || body.result.error) {
    throw new Error(`${rpc} ${params.request_type} ${params.account_id}: no result: ${JSON.stringify(body).slice(0, 300)}`);
  }
  return body.result;
}

async function fetchPinned(name, pin) {
  const path = join(cache, `${name}-${pin.sha256.slice(0, 16)}.wasm`);
  if (existsSync(path) && sha256(readFileSync(path)) === pin.sha256) {
    console.error(`${name}: cached ${path} (sha256 ${pin.sha256})`);
    return path;
  }
  const blobs = [];
  for (const rpc of fixture.rpcs) {
    const acct = await query(rpc, { request_type: 'view_account', finality: 'final', account_id: pin.account });
    const code = await query(rpc, { request_type: 'view_code', finality: 'final', account_id: pin.account });
    const raw = Buffer.from(code.code_base64 ?? '', 'base64');
    const sha = sha256(raw);
    const hash = base58(Buffer.from(sha, 'hex'));
    const bad = [];
    if (raw.length !== pin.bytes) bad.push(`${raw.length} B, want ${pin.bytes}`);
    if (sha !== pin.sha256) bad.push(`sha256 ${sha}, want ${pin.sha256}`);
    if (hash !== pin.code_hash) bad.push(`base58(sha256) ${hash}, want ${pin.code_hash}`);
    if (code.hash !== hash) bad.push(`view_code hash ${code.hash} != ${hash}`);
    if (acct.code_hash !== hash) bad.push(`view_account code_hash ${acct.code_hash} != ${hash}`);
    if (bad.length) throw new Error(`REFUSED ${name} on ${rpc}: ${bad.join('; ')}`);
    console.error(`${name}: ${rpc} view_account block ${acct.block_height} code_hash ${acct.code_hash}; view_code block ${code.block_height} ${raw.length} B sha256 ${sha}`);
    blobs.push(raw);
  }
  if (!blobs[0].equals(blobs[1])) throw new Error(`REFUSED ${name}: the two RPCs' bytes differ`);
  mkdirSync(cache, { recursive: true });
  writeFileSync(path + '.part', blobs[0]);
  renameSync(path + '.part', path);
  return path;
}

for (const [name, pin] of Object.entries(fixture.wasm)) {
  console.log(`${pin.env}=${await fetchPinned(name, pin)}`);
}
