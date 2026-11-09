import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCommands } from "./commands.ts";
import { LiveController } from "./live.ts";

export default function schedulerExtension(pi: ExtensionAPI): void {
  const live = new LiveController();
  registerCommands(pi, live);
  pi.on("session_start", (_event, ctx) => live.guard(ctx, () => live.start(ctx)));
  pi.on("tool_call", (event, ctx) => live.guard(ctx, () => live.observeCall(event)));
  pi.on("tool_result", (event, ctx) => live.guard(ctx, () => live.observeResult(event)));
  pi.on("turn_start", (_event, ctx) => live.guard(ctx, () => live.confirm(ctx, true)));
  pi.on("turn_end", (event, ctx) => live.boundary(event, ctx));
  pi.on("model_select", (_event, ctx) => live.guard(ctx, () => live.restart(ctx, "model-change")));
  pi.on("session_tree", (_event, ctx) => live.guard(ctx, () => live.restart(ctx, "tree-navigation")));
  pi.on("session_compact", (_event, ctx) => live.guard(ctx, () => live.restart(ctx, "compaction")));
  pi.on("agent_settled", (_event, ctx) => live.guard(ctx, () => live.settle(ctx)));
  pi.on("session_shutdown", (_event, ctx) => live.guard(ctx, () => live.close(ctx)));
}
