import { test } from "node:test";
import assert from "node:assert/strict";
import { registerCommands } from "../commands.ts";
import { formatReport, summarize } from "../report.ts";
import { Runtime } from "../runtime.ts";
import { MemorySink } from "./helpers.ts";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Mode } from "../types.ts";

test("on/off/status/report commands use explicit modes, validate arguments and contain failures", async () => {
  let handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> = async () => { throw new Error("not registered"); };
  const pi = { registerCommand: (name: string, command: { handler: typeof handler }) => {
    assert.equal(name, "scheduler"); handler = command.handler;
  } } as unknown as ExtensionAPI;
  const modes: Mode[] = [];
  const notices: string[] = [];
  const days: number[] = [];
  registerCommands(pi, {
    async setMode(mode) { modes.push(mode); }, async status() { return "shadow"; },
    async report(day) { days.push(day); return "report"; },
  });
  const ctx = { ui: { notify: (text: string) => notices.push(text) } } as unknown as ExtensionCommandContext;
  for (const args of ["on", "on deep", "off", "status", "", "report", "report 30", "report -1", "report NaN", "on cheap", "off extra"]) {
    await handler(args, ctx);
  }
  assert.deepEqual(modes, ["light", "deep", "shadow"]);
  assert.deepEqual(days, [7, 30]);
  assert.equal(notices.length, 11);
  registerCommands(pi, { async setMode() { throw new Error("TOP_SECRET"); }, async status() { throw new Error("TOP_SECRET"); }, async report() { return ""; } });
  await handler("on deep", ctx);
  assert.ok(!notices.at(-1)!.includes("TOP_SECRET"));
});

test("reports distinguish proposed/confirmed and require complete, evaluable outcomes", () => {
  const sink = new MemorySink();
  const engine = new Runtime({ source: "live", sessionId: "s", branch: "b", model: "x/y" }, {}, sink);
  const candidate = engine.row("candidate", { id: "c", reasons: ["risk:max"] });
  const proposed = engine.row("intervention-proposed", { id: "i" });
  const known = engine.row("intervention", { id: "i", action: "light", reasons: ["risk:max"] });
  const complete = engine.row("outcome", { id: "i", complete: true, observedSteps: 5, baselineError: "syntax", errorResolved: true,
    newError: false, directionChanged: true, productionEvents: 1, unknownProductionSteps: 0 });
  const incomplete = engine.row("outcome", { id: "c", complete: false, observedSteps: 3, baselineError: "syntax", errorResolved: true });
  const r = summarize([candidate, proposed, known, complete, incomplete]);
  assert.equal(r.interventions, 1);
  assert.equal(r.candidates, 1);
  assert.equal(r.completeOutcomes, 1);
  assert.equal(r.incomplete, 1);
  assert.equal(r.correctionProxy["shadow:intervention"]?.rate, 1);
  const empty = summarize([proposed]);
  assert.equal(empty.interventions, 0);
  assert.ok(formatReport(empty).includes("N/A"));
});

test("report period selects origins, retains their later outcomes, and isolates replay from live", () => {
  const sink = new MemorySink();
  const engine = new Runtime({ source: "live", sessionId: "s", branch: "b", model: "x/y" }, {}, sink);
  const origin = engine.row("candidate", { id: "c", reasons: [] });
  origin.timestamp = "2026-01-01T12:00:00Z";
  const outcome = engine.row("outcome", { id: "c", complete: true, observedSteps: 5, errorResolved: null });
  outcome.timestamp = "2026-01-02T12:00:00Z";
  const replay = { ...origin, id: "replay", source: "replay" as const };
  const r = summarize([origin, outcome, replay], { from: new Date("2026-01-01T00:00:00Z"), to: new Date("2026-01-02T00:00:00Z"), source: "live" });
  assert.equal(r.candidates, 1);
  assert.equal(r.completeOutcomes, 1);
  assert.equal(Object.values(r.correctionProxy)[0]?.rate, null);
});
