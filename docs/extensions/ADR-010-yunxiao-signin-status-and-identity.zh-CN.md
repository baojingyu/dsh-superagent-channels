# ADR-010：云效登录、真实状态词表、RICHTEXT 附件，以及独立的插件身份

> 语言：[中文](ADR-010-yunxiao-signin-status-and-identity.zh-CN.md) · [English](ADR-010-yunxiao-signin-status-and-identity.md)

状态：已接受（2026-11-14）· 范围：`src/infra/yunxiao-oauth.ts`、`src/infra/yunxiao-api.ts`、
`src/sources/work/**`、`cordis.patch.yml`、`src/client/**`、`package.json`、`locale/**`

## 背景

工作项反馈那项工作完成后仍剩四个缺口：运维者仍要手工粘贴个人访问令牌；状态名来自近期工作项恰好展现的内容，而不是来自项目自身的工作流；附件被以 Markdown 形式粘进一个纯文本评论正文，而富文本读取方不会渲染它；并且这个 bundle 沿用了官方 superagent 的内部 id，导致两者无法装进同一个 profile 而不共享面板槽位、预设 id 或状态锁。

## 决定

### 1. 通过云效的 OAuth 2.0 服务器登录，并把令牌文件保留为凭据

云效记录了一个 OAuth 2.0 授权服务器：授权码、强制 PKCE S256、仅公共客户端
（`token_endpoint_auth_method: none`）、动态客户端注册、元数据发现、不透明令牌（`oat-` 24 小时，
`ort-` 90 天）。这恰好就是一个桌面插件的形态，于是 `yunxiao-oauth.ts` 实现了它：发现端点、
用 loopback 回调注册一个客户端、打开浏览器、在 `127.0.0.1:<临时端口>/callback` 上取授权码，然后
交换令牌。

结果写入**同一个仅所有者可读的令牌文件**，那是每个读取方已经在用的文件；刷新令牌、client id、
token endpoint 与过期时间放进同级的 `<tokenFile>.oauth.json`。这样两种凭据都只有一份契约：个人访问令牌
仍然可用（没有同级文件，没有续期），而 OAuth 路径增加了续期。客户端在收到 401 后刷新一次并重试，
所以 24 小时的访问令牌不需要每天去面板一趟；浏览器只在每 90 天需要一次。

未选择的方案：DSH 的 `ctx.credentials` 记录。它们会把令牌绑到一个 profile 上，并让 headless/CLI 路径
改用另一套机制；而这个插件本来就是以文件方式运维的，文件方式还能让令牌不进配置、不进日志、不进面板。
令牌从不经过面板：浏览器与 loopback 监听器直接对话。

### 2. 状态词表是项目的工作流，而不是近期工作项的状态

`GetWorkitemWorkflow` 有两种形态。Region 形态（`/oapi/v1/projex/projects/{id}/workitemTypes/{id}/workflows`）没有
组织段，而客户端的路径限制按设计会拒绝它。**中心**形态则有：
`/oapi/v1/projex/organizations/{org}/projects/{id}/workitemTypes/{typeId}/workflows`，而 `ListWorkitemTypes`
（`?category=Req|Bug|Task`）提供 `typeId`。于是 `listStatuses` 按类别读取已启用的类型以及每个类型的
状态，来源卡片上的动作把它们存下来。

此前的「observed statuses」（在轮询到的工作项上见到的状态）保留为回退：一个从未被任何工作项使用过的状态
在工作流里但未被观察到，而一个类型读不出来的项目仍能解析它已经读到的内容。两处都不在的名称会被
拒绝，并给出填充词表的那个动作。

### 3. 附件以 RICHTEXT 形式评论，使用宿主自己的嵌入

`CreateWorkitemComment` 记录了 `content` 加 `formatType`（`RICHTEXT` 或 `MARKDOWN`，默认 `RICHTEXT`），而
`CreateWorkitemAttachment` 返回 `embedHtml`、`embedMarkdown`、`embedUrl` 与 `url`。把 `embedMarkdown` 粘进一个
纯文本正文正是那个 bug：富文本读取方从不渲染它。

**带**附件的评论现在是 `formatType: 'RICHTEXT'`：文本被转义进 `<p>` 块（单个换行变成 `<br/>`），每次上传的
`embedHtml`（图片是 `<img>`，其它是链接）紧随其后，幂等标记以 HTML 注释的形式随行。**不带**附件的评论保留它
一直以来的纯文本，所以 agent 写的 Markdown 保持原样。回读时，若存储内容是 HTML，`noteBody` 会剥掉 HTML，
于是模型看到的是文本。标记在任何剥离之前由原始载荷检测，所以一次重试仍然只发一次。

### 4. 插件获得自己的身份，于是两个 superagent 都能装上

Bundle 条目 id（`dsh-superagent-multi-channel`、`…-<source>`）、预设 id（`…-worker`、`…-router`）、面板槽位与
locale 命名空间现在都是本 bundle 独有的；`locale/*.json` 描述它（"Superagent multi-channel"），并且
`icon.svg` 被导出。两个 bundle 插入相同的行 id、或定义相同的预设 id、或注册相同的面板槽位，就会冲突；
有了唯一的 id 它们就能共存，每个实例只需自己的 `stateDir`（一个目录只接纳一个实例，锁会说明这一点）。

有意保留的部分，因为它们位于**本插件自己的状态之内**，对另一个 bundle 不可见：投递消息上的
`dsh-superagent:` 消息来源 kind、`dsh-superagent-` 技能名前缀，以及 `scripts/dsh-superagent` 服务脚本。
重命名它们会破坏既有会话的恢复与既有技能，而换不来任何共存收益。

升级既有安装：把 profile 的 `dsh-superagent` 块重命名为 `dsh-superagent-multi-channel` 并保留其
`stateDir`；SQLite 数据库、工单、游标与设置全都在那个目录里，所以不需要任何数据迁移。安装路径（插件管理器、
社区市场、自定义索引、tarball、本地目录）见 `docs/006-deployment.md`。

## 后果

- 令牌文件现在多了一个可选的伴随文件；只复制了令牌文件的运维者仍可工作，直到访问令牌过期，此后的 401
  会要求重新登录，而不是续期。
- 状态动作按需对每个类别下的每个类型发一次请求；类型很多的项目会花掉几次调用，但绝不会花掉一次轮询。
- 附件的好坏取决于宿主的 `embedHtml`；返回空值的宿主回退为一个链接，那在评论里可见，但不是宿主自己的预览。
- 测试覆盖全部四项：OAuth 流程（含伪造 state 的拒绝与一次真实的 loopback 回调）、状态列表、
  RICHTEXT 正文及其标记检测，以及 bundle patch、预设、客户端注册与文档中重命名后的 id。发现与动态客户端注册
  也在生产中心站上演练过（`https://openapi-rdc.aliyuncs.com` → 一个 `account-devops.aliyun.com` 授权端点、
  一个真实的 `client_id`）；授权同意步骤与令牌交换需要一个人，这正是 `verify/oauth-check.py` 与面板动作所提供的。
