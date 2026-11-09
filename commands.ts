import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Mode } from "./types.ts";

export interface CommandHost {
  setMode(mode: Mode): Promise<void>;
  status(): Promise<string>;
  report(days: number): Promise<string>;
}
export function registerCommands(pi: ExtensionAPI, host: CommandHost): void {
  pi.registerCommand("scheduler", {
    description: "Scheduler: on [deep] | off | status | report [days]",
    handler: async (args, ctx) => {
      try {
        const tokens = args.trim().split(/\s+/).filter(Boolean);
        const command = tokens[0] ?? "status";
        if (command === "on" && tokens.length <= 2 && (!tokens[1] || tokens[1] === "deep")) {
          await host.setMode(tokens[1] === "deep" ? "deep" : "light");
          ctx.ui.notify(tokens[1] === "deep" ? "完整两档介入已开启；请确认已完成轻档现场验收。" : "轻介入已开启；深想建议仅作事实提醒。", "warning");
        } else if (command === "off" && tokens.length === 1) {
          await host.setMode("shadow");
          ctx.ui.notify("新介入已关闭；影子记录继续。已提交给 pi 的提醒无法撤回，仍会确认记账。", "info");
        } else if (command === "status" && tokens.length <= 1) {
          ctx.ui.notify(await host.status(), "info");
        } else if (command === "report" && tokens.length <= 2) {
          const days = tokens[1] === undefined ? 7 : Number(tokens[1]);
          if (!Number.isFinite(days) || days <= 0 || days > 36500) throw new Error("Invalid days");
          ctx.ui.notify(await host.report(days), "info");
        } else ctx.ui.notify("用法：/scheduler on [deep] | off | status | report [days]", "warning");
      } catch {
        ctx.ui.notify("Scheduler 操作失败，未开启新的介入。请检查日志目录、配置与参数，必要时 /reload。", "error");
      }
    },
  });
}
