# wxauto-bridge 契约（冻结）

本文件是 Node 侧唯一依据：`src/sources/chat/weixin/bridge.ts` 按本契约实现，`src/sources/chat/weixin/backend.ts`
的 `BridgeEndpoints` 引用 §1。改动本文件等于改动跨进程协议，必须同时改 `bridge.ts` 与
`tests/live/weixin-bridge.live.spec.ts`。

传输：HTTP/1.1，JSON（`application/json; charset=utf-8`），仅回环地址。sidecar 实现见同目录 `server.py`。

---

## §1 端点与路径表

| # | 方法 | 路径 | 用途 |
|---|---|---|---|
| 1 | GET | `/health` | 进程与后端可用性 |
| 2 | GET | `/status` | 登录态与自身 wxid（`@` 判定基准） |
| 3 | GET | `/rooms` | 本后端**能看到的**会话（不是正在听的，见 §7.1） |
| 4 | GET | `/members?room=<id>` | 群成员表 |
| 5 | GET | `/messages?room=<id>&limit=<n>&cursor=<c>` | 增量拉取消息事件 |
| 6 | POST | `/send` | 发一条文本（可引用回复） |
| 7 | GET | `/media/<id>` | 取一条消息图片的原始字节 |
| 8 | POST | `/listen` | 下发要监听的会话集合（集合替换、幂等），见 §9 |

- `limit` 默认 50，服务端夹到 `[1, 200]`。
- `room=""` 表示单聊（直接会话），此时 `threadRoot` 由 Node 侧取发送者 wxid。
- 未知路径 → `404`；已知路径但方法不符 → `405`（带 `Allow` 头）。

## §2 鉴权与错误码

- 每个请求都必须带 `Authorization: Bearer <token>`；sidecar 用 `hmac.compare_digest` 比对。
  缺失或不符 → `401 {"error":"unauthorized"}`，不区分“没带”和“带错”。
- token 只经命令行/环境变量传入，sidecar 启动时只打印 `token=set`，**任何日志不得出现 token 值**。
- 错误响应体统一为 `{"error": "<code>"}`，可附 `detail`：

| 状态 | `error` | 含义 | Node 侧处理 |
|---|---|---|---|
| 400 | `bad_request` | 请求体不是合法 JSON / 不是对象 | 直接失败 |
| 401 | `unauthorized` | 鉴权失败 | 抛 `unauthorized` |
| 404 | `not_found` | 路径或媒体 id 不存在 | 媒体 → `gone` |
| 405 | `method_not_allowed` | 方法不符 | 直接失败 |
| 409 | `gone` | 会话已不能接收 | 发送结果 `'gone'` |
| 500 | `internal` | sidecar 内部异常 | 直接失败 |
| 501 | `unsupported` | 该后端不具备此能力（无下载能力 / pad 桩） | 媒体 → 失败，不重试 |
| 502 | `unavailable` | 后端暂时不可用 | 标记 `retryable` |

## §3 事件对象字段

`GET /messages` → `{"events": [Event...], "next": "<cursor>"}`。

| 字段 | 类型 | 说明 |
|---|---|---|
| `nativeId` | string | 平台消息 id，幂等去重与游标都用它 |
| `room` | string | 会话 id；**单聊为 `""`** |
| `sender.id` | string | 发送者 wxid |
| `sender.name` | string | 昵称（可变，不参与判定） |
| `text` | string | 消息正文；**永不为空串**，渲染规则见 §3.2 |
| `at` | string | ISO8601 UTC，形如 `2026-11-06T04:01:02Z`；取值顺序见 §3.2 |
| `ats` | string[] | **本后端能证明被 @ 的 id**（不是从文本猜出来的名字），见 §8；`fake` 给结构化 wxid，`pc-uia` 只能证明本账号 |
| `own` | bool | 是否本账号自己发的 |
| `quoteId` | string | 引用回复的原消息 `nativeId`，无则为 `""` |
| `media` | array | 可下载的图片，元素 `{id, kind:"image", mime?}`；无则 `[]` |

- `media[].id` 形如 `<nativeId>#<index>`，`index` 从 `0` 起。
- `media[].mime` 是**可选**字段：后端在列表阶段没确认类型时省略，真实类型以 `GET /media/<id>`
  的 `Content-Type` 为准。Node 侧只在非空时才写进 `ChatEvent.media`。
- 只列该后端**确实能下载**的图片；不能下载的构建返回空 `media`，不返回“看得见取不到”的 id。
- `GET /status` → `{"loggedIn": bool, "wxid": string, "name": string, "backend": string,
  "available": bool, "lastEventAt"?: ISO8601, "detail"?: string}`；`detail` 仅在不可用时出现。
- `GET /health` → `{"ok": bool, "available": bool, "version": string, "sidecar": "1",
  "backend": string, "uptimeSec": int, "capabilities": {...}, "detail"?: string}`；`ok` 与 `available` 同值，
  后端不可用时为 `false` 且带 `detail`（进程仍返回 200，便于 Node 读取原因）。
- `GET /rooms` → `{"rooms":[{"id","name"}]}`：**本后端能看到的会话全集**（面板下拉的候选），
  **不是**「正在听哪些」——订阅状态只由 `POST /listen` 的 `listening` 与 `/health` 的 `detail` 表达。
  该端点**只读**：不 `AddListenChat`、不切会话、不改任何状态。
- `GET /members` → `{"members":[{"id","name"}]}`，未知 `room` 返回空数组而不是错误。

### §3.1 `capabilities`（能力自述，三态）

`/health.capabilities` 是后端对「自己能兑现哪些契约字段」的诚实声明。Node 侧据此决定是否启用群 `@`，
**不要**用「`ats` 是否为空」去猜。

| 字段 | 取值 | 含义 |
|---|---|---|
| `mentions` | `"structured"` / `"markup"` / `"none"` | 结构化列表 / 客户端 `@名字␅` 标记 / 不可判定 |
| `members` | `"full"` / `"observed"` / `"none"` | 完整成员表 / 只含本会话发过言的人 / 无 |
| `media` | `true` / `false` | 能否下载图片 |

| 后端 | `mentions` | `members` | `media` |
|---|---|---|---|
| `fake` | `"structured"` | `"full"` | `true` |
| `pc-uia`(L0) | `"markup"` | `"observed"` | 取决于该构建有无 `download()` |
| `pad`(L2 桩) | `"none"` | `"none"` | `false` |

**向后兼容**：旧 sidecar 只发布尔值时，`true` 归一为 `"structured"` / `"full"`，`false` 归一为 `"none"`；
`media` 始终是布尔。Node 侧按同一规则归一，两侧都不得因布尔值报错。

`mentions:"none"` 表示该后端**不具备**群 `@` 判定能力：`ats` 恒为 `[]`、`mentionsAgent` 恒为 `false`，
依赖群 `@` 的工单不应接在该实例上。

### §3.2 正文与时间的渲染规则（`text` / `at`）

`text` 的渲染顺序（**任何分支都不得产出空串**）：

| 消息 | `text` |
|---|---|
| 普通文本 | 原文 |
| 语音（`voice`） | `to_text()` 的转写结果；失败/超时/空结果 → 原 `content` + `（语音转写失败）`（原 `content` 为空时只留标注） |
| 引用（`quote`） | `「引用」<被引文本>\n<回复正文>`；取不到被引文本 → 只留回复正文（**不伪造**），正文也空 → `[引用消息]` |
| 图片 / 文件 / 视频 / 链接 / 位置 / 表情 / 合并转发 / 其他 | 有可读 `content` 就原样透传；为空 → `[图片]` / `[文件消息]` / `[视频消息]` / `[链接消息]` / `[位置消息]` / `[表情消息]` / `[合并转发消息]` / `[其他消息]`，未知类型 → `[消息]` |
| 时间分隔符（`time`） | **不进事件流**，只用来给后续事件定时间 |

语音转写 `to_text()` 会占用客户端 UI，因此**必须**在主线程执行器上跑、限时 8 s、**只尝试一次不重试**；
超时或抛异常都按失败处理，不阻塞消息队列。

`at` 的取值顺序：

1. **房间内最近一条 `TimeMessage` 的时间**（微信在消息流里插的时间分隔符，带完整日期，本地墙钟→UTC）。
   它一直生效到下一个分隔符，所以同一分钟内的多条消息 `at` 相同；
2. 消息自带的 `time` 字段（多数普通消息没有）；
3. 服务端接收时间（`iso_now()`）——**诚实降级**：监听启动前的历史消息没有分隔符，只能这样。

分隔符按 `room` 分别记录，不跨会话串用。

## §4 游标语义

- `next` 是**不透明字符串**，Node 侧不得解析、比较或自造。
- 不传 `cursor`：返回当前窗口内的一页（`fake` 从最早开始；`pc-uia` 返回最近 `limit` 条）。
- 传回 `next`：只返回**比它更新**的事件。
- 没有新事件时：`events: []`，`next` 原样返回（不前进、不清空）。
- 游标失效（服务重启、`nativeId` 已滚出缓冲、格式不认识）：按**无游标**处理（返回当前窗口的一页），不得报错。
- 至少一次语义：`nativeId` 可能重复出现，Node 侧按 `nativeId` 去重。

## §5 媒体方案

- 路径：`GET /media/<id>`，`<id>` 在 URL 上百分号编码（`m4#0` → `m4%230`），sidecar 解码后匹配。
- 成功：`200` + 原始字节 + 正确的 `Content-Type`（`image/png` / `image/jpeg` / `image/webp` / `image/gif` …）。
- `404`：该 id 不在当前可见窗口内、定位失败、或**载荷为空**。
- `501`：该后端整体没有下载能力（例如免费构建没有 `download()`、`pad` 未实现）。
- **零字节规则**：绝不返回 `200` + 0 字节。空载荷一律按 `404` 处理（ADR-005 §7 遗留项 IMG-3）。
- 缓存：sidecar 内部按 `--media-cache-ttl`（默认 300 s）缓存已下载字节，命中直接返回。
- 串行化：`/media` 与 `/send` **共用同一把进程内锁**——两者都会占用客户端 UI。
- Node 侧只按**魔数**判定图片格式，不信远端 `Content-Type`；超限或格式不接受时在落盘前抛错。

## §6 发送幂等与串行化

请求：`POST /send`，body `{"room","wxid","text","quoteId"}`（`quoteId` 可为 `""`），
可选头 `Idempotency-Key: <OutboundMessage ID>`。

响应：`200 {"msgId": string, "deduped": bool}`；会话不可接收 → `409 {"error":"gone"}`。

- 同一个 `Idempotency-Key` 重放：返回**同一个** `msgId` 且 `deduped: true`，不产生第二条消息。
- 幂等缓存有界（256 条 / 600 s TTL，LRU 淘汰）；过期后同 key 视为新请求。
- 命中缓存的重放**不**消耗发送间隔，立即返回。
- 进程内所有发送串行（一把锁），相邻两次发送间隔 ≥ 1 s 并叠加随机抖动（ADR-005 §2.3 第 2 条）。
- 没有 `Idempotency-Key` 的请求不去重，由调用方负责。

## §7 后端阶梯与切换

| 层 | `--backend` | 形态 | 启用条件 |
|---|---|---|---|
| L0 | `pc-uia` | wxauto 一类，UIAutomation，不注入进程 | 默认 |
| L1 | `pc-hook` | DLL 注入 + 本地 HTTP（wxhelper 一类） | L0 受窗口/版本限制且业务书面接受注入风险 |
| L2 | `pad` | iPad 协议（WeChatPadPro 一类） | 无 Windows 机；业务书面接受协议风控 |

- 当前实现：`fake`（契约自测，跨平台）、`pc-uia`（L0，`wxautox4`，延迟导入）、`pad`（桩：
  `available:false` + `detail:"the pad backend is not implemented"`，数据端点 `501`）。
- **切换后端 = 改配置 + 重启该实例**，不改 Node 代码；`GET /health` 的 `backend` 字段用于确认当前层。
- 同一时刻只允许一个实例持有同一微信号的登录态（双发/风控红线）。
- 后端不可用时进程**不崩**：`/health` 与 `/status` 仍应答，数据端点返回 `502`（`pad` 为 `501`）。

### §7.1 L0（`pc-uia`）的判定方式、身份归一与代价

**收消息走监听模式**：`AddListenChat(nickname=…, callback=…)` + `StartListening()`，回调把消息推进有界队列
（`--queue-size`，默认 500），`/messages` 从队列出、游标是单调递增序号。不再用 `GetAllMessage()` 轮询——
它只返回当前窗口**已渲染**的消息，`ChatWith()` 在目标已是当前会话时不重绘，会周期性读到 0 条。
`TimeMessage` 分隔符不进事件流。

**群 `@` 用客户端标记判定**（`capabilities.mentions = "markup"`）：微信 4.x 真正 @ 某人时插入的是
`@<显示名>` + `U+2005`（四分宽空格），人工手打用 `U+0020`。规则只有三条：`@名字␅` 出现、正文以
`@名字` 结尾、`@所有人␅`。**不做**裸子串匹配（否则「他刚才说了 @<昵称> 这句话」会被误判）。

代价（**已知，不是 bug**）：

| 风险 | 说明 |
|---|---|
| 可伪造 | 任何群成员都能发一条含 `@<机器人显示名>␅` 的文本被判为「被 @」——markup 本质是文本标记 |
| 句末误判 | 正文恰好以 `@<显示名>` 结尾（例如复述别人的话）会被判成命中 |
| 改昵称即换 id | `wxname_` 身份由显示名派生：**群/发送人的 id 会跟着变**，配置要跟着改（见下） |

**判据名的刷新**：`@<本账号显示名>` 里的名字不是启动时读一次就固定——sidecar 按
`--self-name-ttl`（默认 60s）重读 `GetMyInfo().display_name`，`POST /listen` 时**强制刷新**一次
（运维刚在客户端改完名、顺手存面板，这个时机最自然），`/messages` 的轮询路径也会按 TTL 顺带刷新。
**改完昵称无需重启 sidecar**，最多等一个 TTL。当前判据名直接写在 `/health` 与 `/status` 的 `detail` 里
（形如 `群 @ 判据：@<昵称>`），改名后从接口就能看出来；读失败时**保留旧名**并记 note，绝不清空
（清空会让判定永不命中，比旧值更糟）。`wxid` 与显示名同源同处读，不做两套缓存。

**身份归一 `wxname_<sha1(显示名)[:16]>`**（L0 拿不到 chatroomId 与发送人 wxid，而 Node 侧
`rooms[].id` / `policy.allowed[].id` 是 `^[A-Za-z0-9_-]+$`，中文名过不了；归一留在 sidecar）：

- `rooms[].id` = `wxname_…`，`rooms[].name` = 显示名；
- `sender.id` = `wxname_<sha1(显示名)>`，`sender.name` = 显示名；
- `/members` = 该会话**已观测到的发送人**（`members:"observed"`），按 `sender.id` 去重、先到先列；
- `/send` 的 `room` 同时接受 `wxname_…` 和显示名；
- **显示名改了 id 就变**，配置要跟着改 —— 没有 chatroomId 的必然结果。

其余 L0 缺口（**契约允许的已知行为**，不要当缺陷排查）：

| 契约字段 | L0 实际行为 | 原因 |
|---|---|---|
| `sender.id` | `wxname_<显示名>`，**不是 wxid** | 已实测：`sender_info()` **能**返回 `id`，但那是**微信号**（如 `<微信号>`、`<微信号>`）而非 `wxid_…`；更关键的是它**滞后一条消息**（消息 `sender` 是 A，`sender_info()` 返回 B）且**有时返回 `null`**，不能用于逐条消息的身份映射。**Policy 的 wxid 名单在 L0 上不可用** |
| `room`（chatroomId） | 只有显示名，没有稳定 ID | `ChatInfo()` 只有 `chat_type/chat_name/group_member_count`；`SessionElement` 只有 `name/time/content/isnew/new_count/ismute` |
| `at`（时间） | 优先取房间内最近的 `TimeMessage` 分隔符（本地墙钟→UTC）；没有分隔符时回落到**服务端接收时间** | 普通消息没有时间字段；监听启动前的历史消息没有分隔符，只能降级 |
| `/members` | 只含发过言的人 | `GetAllRecentGroups()` 只给 `(群名, 成员数)`，没有成员列表 API（`_api` 里只有 `add_group_members`） |
| 单聊 | `room: ""`；但 `/rooms` 里**会**列出单聊 | 单聊没有房间 id，事件里只能靠 `room: ""` 表示；`/rooms` 是候选全集，面板下拉需要它 |

`/health.capabilities` 是这些能力的机器可读形式（见 §3.1）：L0 上 `mentions:"markup"`、`members:"observed"`。

**单聊怎么读（L0）**：单聊事件的 `room` 是 **空串**（契约如此），而面板里存的是那个人或那个会话的
`wxname_…`。所以 `/messages` 与 `/media` 的 `room` 接受三种写法：空串、`wxname_…`、显示名；后两者会被
映射回单聊流。判断依据是消息到达时客户端报的 `chat_type`，还没见过消息时退化为「不在最近群列表里就不是群」。

> **已知限制**：所有单聊共用 `room: ""` 这一条流，所以多个人的私信在 sidecar 侧是混在一起的。Node 侧按
> 发送人分线程（`threadRoot = senderId`），并按消息 id 去重，所以不会串错、也不会重复；代价是配置了 N 个
> 单聊时，每轮会看到这 N 个人混在一起的页面。

**`file`（可选，L0）**：`/send` 可以带一个文件——`{"file": {"name": "chart.png", "data": "<base64>"}}`。
sidecar 把它写进一个私有临时目录，用 `Chat.SendFiles(filepath, who)` 发出去，然后删掉临时文件；文字与文件可以同时给，
**先文字后文件**。护栏：解码后 ≤ 20 MiB（超了 413）、请求体 ≤ 约 27 MiB、文件名只保留 basename 并过滤到 `[A-Za-z0-9._-]`
（`../../etc/passwd` → `passwd`），权限与其他端点同一个 bearer token。`at` 只作用于文字：`SendFiles` 没有提及参数。
真机验证：一张 2×2 PNG 经 `/send` 发出，客户端把它渲染成图片消息（队列回显 `text="图片"`）。

**游标必须跨重启单调（L0）**：`/messages` 的游标是**单调递增**的整数序号，`seq` 由**时钟**播种而不是从 0 开始——
客户端把游标持久化，若重启后序号倒回 0，那个游标就比所有后续事件都大，过滤条件 `seq > cursor` 永远不成立，
表现是**会话静默，任何日志里都没有错误**（真机踩过：`kv` 里存着 `8`，队列从 1 重新数，之后整段消息被吞掉）。
响应因此带 `head`（当前已分配的最大序号）：客户端发现自己的游标**比 `head` 还大**，就说明计数回退过，应当从头再读。

**监听的自愈（L0）**：`/listen` 是幂等的——集合与 `options` 都没变就一个微信调用都不发。但「没变」不等于
「还活着」：客户端界面被卡住、或另一个 UI 自动化工具抢过窗口时，`AddListenChat` 与 `StartListening` 依旧
返回成功，而回调从此不再触发。所以 sidecar 把**连续 `LISTENER_QUIET_S`（600 秒）没有真实事件**判定为挂载
哑掉，对每个会话**先摘后挂**并重调 `StartListening`，每个 `LISTENER_REATTACH_GAP_S`（900 秒）最多一次。
`/health` 与 `/status` 的 `detail` 会写「监听 N 个会话，最近事件 K 秒前」，以及「已自动重挂 M 次」——看到 M 在涨，
就是客户端被人或别的工具抢过界面。

**`at`（可选，L0）**：`/send` 的正文之外可以带 `{"at": [名字或 wxname_id, …]}`，表示**群里 @ 这些人**。
sidecar 只对**群**生效（单聊直接忽略，那里没有 @ 这回事），并且只把 `wxname_…` 换成**它自己在该会话观测到**
的显示名——解析不出来就不 @，绝不把 id 原样交给客户端。重复项去重、空项忽略。
> 陷阱：入站的 `Message.at` 是「拍一拍」，出站的 `SendMsg(at=[...])` 是提及，同名不同义。

**`options`（可选，L0）**：`{"voice": bool, "images": bool}` 随 `/listen` 一起下发，决定**消息被渲染成事件时**做什么：
`voice=false` 不调 `to_text()`（每条语音省下最多 8 秒客户端 UI，正文变成 `[语音消息]` 占位）；
`images=false` 不把图片列进 `media`（正文留 `[图片]` 占位，一个字节都不下载）。
未出现的键**保持当前取值**（不是复位成默认值），所以只翻转一个开关不会顺手改另一个；
键名不认识就忽略，值不是布尔则 400。整体缺省等价于两个都开。

**`/rooms` 的语义（L0）**：返回 `GetAllRecentGroups()` 的群 + `GetSession()` 里的会话，按显示名排序
（`GetSession()` 是 MRU 序，新消息一来就抖，面板下拉需要稳定顺序），上限 500 条；超过时在
`/health` 与 `/status` 的 `detail` 里说明截断了多少。**它不反映订阅状态**：`/rooms` 全量列出候选，
「正在听哪些」只看 `/listen` 的 `listening`。该端点只读——不 `AddListenChat`、不切会话。

> **已知限制**：`GetSession()` 只返回**当前会话列表里可见**的那些会话（本机约 8 个，滚出列表的不在里面），
> 所以**一个滚出列表的单聊不会出现在 `/rooms` 候选里**。配置单聊时先打开它一次，再点面板的刷新。
> 群不受此限——`GetAllRecentGroups()` 覆盖全部近期群（本机 107 个）。这是拿不到 chatroomId 的又一处代价。

**启动与依赖发现**：`--venv` 决定 `wxautox4` 装在哪。不给时依次取 `WXBRIDGE_VENV`、
当前解释器所在的 venv（`sys.prefix`，当它含 `pyvenv.cfg`）、否则为空——**源码里没有任何机器专属路径**。
**`wxautox4` 是商业库，授权由部署方自行承担**：本仓库不分发它的任何文件，也不含任何规避其
授权检查的代码。没有有效授权时，后端会以 `available:false` 加 `detail` 报出原因，进程不会崩。
**运行约束**：微信 4.x 的监听必须注册在**主线程**，且此后任何跨线程的微信调用都会让回调彻底失效
（三种组合实测，见 `verify/_listen_probe*.py`）。所以 HTTP 由后台线程服务、主线程归微信，所有微信调用
经 `_MainThreadExecutor` 串行排队——顺带满足 ADR-005 的「UI 串行化」。

## §8 不变量

1. **`ats` 的语义收窄**：`ats` = **本后端能证明被 @ 的 id**，不是「从文本猜出来的名字」。
   `fake` 给结构化 wxid 列表；`pc-uia` 只能证明**本账号**是否被 @（客户端 `@名字␅` 标记），命中即
   `[self_wxid]`，否则 `[]`——**永远不含第三方**。任何后端都不得退化成裸子串匹配。
   `/health.capabilities.mentions` 必须与此一致（L0 为 `"markup"`，见 §7.1）。
   **只读铁律**：取 `ats` 只允许读属性与 `sender_info()` / `chat_info()` 这两个纯读取方法，
   **绝不调用** `at()` 之类会改状态的方法——`FriendMessage.at` 执行即「拍一拍」。
2. **只被动回复**：不群发、不拉群、不加好友；`/send` 只回应已有会话。
3. **只听 127.0.0.1**：默认绑定 `127.0.0.1`；绑定非回环地址必须显式 `--allow-remote`。
4. **发送串行**：见 §6，且 `/media` 与之共用锁。
5. **不泄露 token**：日志、异常、启动信息都不得包含 token 值。

## §9 监听集合下发（`POST /listen`）

`--listen` 只是启动参数；运维在面板里配的群必须能直接下发，否则同一批群要在两处各填一遍，漏一处就
「配了但收不到」。Node 侧每轮轮询前把 `config.rooms` 下发一次（`rooms` 为空时不调用），sidecar 自己做增删 diff。

请求：`{"rooms": ["研发-交付群", "wxname_3da351bad1d722cb"]}`

- `rooms` 里**既接受显示名，也接受 `wxname_…` id**（面板存 id，运维手写名字）；
- 语义是**集合替换**：目标是「只听这些」。比现在多的 `AddListenChat`、少的 `RemoveListenChat`；
  **完全相同则一个微信调用都不发**；
- 空数组 = 停掉全部监听（端点支持；Node 侧在 `rooms` 为空时不调用，避免误静默）。

响应 `200`：

```json
{
  "listening": [{"id": "wxname_3da351bad1d722cb", "name": "研发-交付群"}],
  "added": ["研发-交付群"],
  "removed": [],
  "failed": [{"room": "不存在的群", "detail": "会话不存在或 AddListenChat 返回失败"}]
}
```

- `listening` = **当前实际在听的集合**（归一后的 id + 显示名）；`added` / `removed` = 这次真正动了的；
  `failed` = 解析或增删失败的条目（元素固定为 `{room, detail}`）。
- **部分失败不 500**：能加的照加，失败的进 `failed`，整体仍 `200`。只有后端完全不可用时才 `502`。
- `401`（未授权）、`405`（`GET /listen`）、`400`（body 不是对象 / `rooms` 不是字符串数组 / 缺 `rooms`）。

**`wxname_…` 如何解析回显示名**：没有反函数，只能建名字表——已观测到的 room、`GetAllRecentGroups()`
（`(群名, 成员数)`）、`GetSession()`，对每个候选名算一次 `wxname()` 比对。解析不到就进 `failed`，
**不猜、不拿 id 当名字去 `AddListenChat`**。

三后端行为：

| 后端 | 行为 |
|---|---|
| `pc-uia` | 真 `AddListenChat` / `RemoveListenChat`，全部经主线程执行器（见 §7.1 运行约束） |
| `fake` | 幂等且**不改变固定数据集**：认识的会话报进 `listening`、`added: []`；不认识的进 `failed` |
| `pad` | `501` |
