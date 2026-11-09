# 开发验证记录

日期：2026-11-09；最后一轮验证为本机时间 22:28。
结论：**本地开发交付已完成；真实 v0/v1/v2 效果验收未完成。** 默认 shadow，没有修改全局 pi 配置或开启真实介入。

## 当前证据

| 声明 | 已执行证据 | 结果 |
| --- | --- | --- |
| 严格 TypeScript 检查 | `npm run typecheck`（包含在最终 check） | 通过 |
| 全部自动测试 | `npm run check` | 43/43 通过，无失败、跳过或 todo |
| 本机 pi 1.5.0 可发现唯一入口 | 将 loader 测试的 `PI_SCHEDULER_TEST_PI_ROOT` 指向实际宿主安装目录后运行 | 1/1 通过；命令和事件注册成功，未发起模型请求 |
| 离线 CLI 链路 | `tests/cli.test.ts` | 12 个**合成** v3 会话回放成功，生成 20 条未填写人工判断的抽样；输入文件哈希一致，live/replay 隔离 |
| 调度边界、硬触发和迟滞 | `tests/scheduler.test.ts` 与 review regressions | 默认阈值、12 步、2 步、深想衰减、硬触发优先和自定义冷却首步均通过 |
| 信号与并行顺序 | `tests/signals.test.ts`、`tests/replay.test.ts` | 五类风险、普通读取、同类错误、并行非重试、完整输入上的 live/replay 决策一致性通过 |
| 只读树形回放与缺失输入 | replay tests 与 review regressions | 分支选择、坏格式/断链/重复 ID、缺结果前后截断通过 |
| 记录与故障放行 | `tests/recorder.test.ts`、live/runtime tests | 串行 100 行不缺、五步关联/不足五步、超时/写失败/无效配置、90 天仅归档及实例隔离通过 |
| 开关和投递记账 | live/commands/review regressions | 默认不注入、轻档/深档、保留他人 entries、不强制续跑、取消/错误回合不注入、提议不冒充持久化通过 |
| 主机接管后的 off 时序 | review regressions 中 actual pi ExtensionRunner 测试 | 使用真实 pi 边界处理器链，暂停后续扩展后 off，再模拟最终 session append；原模式记账一次、outcome 截断，测试通过 |
| 独立代码审阅 | 独立 reviewer 只读初审及两次针对性复审 | 最终结论 `OK with notes`，原始阻塞均已解除；reviewer 未代跑测试，以上执行证据由父代理实际运行 |

最终命令输出保存在：

- `.tmp/verification-check.log`
- `.tmp/host-loader-check.log`
- 测试数据在 `.tmp/tests/`，没有自动批量删除。

宿主加载器路径：`C:/Users/ASUS/.pi/agent/install/releases/1.5.0/node_modules/@earendil-works/pi-coding-agent`。
安装包及测试依赖锁定于 `package-lock.json`；安装使用 `--ignore-scripts`。依赖安装/锁更新时 npm audit 报告 0 vulnerabilities，这不等于完整安全审计。

## 独立审阅及修复链

初审发现三项 P1、两项 P2；额外自测还发现自定义最小间隔可能抑制首次介入：

1. off 与本插件正在等待日志的边界并发：通过串行操作与同步 generation 失效解决。
2. 评分缓存了中间工具结果：最终结果在边界重新计算，仍保留实际工具输入的哈希/风险元数据。
3. 缺失回放结果仍拼出完整五步：在缺失批次前后中断测量，保留已知 score，不虚构完整样本。
4. 并行 score 的 canonical step 错误：按 snapshot.step 写入，完成于批中间的 outcome 也用真实步号。
5. 无关成功被算成错误消失：要求同工具同目标的成功重试。
6. 首次介入被自定义冷却抑制：初始无介入历史，不施加冷却。

六个直接回归先观察到全红，再修复到全绿。复审进一步指出主机接管后仍不能撤回草稿，因此新增 **host submissions 账本**：内部意图可失效，已交 pi 的草稿不可撤回；跨模式/模型/窗口重置保留提交关联，真正后边界才判断未确认，晚到持久化按原模式记账并截断 outcome。这一语义已明确写入 README、off 提示和原设计，另有真实 runner 链及 ledger 替换/负确认测试。

最终独立复审：没有发现新的必修记账问题或嵌套队列死锁，原审阅阻塞全部解除。原始审阅文件由本次 pi 子代理产物存储保存；其最终结论不是有效性基准评测。

## 主动诊断的真实覆盖

已主动调用 `lens_diagnostics(source=lsp, scope=paths)` 检查 22 个 TS 文件，并对最终改动的 7 个文件复查。

- 最后一次复查无 error 级发现，有 10 条辅助 warning（CLI 输出、受长度检查保护的非空断言、字符串排序、本地数组 reverse、布尔边界参数等）。
- 初次全量探测另有样式提示和可配置 RegExp 的 Semgrep 风险提示。配置仅允许可信用户提供；正则不是沙箱，不能保证恶意/病态自定义表达式不阻塞主线程。这是已公开的配置安全边界。
- LSP 存在 push-only/silent-on-clean 的未确认项：初查 4 个，最后 7 文件复查中 1 个；**没有把静默或空缓存当成全体干净。** 当前严格类型检查由真实 `tsc --noEmit` 通过提供补充证据。
- 未为了消除通用风格提示而做无关重构或屏蔽规则。

## 仍未执行／不能声称

- **真实 v0：** 尚未获指定的 10+ 历史会话；20 点判断仍需人工，合成会话不能替代。
- **真实 v1：** 一周影子及压缩实用数据、阈值标定未完成。
- **真实 v2：** 轻介入一周、主人主观打扰感和 deep 阶段未完成。
- **完整端到端：** 已测真实 loader 与真实边界 runner 链；没有实际模型驱动的完整 CLI 循环。runner 测试的 session append 由测试模拟，不冒充真实 CLI 会话写入。
- **跨扩展／模型：** 已覆盖最终结果重新计算与执行输入元数据保留；任意第三方工具输入改写、虚拟路由模型与实际子模型的完整 live/replay 等价性未验证。
- **崩溃与存储：** 正常 flush、受控写失败已测；强杀/断电/磁盘满不能承诺零丢失或事务性投递。
- **效果与成本：** 没有进行原设计第 9 节独立环境 DeepSeek 双臂评测，不宣称提高正确率、省 token 或因果纠错收益。
- **安全：** 插件不阻断危险动作，不能替代权限控制；也不能撤回已被 pi 接管的消息。

## 下一步

先按 README 用明确允许的真实会话执行 v0，并填写人工审查表。其后再决定是否进入一周 shadow。需要临时加载时使用 `pi -e "D:\1pi\pi-deepthing"`；本次没有自动全局安装。
