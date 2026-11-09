import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { LiveController } from "../live.ts";
import { Runtime } from "../runtime.ts";
import { Signals, normalize } from "../signals.ts";
import { defaults } from "../config.ts";
import { decide, initialState } from "../scheduler.ts";
import { replayText } from "../replay.ts";
import { logFiles, readRows } from "../report.ts";
import { MemorySink, sessionText, tempDirectory } from "./helpers.ts";
import type { ExtensionContext, ToolCallEvent, ToolResultEvent, TurnEndEvent } from "@earendil-works/pi-coding-agent";
import type { Snapshot } from "../types.ts";

async function liveSetup() {
  const directory = await tempDirectory("regression");
  process.env.PI_SCHEDULER_DATA_DIR = directory;
  delete process.env.PI_SCHEDULER_CONFIG;
  const entries: unknown[] = [];
  const context = { model: { provider: "fake", id: "test" }, thinkingLevel: "high",
    sessionManager: { getSessionId: () => "s", getLeafId: () => "root", getBranch: () => entries, getEntries: () => entries },
    ui: { notify: () => {} } } as unknown as ExtensionContext;
  const live = new LiveController();
  await live.start(context);
  return { live, context, directory, entries };
}
function event(id = "call"): TurnEndEvent {
  return { type: "turn_end", turnIndex: 1, outcome: "completed", entries: [], continue: false,
    context: { canContinue: true }, messageEntryId: "assistant", toolResultEntryIds: ["result"],
    message: { role: "assistant", stopReason: "toolUse", provider: "fake", model: "test", usage: { totalTokens: 10 },
      content: [{ type: "toolCall", id, name: "write", arguments: { path: "a.ts" } }] },
    toolResults: [{ role: "toolResult", toolCallId: id, toolName: "write", isError: false,
      content: [{ type: "text", text: "Successfully wrote file" }] }] } as unknown as TurnEndEvent;
}
test("review P1: off invalidates a boundary suspended in usage logging", async () => {
  const { live, context } = await liveSetup();
  await live.setMode("deep");
  const runtime = live.runtime!;
  const log = runtime.log.bind(runtime);
  let release!: () => void;
  let enter!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const entered = new Promise<void>(r => { enter = r; });
  runtime.log = async (type, fields) => { if (type === "usage") { enter(); await gate; } await log(type, fields); };
  const inFlight = live.boundary(event(), context);
  await entered;
  const disable = live.setMode("shadow");
  release();
  assert.equal(await inFlight, undefined);
  await disable;
  assert.equal(live.runtime!.mode, "shadow");
  await live.close(context);
});
test("review P1: finalized tool result wins over cached intermediate result, while executed-input risk survives", async () => {
  const { live, context, directory } = await liveSetup();
  live.observeCall({ type: "tool_call", toolName: "read", toolCallId: "call", input: { path: "a.ts" } } as ToolCallEvent);
  live.observeResult({ type: "tool_result", toolName: "read", toolCallId: "call", input: { path: ".ssh/id_rsa" },
    isError: true, content: [{ type: "text", text: "Permission denied" }], details: undefined } as ToolResultEvent);
  const final = event();
  final.toolResults[0]!.isError = false;
  final.toolResults[0]!.content = [{ type: "text", text: "success" }];
  await live.boundary(final, context);
  await live.close(context);
  const rows = (await readRows(await logFiles(join(directory, "logs")))).rows;
  const observation = rows.find(r => r.type === "score")!.observation as { error: string | null; risk: number };
  assert.equal(observation.error, null);
  assert.equal(observation.risk, 1);
});
test("review P1: missing result in the middle truncates earlier outcomes even when five later results exist", async () => {
  const entries = sessionText(12).trim().split("\n").map(line => JSON.parse(line));
  const text = entries.filter(row => row.id !== "rc2").map(row => {
    if (row.parentId === "rc2") row.parentId = "a2";
    return JSON.stringify(row);
  }).join("\n");
  const sink = new MemorySink();
  await replayText(text, sink);
  const candidate = sink.rows.find(r => r.type === "candidate")!;
  const outcome = sink.rows.find(r => r.type === "outcome" && r.id === candidate.id)!;
  assert.equal(outcome.complete, false);
  assert.ok(String(outcome.reason).includes("missing-tool-result"));
});
test("review P2: canonical parallel step and mid-batch outcome completion step are exact", async () => {
  const sink = new MemorySink();
  const runtime = new Runtime({ source: "live", sessionId: "s", branch: "b", model: "fake/test" }, {}, sink);
  const o = (id: string, risk = false) => normalize({ id, name: risk ? "write" : "read", input: { path: "a.ts" } },
    { id, isError: false, content: "" }, defaults);
  await runtime.process([o("one", true)]);
  await runtime.process(Array.from({ length: 7 }, (_, i) => o("next-" + i)));
  assert.deepEqual(sink.rows.filter(r => r.type === "score").map(r => r.step), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(sink.rows.find(r => r.type === "outcome")?.step, 6);
});
test("review P2: unrelated success cannot manufacture error-disappeared progress", () => {
  const failure = normalize({ id: "a", name: "bash", input: { command: "node broken.js" } },
    { id: "a", isError: true, content: "SyntaxError" }, defaults);
  const unrelated = normalize({ id: "b", name: "read", input: { path: "other.ts" } },
    { id: "b", isError: false, content: "" }, defaults);
  const signals = new Signals(defaults);
  signals.batch([failure]);
  assert.ok(!signals.batch([unrelated])[0]!.observation.production.includes("error-disappeared-proxy"));
  const retry = new Signals(defaults);
  retry.batch([failure]);
  assert.ok(retry.batch([{ ...failure, error: null }])[0]!.observation.production.includes("error-disappeared-proxy"));
});
test("review handoff: later real pi boundary handler cannot cause an unaccounted already-submitted draft after off", async () => {
  const { live, context, directory, entries } = await liveSetup();
  await live.setMode("deep");
  const base = import.meta.resolve("@earendil-works/pi-coding-agent");
  const { ExtensionRunner } = await import(new URL("./core/extensions/runner.js", base).href);
  const { createExtensionRuntime } = await import(new URL("./core/extensions/loader.js", base).href);
  let release!: () => void;
  let enter!: () => void;
  const paused = new Promise<void>(r => { enter = r; });
  const gate = new Promise<void>(r => { release = r; });
  const runner = new ExtensionRunner([
    { path: "scheduler", handlers: new Map([["turn_end", [(e: TurnEndEvent) => live.boundary(e, context)]]]) },
    { path: "later-extension", handlers: new Map([["turn_end", [async () => { enter(); await gate; }]]]) },
  ], createExtensionRuntime(), process.cwd(), context.sessionManager, {});
  runner.createContext = () => context;
  const running = runner.emitBoundary(event(), () => ({ canContinue: true, contextEntries: [], contextMessages: [], llmMessages: [], pendingMessages: [] }));
  await paused;
  await live.setMode("shadow");
  assert.equal(live.runtime!.mode, "shadow");
  release();
  const boundary = await running;
  assert.equal(boundary.entries.length, 1); // Host owns the submitted draft: off cannot retract it.
  entries.push({ ...boundary.entries[0], id: "committed", parentId: "root" });
  await live.confirm(context);
  await live.close(context);
  const rows = (await readRows(await logFiles(join(directory, "logs")))).rows;
  const actual = rows.filter(row => row.type === "intervention");
  assert.equal(actual.length, 1);
  assert.equal(actual[0]!.mode, "deep"); // attributed to the submission mode, not shadow
  assert.ok(rows.some(row => row.type === "outcome" && row.kind === "intervention" && row.complete === false));
});

test("submitted ledger survives runtime replacement, counts exactly once in original mode, and never bridges outcomes", async () => {
  const { live, context, directory, entries } = await liveSetup();
  await live.setMode("deep");
  const oldRuntime = live.runtime;
  const draft = (await live.boundary(event(), context))!.entries![0]!;
  await live.restart(context, "model-change");
  assert.notEqual(live.runtime, oldRuntime);
  entries.push({ ...draft, id: "late", parentId: "root" });
  await live.confirm(context, true);
  await live.confirm(context, true);
  await live.close(context);
  const rows = (await readRows(await logFiles(join(directory, "logs")))).rows;
  assert.equal(rows.filter(r => r.type === "intervention").length, 1);
  assert.ok(rows.some(r => r.type === "outcome" && r.reason === "context-changed-before-confirmation"));
});

test("submitted drafts are not prematurely expired by off, but missing drafts expire at a true post-boundary seam", async () => {
  const { live, context, directory } = await liveSetup();
  await live.setMode("deep");
  await live.boundary(event(), context);
  await live.setMode("shadow");
  let rows = (await readRows(await logFiles(join(directory, "logs")))).rows;
  assert.equal(rows.filter(r => r.type === "delivery-unknown").length, 0);
  await live.confirm(context, true);
  await live.close(context);
  rows = (await readRows(await logFiles(join(directory, "logs")))).rows;
  assert.equal(rows.filter(r => r.type === "intervention").length, 0);
  assert.equal(rows.filter(r => r.type === "delivery-unknown").length, 1);
});

test("custom minimum interval cannot suppress the first non-hard intervention", () => {
  const snapshot = { step: 1, U: .4, R: 0, P: 0, A: 0, sameErrorStreak: 0, riskReasons: [] } as unknown as Snapshot;
  const config = { ...defaults, minInterval: 10, weights: { U: 1, R: 0, P: 0, A: 0 } };
  assert.equal(decide(snapshot, initialState(), config).action, "light");
});
