// Who runs an EVM RPC and which list a pool is read on (card robinhood-mainnet-rpcs, review L-2 and M-2): the kit's one
// operator rule, the cases the review planted against the helper's first rule (op-edges), the curated map held to the
// money gate's, and the one accessor every pool-list reader takes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EVM_RPC_DOMAIN_ALIASES, EVM_RPC_OPERATORS, evmPoolProvidersOf, evmPoolVenues, evmRpcOperator, type EvmPoolVenue } from "../src/index.ts";
// the money gate's curated map (a script, so read by its URL: the kit's types reach no script)
const GATE = new URL("../../../scripts/ci/rpc-operators.mjs", import.meta.url).href;
const { RPC_OPERATORS } = (await import(GATE)) as { RPC_OPERATORS: Readonly<Record<string, Readonly<Record<string, string>>>> };

const op = evmRpcOperator;

test("one operator, however its URL is written: a trailing dot, upper case, userinfo, a path or a key, a port", () => {
  assert.equal(op("https://rpc.mainnet.chain.robinhood.com."), "robinhood.com");
  assert.equal(op("https://RPC.Mainnet.Chain.Robinhood.COM"), "robinhood.com");
  assert.equal(op("https://user:s3cr3t@a.robinhood.com/v2/KEY?k=1"), "robinhood.com");
  assert.equal(op("https://a.robinhood.com.:8443/x"), "robinhood.com");
  assert.equal(op("https://robinhood.com"), "robinhood.com");
  // the host Robinhood's own RPC is a CNAME of answers its node: one operator, never a second
  assert.equal(op("https://customer-origin.offchainlabs.com"), op("https://rpc.mainnet.chain.robinhood.com"));
  // the node that answers in Pocket's very words is counted as Pocket's, so the two never make a pair
  assert.equal(op("https://rpc.degenprotocol.io"), op("https://robinhood.api.pocket.network"));
  // a two-part suffix reads two operators as one: a pair refused, never one operator passed as two
  assert.equal(op("https://rpc.foo.co.uk"), op("https://rpc.bar.co.uk"));
  assert.notEqual(op("https://rpc.mainnet.chain.robinhood.com"), op("https://robinhood.api.pocket.network"));
  assert.notEqual(op("https://robinhood.drpc.org"), op("https://rpc.mainnet.chain.robinhood.com"));
});

test("an IP host is its address however it is written, never its port; localhost is one host", () => {
  assert.equal(op("http://127.0.0.1:1"), "127.0.0.1");
  assert.equal(op("http://127.1:2"), "127.0.0.1");
  assert.equal(op("http://2130706433:1"), "127.0.0.1");
  assert.equal(op("http://[::ffff:127.0.0.1]:1"), "127.0.0.1");
  assert.equal(op("http://[::1]:1"), "[::1]");
  assert.equal(op("http://[0:0:0:0:0:0:0:1]:2"), "[::1]");
  assert.equal(op("http://localhost:1"), op("http://localhost:2"));
  assert.notEqual(op("http://[::1]:1"), op("http://127.0.0.1:1"));
});

test("anything but an http or https URL has no operator", () => {
  for (const u of ["not a url/KEY", "also not/KEY2", "robinhood.com", "", "ws://rpc.mainnet.chain.robinhood.com", "file:///etc/hosts", "javascript:alert(1)"]) assert.equal(op(u), null, u);
});

test("the curated map names every EVM host of the money gate's map, as the money gate pairs them: two of a chain two operators, one operator's hosts one", () => {
  assert.ok(Object.isFrozen(EVM_RPC_OPERATORS));
  const byGate = new Map<string, string>();
  for (const [chain, hosts] of Object.entries(RPC_OPERATORS)) {
    if (chain.startsWith("solana")) continue;
    const ops = Object.keys(hosts).map((h) => op(`https://${h}`));
    assert.equal(new Set(ops).size, Object.keys(hosts).length, `${chain}: two operators`);
    for (const [h, gateOp] of Object.entries(hosts)) {
      assert.ok(Object.hasOwn(EVM_RPC_OPERATORS, h), `${h}: in the kit's map`);
      const mine = op(`https://${h}`)!;
      if (byGate.has(gateOp)) assert.equal(byGate.get(gateOp), mine, `${h}: the money gate's ${gateOp} is one operator here too`);
      byGate.set(gateOp, mine);
    }
  }
});

// delta review L-2: a host entry naming another domain's operator made a second host of that domain a second operator
// (customer-origin.offchainlabs.com robinhood.com, other-origin.offchainlabs.com offchainlabs.com)
test("each name the map gives a host is the name its domain gets anyway, its domain or that domain's alias, so a mapped host and an unmapped one of one domain never read as two", () => {
  for (const [host, name] of Object.entries(EVM_RPC_OPERATORS)) {
    const domain = host.split(".").slice(-2).join(".");
    assert.equal(name, Object.hasOwn(EVM_RPC_DOMAIN_ALIASES, domain) ? EVM_RPC_DOMAIN_ALIASES[domain] : domain, host);
  }
  assert.ok(Object.isFrozen(EVM_RPC_DOMAIN_ALIASES));
  for (const [domain, name] of Object.entries(EVM_RPC_DOMAIN_ALIASES)) assert.notEqual(name, domain, domain);
});

test("every host of an aliased domain is the alias's operator: two hosts of Offchain Labs are Robinhood's one, two of degenprotocol Pocket's one", () => {
  for (const [x, y] of [
    ["https://customer-origin.offchainlabs.com", "https://other-origin.offchainlabs.com"],
    ["https://customer-origin.offchainlabs.com", "https://rpc.mainnet.chain.robinhood.com"],
    ["https://rpc.degenprotocol.io", "https://rpc2.degenprotocol.io"],
    ["https://rpc2.degenprotocol.io", "https://robinhood.api.pocket.network"],
  ] as const) assert.equal(op(x), op(y), `${x} and ${y}`);
  assert.equal(op("https://other-origin.offchainlabs.com"), "robinhood.com");
  assert.equal(op("https://rpc2.degenprotocol.io"), "pocket.network");
});

// card evm-pool-sync-holds: dRPC's keyed hosts (lb.drpc.live) and Grove's (*.rpc.grove.city, Pocket's gateway) are the
// operators of drpc.org and pocket.network, so a helper's keyed URL of either never counts as a second operator beside them
test("dRPC's keyed domain is drpc.org and Grove's is pocket.network: a keyed URL of either is never another operator", () => {
  assert.equal(op("https://lb.drpc.live/base/FAKEKEY123"), "drpc.org");
  assert.equal(op("https://lb.drpc.live/x"), op("https://base.drpc.org"));
  assert.equal(op("https://base.rpc.grove.city/v1/FAKEKEY123"), "pocket.network");
  assert.equal(op("https://robinhood.rpc.grove.city/v1/x"), op("https://robinhood.api.pocket.network"));
});

test("every list the kit pins for an EVM venue, quote, fee and pool, is each entry another operator's", () => {
  for (const [chain, v] of Object.entries(evmPoolVenues()) as [string, EvmPoolVenue][]) {
    for (const [name, list] of [["providers", v.providers], ["feeProviders", v.feeProviders], ["poolProviders", v.poolProviders]] as const) {
      if (list === undefined) continue;
      const ops = list.map(op);
      assert.ok(!ops.includes(null), `${chain} ${name}: every entry a URL`);
      assert.equal(new Set(ops).size, list.length, `${chain} ${name}: ${ops.join(", ")}`);
    }
  }
});

test("evmPoolProvidersOf: a venue's pool list, its quote list where it has none, its own fields only", () => {
  const pool = Object.freeze(["https://a.example", "https://b.example"]);
  const quote = Object.freeze(["https://c.example", "https://d.example"]);
  assert.equal(evmPoolProvidersOf({ chainId: 1, providers: quote, poolProviders: pool } as unknown as EvmPoolVenue), pool);
  assert.equal(evmPoolProvidersOf({ chainId: 1, providers: quote } as unknown as EvmPoolVenue), quote);
  assert.equal(evmPoolProvidersOf({ chainId: 1 } as unknown as EvmPoolVenue), undefined);
  const inherited = Object.create({ poolProviders: pool, providers: pool }) as EvmPoolVenue;
  assert.equal(evmPoolProvidersOf(inherited), undefined);
  assert.equal(evmPoolProvidersOf(evmPoolVenues().robinhood), evmPoolVenues().robinhood.poolProviders);
  assert.equal(evmPoolProvidersOf(evmPoolVenues().base), evmPoolVenues().base.poolProviders);
  // a venue with no pool list of its own reads its quote list (card evm-pool-lists-mainnet: Base mainnet has its own now)
  assert.equal(evmPoolVenues()["base-sepolia"].poolProviders, undefined);
  assert.equal(evmPoolProvidersOf(evmPoolVenues()["base-sepolia"]), evmPoolVenues()["base-sepolia"].providers);
});

// review mutant M3b: the pool reads check with its fallback removed passed every test; each pool-list reader outside the
// kit takes the list from the accessor, never from a venue's fields itself
test("every pool-list reader takes the list from evmPoolProvidersOf, never a venue's poolProviders or providers itself", () => {
  for (const f of ["../../wallet/scripts/pool-reads-throttle-check.ts", "../../../scripts/live-checks/robinhood-mainnet-rpcs.mjs", "../../signpage/test/pool-restore.test.ts", "../../../scripts/live-checks/evm-pool-lists-mainnet.mjs"]) {
    const src = readFileSync(new URL(f, import.meta.url), "utf8");
    assert.match(src, /evmPoolProvidersOf\(/, `${f}: takes the accessor`);
    assert.doesNotMatch(src, /\.poolProviders\b|\?\.providers\b|\.providers\s*\?\?/, `${f}: reads no venue list itself`);
  }
});
