# ADR-011：让微信与飞书对齐

> 语言：[中文](ADR-011-weixin-feishu-alignment.zh-CN.md) · [English](ADR-011-weixin-feishu-alignment.md)

状态：已接受（2026-11-14）· 范围：`src/sources/chat/weixin/**`、`src/app/resources.ts`、`src/app/prompts.ts`、
`src/app/skill-files.ts`、`skills/dsh-superagent-weixin/**`

## 背景

飞书渠道让 agent 在干活的同时读取原始会话：`feishu/<trigger-id>/message`、`/root`、
`/parent`、`/thread` 与 `/around`，由随附的 `dsh-superagent-feishu` 技能描述；它的评估读取
`thread`/`root`/`parent`；面板能按消息 ID 检索；一次回复的父消息会被映射回它所回应的触发。微信已经能
接收、结构化地判定 `@`、发文本与文件、转写语音、同步成员，并重挂它的监听器，但 agent 无法读取微信会话，
面板无法按 ID 找到消息，回复链也没有被连起来。

## 决定

### 1. 同一套资源语法，在 sidecar 之上实现

`weixin/<trigger-id>/message`、`/thread` 与 `/around` 镜像飞书的名称与响应形状（`{ status, message }`、
`{ status, messages, next_resource }`），于是 worker 以同样的方式读取任一渠道，技能只在后端能力上有所差别。
`/thread` 用桥的游标分页；`/around` 是包含该触发消息的那一页（微信不提供时间窗查询，所以用这一页
顶替飞书的前五/后五窗口）。读取按触发划定范围：`readWeixin` 会拒绝 trigger id 不匹配的资源，这与飞书读取方
用的是同一道护栏。

### 2. `root` 回答 `no_root`，因为没有主题

一条飞书消息可以属于一个以更早消息为根的主题；而一次微信会话是一条平坦的流。把房间的第一条消息当作
"root" 返回会是一个凭空发明的锚点，而被告知"这就是根"的模型会从错误的消息出发推理。所以 `/root` 与
`root` 这个线程部分回答 `no_root`，而 `parent` **只在桥报告了引用消息时**才回答那条被引用的消息；
否则回答 `no_parent`。技能也这么说，于是模型不会把缺失的根当作一次失败的读取。

### 3. 按平台消息 ID 检索；把回复映射到它的父消息

共享的 chat kind 已经把 ID 形状的词转成检索词，并把 `meta.parentId` 映射成触发 ID；微信这个 kind 两样
都没接。现在两样都接上了，`Store.read.search` 精确匹配 `meta.nativeId`，与它此前已匹配的飞书
`meta.messageId` 并列。因此粘贴一条消息 ID 就能找到那个触发，而一条被引用的回复会展现出与飞书相同的
那一段对话。

### 4. `readPageSize` 与一个微信技能

`readPageSize`（1–50，桥的上限）进入配置，使评估读取与 worker 资源用同样的页大小分页，与飞书的
`readPageSize` 一致。一个随附的 `dsh-superagent-weixin` 技能在每个会话里注册，与飞书和 GitHub 技能
并列；它描述这些资源、`[image:<id>]` 标记，以及微信做不到的那两件事。

## 仍然不可能、并且如实说明而不是伪造的部分

- **没有消息深链。** sidecar 不暴露任何深链，所以 `ChannelLink.url` 为空，面板只报出来源。编造一个
  `weixin://` URL 并不能打开那条消息。
- **没有机器人列表。** 飞书能靠 `sender_type` 认出机器人发送者；微信没有这个概念，桥对所有人报
  `bot:false`。一份"其消息可能成为候选的机器人"名单会是一个永远匹配不上的控件。
- **没有主题根**——见决定 2。

## 变成可能的部分，以及怎么做的

- **图片字节能到 worker。** 技能记录了一种下载方式：`DSH_SUPERAGENT_WEIXIN_BRIDGE` 与
  `DSH_SUPERAGENT_WEIXIN_TOKEN_FILE` 被导出进 worker 的环境，然后用一次 `curl`/`Invoke-WebRequest` 打
  `GET /media/<id>`（百分号编码，bearer 令牌来自 0600 文件）写下一个文件，`read_image` 能打开它。这就是飞书的
  "用 lark-cli 下载，再读它"，但不必附带一个 CLI，因为桥本身就是那个已鉴权的端点。
  `/media` 与 `/send` 串行，所以下载一次只进行一个，而 401 会被如实报出而不是被猜。
- **首见回填是存在的，现在被标记出来了。** sidecar 在重挂之后（或某个会话刚开始被监听时）已经把会话的最后几条
  消息读回来并排队；那就是微信的 `backfillChat`，每个会话上限 `CATCHUP_MAX_MESSAGES`
  （20）条，每轮最多 `CATCHUP_MAX_CHATS`（3）个会话，因为每次读取都要打开客户端窗口。这些事件现在
  带上 `historical: true`（契约 §3），而 `pollChat` 把它们交给评估时不带回执、不自动回复、也不发处理中提示：
  旧话必须可读，但不应被回答。它不是一次完整的历史扫描——一个从未被监听过的会话没有队列可读——技能也是这么说的。

## 后果

- worker 能读取它工单的微信会话并分页，这正是飞书的资源语法所给予的。
- 现在随附两个渠道专属技能；`Prompts.skills` 无条件注册 `weixin`（它不需要机器人，与飞书不同），
  而面板列出它的部分以便覆盖。
- 资源路由从实例配置（`weixinBridge`）构建桥，所以一次资源读取每页只花一次 sidecar 调用，并且从不启动桥。
- 测试覆盖引用/语法、每种读取形状及其状态（`ok`、`no_room`、`not_found`）、ThreadContext 的各个部分
  （`root`/`parent`/`thread`）、检索词与回复映射。
