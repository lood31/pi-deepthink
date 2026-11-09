import type { CustomMessageEntryDraft } from "@earendil-works/pi-coding-agent";
import type { Action, Decision, Snapshot } from "./types.ts";

export function interventionMessage(id: string, action: Exclude<Action, "pass">, decision: Decision, snapshot: Snapshot): CustomMessageEntryDraft {
  const facts = snapshot.facts.join("；");
  const reason = decision.reasons.join("、");
  const content = action === "light"
    ? "[调度器事实提醒 " + id + "] 触发：" + reason + "。最近观测：" + facts + "。"
    : "[调度器复盘 " + id + "] 触发：" + reason + "。最近观测：" + facts
      + "。请在继续工作前给出简短、可审阅的三项摘要："
      + "1. 当前目标与已完成部分；2. 最近几步最可疑的一步；3. 接下来三步的计划。"
      + "无需披露隐藏推理过程。随后继续原任务。";
  return {
    type: "custom_message", customType: "intervention-scheduler", content, display: true,
    details: { schedulerId: id, action, reasons: decision.reasons },
  };
}
