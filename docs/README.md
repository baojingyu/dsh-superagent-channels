# 文档总览

本目录描述 `dsh-superagent 多通道`（2.4.0，2026-11-14 复核）现在**实际具备**的能力。所有页面都以当前实现为准；与平台限制相关的内容在
[capability-matrix.md](extensions/capability-matrix.md) 里逐项标注为「做不到」而不是省略。

![架构](images/architecture.png)

## 阅读顺序

| 顺序 | 文档 | 读它是为了 |
| --- | --- | --- |
| 1 | [000-philosophy.md](000-philosophy.md) | 为什么把协作拆成「评估 → 工单 → 执行」 |
| 2 | [001-domain.md](001-domain.md) | Trigger / Thread / Ticket / Assignment / Decision 的定义 |
| 3 | [002-authorization.md](002-authorization.md) | 谁能发起工作，什么消息算点名，人工确认在哪 |
| 4 | [003-execution.md](003-execution.md) | 执行器会话、目录隔离、交付与状态 |
| 5 | [004-prompts.md](004-prompts.md) | 主/执行器提示词与六个来源技能 |
| 6 | [005-panel.md](005-panel.md) | 面板逐页说明（含实机截图） |
| 7 | [006-deployment.md](006-deployment.md) | 部署、配置项、升级、与官方并存 |
| 8 | [007-architecture.md](007-architecture.md) | 模块与测试清单（架构权威表） |
| 9 | [008-cookbook.md](008-cookbook.md) | 常见做法与排障 |
| — | [../EXTENSIONS.zh-CN.md](../EXTENSIONS.zh-CN.md) | 逐通道功能点（中文长文） |
| — | [extensions/capability-matrix.md](extensions/capability-matrix.md) | 六来源能力对照与平台限制 |
| — | [extensions/](extensions/) | ADR-005 … ADR-012，记录每个取舍 |

## 一页看懂

![生命周期](images/lifecycle.png)

- **输入统一**：六个来源都归一成同一个 `Trigger`（线程、发起人、结构化 @、原始 ID、可选图片）。
- **判断统一**：策略按来源配置名单与准入表；评估读上下文后给出 接单 / 仅观察 / 拒绝，并记录强度与依据。
- **执行统一**：一条工单一个执行器 Session，独立目录/分支，结构化交付。
- **回流统一**：回复落回原线程，评论带幂等标记；工作项可回写状态。

## 截图约定

- `images/panel-*.png` 是**实机截图**，敏感信息（项目/组织 ID、令牌路径、姓名、群名、会话标题）已打码；个别图带讲解红框。
- `images/architecture.png`、`lifecycle.png`、`sources.png`、`install.png` 是按当前实现绘制的**示意图**。
- 新增截图时放在 `docs/images/`，命名 `panel-<页面>.png`，并在正文图注写明「实机 / 示意」。

## 文档维护约定

- 改动能力面（新增来源、字段、动作）时，同步更新：本页、[005](005-panel.md) 的页面说明、[007](007-architecture.md) 的模块/测试表、
  [capability-matrix](extensions/capability-matrix.md)，以及 [CHANGELOG](../CHANGELOG.md)。
- 测试数量与命令只写在 [README](../README.zh-CN.md) 与 [007](007-architecture.md)，避免多处漂移。
