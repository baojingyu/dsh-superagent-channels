# 给 dshfind 的收录申请（开源后发送）

> 语言：[中文](dshfind-submission.md) · [English](dshfind-submission.en-US.md)

dshfind 的插件超市由站点与其 GitHub 仓库（https://github.com/hikariming/dshfind）维护。先在其仓库的 Issue/PR 或站点提供的提交入口
提交以下信息；若站点没有公开提交入口，用下面的「通用申请」发给站点维护者。

## 插件条目（结构化）

```yaml
name: dsh-superagent-multi-channel
displayName: dsh-superagent 多通道
version: 2.4.0
license: MIT
repo: https://github.com/baojingyu/dsh-superagent-multi-channel
npm: dsh-superagent-multi-channel
categories: [collaboration, chat, work-items]
keywords: [dsh, superagent, wechat, wecom, dingtalk, yunxiao, projex, feishu, github]
summary: 给 DSH superagent 增加微信、企业微信、钉钉、云效 Projex，与官方飞书/GitHub 并存，统一为「评估 → 工单 → 执行 → 回复」闭环。
```

## 通用申请（可直接粘贴）

> 你好，想申请收录一个 DSH 插件：**dsh-superagent 多通道**。
>
> - 仓库：https://github.com/baojingyu/dsh-superagent-multi-channel
> - npm：`dsh-superagent-multi-channel`（2.4.0，MIT）
> - 作用：官方 superagent 只有飞书与 GitHub；本插件新增微信、企业微信、钉钉、阿里云云效 Projex，并把六种来源统一到
>   「评估 → 工单 → 执行 → 回复」闭环；可与官方 superagent 并存安装。
> - 面板：独立侧边栏入口「Superagent 多通道」，含来源/触发/评估/执行/提示词/部署。
> - 数据与边界：全部状态在本机；令牌放 0600 文件；只被动回复；平台做不到的能力（深链、企业微信/钉钉历史、钉钉 SDK 连接）
>   在 README 与能力矩阵中明确写出。
> - 截图：README 内有实机截图（敏感信息已打码）。
>
> 如果收录需要特定字段（分类、标签、图标、许可、演示地址）或走某个提交模板，请告诉我，我按规范补齐。

## 注意

- 只收「npm 包与仓库对得上」的插件：发布 npm 后确保 `package.json` 的 `repository` 与仓库一致（当前已填）。
- 收录后如需索引到 `https://api.dshfind.com/market/dsh-index.json`，按其说明提交仓库信息即可。
