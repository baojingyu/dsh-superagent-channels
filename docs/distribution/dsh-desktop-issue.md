# 给 dsh-desktop 的 Issue（开源后发送）

> 语言：[中文](dsh-desktop-issue.md) · [English](dsh-desktop-issue.en-US.md)

**标题**：`[插件收录] dsh-superagent 多通道：为 superagent 增加微信 / 企业微信 / 钉钉 / 云效 Projex`

**正文（Markdown，可直接粘贴）**

```markdown
## 这是什么

`dsh-superagent-multi-channel` 是官方 superagent 的扩展 bundle：保留飞书与 GitHub 两种来源，**新增**微信个人号、企业微信、
钉钉与阿里云云效 Projex，并把六种来源统一到同一套「评估 → 工单 → 执行 → 回复」闭环。可与官方 `dsh-superagent` 并存安装
（入口 id、面板入口、状态目录独立）。

- 仓库：https://github.com/baojingyu/dsh-superagent-multi-channel
- 包：npm `dsh-superagent-multi-channel`，版本 `2.4.0`，许可 MIT
- 目录 manifest（路径 A）：https://baojingyu.github.io/dsh-superagent-multi-channel/catalog-source.json

## 能力概览

| 来源 | 接收 | 亮点 |
| --- | --- | --- |
| 飞书 / GitHub | 官方通道 | 保持原样 |
| 微信 | sidecar 轮询 | 结构化 @、语音转写、图片可下载、worker 读 `weixin/<id>/…` |
| 企业微信 | 签名回调（插件自挂 `/wecom/<实例>`） | @ 判定、入站图片、通讯录名单 |
| 钉钉 | Stream（部署注入 SDK 连接） | staffId @、Markdown 5000 |
| 云效 Projex | 工作项轮询 | 评论、状态回写、附件、worker 读 `projex/<id>/item·comments` |

面板：独立侧边栏入口「Superagent 多通道」，含概览 / 来源 / 触发 / 评估 / 执行 / 设置 / 提示词 / 部署。
截图见仓库 README（实机截图，敏感信息已打码）。

## 数据与安全

- 全部状态在本机 `stateDir`；令牌优先 0600 文件；面板与日志不打印密钥。
- 只被动回复：不群发、不拉群、不加好友；评论带幂等标记、事件按平台消息 ID 去重。
- 平台限制公开写明：微信/企业微信/钉钉无消息深链；企业微信、钉钉无历史回补；钉钉 Stream 需部署注入 SDK 连接；微信通道为第三方 UI 自动化，未获腾讯授权。

## 验证

`tsc` 0；`vitest` 102 文件 / 1624 通过 / 0 失败；`tsdown` 8 入口。

## 请求

希望：
1. 将本插件收录进 Community Market 目录（路径 A 静态源已在准备）；
2. 若有收录规范或字段补充要求，请指出，我会按规范调整 manifest 与 README。
```

**发送前检查**：仓库已公开、npm 包已发布（或注明"目录指向仓库，npm 首发中"）、manifest URL 可访问。
