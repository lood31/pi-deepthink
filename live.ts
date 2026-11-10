import { join } from "node:path";
import type { ExtensionContext, ToolCallEvent, ToolResultEvent, TurnEndEvent, BoundaryResult } from "@earendil-works/pi-coding-agent";
import { dataDirectory, loadConfig, resolveConfig } from "./config.ts";
import { Runtime } from "./runtime.ts";
import type { Intent } from "./runtime.ts";
import { Recorder } from "./recorder.ts";
import { finalize, normalize } from "./signals.ts";
import { interventionMessage } from "./intervener.ts";
import { formatReport, reportDirectory } from "./report.ts";
import type { ConfigFile, Mode, Observation } from "./types.ts";

export class LiveController {
  runtime: Runtime | null = null;
  private recorder: Recorder | null = null;
  private file: ConfigFile = {};
  private observations = new Map<string, Observation>();
  private topCalls = new Set<string>();
  private context: ExtensionContext | null = null;
  private warned = false;
  private broken = false;
  private directory = join(dataDirectory(), "logs");
  private generation = 0;
  private submissions = new Map<string, { runtime: Runtime; intent: Intent; mode: Mode; generation: number }>();
  private operations: Promise<void> = Promise.resolve();

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.operations.then(work);
    this.operations = result.then(() => {}, () => {});
    return result;
  }

  async guard(ctx: ExtensionContext, work: () => Promise<unknown> | unknown): Promise<void> {
    this.context = ctx;
    try { await work(); } catch { await this.fail(ctx); }
  }

  async fail(ctx: ExtensionContext): Promise<void> {
    this.generation++;
    this.broken = true;
    if (this.runtime) {
      this.runtime.failed = true;
      await this.runtime.log("health", { issue: "component-failure", failOpen: true }).catch(() => {});
    }
    if (!this.warned) {
      this.warned = true;
      try { ctx.ui.notify("Scheduler 已失效放行：不再注入。请检查配置/日志权限后 /reload。", "warning"); } catch { /* headless */ }
    }
  }

  async start(ctx: ExtensionContext): Promise<void> {
    this.context = ctx;
    try {
      this.file = await loadConfig();
      const model = ctx.model ? ctx.model.provider + "/" + ctx.model.id : "unknown";
      const config = resolveConfig(this.file, model);
      this.directory = join(dataDirectory(), "logs");
      this.recorder = new Recorder({
        directory: this.directory, retentionDays: config.retentionDays,
        onError: () => { this.broken = true; void this.fail(ctx); },
      });
      await this.recorder.open();
      this.runtime = new Runtime({
        source: "live", sessionId: ctx.sessionManager.getSessionId(),
        branch: ctx.sessionManager.getLeafId() ?? "root", model,
      }, this.file, this.recorder);
      await this.runtime.log("lifecycle", { reason: "session-start", thinkingLevel: ctx.thinkingLevel ?? "unknown" });
      if (!this.recorder.healthy) await this.fail(ctx);
    } catch { await this.fail(ctx); }
  }

  restart(ctx: ExtensionContext, reason: string): Promise<void> {
    this.generation++;
    return this.serial(() => this.restartWork(ctx, reason));
  }

  private async restartWork(ctx: ExtensionContext, reason: string): Promise<void> {
    if (this.broken || !this.runtime || !this.recorder) return;
    await this.confirmPersisted(ctx);
    const mode = this.runtime.mode;
    await this.runtime.close(reason);
    this.observations.clear();
    this.topCalls.clear();
    this.runtime = new Runtime({
      source: "live", sessionId: ctx.sessionManager.getSessionId(),
      branch: ctx.sessionManager.getLeafId() ?? "root",
      model: ctx.model ? ctx.model.provider + "/" + ctx.model.id : "unknown",
    }, this.file, this.recorder);
    this.runtime.mode = mode;
    await this.runtime.log("lifecycle", { reason });
  }

  observeCall(event: ToolCallEvent): void {
    if (event.parentToolCallId || !this.runtime || !this.runtime.healthy) return;
    this.topCalls.add(event.toolCallId);
  }

  observeResult(event: ToolResultEvent): void {
    if (event.parentToolCallId || !this.runtime || !this.runtime.healthy || !this.topCalls.has(event.toolCallId)) return;
    this.observations.set(event.toolCallId, normalize(
      { id: event.toolCallId, name: event.toolName, input: event.input },
      { id: event.toolCallId, isError: event.isError, content: event.content.filter(b => b.type === "text").map(b => b.text).join("\n"), details: event.details },
      this.runtime.config,
    ));
  }

  confirm(ctx: ExtensionContext, postBoundary = false): Promise<void> {
    return this.serial(() => this.confirmPersisted(ctx, postBoundary));
  }

  private async confirmPersisted(ctx: ExtensionContext, postBoundary = false): Promise<void> {
    if (!this.submissions.size) return;
    const ids = new Set<string>();
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type !== "custom_message" || entry.customType !== "intervention-scheduler") continue;
      if (entry.details && typeof entry.details === "object" && "schedulerId" in entry.details
        && typeof entry.details.schedulerId === "string") ids.add(entry.details.schedulerId);
    }
    for (const [id, submission] of this.submissions) {
      if (ids.has(id)) {
        this.submissions.delete(id);
        await submission.runtime.delivered(submission.intent, submission.mode,
          submission.generation === this.generation && submission.runtime === this.runtime);
      } else if (postBoundary) {
        this.submissions.delete(id);
        await submission.runtime.log("delivery-unknown", { id, mode: submission.mode,
          step: submission.intent.boundaryStep, delivery: "not-confirmed-after-boundary" });
      }
    }
  }

  boundary(event: TurnEndEvent, ctx: ExtensionContext): Promise<BoundaryResult | undefined> {
    const generation = this.generation;
    return this.serial(() => this.boundaryWork(event, ctx, generation));
  }

  private async boundaryWork(event: TurnEndEvent, ctx: ExtensionContext, generation: number): Promise<BoundaryResult | undefined> {
    this.context = ctx;
    if (this.broken || !this.runtime) return;
    try {
      await this.confirmPersisted(ctx, true);
      if (event.message.role !== "assistant") return;
      const calls = event.message.content.filter(b => b.type === "toolCall");
      const ordered: Observation[] = [];
      for (const call of calls) {
        const result = event.toolResults.find(r => r.toolCallId === call.id);
        if (!result) continue;
        const finalResult = { id: call.id, isError: result.isError,
          content: result.content.filter(b => b.type === "text").map(b => b.text).join("\n"), details: result.details };
        const cached = this.observations.get(call.id);
        const observed = cached ? finalize(cached, finalResult) : normalize(
          { id: call.id, name: call.name, input: call.arguments }, finalResult, this.runtime.config);
        ordered.push({ ...observed, entryId: event.messageEntryId });
      }
      this.observations.clear();
      this.topCalls.clear();
      const eligible = event.outcome === "completed" && event.context.canContinue
        && event.message.stopReason === "toolUse" && ordered.length > 0 && ordered.length === calls.length;
      const intent = await this.runtime.process(ordered, eligible);
      const tokens = event.message.usage.totalTokens;
      if (Number.isFinite(tokens) && tokens >= 0) await this.runtime.log("usage", { tokens });
      if (!this.runtime.healthy) { await this.fail(ctx); return; }
      if (!intent || generation !== this.generation || this.runtime.mode === "shadow"
        || this.runtime.pendingId !== intent.id) return;
      const draft = interventionMessage(intent.id, intent.action, intent.decision, intent.snapshot, intent.recurrence);
      if (!this.runtime.submit(intent.id)) return;
      // Host-owned drafts are not retractable. Keep them across off/reset until post-boundary confirmation.
      this.submissions.set(intent.id, { runtime: this.runtime, intent, mode: this.runtime.mode, generation });
      return { entries: [...event.entries, draft] };
    } catch { await this.fail(ctx); return; }
  }

  settle(ctx: ExtensionContext): Promise<void> {
    return this.serial(async () => {
      await this.confirmPersisted(ctx, true);
      await this.runtime?.settle();
    });
  }

  close(ctx: ExtensionContext): Promise<void> {
    this.generation++;
    return this.serial(() => this.closeWork(ctx));
  }

  private async closeWork(ctx: ExtensionContext): Promise<void> {
    await this.confirmPersisted(ctx, true);
    await this.runtime?.close("session-shutdown");
    await this.recorder?.flush();
    this.observations.clear();
    this.topCalls.clear();
  }

  setMode(mode: Mode): Promise<void> {
    // Invalidate before awaiting the queue, including a boundary blocked on I/O.
    this.generation++;
    return this.serial(async () => {
      if (!this.runtime || !this.context || (this.broken && mode !== "shadow")) throw new Error("Scheduler unavailable");
      await this.confirmPersisted(this.context);
      await this.runtime.changeMode(mode);
    });
  }

  async report(days: number): Promise<string> {
    await this.recorder?.flush();
    return formatReport(await reportDirectory(this.directory, { source: "live", from: new Date(Date.now() - days * 86400000) }));
  }

  async status(): Promise<string> {
    await this.recorder?.flush();
    const from = new Date();
    from.setHours(0, 0, 0, 0);
    const r = await reportDirectory(this.directory, { source: "live", from });
    return [
      "模式：" + (this.broken || !this.runtime?.healthy ? "failed（自动放行）" : this.runtime.mode),
      "模型：" + (this.runtime?.meta.model ?? "unknown"),
      "今日（本地日界）候选 " + r.candidates + " / 已落会话介入 " + r.interventions,
      "已提交给 pi 待确认 " + this.submissions.size + "（已提交消息无法撤回）",
      "记录：" + (this.recorder?.healthy ? "可写" : "异常") + "；" + this.directory,
    ].join("\n");
  }
}
