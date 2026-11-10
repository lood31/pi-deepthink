import type { CustomMessageEntryDraft } from "@earendil-works/pi-coding-agent";
import type { Action, Decision, Recurrence, Snapshot } from "./types.ts";

export function interventionMessage(id: string, action: Exclude<Action, "pass">, decision: Decision, snapshot: Snapshot, recurrence?: Recurrence): CustomMessageEntryDraft {
  const facts = snapshot.facts.join("；");
  const reason = decision.reasons.join("、");
  const repeated = recurrence ? "上次介入 " + recurrence.previousId + " 后 " + recurrence.stepsSince
    + " 个工具步，同目标同类错误再次出现（" + recurrence.error + "）。" : "";
  const content = action === "light"
    ? "[调度器事实提醒 " + id + "] 触发：" + reason + "。最近观测：" + facts + "。" + repeated
    : recurrence
    ? "[调度器复发复盘 " + id + "] 触发：" + reason + "。最近观测：" + facts + "。" + repeated
      + "请在继续工作前给出简短、可审阅的摘要："
      + "1. 上次尝试的可观察结果；2. 当前失败假设；3. 接下来一条不同路线及其可执行验证。"
      + "无需披露隐藏推理过程。随后继续原任务。"
    : "[调度器复盘 " + id + "] 触发：" + reason + "。最近观测：" + facts
      + "。请在继续工作前给出简短、可审阅的三项摘要："
      + "1. 当前目标与已完成部分；2. 最近几步最可疑的一步；3. 接下来三步的计划。"
      + "无需披露隐藏推理过程。随后继续原任务。";
  return {
    type: "custom_message", customType: "intervention-scheduler", content, display: true,
    details: { schedulerId: id, action, reasons: decision.reasons, ...(recurrence ? { recurrence } : {}) },
  };
}
