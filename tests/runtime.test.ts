import { test } from "node:test";
import assert from "node:assert/strict";
import { Runtime } from "../runtime.ts";
import { normalize } from "../signals.ts";
import { defaults } from "../config.ts";
import { interventionMessage } from "../intervener.ts";
import { summarize } from "../report.ts";
import type { LogRow, Observation, RowSink } from "../types.ts";

export class MemorySink implements RowSink {
  healthy = true;
  rows: LogRow[] = [];
  async write(row: LogRow): Promise<boolean> { if (!this.healthy) return false; this.rows.push(row); return true; }
  async flush(): Promise<void> {}
}
let n = 0;
const obs = (risk = false): Observation => normalize({
  id: "call" + ++n, name: risk ? "write" : "read", input: { path: "a.ts" },
}, { id: "", isError: false, content: risk ? "Successfully wrote file" : "" }, defaults);
const make = () => {
  const sink = new MemorySink();
  return { sink, runtime: new Runtime({ source: "live", sessionId: "test", branch: "root", model: "x/y" }, {}, sink) };
};
test("shadow observes but never injects, deduplicates calls", async () => {
  const { sink, runtime } = make();
  const o = obs(true);
  assert.equal(await runtime.process([o]), null);
  await runtime.process([o]);
  assert.equal(sink.rows.filter(r => r.type === "score").length, 1);
  assert.equal(sink.rows.filter(r => r.type === "candidate").length, 1);
  assert.equal(sink.rows.filter(r => r.type === "intervention").length, 0);
});
test("light downgrades actual deep without recording an actual deep", async () => {
  const { sink, runtime } = make();
  await runtime.changeMode("light");
  const intent = (await runtime.process([obs(true), obs(true)]))!;
  assert.equal(intent.action, "light");
  assert.equal(sink.rows.filter(r => r.type === "intervention-proposed").length, 1);
  assert.equal(sink.rows.filter(r => r.type === "intervention").length, 0);
  await runtime.confirm(new Set([intent.id]));
  assert.equal(sink.rows.find(r => r.type === "intervention")?.action, "light");
  assert.equal((await runtime.process([obs(true)]))?.action, "light"); // hard risk bypasses cooldown
});
test("unpersisted drafts are not counted and ineligible turns do not inject", async () => {
  const { sink, runtime } = make();
  await runtime.changeMode("deep");
  await runtime.process([obs(true)]);
  await runtime.confirm(new Set());
  assert.equal(sink.rows.filter(r => r.type === "intervention").length, 0);
  assert.equal(sink.rows.filter(r => r.type === "delivery-unknown").length, 1);
  assert.equal(await runtime.process([obs(true)], false), null);
});
test("five-step outcomes append and interrupted samples are excluded", async () => {
  const { sink, runtime } = make();
  await runtime.process([obs(true)]);
  for (let i = 0; i < 5; i++) await runtime.process([obs()]);
  const outcome = sink.rows.find(r => r.type === "outcome");
  assert.equal(outcome?.complete, true);
  assert.equal(outcome?.observedSteps, 5);
  await runtime.process([obs(true)]);
  await runtime.reset("compaction");
  assert.equal(runtime.step, 0);
  const r = summarize(sink.rows);
  assert.equal(r.completeOutcomes, 1);
  assert.equal(r.incomplete, 1);
  assert.equal(r.interventions, 0);
});
test("sink failures suppress intervention; deep template contains summaries, not hidden reasoning demand", async () => {
  const { sink, runtime } = make();
  await runtime.changeMode("deep");
  sink.healthy = false;
  assert.equal(await runtime.process([obs(true)]), null);
  assert.equal(runtime.healthy, false);
  const second = make().runtime;
  await second.changeMode("deep");
  const intent = (await second.process([obs(true)]))!;
  const msg = interventionMessage(intent.id, intent.action, intent.decision, intent.snapshot);
  assert.equal(msg.customType, "intervention-scheduler");
  for (const text of ["当前目标", "最可疑", "三步", "无需披露隐藏"]) assert.ok(String(msg.content).includes(text));
});
test("complete outcomes require retry evidence to evaluate correction proxy", async () => {
  const { sink, runtime } = make();
  const failure = { ...obs(true), error: "syntax" };
  await runtime.process([failure]);
  for (let i = 0; i < 5; i++) await runtime.process([obs()]);
  const outcome = sink.rows.find(r => r.type === "outcome");
  assert.equal(outcome?.errorResolved, null); // unrelated read cannot prove successful retry
});
