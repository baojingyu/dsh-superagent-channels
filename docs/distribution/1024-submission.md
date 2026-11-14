# 给 deepseek1024 的收录/介绍申请（开源后发送）

该站点的提交入口以站点当前页面为准；若没有公开表单，用下面的邮件/私信模板。

## 主题

`插件收录申请：dsh-superagent 多通道（DSH superagent 六来源扩展）`

## 正文

> 你好，
>
> 想向 deepseek1024 提交一个 DSH 插件：**dsh-superagent 多通道**。
>
> - 仓库：https://github.com/baojingyu/dsh-superagent-multi-channel
> - npm：`dsh-superagent-multi-channel`，版本 2.4.0，MIT
> - 一句话：给 DSH 的 superagent 增加微信、企业微信、钉钉、阿里云云效 Projex，并保留官方飞书/GitHub 通道；六种来源统一为
>   「评估 → 工单 → 执行 → 回复」闭环，可与官方 superagent 并存安装。
> - 适合谁的场景：团队把需求分散在飞书/微信/企微/钉钉/云效上，希望一个 agent 统一接单、在隔离目录执行、把结果回到原线程，
>   并可选把云效工作项状态往前推。
> - 安全与边界：全部状态在本机 stateDir，令牌放在 0600 文件，只被动回复、不群发不拉群；平台限制（无深链、企微/钉钉无历史、
>   钉钉需注入 SDK 连接）在 README 与能力矩阵公开写明。
> - 截图与文档：仓库 README（实机截图，敏感信息已打码）、`docs/` 全套文档、`docs/extensions/capability-matrix.md` 能力对照。
>
> 如果贵站需要特定格式（标题、简介字数、分类、图标、演示视频）或提交表格，请告知，我按格式补充。谢谢！

## 备用短版（表单字段）

- 名称：dsh-superagent 多通道
- 类型：DSH 插件 / 协作与工作流
- 链接：仓库 + npm
- 简介（≤120 字）：给 DSH superagent 增加微信、企业微信、钉钉、云效 Projex，与官方飞书/GitHub 并存，统一评估→工单→执行→回复闭环。
