import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import type { ExtensionContext, TurnEndEvent } from "@earendil-works/pi-coding-agent";
import { defaults, resolveConfig } from "../config.ts";
import { Runtime } from "../runtime.ts";
import type { Intent } from "../runtime.ts";
import { LiveController } from "../live.ts";
import { interventionMessage } from "../intervener.ts";
import { normalize } from "../signals.ts";
import { logFiles, readRows, summarize } from "../report.ts";
import { MemorySink, tempDirectory } from "./helpers.ts";
import type { Mode, Observation } from "../types.ts";

let serial = 0;
function observation(patch: Partial<Observation> = {}): Observation {
  const id = "h3-call-" + ++serial;
  return { ...normalize({ id, name: "write", input: { path: "/private/a.ts" } },
    { id, isError: true, content: "SyntaxError: SECRET" }, defaults), ...patch };
}
async function setup(window = 5, mode: Mode = "deep") {
  const sink = new MemorySink();
  const runtime = new Runtime({ source: "live", sessionId: "h3", branch: "root", model: "fake/test", runId: "h3" },
    { defaults: { recurrenceWindow: window } }, sink);
  await runtime.changeMode(mode);
  return { runtime, sink };
}
async function delivered(runtime: Runtime, obs = observation()) {
  const intent = (await runtime.process([obs]))!;
  assert.ok(intent);
  await runtime.confirm(new Set([intent.id]));
  return intent;
}
function message(intent: Intent) {
  return interventionMessage(intent.id, intent.action, intent.decision, intent.snapshot, intent.recurrence);
}
const unrelated = () => observation({ tool: "read", target: "unrelated-hash", mutation: false,
  risk: 0, riskReasons: [], error: null });

test("H3 config is opt-in, bounded, and supports model overrides", () => {
  assert.equal(resolveConfig().recurrenceWindow, 0);
  for (const recurrenceWindow of [0, 1, 5, 10000]) {
    assert.equal(resolveConfig({ defaults: { recurrenceWindow } }).recurrenceWindow, recurrenceWindow);
  }
  for (const recurrenceWindow of [-1, .5, NaN, Infinity, "5", null, 10001]) {
    assert.throws(() => resolveConfig({ defaults: { recurrenceWindow } } as never));
  }
  assert.equal(resolveConfig({ defaults: { recurrenceWindow: 5 }, models: { "fake/test": { recurrenceWindow: 0 } } }, "fake/test").recurrenceWindow, 0);
  assert.throws(() => resolveConfig({ models: { ignored: { recurrenceWindow: -1 } } }));
});

test("H3 default and explicit zero preserve the original template and omit metadata", async () => {
  for (const window of [undefined, 0]) {
    const { runtime, sink } = await setup(window === undefined ? 0 : window);
    // Also exercise the actual missing-key default, rather than just an explicit zero.
    const current = window === undefined
      ? new Runtime({ source: "live", sessionId: "s", branch: "b", model: "x" }, {}, sink) : runtime;
    if (window === undefined) await current.changeMode("deep");
    await delivered(current);
    const next = (await current.process([observation()]))!;
    assert.equal(next.recurrence, undefined);
    const draft = message(next);
    assert.equal(draft.content, "[调度器复盘 " + next.id + "] 触发：" + next.decision.reasons.join("、")
      + "。最近观测：" + next.snapshot.facts.join("；") + "。请在继续工作前给出简短、可审阅的三项摘要："
      + "1. 当前目标与已完成部分；2. 最近几步最可疑的一步；3. 接下来三步的计划。"
      + "无需披露隐藏推理过程。随后继续原任务。");
    assert.ok(sink.rows.every(row => !("recurrence" in row)));
    assert.ok(draft.details && typeof draft.details === "object");
    assert.ok(!("recurrence" in draft.details));
  }
});

test("H3 links only persisted interventions and records the same private metadata in draft/proposed/persisted", async () => {
  const { runtime, sink } = await setup();
  const previous = await delivered(runtime);
  const next = (await runtime.process([observation()]))!;
  const expected = { previousId: previous.id, error: "syntax", stepsSince: 1 };
  assert.deepEqual(next.recurrence, expected);
  const draft = message(next);
  assert.deepEqual((draft.details as { recurrence: unknown }).recurrence, expected);
  for (const snippet of ["同类错误再次出现", "上次尝试的可观察结果", "当前失败假设", "不同路线", "可执行验证", "无需披露隐藏推理过程"]) {
    assert.ok(String(draft.content).includes(snippet), snippet);
  }
  await runtime.confirm(new Set([next.id]));
  const rows = sink.rows.filter(row => row.id === next.id && ["intervention-proposed", "intervention"].includes(row.type));
  assert.equal(rows.length, 2);
  for (const row of rows) assert.deepEqual(row.recurrence, expected);
  assert.ok(!JSON.stringify(expected).includes("/private"));
  assert.ok(!JSON.stringify(draft).includes("SECRET"));
  assert.equal(summarize(sink.rows).interventions, 2);
});

test("H3 window includes steps 1 and K but excludes K+1; unrelated success is not recovery", async () => {
  for (const distance of [1, 5, 6]) {
    const { runtime } = await setup();
    await delivered(runtime);
    for (let i = 1; i < distance; i++) assert.equal(await runtime.process([unrelated()]), null);
    const next = (await runtime.process([observation()]))!;
    assert.equal(next.recurrence?.stepsSince, distance <= 5 ? distance : undefined);
  }
});

test("H3 a later sibling expiring the window cannot erase an in-window selected error", async () => {
  const { runtime } = await setup(1);
  const previous = await delivered(runtime);
  const next = (await runtime.process([observation(), unrelated()]))!;
  assert.equal(next.snapshot.step, 2);
  assert.equal(next.boundaryStep, 3);
  assert.deepEqual(next.recurrence, { previousId: previous.id, error: "syntax", stepsSince: 1 });
  // Leave this draft unconfirmed: the expired old anchor must not survive into the next batch.
  const later = (await runtime.process([observation()]))!;
  assert.equal(later.recurrence, undefined);
});

test("H3 recovery after an in-window failure still clears its association", async () => {
  const { runtime } = await setup(1);
  await delivered(runtime);
  const next = (await runtime.process([observation(), observation({ error: null, risk: 0, riskReasons: [] })]))!;
  assert.equal(next.snapshot.step, 2);
  assert.equal(next.recurrence, undefined);
});

test("H3 requires matching error, tool, and target", async () => {
  for (const patch of [{ error: "permission" }, { tool: "edit" }, { target: "different-hash" }]) {
    const { runtime } = await setup();
    await delivered(runtime);
    const next = (await runtime.process([observation(patch)]))!;
    assert.equal(next.recurrence, undefined);
  }
});

test("H3 successful retry clears history even if a later sibling fails; non-error delivery also clears it", async () => {
  const { runtime } = await setup();
  await delivered(runtime);
  const recovered = observation({ error: null, risk: 0, riskReasons: [] });
  const next = (await runtime.process([recovered, observation()]))!;
  assert.equal(next.recurrence, undefined);
  await runtime.confirm(new Set([next.id]));
  await delivered(runtime, observation({ error: null, target: "other-hash" }));
  assert.equal((await runtime.process([observation()]))!.recurrence, undefined);
});

test("H3 unconfirmed, ineligible, and discontinuous drafts cannot seed history", async () => {
  for (const delivery of ["unknown", "implicit-unknown", "discontinuous", "ineligible"]) {
    const { runtime } = await setup();
    const first = await runtime.process([observation()], delivery !== "ineligible");
    if (delivery === "unknown") await runtime.confirm(new Set());
    if (delivery === "discontinuous") {
      assert.ok(runtime.submit(first!.id));
      await runtime.delivered(first!, "deep", false);
    }
    const next = (await runtime.process([observation()]))!;
    assert.equal(next.recurrence, undefined, delivery);
  }
});

test("H3 reset and mode changes clear anchors; delayed discontinuous confirmation does not revive one", async () => {
  for (const reason of ["compaction", "tree-navigation", "model-change", "mode-change"]) {
    const { runtime } = await setup();
    const first = await delivered(runtime);
    if (reason === "mode-change") await runtime.changeMode("deep");
    else await runtime.reset(reason);
    await runtime.delivered(first, "deep", false);
    assert.equal((await runtime.process([observation()]))!.recurrence, undefined, reason);
  }
});

test("H3 siblings use the preceding boundary, never a sibling intervention", async () => {
  const { runtime } = await setup();
  const first = (await runtime.process([observation(), observation()]))!;
  assert.equal(first.recurrence, undefined);
  assert.equal(first.boundaryStep, 2);
  await runtime.confirm(new Set([first.id]));
  const next = (await runtime.process([observation(), observation()]))!;
  assert.equal(next.recurrence?.stepsSince, 2);
});

test("H3 light is still factual and shadow never builds an actual recurrence chain", async () => {
  const { runtime } = await setup(5, "light");
  await delivered(runtime);
  const next = (await runtime.process([observation()]))!;
  assert.equal(next.action, "light");
  assert.ok(String(message(next).content).includes("同类错误再次出现"));
  assert.ok(!String(message(next).content).includes("请在继续工作前"));
  assert.ok(!String(message(next).content).includes("当前失败假设"));
  const shadow = await setup(5, "shadow");
  for (let i = 0; i < 3; i++) assert.equal(await shadow.runtime.process([observation()]), null);
  assert.equal(shadow.sink.rows.filter(row => row.type === "intervention-proposed").length, 0);
  await shadow.runtime.changeMode("deep");
  assert.equal((await shadow.runtime.process([observation()]))!.recurrence, undefined);
});

test("H3 neither bypasses cooldown nor promotes a scheduled light action", async () => {
  const { runtime } = await setup();
  await delivered(runtime);
  // Different error prevents the existing repeated-error hard trigger.
  assert.equal(await runtime.process([observation({ risk: 0, riskReasons: [], error: "permission" })]), null);
  // A normal-risk same-error recurrence can be selected as light by the original scheduler.
  const lowRisk = await setup();
  const first = await delivered(lowRisk.runtime);
  await lowRisk.runtime.process([unrelated()]);
  await lowRisk.runtime.process([unrelated()]);
  const next = (await lowRisk.runtime.process([observation({ risk: 0, riskReasons: [] })]))!;
  assert.equal(next.action, "light");
  assert.equal(next.recurrence?.previousId, first.id);
});

test("H3 deduplicates tool calls, respects sink health, and has action/reason parity with disabled", async () => {
  const off = await setup(0);
  const on = await setup();
  const sequence = [observation(), observation(), unrelated(), observation(), observation({ error: null }), observation()];
  for (const o of sequence) {
    const a = await off.runtime.process([o]);
    const b = await on.runtime.process([o]);
    assert.equal(a?.action, b?.action);
    assert.deepEqual(a?.decision, b?.decision);
    if (a) await off.runtime.confirm(new Set([a.id]));
    if (b) await on.runtime.confirm(new Set([b.id]));
  }
  const step = on.runtime.step;
  assert.equal(await on.runtime.process([sequence[0]!]), null);
  assert.equal(on.runtime.step, step);
  const scores = (sink: MemorySink) => sink.rows.filter(row => row.type === "score").map(row => ({
    score: row.score, action: row.proposedAction, actual: row.actualProposedAction, reasons: row.reasons,
  }));
  assert.deepEqual(scores(on.sink), scores(off.sink));
  assert.equal(summarize(on.sink.rows).interventions, summarize(off.sink.rows).interventions);
  on.sink.healthy = false;
  assert.equal(await on.runtime.process([observation()]), null);
});

function boundary(id: string): TurnEndEvent {
  return { type: "turn_end", turnIndex: 1, outcome: "completed", entries: [], continue: false,
    context: { canContinue: true }, messageEntryId: "a-" + id, toolResultEntryIds: ["r-" + id],
    message: { role: "assistant", stopReason: "toolUse", provider: "fake", model: "test", usage: { totalTokens: 10 },
      content: [{ type: "toolCall", id, name: "write", arguments: { path: "/private/a.ts" } }] },
    toolResults: [{ role: "toolResult", toolCallId: id, toolName: "write", isError: true,
      content: [{ type: "text", text: "SyntaxError: SECRET" }] }] } as unknown as TurnEndEvent;
}

test("H3 live boundary passes metadata to templates and never bridges off/model/compaction/tree confirmation", async () => {
  const previousData = process.env.PI_SCHEDULER_DATA_DIR;
  const previousConfig = process.env.PI_SCHEDULER_CONFIG;
  try {
    for (const transition of ["continuous", "off", "model-change", "compaction", "tree-navigation", "missing"]) {
      const directory = await tempDirectory("h3-live");
      const config = resolve(directory, "config.json");
      await writeFile(config, JSON.stringify({ defaults: { recurrenceWindow: 5 } }));
      process.env.PI_SCHEDULER_DATA_DIR = directory;
      process.env.PI_SCHEDULER_CONFIG = config;
      const entries: unknown[] = [];
      const ctx = { model: { provider: "fake", id: "test" },
        sessionManager: { getSessionId: () => "h3", getLeafId: () => "root", getEntries: () => entries },
        ui: { notify: () => {} } } as unknown as ExtensionContext;
      const live = new LiveController();
      await live.start(ctx);
      await live.setMode("deep");
      try {
        const first = (await live.boundary(boundary("first"), ctx))!.entries![0]!;
        if (transition === "off") { await live.setMode("shadow"); await live.setMode("deep"); }
        else if (!["continuous", "missing"].includes(transition)) await live.restart(ctx, transition);
        if (transition !== "missing") entries.push({ ...first, id: "saved-first" });
        await live.confirm(ctx, true);
        const next = (await live.boundary(boundary("second"), ctx))!.entries![0]!;
        assert.ok(next.type === "custom_message");
        const details = next.details as { recurrence?: { stepsSince: number } };
        assert.equal(details.recurrence?.stepsSince, transition === "continuous" ? 1 : undefined, transition);
        if (transition === "continuous") {
          assert.ok(String(next.content).includes("上次尝试的可观察结果"));
          entries.push({ ...next, id: "saved-next" });
          await live.confirm(ctx, true);
        }
      } finally { await live.close(ctx); }
      const rows = (await readRows(await logFiles(resolve(directory, "logs")))).rows;
      assert.equal(rows.filter(row => row.type === "intervention" && row.recurrence).length, transition === "continuous" ? 1 : 0);
    }
  } finally {
    if (previousData === undefined) delete process.env.PI_SCHEDULER_DATA_DIR;
    else process.env.PI_SCHEDULER_DATA_DIR = previousData;
    if (previousConfig === undefined) delete process.env.PI_SCHEDULER_CONFIG;
    else process.env.PI_SCHEDULER_CONFIG = previousConfig;
  }
});
