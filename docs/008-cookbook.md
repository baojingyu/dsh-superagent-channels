# 常见做法与排障

## 只让白名单里的人能发起工作

1. 面板 → 评估 → 在各来源上选中来源（钉钉 / 飞书 / GitHub / GitLab / 云效 Projex / 企业微信 / 微信）。
2. 在「能发起工作的用户」里加人。微信/企业微信可以点「立即同步 / 刷新名单」从群成员或通讯录带入。
3. 准入表按行定义：名单内/名单外 × 群里 @/未 @/私聊。名单外的人即使 @ 机器人也不会变成工单。

## 群里只在被 @ 时响应

- 微信 / 钉钉 / 企业微信：把该群/来源的「接收」设为「仅 @」（准入表的「群里未 @」一行设为「忽略」）。
- 飞书：群的「接收」选「仅 @」；工作项/GitHub 没有这个概念。

## 关掉看板状态回写

面板 → 来源 → 云效 Projex → 关「回写工作项状态」。默认就是关的：智能体只在评论里交付，不改看板。打开后要选两个状态（下拉里是看板上的名字，实际写的是状态 ID）。

## 让执行器读到原始上下文

| 来源 | 资源 |
| --- | --- |
| 飞书 | `feishu/<trigger-id>/message`、`/root`、`/parent`、`/thread`、`/around` |
| GitHub | `github/<trigger-id>/…` |
| 微信 | `weixin/<trigger-id>/message`、`/thread`、`/around`（图片 `[image:<id>]`，可用 `GET /media` 下载） |
| 企业微信 | `wecom/<trigger-id>/message` |
| 钉钉 | `dingtalk/<trigger-id>/message` |
| 云效 Projex | `projex/<trigger-id>/item`、`/comments`（可翻页） |

资源是只读的：读不会创建触发、不会回复、不会改远程状态。

## 排障

| 现象 | 先看什么 |
| --- | --- |
| 面板显示「dsh-superagent 没有响应」 | 多半是插件没挂载：看 DSH 日志有没有 `dsh-superagent ready`；常见原因是状态目录里旧会话的 preset 名不存在（2.3.0 已修，preset 用共享 id），或 `stateDir` 配错。 |
| 云效报 `操作失败，当前工作项已进回收站` | 工作项被人删了。插件会把它当「已消失」：线程标 `gone`，不再读、不再报错；恢复工作项后请删掉旧线程让它重新出现。 |
| 云效授权页 `invalid client_id or redirect_uri` | 2.4.0 以前是 Windows `cmd start` 把 URL 在 `&` 处截断；已改为 `rundll32 url.dll,FileProtocolHandler`。升级后重启 DSH 再授权。 |
| 企业微信收不到消息 | 应用「接收消息」URL 必须是 `https://<公网>/wecom/<实例>` 且反向代理到本服务；`回调 Token` 与 `EncodingAESKey` 必须和后台一致，缺 Token 时全部拒绝（403）。 |
| 钉钉不监听 | 本 bundle 不内置 Stream SDK：部署要注入 `connect()`（`dingtalk-stream` 客户端）；`facts`/健康会说明「未注入」。 |
| 微信桥掉线 | 面板「检查」读 `/health`；长期无事件会自愈重挂；换号/重登录后桥会重新 attach，不需要重启插件。 |
| 状态名提示「从未见过」 | 先在来源卡片点「读取云效状态词表」（或字段旁刷新），再把下拉里的名字选中。 |
| 升级后两套插件都启用 | 同一种 Source kind 只能注册一次：先停旧 `dsh-superagent-channels`，再启本插件；`stateDir` 留空即沿用原目录。 |

## 自己加一个来源

1. 实现 `ChatAdapter`（轮询/流/回调）或 `WorkAdapter`，定义 `SourceKind`（scope / policy / channel / threadContext / find / refreshLabels）。
2. 在 `cordis.patch.yml` 增加一行 `- id: ... name: dsh-superagent-multi-channel/<name>-watch`。
3. 给 worker 加资源：`src/app/resources.ts` 的 `RESOURCES` 与路由，并在 `skills/dsh-superagent-<name>/SKILL.md` 说明。
4. 加单测：读取、引用语法、上下文三段、排障字段；跑 `pnpm check`。
