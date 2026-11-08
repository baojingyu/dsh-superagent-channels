# 扩展：多通道层

[English](EXTENSIONS.md) · **简体中文**

本仓库是一个基于 [DeepSeek Harness](https://dsh.dev) 的研究原型的**下游发行版**（见
[REPOSITORY.zh-CN.md](REPOSITORY.zh-CN.md)）。原型监听一个 GitHub 仓库、可选飞书。
本版保留原型全部行为，补上国内团队真正在用的通道，并让同一种通道可以跑多个实例。

上游的编号文档仍然描述 Agent 本身。本文是「加了什么」的地图，也是后来者继续扩展时的参考。

## 1. 加了什么，放在哪

| 缺口 | 本版补上的 | 位置 |
| --- | --- | --- |
| 只有 GitHub | **GitLab**（自建或 gitlab.com）：合并请求、评论、流水线 | `src/sources/hosting/gitlab/*`、`src/infra/hosting-api.ts` |
| 没有工作项 | **云效 Projex**：需求 / 缺陷 / 任务、评论、状态 | `src/sources/work/projex/*`、`src/infra/yunxiao-api.ts` |
| 只有飞书 | **微信个人号**：群 `@`、消息图片、语音转写 | `src/sources/chat/weixin/*` 与 sidecar |
| — | **钉钉** Stream、**企业微信**加密回调 | `src/sources/chat/{dingtalk,wecom}/*` |
| 一种通道一个实例 | **同种通道多实例**，配置 / 健康 / 游标按实例隔离 | `src/sources/instance.ts`、`src/sources/registry.ts` |

每个来源插件都会加载（`weixin`、`gitlab`、`projex`、`dingtalk`、`wecom`、`feishu`、`github`），并各自构建成独立入口
（`lib/*-watch.js`），所以面板能把它们全列出来，跑不跑由卡片上的开关决定、不由 profile 决定。
没配置的来源报 `sourceOff` 后空转，因此启用一个通道 = 打开开关 + 填它自己的配置，不用重新打包、也不用改 profile。

## 2. 唯一不得不改的假设

原型只有一个扩展点 `SourceKind`，但它把**通道**当成了**实例**：`registry.resolve()` 写死
`id: kind.kind`，于是「两个 GitLab 项目」「两个微信账号」不可能。本版把**设置键**（实例 id）与
**行为 id**（通道 id）分开，并保留一条兼容规则：

> 默认实例 id 仍等于通道 id，因此已存的 trigger、thread、mandate 与 policy 无需迁移即可解析。

其余一切都由三份窄契约推出来，而不是三套一次性集成：

```
src/sources/hosting/   HostAdapter  →  变更请求、评论、CI
src/sources/work/      WorkAdapter  →  工作项、评论、状态
src/sources/chat/      ChatAdapter  →  消息、线程、媒体
                       InboundTransport（poll | stream | webhook）、DeliveredRing
```

新增一个 provider 就是写一个几百行的适配器。trigger 形状、变更请求生命周期、CI 摘要、评论幂等、
卡片与提示词都原样复用；只有身份与 scope 是 provider 特有的。第 6 节是配方。

## 3. 逐通道的功能点

### 3.1 GitLab — `hosting/gitlab`

| 方面 | 细节 |
| --- | --- |
| 监听什么 | 配置项目的合并请求、其评论、以及流水线状态 |
| 传输 | 轮询（`pollSeconds`，默认 30） |
| 身份 | `hostUrl` + `project`（`group/name`）；自建实例是一等公民 |
| 凭据 | 个人访问令牌（`api` 作用域）放在**文件**里，每次调用读取，owner-only（`0600`，Windows 用 ACL） |
| 路径安全 | 每个请求路径都被限制在配置的项目内；越界的路径在任何请求发出之前就被拒 |
| 错误映射 | 非 JSON 响应变成状态错误，绝不回显令牌；401 映射为 `unauthorized` |
| 出站 | 评论与评审线程回复，**标记幂等**（回复带标记，重试时已落地的能被识别） |
| 已知缺口 | 对真实实例的写操作在本机未验证（没有 PAT） |

### 3.2 云效 Projex — `work/projex`

| 方面 | 细节 |
| --- | --- |
| 监听什么 | 配置项目空间里的工作项（按类别）及其评论 |
| 类别 | 默认轮询需求 / 缺陷 / 任务；其它类别直接丢弃，不猜 |
| 传输 | 轮询（`pollSeconds`） |
| 身份 | `organizationId` + `project`；`assignedTo` 是阿里云 **accountID**，所以配置里必须存机器人自己的 accountID |
| 凭据 | `pt-…` 个人令牌放在文件里，owner-only，每次调用重读 |
| 路径安全 | 限制在 `/oapi/v1/`，并有组织白名单；点段逃逸（明文或百分号编码）在任何请求之前就被拒 |
| 默认只读 | `writeBack` 默认 **false**，除非明确要求，适配器绝不改工作项状态 |
| 出站 | 评论，标记幂等 |
| 已知缺口 | 对真实实例的读写在未本机验证（没有 token） |

### 3.3 微信 — `chat/weixin`

桌面客户端没法从 Node 驱动，所以它放在一个**回环 HTTP sidecar** 后面，契约是冻结的。
Node 侧只认契约，后端因此可替换。第 4、5 节是细节。

| 方面 | 细节 |
| --- | --- |
| 监听什么 | 面板里配置的会话：群（按结构化 `@` 判定）与单聊（按会话即可，私信里没有 `@` 这一说） |
| 传输 | 轮询 sidecar（`pollSeconds`，最小 5），而 sidecar 本身被客户端的**监听器推送**喂养 |
| 身份 | `selfWxid` 是「谁的 `@` 算数」；会话与发送人用 sidecar 给的 id |
| 凭据 | sidecar 的 bearer token 放在文件里，owner-only |
| 群 `@` | 只看 `ats`，绝不看消息正文 —— 见 §5.2 |
| 出站 | 文本，**keyed 幂等**（OutboundMessage 的 id 作为 `Idempotency-Key` 发出），进程内串行且间隔 ≥1 秒。群里可按开关带 @（`mentionBack`，按发送人 id 解析成显示名）；**没有原生引用**——客户端库的 `SendMsg` 没有 quote 参数，见 ADR-007 |
| 入站媒体 | 图片，经 sidecar 下载，按魔数判定；群与单聊走同一条 `/media` 链路。面板可关（关掉只在正文留 `[图片]`，不下载） |
| 入站语音 | 转写为文字（`to_text`，每条最多占用客户端 UI 8 秒，失败降级为占位）。面板可关，关掉正文是 `[语音消息]` |
| 面板配置 | `POST /listen` 集合替换，同一次请求还带 `options.voice` / `options.images`；增删会话与翻转开关都不用重启 |
| 关键词 | `keywords` 里的词出现在群消息正文里，就**不需要 @** 也算找机器人（大小写不敏感）；是否成为可接的工作仍由准入模型判断 |
| 关键词自动回复 | `autoReplies` 命中即由轮询循环直接回固定文字，不经过模型；**这条消息仍交给模型**，不用模板吞掉对方剩下的内容 |
| 收到回执 | 有人 @ 或私聊机器人时，**在评估之前**先回一句（`acknowledge` / `ackText`，同一会话 30 秒内只回一次）。实测评估要 53 秒～2 分 09 秒，回执不缩短它，只让你不用干等 |
| 处理中提醒 | 回执发出后机器人在该会话一直没开口，就每隔 `progressAfterSeconds` 补一句「还在处理中」，最多 3 次；机器人一说话就停 |

> **同一台机器上只能有一个 UI 自动化客户端。** 微信渠道是靠驱动微信客户端界面工作的，若同时还跑着另一个
> 同类工具（例如 SiverWXBot），两边会抢同一个窗口：后驱动的一方会让先挂上的监听器失效，表现为「界面在动，
> 但再也收不到消息」。真机验证过：关掉另一个客户端后重启 sidecar，监听立刻恢复。

### 3.4 钉钉 — `chat/dingtalk`

| 方面 | 细节 |
| --- | --- |
| 监听什么 | 群里发给机器人的消息，以及私聊 |
| 传输 | **Stream**（长连接），重连可被中断 |
| 身份 | `clientId` + `robotCode` |
| 凭据 | `clientSecret` 可内联或放文件，owner-only |
| 能力 | `idempotency: none`、`maxChars: 5000`、`markdown: true`、`proactive: false` |
| 诚实的弱点 | 出站是**至少一次**：没有服务端幂等键，sessionWebhook 也无法去重，重试可能重复发送。这个 kind 声明了它，而不是假装没有 |
| 已知缺口 | Stream 传输需要注入 `dingtalk-stream` SDK 的 `connect`；没有它，kind 只注册不启动 |

### 3.5 企业微信 — `chat/wecom`

| 方面 | 细节 |
| --- | --- |
| 监听什么 | 应用的消息：按 `chatid` 的群聊，以及私聊 |
| 传输 | **webhook**（签名 + 加密回调） |
| 身份 | `corpId` + `agentId` |
| 凭据 | `corpSecret` 可内联或放文件；`encodingAesKeyFile` 放 43 字符的 EncodingAESKey |
| 加密 | 验签、AES-CBC 解密、重放拒绝（重投的消息不会产生第二个事件） |
| 能力 | `idempotency: none`、`maxChars: 2048`、`markdown: false`、`proactive: true` |
| 诚实的弱点 | 出站至少一次；消息 API 没有幂等键 |
| 已知缺口 | 回调需要公网反代路由；目前只有纯函数 `handleWebhook` |

## 4. 微信 sidecar

一个独立的 Python 进程（只用标准库），监听 `127.0.0.1`，用 owner-only 文件里的 bearer token 鉴权。
契约冻结并带版本；Node 侧是它的参考消费者。

| 端点 | 作用 |
| --- | --- |
| `GET /health` | sidecar 与后端是否可用，以及 `capabilities` |
| `GET /status` | 已登录账号，以及当前用于判定 `@` 的显示名 |
| `GET /rooms` | 后端**能看到的**会话（下拉候选），不是正在听的 |
| `GET /members?room=` | 该会话里见过的联系人（或按能力给完整成员表） |
| `GET /messages?room=&cursor=&limit=` | 游标之后的事件，带 `next` |
| `POST /send` | 发文本，可选引用，可选 `Idempotency-Key` |
| `GET /media/<id>` | 某条消息图片的字节；失效 `404`，构建不支持下载 `501` |
| `POST /listen` | 集合替换式设置监听；幂等，只对差异动作 |

契约守的不变量：

- **`ats` 绝不从消息正文推导。** 拿不到 mention 列表的后端要如实声明，不得退化为匹配正文里的 `@名字`。
- **`/media` 绝不返回「200 + 零字节」。** 空载荷就是 `404`。
- **`/send` 进程内串行**，两次发送间隔 ≥1 秒，`/media` 共用同一把锁——它们驱动同一个客户端 UI。
- **`/rooms` 只读。** 绝不因为被调用而顺手启动监听。
- **bearer token 不出现在任何日志行里。**

## 5. 微信后端阶梯

### 5.1 阶梯

| 层 | 后端 | 适用 |
| --- | --- | --- |
| L0 | `wxauto` / `wxauto4` / `wxautox4`（UI 自动化） | 默认；需要一个交互式 Windows 桌面会话 |
| L1 | `wxhelper` 一类注入插件 | **已划掉**：只适配微信 3.9.x，且消息载荷里没有 mention 列表，装了也拿不到 `@`（ADR-005 §7） |
| L2 | `WeChatPadPro` 一类 iPad 协议服务 | 没有 Windows 机器时 |
| L3 | 托管 API | 其它全挂且业务不能停 |

只实现了 **L0**。L2 是桩：`available: false`，数据端点 `501`，所以将来切过去是改配置 + 重启，而不是改代码。

### 5.2 群 `@`，以及为什么它分档

微信 4.x **没有结构化 mention 列表**：消息气泡是扁平的无障碍叶子节点
（`childCount == 0`，没有 text/value/legacy pattern），消息对象上也没有 mention 字段。
所以群 `@` 读的是**客户端自己的标记**——从 mention 列表选出的名字后面跟 `U+2005`（四分宽空格），
手打 `@名字` 用的是 `U+0020`——外加 `@所有人`。

这比子串匹配强、比结构化列表弱，所以能力自述要说清是哪种：

| 值 | 含义 |
| --- | --- |
| `structured` | 客户端给了 mention 列表（`fake` 参考后端，以及将来的 L1/L2） |
| `markup` | 客户端自己的标记，对本账号解析（当前 L0） |
| `none` | 完全判不出 |

判据用的本账号显示名按 **60 秒 TTL** 重读、每次 `/listen` 强制重读、轮询路径顺带刷新，
所以改昵称不用重启就能自愈。读失败保留旧名而不是清空——清空会让判定永远不命中，比旧值更糟。

### 5.3 L0 给不出的东西

| 契约字段 | L0 现实 |
| --- | --- |
| `room`（chatroomId） | 拿不到；会话命名为 `wxname_<sha1(显示名)[:16]>` |
| `sender.id` | 显示名，同样命名空间化；`sender_info()` 给的是微信号，且滞后一条消息、有时为 null |
| `at`（消息时间） | 有客户端时间分隔符就用它，否则用接收时间 |
| `/members` | 只有见过的发送人（`members: observed`） |

命名空间化是有意的：它保住了设置里的 id 正则的严格性，而不是为了迁就显示名去放宽；
`refreshLabels` 再把 id 解析回名字给面板的下拉用。代价是改群名会换 id。

## 6. 新增一个 provider

1. 实现那份契约。聊天类需要：列会话、按游标读消息、发送、（可选）下载媒体。工作项：列/读/评论。托管：变更请求、评论、CI。
2. 如实声明 `capabilities` —— `idempotency`（`keyed` / `marker` / `none`）、`maxChars`、`markdown`、`proactive`。
   面板会显示它们；写错就是给出一个错的承诺。
3. 写 kind：schema、字段（schema 每个键都要有对应字段）、`scope` 规则、环境变量。
4. 加一个 `*-watch.ts` 插件入口，以及 `cordis.patch.yml` 里的 insert。**不要**给它写 `disabled: true`：
   kind 只有在插件注册之后才会出现在面板里，而「跑不跑」由面板的开关决定。
5. 把文件行补进 `docs/007-architecture.md` —— 模块或测试文件缺行，`tests/docs.spec.ts` 会红。
6. 补 spec。真实行为放 `tests/live/*.live.spec.ts`，由 `LIVE=1` 门控。

## 7. 验证矩阵

| 对象 | 怎么证明 |
| --- | --- |
| 全量 | `vitest run --maxWorkers=2`，macOS arm64 与 Windows 11 双平台绿 |
| 微信契约 | 真实 sidecar 进程 + 回环：9 条 live 用例（端点、`ats`、幂等发送、图片字节、`/listen`） |
| 微信真机 | 真实微信 4.x：监听回调、本账号身份、发送往返、图片下载、五条标记用例证明手打 `@名字` 不算 |
| GitLab | 真实 `gitlab.com` API：MR 映射、伪 token 映射为 401 且不回显 |
| 企微 / 钉钉 / 云效 | 真实鉴权失败被映射成可诊断错误，消息里没有密钥 |
| 面板数据层 | 同通道两实例、删除其一、无通道 id 的旧设置 |
| Windows | 首次 clone 时失败的 16 个文件与实测基线，见 [HANDOVER-WIN11.md](HANDOVER-WIN11.md) |

**未验证、也不声称**：对真实代码托管/工作项的任何写操作；企微回调走公网反代；钉钉 Stream 植入 SDK；
微信的 `structured` mention（目前没有任何一层提供它）；企微/钉钉的消息图片。

## 8. 改代码时要守的约定

- **`@` 绝不按文本判定。** `scope` 只读 `ats`。后端可以由客户端自己的标记得出 `ats`，
  但强度必须声明在 `capabilities.mentions` 里，让人看得出一个群 `@` 是证据还是线索。
- **一份状态一个写者。** Source 只能经 `SourceContext.tickets` 改工单；健康条目按实例 claim；回执只由 Outbox 写。
- **幂等是声明的。** `keyed` / `marker` / `none`，面板显示代码的真实行为。
- **密钥来自文件**，每次调用读取，owner-only，且绝不出现在消息或日志行里。
- **后端差异留在 sidecar。** 身份归一属于那里，不属于设置 schema。
- **`src/sources` 不 import `src/app`。** 双方都要用的类型留在 `src/sources`。
- **不放个人数据、不放机器专属路径。** 文档与夹具用占位符；路径走参数或环境变量。

## 9. 许可

MIT，与本版所生长的原型一致；上游版权声明保留。微信的 UI 自动化是第三方工具：
未经腾讯授权，可能随时被客户端或平台限制，必须守在
[ADR-005](docs/extensions/ADR-005-weixin-backend.md) 记录的边界内——只在被 `@` 时回复、不群发、
不批量加好友、同一时刻只有一个账号在线。
