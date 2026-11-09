# pi 介入时机调度器

TypeScript pi 扩展：观察工具步骤，计算 U/R/P/A，按需追加事实提醒或简短复盘。默认 **shadow（只记录）**。本机兼容性基线为 **pi 1.5.0**。

> 不是安全防火墙：不阻断、不修改工具，高危操作可能先执行、下一回合才收到提醒。不要拿它保护删除、推送或凭据。
>
> 工程测试通过不等于有效性已验证。真实会话抽查、一周影子、一周轻介入及独立双臂评测尚须分别完成。

## 开发与临时加载

```powershell
cd D:\1pi\pi-deepthing
npm install --ignore-scripts
npm run check
pi -e "D:\1pi\pi-deepthing"
```

扩展由 pi/jiti 直接加载，无需 build。包 manifest 只声明 `index.ts`，不会把辅助文件当作独立扩展。开发测试使用支持直接运行 TS 的 Node（24 或 22.18+），不需要 API key，不发起模型请求。

上述 `pi -e` 启动的是你主动打开的 pi，不会给已经运行的会话偷偷装插件。若以后要持久安装，包应放在 `~/.pi/agent/extensions/pi-intervention-scheduler/` 子目录，保留整个包及 manifest，**不要把全部 TS 文件散放到 extensions 根目录**。本次交付没有修改全局 settings，也没有自动开启介入。

## 命令

| 命令 | 行为 |
| --- | --- |
| `/scheduler status` | 模式、当前模型、本地今日候选/真实介入、记录健康和目录 |
| `/scheduler on` | 开轻档；deep 建议也只发事实提醒 |
| `/scheduler on deep` | 显式启用完整 light/deep 两档 |
| `/scheduler off` | 关闭真实介入，仍采集和记录 shadow |
| `/scheduler report` | 最近 7 天 live 汇总 |
| `/scheduler report 30` | 最近 30 天 live 汇总 |

开关是当前扩展实例的内存状态。`off` 立即使本插件尚未返回的草稿失效，但已返回给 pi 的草稿由主机掌管，不能撤回：若另一个扩展正在异步处理同一边界，这条旧提醒仍可能稍后落盘。插件保留提交账本，随后按提交时的模式确认记账，不把它漏算或误算成 shadow 的新注入。新会话、重载回到 shadow；模式不持久化。模型切换、压缩和树导航保留模式，但重置短窗口。调度器自身或 recorder 异常后进入 failed，不注入；修复权限/配置后 `/reload`。报告失败会提示，不把不可用当健康。

## v0：只读离线回放

先由你选一组允许用于抽查的 pi **v3** 会话 JSONL；不需要上传，不默认遍历私人历史。

```powershell
npm run replay -- "D:\selected-sessions" --out ".tmp\replay"
npm run replay -- "D:\selected-sessions\example.jsonl" --out ".tmp\replay" --leaf "entry-id"
```

目录输入只读取该目录直接包含的 `.jsonl`，不递归。每次新建 `replay-UUID` 输出子目录，包含：

- `scheduler-*.jsonl`：回放的 score/candidate/outcome 等；source 为 replay，绝不注入。
- `summary.json`：会话数、步数、警告、被排除文件和分数等汇总。
- `review.md`：最多 20 个可复现抽样点，含 session/branch/entry ID，判断栏保留“待判断”。

默认选择最后有效 entry 所在分支；`--leaf` 可指定已有 entry。按 parentId 只走选中路径，不混入遗弃分支；只读解析，不调用会迁移旧文件的 SessionManager.open。旧版本、坏 JSON、断链、重复 ID 等报错并排除该文件；缺工具结果只记录已知结果并告警，不伪造成功；缺失批次前后截断窗口和 outcome，不能把未知步骤跨接成完整五步样本。非完整结果会话不适合用作完整效果样本。

抽查时用原会话的 session/entry ID 对照原文，不复制原始私密内容进插件日志。输入哈希不变与分支选择已有合成数据测试；这不替代真实 10+ 会话和 20 点人工判断。

离线报告指定某次输出目录：

```powershell
npm run report -- ".tmp\replay\replay-UUID"
```

`replay-UUID` 要替换为命令实际打印的路径。CLI 报告默认全时段，可附第二个参数天数。live 命令报告默认只看 live，不和 replay 混合。

## 配置与数据

默认配置：`~/.pi/agent/scheduler/config.json`，不存在则使用内置默认值。
默认日志：`~/.pi/agent/scheduler/logs/`。

可在启动 pi **之前**设置：

```powershell
$env:PI_SCHEDULER_DATA_DIR = "D:\scheduler-data"
$env:PI_SCHEDULER_CONFIG = "D:\scheduler-config.json"
pi -e "D:\1pi\pi-deepthing"
```

`PI_SCHEDULER_DATA_DIR` 更改数据根目录及默认配置位置；`PI_SCHEDULER_CONFIG` 指向明确配置文件，指定后缺失不能静默忽略。从 `config.example.json` 复制配置后修改，`/reload` 生效；无需改源码。不支持热更新。

配置由 `defaults` 与 `models` 两部分组成，模型键为 `provider/model-id`。模型 patch 覆盖 defaults 的顶层字段；`weights` 和 `riskRules` 都是整体替换，不是局部合并。所有模型配置启动时都会校验。live 模型键取 pi 选中的 `ctx.model`；虚拟路由模型与实际子模型的配置等价性尚未验证，不承诺按每个路由子模型单独标定。模型示例键只是示意，不会匹配你的真实模型。

默认：

```text
S = .30 U + .25 R + .15 P + .30 A
light >= .35，deep >= .60
硬触发：R=1 / 同类连续错误>=2 / 深想后连续12步
最小间隔2步；深想后3步分数乘 .7（硬触发不受限制）
窗口6步；日志在线90天后归档，不自动删除
```

一步指一次完成的**顶层工具调用**。并行工具按 assistant 调用顺序处理，同批两个错误不算顺序重试；同一回合最多追加一条消息，合并最强动作及原因。纯文本回复、嵌套工具、插件消息不计工具步。硬触发有意绕过冷却，因此一串高危调用仍可能频繁提醒。

风险规则字段：`id`（不含私密内容的类别标识）、`level`（0/.5/1）、`field`（tool/path/command）、`pattern`（忽略大小写的 JS 正则）。在 `config.example.json` 中可编辑完整初始表。配置仅应来自可信本地用户：正则规则不是 shell 解析器，避免昂贵的回溯表达式。

高危：删除、具有覆盖能力的 write、git push、明确外发、凭据路径；中危：修改配置/依赖、一次声明 5+ 文件。write 新文件也按覆盖能力保守判高危，不额外读盘判断是否存在。无法可靠识别动态别名、变量拼接、所有外发工具、codemode 脚本或封装命令的语义；文件路径识别和规则都可能漏报/误报。普通源码 read 不算风险，读取凭据本身算高危。

## 信号与注入的限制

- U：同目标重复修改、失败/重试、参数变化的可观测代理，不采用模型自报置信度，也不窥探隐藏思维。
- R：上述明确规则，不能保证提前阻止风险。
- P：窗口内可确认或有明确成功文本的产出事件比例。`mutation-success-proxy` 不是磁盘差异；测试计数只有可解析且出现增长时才算增长；只在同工具、同目标的成功重试时记 `error-disappeared-proxy`，仍不是证明修好了错误；无关的成功读取不算错误消失。
- A：结果 isError/退出码、归一化错误类别与超时。两次错误类别不同不会误算同类硬触发；宽泛类别仍有测量误差。

轻档只报告原因和事实计数。deep 追加固定模板，要求简洁的目标/已完成、可疑步骤、后三步计划；不要求披露推理链。始终保留当前模型和 thinking level，不切换廉价模型、不降低强度；也不强行提高你的档位。模型是否服从并无保证。

消息走 pi 1.5.0 的 turn_end `custom_message` 草稿，保留其他扩展条目，不改旧消息、工具参数/结果或系统提示。只在成功、仍有正常工具后续、允许继续的回合追加，不强迫已经完成的任务多跑一轮，取消/错误回合也不会注入。

## 日志、报告和隐私

记录是插件自己的 append-only JSONL，不写 score 等内部状态到 pi 会话。真实扩展提醒本身会按 pi 正常机制追加进会话，这是它传给模型的通道。

- 每步 `score`；每轮至多一个 `candidate`；`intervention-proposed` 只代表返回草稿。
- 从本会话已持久化 entries 中确认 schedulerId 后，才写 `intervention` 并计为真实介入；只有真实后边界（下一 turn_start/turn_end、agent_settled 或 shutdown）仍未确认才写 `delivery-unknown`。模式切换不会把尚在 pi 手中的草稿提前判丢失，跨重置的晚到确认保留提交时模式并将 outcome 标记截断。**已落会话不等于模型已经阅读/执行。**
- shadow 维护虚拟介入/衰减历史；真实介入另有历史。light 不把未执行的 deep 计成真实深想。两者的动作可能不同，score 中分别记录。
- candidate 与 intervention 各自观测后续 5 步，追加关联 `outcome`，不重写已有行。会话/模型/压缩/树导航/模式切换或 run 结束时不足 5 步则截断，不拼到下一任务。
- outcome 包括新错误、行为方向哈希改变、确认或代理产出数、未知产出步。方向改变是类别/目标变化代理，不是读取模型意图。
- “纠错代理”仅在原样本有错误、后五步存在同工具同目标重试、且原错误类别未再出现时计入分子。无可比重试、样本不足均为 N/A。它不能证明真正修复或因果提升。
- 报告显示候选/真实数量、分数分布、原因、完整/缺失样本、已观测 token。未测量出的额外 token、节省、基准成绩不编造；影子与开启数据不是随机因果对照。

不落原始 prompt、完整工具参数/输出、文件内容、密钥或思维文本；目标、参数与未分类错误只保留哈希，外加受限工具名、规则类别、session/entry ID。哈希不是匿名化保证（低熵路径可能被猜测）；会话 ID/模型名等仍属本地行为元数据，请保护数据目录。文件尝试以 0600 创建，Windows 访问控制仍取决于目录 ACL。

日志按运行隔离串行写，正常 shutdown flush。满 90 天只把命名匹配的插件文件移动到 logs/archive，不删除、不压缩；总磁盘用量不会自动降低，历史报告仍可读归档。不做批量删除。

I/O 操作有等待上限；失败立刻停真实注入并告警，尽量放行 agent。无法对磁盘满、权限失败、强杀承诺零丢失；超时 I/O 可能稍后完成，当前运行仍保持 failed，不能视为健康。无法写入时，故障本身也可能无法记录，报告缺少 health 行不代表没有故障。

## 分阶段现场验收（尚未完成）

1. **v0：** 你指定 10+ 真实会话，回放并填写 20 个介入点判断；命中率不理想就停下调信号。
2. **v1：** shadow 运行一周，审查各模型分数分布，专门验证压缩事件；如改阈值，在设计文档留下理由。
3. **v2 light：** 再开 `/scheduler on` 跑一周，由你判断是否明显打扰。
4. **v2 deep：** 看过上阶段数据后才开 `/scheduler on deep`。
5. **独立评测：** 原设计第 9 节双臂 DeepSeek 测试另行安排；协议、难度、次数、预算先确定。代码审阅不是有效性评测。

## 文件与验证

入口 `index.ts` 只装配；`live.ts` 适配 pi；`signals.ts` 采集；`scheduler.ts` 纯决策；`runtime.ts` 管理虚拟/真实状态和关联；`intervener.ts` 模板；`recorder.ts` 串行写入、五步 outcome、归档；`config.ts` 配置；`commands.ts` 命令；`replay.ts` 只读回放；`report.ts` 汇总。

`tests/` 覆盖纯函数边界、并行/重试、敏感信息、只读分支回放、故障放行、归档、延迟 outcome、命令与 pi loader。所有测试产物保留在 `.tmp/tests/`，没有自动批量清理。最新执行证据及未验收项见 `VERIFICATION.md`。
