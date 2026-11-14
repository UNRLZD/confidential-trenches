// node --test contracts/pool-evm/test/socket-tos.test.mjs: socket-tos.mjs makes a refused type of service no throw, and
// leaves every other fault of setTypeOfService a throw.
import assert from "node:assert/strict";
import net from "node:net";
import { test } from "node:test";

const EINVAL = -22;
// a socket whose system call answers as macOS did on a socket its peer had reset
const reset = () => Object.assign(new net.Socket(), { _handle: { setTypeOfService: () => EINVAL } });

test("a type of service the system refuses throws without it (Node's own setTypeOfService), and is no throw with it", async () => {
  const own = net.Socket.prototype.setTypeOfService;
  if (typeof own !== "function") return; // a Node without setTypeOfService: nothing to hold
  if (own.bestEffort !== true) assert.throws(() => reset().setTypeOfService(0), (e) => e.syscall === "setTypeOfService");
  const { refusedTos } = await import("./socket-tos.mjs");
  const s = reset();
  const before = refusedTos.count;
  assert.equal(s.setTypeOfService(0), s);
  assert.equal(refusedTos.count, before + 1);
  // a value Node refuses itself is still the caller's fault
  assert.throws(() => reset().setTypeOfService(300), { code: "ERR_OUT_OF_RANGE" });
  // loaded twice, it wraps once
  await import("./socket-tos.mjs?again");
  assert.equal(net.Socket.prototype.setTypeOfService.bestEffort, true);
  reset().setTypeOfService(0);
  assert.equal(refusedTos.count, before + 2);
});
