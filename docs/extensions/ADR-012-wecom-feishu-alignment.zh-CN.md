# ADR-012：让企业微信与飞书对齐

> 语言：[中文](ADR-012-wecom-feishu-alignment.zh-CN.md) · [English](ADR-012-wecom-feishu-alignment.md)

状态：已接受（2026-11-14）· 范围：`src/sources/chat/wecom/**`、`src/sources/wecom-watch.ts`、`src/app/resources.ts`、
`skills/dsh-superagent-wecom/**`

## 背景

飞书渠道能接收消息、携带图片、让 agent 读取原始消息（及其线程/主题）、把回复映射到它的父消息，并能按消息 ID 检索。企业微信已有 kind、XML 解析器、发送者与一个纯回调处理器，但**没有任何路由挂载它**，所以什么都进不来；它只携带文本；它没有 ThreadContext、没有 worker 读取、也没有图片处理。本 ADR 在后端能办到的地方补上缺口，其余部分如实说明。

## 决定

### 1. 插件自己挂载回调路由

`wecom-watch` 现在在 Host 的 web 服务器上注册一条 `/wecom/<instance>` 的公开 `prefix` 路由。它在来源注册表里查出该实例的配置，以 1 MB 上限读取请求体，调用既有的 `handleWebhook`（验签 → 解密 → 解析 → 按实例去重环），用 `wecomTriggerOf` 把每个事件转成触发，并交给该 kind 的 `SourceContext.receive`。回复是加密的 `success`（或在 URL 验证时是解密后的 `echostr`）。这条路由之所以公开，是因为企业微信对每次调用都签名；运维把应用的接收 URL 指向它。这是插件唯一一处对外提供不可信请求的地方，签名不对就产不出事件。

### 2. 图片通过 `MediaId` 传递，评估可以下载它们

一个 `image` 回调携带 `MediaId` 且没有文本。`parseXml` 现在返回带 `media: [{ id, kind: 'image' }]` 的这类事件；读取方与 ThreadContext 渲染 `[image:<id>]`，而 ThreadContext 的 `image` 用发送者的 `media` 调用（`GET /cgi-bin/media/get`）下载字节，其 JSON 错误形状会在请求体被当作字节处理之前被识别出来。worker 看到标记；持有实例配置的评估则附上图片。文本与其它消息类型不变，语音/视频/文件/位置仍然不产事件——如实说明，而不是伪造。

### 3. 一个回调能回答与不能回答什么

一个回调就是一条消息：`thread` 就是那条消息，`root` 回答 `no_root`，`parent` 回答 `no_parent`，没有历史回填，也没有下一页。`wecom/<trigger-id>/message` 是 worker 的读取（一条消息）。检索把十进制 `MsgId` 转成触发检索词，`repliesTo` 存在但回调不携带被引用的 ID，所以它通常是空的。

## 在这个后端上仍然不可能的部分

- **没有历史。** 接收 API 是推送式回调；没有可用来分页会话的回读端点，所以没有回填，也没有 `/thread` 分页。
- **没有消息深链。** 不存在按消息的 URL；渠道链接为空，面板只报出来源。
- **没有会话成员名册。** 对自建应用来说，枚举一个群的成员需要客户联系相关 API 以及各企业不同的权限；把应用可见的用户等同于某个会话的成员会是错的，所以不提供同步。
- **worker 拿不到图片字节。** worker 有标记但没有企业密钥，所以它无法调用媒体 API；改为由评估下载图片。

## 后果

- 企业微信第一次变得可用：一个回调变成一个触发，而一条回复回到同一个会话或同一个人。
- 为验签新增了两个配置字段（`token`、内联 `encodingAesKey`），两者都是可选的，所以既有的已存储配置仍能解析；没有 `token` 时每个回调都会被拒绝，`facts` 与字段提示都这么说。
- 测试覆盖图片解析、触发地址（`chatid` 与 `touser`）、资源语法以及 ThreadContext 的各个部分。
