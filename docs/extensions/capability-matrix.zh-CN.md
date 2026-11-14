# 能力矩阵：四个新增来源对照飞书与 GitHub

> 语言：[中文](capability-matrix.zh-CN.md) · [English](capability-matrix.md)

关于「对齐」意味着什么的参照。飞书与 GitHub 是上游 superagent 自带的两个来源；另外四个是本 bundle 新增的。✅ 具备 · ➖ 该平台不适用 · ❌ 后端不可能（如实说明，绝不伪造）。

| 能力 | 飞书（官方） | GitHub（官方） | 微信 | 企业微信 | 钉钉 | 云效 Projex |
| --- | --- | --- | --- | --- | --- | --- |
| 接收消息 | ✅ 轮询历史 + 事件 | ✅ 轮询通知 | ✅ sidecar 轮询 | ✅ 签名回调（插件挂载 `/wecom/<instance>`） | ✅ 流（需注入 `connect`；未随附 SDK） | ✅ 轮询工作项/评论 |
| 评估 / 判定 / 执行 / 回复循环 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 结构化 `@` 判定 | ✅ open_id | ➖ | ✅ `ats`（markup 回退，强度见 facts） | ✅ `mentionsAgent` | ✅ `ats` staffId | ➖ |
| 单聊 | ✅ | ➖ | ✅ | ✅ | ✅ | ➖ |
| 出站文本 | ✅ markdown | ✅ 评论 | ✅ + 回复时 @ 回去 | ✅ 纯文本 2048 | ✅ markdown 5000 | ✅ RICHTEXT/Markdown 评论 |
| 出站文件 | ➖（CLI） | ➖ | ✅ `sendFiles` | ❌ API 仅文本 | ➖（webhook） | ✅ 附件 |
| 幂等发送 | ✅ 带键 | ✅ 标记 | ✅ 带键 | ❌ 无（已说明） | ❌ 无（已说明） | ✅ 标记 |
| 供评估使用的线程上下文 | ✅ thread/root/parent | ✅ PR/issue | ✅ thread/parent；`root`→`no_root` | ✅ thread；`root`/`parent`→`no_*` | ✅ thread；`root`/`parent`→`no_*` | ✅ 工作项正文 + 评论 |
| worker 读取原文 | ✅ `feishu/<t>/…` | ✅ `github/<t>/…` | ✅ `weixin/<t>/…` | ✅ `wecom/<t>/message` | ✅ `dingtalk/<t>/message` | ✅ `projex/<t>/item`、`/comments` |
| 供评估使用的入站图片 | ✅ | ➖ | ✅ `[image:<id>]`、`/media` | ✅ `MediaId`、`/cgi-bin/media/get` | ➖（文本流） | ✅ 工作项/评论图片已归档 |
| 面板检索 | ✅ 消息 id | ✅ issue/PR 编号 | ✅ 原生 id | ✅ 十进制 `MsgId` | ✅ `msgId` | ✅ 流水号或页面 URL |
| 回复→父消息映射 | ✅ | ✅ | ✅（引用 id） | ➖ 回调不带引用 | ➖ | ➖ |
| 显示名刷新 | ✅ 会话名 | ✅ 仓库名 | ✅ 房间/成员 | ✅ 部门用户（`refreshLabels`） | ❌ 需要通讯录权限 API，未提供 | ✅ 状态词表 |
| 成员/名册同步进策略 | ✅ 会话成员 | ✅ 协作者 | ✅ 群成员 | ❌ 群成员不可读；用户列表只填名字 | ❌ 同上 | ✅ 项目成员 |
| 健康条目 | `feishu` + `history` | `github` | `weixin` | `wecom` | `dingtalk` | `projex` |
| 历史回填 | ✅ 会话历史 | ✅ 通知 | ✅ 重挂后追赶（标记 `historical`） | ❌ 仅回调 | ❌ 仅流 | ✅ 首见评论 |
| 消息深链 | ✅ AppLink | ✅ issue/PR URL | ❌ | ❌ | ❌ | ✅ 工作项页面 |
| 多实例 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

## 平台限制，以及为什么它们不是 bug

- 微信、企业微信与钉钉**没有深链**：三者都不暴露按消息的 URL；面板只报出来源。
- 企业微信与钉钉**没有历史**：两者都以推送方式投递（回调 / 流），且不提供回读端点，所以没有回填、也没有 `/thread` 分页。微信通过它的 sidecar 读取历史；飞书通过历史 API；Projex 通过工作项 API。
- **钉钉传输**：WebSocket 客户端是 `dingtalk-stream` SDK，本 bundle 有意不内置它。部署时注入 `connect()`（见 `src/sources/dingtalk-watch.ts`）；没有它，kind 会被注册但没有任何东西在监听，健康状态会说明这一点。流下游的一切（触发、ThreadContext、worker 读取、回复、策略）都已对齐。
- **企业微信 / 钉钉成员同步**：自建应用无法枚举一个会话的成员；企业微信从它被允许读取的一个部门填充策略里的*名字*，而两者都拒绝把一份可见用户列表当作会话名册。
- **企业微信 / 钉钉 / 微信图片**：微信与企业微信投递图片时带一个部署方可下载的媒体 id；钉钉的流事件携带文本，所以不声称有图片。

## 本轮新增了什么

1. `projex/<trigger-id>/item` 与 `/comments` 的 worker 读取（`src/sources/work/projex/read.ts`），带分页，且 agent 自己的评论被标记为 `bot`。
2. `dingtalk/<trigger-id>/message` 的 worker 读取与一个钉钉 ThreadContext（`thread` = 那一条消息，`no_root`、`no_parent`）——`src/sources/chat/dingtalk/{read,kind}.ts`。
3. 企业微信在通讯录用户列表上的 `refreshLabels`，外加一个 `departmentId` 设置，于是策略的行能显示名字。
4. 一个 `dsh-superagent-dingtalk` 技能，且 Projex 技能现在点名它的两个资源。
5. 测试：`tests/projex-read.spec.ts`、`tests/dingtalk-read.spec.ts`，外加既有的企业微信/微信/Projex 套件。
