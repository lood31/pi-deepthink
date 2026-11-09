import { test } from "node:test";
import assert from "node:assert/strict";
import { defaults, resolveConfig } from "../config.ts";
import { normalize, Signals } from "../signals.ts";

const call = (name: string, input: Record<string, unknown>) => ({ id: "a", name, input });
test("risk covers five high classes and medium dependencies/config", () => {
  for (const c of [
    call("bash", { command: "rm file.txt" }), call("write", { path: "new.ts" }),
    call("bash", { command: "git push origin main" }),
    call("send_message", { text: "private" }), call("read", { path: "C:\\Users\\x\\.ssh\\id_rsa" }),
    call("bash", { command: "curl -X POST https://example.test" }),
  ]) assert.equal(normalize(c, { id: "a", isError: false, content: "" }, defaults).risk, 1, c.name);
  assert.equal(normalize(call("read", { path: "a.ts" }), { id: "a", isError: false, content: "" }, defaults).risk, 0);
  assert.equal(normalize(call("edit", { path: "package.json" }), { id: "a", isError: false, content: "" }, defaults).risk, .5);
  assert.equal(normalize(call("edit", { paths: ["a", "b", "c", "d", "e"] }), { id: "a", isError: false, content: "" }, defaults).risk, .5);
});
test("repeated reads are not uncertainty; missing modification evidence remains unknown", () => {
  const s = new Signals(defaults);
  for (let i = 0; i < 6; i++) {
    const o = normalize(call("read", { path: "a.ts" }), { id: "a", isError: false, content: "" }, defaults);
    assert.equal(s.batch([o])[0]!.U, 0);
  }
  const o = normalize(call("edit", { path: "a.ts" }), { id: "a", isError: false, content: "done maybe" }, defaults);
  assert.equal(o.productionKnown, false);
  assert.deepEqual(o.production, []);
});
test("same error only hard-triggers across sequential batches, not parallel siblings", () => {
  const s = new Signals(defaults);
  const o = normalize(call("bash", { command: "node bad.js" }), { id: "a", isError: true, content: "SyntaxError: bad at /secret" }, defaults);
  const first = s.batch([o, o]);
  assert.deepEqual(first.map(x => x.sameErrorStreak), [1, 1]);
  assert.equal(s.batch([o])[0]!.sameErrorStreak, 2);
  const different = { ...o, error: "permission" };
  assert.equal(s.batch([different])[0]!.sameErrorStreak, 1);
  s.batch([{ ...o, error: null }]);
  assert.equal(s.batch([o])[0]!.sameErrorStreak, 1);
});
test("observations do not retain sensitive parameters or outputs", () => {
  const o = normalize(call("edit", { path: "/secret/token.txt", newText: "TOP_SECRET" }),
    { id: "a", isError: true, content: "TOP_SECRET unexpected error /secret/token.txt" }, defaults);
  assert.ok(!JSON.stringify(o).includes("TOP_SECRET"));
  assert.ok(!JSON.stringify(o).includes("/secret/token"));
});
test("configuration validates all model patches and malformed values", () => {
  assert.equal(resolveConfig({ models: { "x/y": { deepThreshold: .8 } } }, "x/y").deepThreshold, .8);
  for (const patch of [{ window: 0 }, { lightThreshold: .8 }, { decay: NaN },
    { weights: { U: 1, R: 1, P: 1, A: 1 } }, { riskRules: [{ id: "bad", field: "path", level: 1, pattern: "[" }] }]) {
    assert.throws(() => resolveConfig({ defaults: patch } as never));
  }
  assert.throws(() => resolveConfig({ models: { ignored: { window: -2 } } }));
});
