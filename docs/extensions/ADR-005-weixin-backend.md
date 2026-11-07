# ADR-005 微信个人号群消息的后端选型与切换策略

- **状态**：Accepted（2026-11-06，方案 owner 已确认）
- **决策范围**：`src/sources/chat/weixin/*` 的后端形态、主备策略、部署前提
- **关联**：设计文档 §6.7、§6.7.9、§6.7.10；本文不重复背景，只固化决定

## 1. 背景（一句话）

微信群 `@` 机器人是本项目的**必须项**，但官方 ClawBot 通道只覆盖单聊，且开源社区的主力后端在过去三年连续退场（itchat → gewechat → wcf）。因此**任何"选定一个后端长期依赖"的方案都不可接受**。

## 2. 决定

### 2.1 形态：Windows 常驻 sidecar + loopback HTTP

WeChat 客户端自动化跑在一台 **Windows 常驻机**上，以独立进程（`sidecar/wxauto-bridge`）暴露
`127.0.0.1` 的 HTTP 契约（见 `sidecar/wxauto-bridge/contract.md`），dsh-superagent 通过
`src/sources/chat/weixin/pc-uia/*` 适配器调用。

理由：
1. 客户端自动化与 Agent 运行时**故障域隔离**——微信掉线不该拖垮工单执行；
2. sidecar 可用任意语言/任意库实现，后端切换不动 DSH 侧代码；
3. 契约只有 6 个端点，反序列化面小，安全面小。

### 2.2 主备阶梯（按优先级，不是并列候选）

| 层 | 后端 | 触发启用的条件 |
|---|---|---|
| **L0** | `pc-uia`（wxauto 一类，UIAutomation，不注入进程） | 默认 |
| **L1** | `pc-hook`（wxhelper 一类，DLL 注入 + HTTP） | L0 受窗口/版本限制，且业务书面接受注入风险 |
| **L2** | `pad`（WeChatPadPro / 社区 fork，iPad 协议） | 无 Windows 机、只有 Linux；业务书面接受协议风控 |
| **L3** | `hosted`（付费 API） | L0–L2 全挂且业务不能停 |
| 旁路 | 企微客户群 / 官方 ClawBot 单聊 | 客户愿意迁群 / 只需单聊（属需求变更，不是技术降级） |

**同一时刻只有一个实例持有同一微信号的登录态**（双发/风控红线）。

### 2.3 硬约束（写进 DoD，不满足则"能换"不成立）

1. `WeixinBackend` ≤ 8 个方法；单后端实现 ≤ 400 行。
2. dsh 侧对微信实例 `replyConcurrency = 1`，`/send` 由 bridge 串行 + 1s 间隔 + 抖动。
3. 切换后端 = 改配置 + 重启该实例，**不改 DSH 代码**；目标 ≤ 2 人日。
4. 群 `@` 判定只认 `ats` 结构化列表；**禁止**用文本 `@昵称` 反解。
5. 权限边界：只被动回复；不群发、不拉群、不加好友。

## 3. 后果

**正面**
- 任一后端退场，业务在 60s（主备接管）到 2 人日（跨后端迁移）内恢复。
- 群消息、`@`、群成员三件事在契约层被固定，Node 侧只依赖契约。

**负面 / 代价**
- 必须有一台 Windows 机器（或安卓真机）常驻；这是**运维成本**，不是代码成本。
- wxauto 作者免责声明禁止生产/商用 → 需业务 + 法务书面确认，否则 L0 不可用，直接落 L1。
- bridge 侧多一个进程 + 一套凭据（token + 登录态）要管。

**不做**
- 不做"多后端同时在线双写"（同一群双发）。
- 不把客户端自动化内嵌进 dsh 进程（故障域混同）。
- 不承诺"无风控"，只承诺"被限时能换"。

## 4. 验收（本 ADR 完成的标准）

1. `poc/probe_wxauto.py` 在目标 Windows 机产出 `probe-report.json`，且 **Q1（群消息字段 + 是否有结构化 ats）** 与 **Q2（群成员表）** 均有证据。
2. `sidecar/wxauto-bridge` 用 `--backend fake` 通过契约自测（本仓已可跑，见 README）。
3. 真实后端接入后，跑通设计文档 §6.7.8 六条剧本（含"改昵称后 `@` 仍生效"与"重试不重复发送"）。
4. 主备切换演练：L0 停进程 → L1 在 60s 内接管，群里无重复消息。

## 5. 回滚

- 单实例回滚：实例置 `enabled:false` → 该群不再接入，其余通道不受影响。
- 跨后端回滚：把 `backend` 配置改回上一层，重启实例；登录态需要重新扫码（微信不允许两处同时在线）。
- 彻底回滚：删除 `weixin` 实例配置，插件 `disabled`，行为等同 v1.0 方案（无微信接入）。

## 6. 未决前置（阻塞项，必须由业务方给出）

| # | 前置 | 谁给 | 不给的后果 |
|---|---|---|---|
| 1 | Windows 常驻机（或安卓真机）承诺 | 业务/运维 | L0/L1 全部不可用，只能落 L2（风险最高）或旁路 |
| 2 | wxauto 生产/商用许可确认（法务） | 业务 + 法务 | L0 不可用，直接落 L1（注入风险） |
| 3 | 目标微信 PC 客户端版本冻结策略（不允许自动升级） | 运维 | 客户端升级即可能失效，切换成本回到"按周" |
| 4 | **探针与客户端必须在同一交互式桌面会话**（物理控制台或未锁屏的 RDP；不能从 SSH/服务/CI 会话跑） | 运维 | `wxauto` 通过 UIAutomation 读客户端窗口，跨会话一律看不到窗口，表现为 `WindowDiscoveryError` |
## 7. 真机探针实测记录

### 2026-11-06 首次运行（Windows 11 / Python 3.13.17）

- 环境：`Windows-11-10.0.26200-SP0`，wxauto **3.9.11.17+dsh1**（`wxauto-fork/wxauto-main` 构建）
- 结果：`import wxauto` ✅；`attach client` ❌
  `WindowDiscoveryError: No visible Weixin/WeChat top-level window is accessible in Windows session 21. Discovered client window sessions: (none).`
- 判定：**不是代码缺陷，是会话/窗口不可见问题**。探针进程在 session 21（典型 RDP/远程会话），UIAutomation 只能枚举本会话顶层窗口；若客户端在别的会话、或未启动、或只在托盘，均表现为 `(none)`。
- 因此新增 `poc/win_diag.py`：`python win_diag.py` 直接给出当前进程 session、微信窗口所在 session、是否管理员、以及下一步动作；`probe_wxauto.py --diag` 同效。attach 失败时会自动打印 next steps。
- **准入状态：仍为未通过**（Q1/Q2 均无证据）。下一次运行必须满足 §6 前置 4，并要求客户端版本与 wxauto 构建匹配（3.9.x 与 4.x 是两套 UI）。

### 2026-11-06 第二次运行（同机，会话问题已解决）

- 探针已能**看到并 attach 到窗口**：`Weixin.exe`，pid 46576，session 21，class `Qt51514QWindowIcon`，title 微信；
  但 `RuntimeError: Attached to Weixin/WeChat HWND 0x1F0C2A, but the wxauto 3.9 accessibility tree was not found`，
  root children = `MMUIRenderSubWindowHW`（微信 4.x 的新 UI 容器）。
- **判定：客户端是微信 4.x，`wxauto`（3.9 系）无法驱动**。这是版本代际问题，不是会话问题（窗口这次可见）。
- 可行路径（二选一，成本/风险不同）：
  | 路径 | 做法 | 代价 | 风险 |
  | --- | --- | --- | --- |
  | **4.x 路线（不动客户端）** | `pip install wxauto4`（免费，Python 3.9–3.12，客户端 ≤ 4.1.8.107）或 `pip install wxautox4`（付费，Python ≤ 3.13） | 需装 Python 3.12 或购买激活码；客户端可能需要降到 ≤4.1.8.107 | 免费版对客户端版本敏感 |
  | **3.9 路线（不动工具链）** | 装微信 3.9.11.17 + 关闭自动更新，沿用现有 `wxauto` fork | 需在客户端上做版本锁定 | 官方可能强推升级 |
- **Q1 未决风险（重要）**：wxauto4 文档的 `Message` 只有 `attr/type/id/sender/content/info`，**没有文档化的结构化 `@` 列表**（`at` 只出现在发送侧 `quote(text, at=[...])`）。因此群 `@` 是否可结构化判定，取决于运行时 `info` 里是否带 at 列表——必须由探针 dump 后决定。若确实没有，按 §6 前置规则**不得改用文本 `@昵称` 反解**，应转 L2（pad）或另选后端。
- 工具已升级：`poc/win_diag.py` 识别 `Weixin.exe`/`Qt51514QWindowIcon` 即判为 4.x 并给出包建议；`poc/probe_wxauto.py` 依次尝试 `import wxauto4` 再回退 `wxauto`，并把包名写进报告。

### 2026-11-07 探针 v3：先保证"一定出报告"

- 现象：Windows 上跑旧版 probe **没有生成 `probe-report.json`**。三个原因（均已修）：
  1) 旧版顶部 `import win_diag` 是硬依赖，只拷了 `probe_wxauto.py` 就 `ModuleNotFoundError`，一行都不写；
  2) 旧版只尝试 `wxauto4` / `wxauto`，**没有 `wxautox4`（Plus）**，装了商业版也判为"无包"；
  3) `--out` 默认是相对 cwd 的文件名，报告可能落在别的目录。
- v3 起：`win_diag` 变可选；包按 `wxauto4 → wxautox4 → wxauto` 依次尝试；报告在 `finally` 里必写并打印**绝对路径**；新增 `--selftest`（不碰微信，只验证写文件链路）。
- 同时收紧 `@` 探测：把 `attr`（消息来源 system/self/friend）从候选里剔除，并要求 `atListCandidates` 里的值真像列表——否则旧逻辑会把 `attr` 当成 @ 列表，**直接骗过 Q1**。
- 另据使用者反馈：**商业版授权后微信消息收发成功**。这说明客户端与 Plus 库在该机器上可用，但"产品能收消息"不等于"我们能拿到结构化 @ 列表"，Q1 仍需 `atListCandidates` 证据。

### 2026-11-07 群消息图片（Q4）：能力已确认存在，落地前先量三项指标

- 依据 v4.0 文档：消息类表里 `✨图片消息 ImageMessage` 带 ✨（Plus 构建专属），该类提供
  `download(dir_path, original)` 与 `ocr(timeout)`；群里的图片就是 `type='image'` 的普通消息，`sender` 为群成员，
  `chat_info()` 返回 `chat_type='group'`。因此「识别 → 下载 → OCR」链路成立，但**需要商业版**。
- 三个必须先量的约束：① 免费构建可能只给 `type='image'` 而无 `download()`；
  ② `GetAllMessage()` 只覆盖当前窗口已渲染的消息，更早的图要先 `roll_into_view()`，所以轮询间隔过大时图片可能已滚出视野；
  ③ 下载会占用客户端 UI，必须与切会话/发消息串行，用户同时操作时会变慢。
- 探针新增 `--media`：报告 `media.imageCount / hasDownload / download.bytes / download.ms / ocr`，
  在无 `download()` 的构建上明确输出 `image messages need the Plus build`，不会假绿。
- 落地设计（待数据确认参数后实施）：`ChatEvent.media` + sidecar `GET /media/<nativeId>`（下载缓存 + TTL）
  + `weixinKind.threadContext.image()` 取图作为模型附件（复用 `feishu-image.ts` 的既有模式）；出站发图暂不做。

### 2026-11-07 Q1 定论：L0（pc-uia）**没有**结构化 `@`，按 §4.1 不准入

**环境**：Windows 11（session 1，console，Active）/ Python 3.12.10 / `wxautox4` 41.2.3 /
微信 4.x（`C:\Program Files\Tencent\Weixin\Weixin.exe`，`Qt51514QWindowIcon`）/ 已登录账号 `<wxid>`。
探针：`poc/win_diag.py` → `a WeChat window is visible in this session`；
`poc/probe_wxauto.py --group "<群名>" --media` → `poc/probe-report.json`。

**结论：`atListCandidates` 为空 → 后端按 §4.1 应切 L2（pad）；群 `@` 不得文本反解。**

三条独立证据（任一条都足以否掉 L0 的结构化 `@`）：

1. **UI 树是扁平叶子。** 消息控件 `mmui::ChatTextItemView`（`AutomationId`
   `chat_message_list.qt_scrollarea_viewport.chat_bubble_item_view`）的 `childCount == 0`，
   `TextPattern` / `ValuePattern` / `LegacyIAccessiblePattern` / `SelectionPattern` **全部不存在**。
   `@昵称` 与正文是同一个 `Name` 字符串，客户端没有把 mention 渲染成独立元素。
2. **消息对象没有 at 列表。** `FriendTextMessage` 的全部字段是
   `id / content / hash_text / hash / sender / chat_info / type / attr`（`attr` 是 `friend|self|system` 来源标记）。
3. **`FriendMessage.at` 是动作不是字段。** 它是 bound method，执行即「拍一拍」，返回
   `WxResponse{"status":"成功"}`。把它当取值方法会**每轮询一次就拍群成员一次**——真实副作用。

> 唯一带 `@` 的结构线索是正文里的 `U+2005`（四分宽空格）分隔符，例如 `@<成员>\u2005妈`。
> 它是**文本**特征，可被复制粘贴伪造，因此只作为证据记录在报告的 `textSeparator`
> （`textDerived: true, usable: false`），**不构成判定依据**（§2.3 硬规则 4）。

**顺带查清的另外四个 L0 缺口**（同样进契约，避免以后被误判为 bug）：

| 契约字段 | L0 实际情况 | 后果 |
|---|---|---|
| `room`（chatroomId） | 拿不到。`ChatInfo()` 只有 `chat_type/chat_name/group_member_count`；`SessionElement` 只有 `name/time/content/isnew/new_count/ismute` | `rooms[].id` 只能用显示名，而 Node schema 的 `^[A-Za-z0-9_-]+$` 会拒绝中文群名 → **配置层根本表达不了** |
| `sender.id` | 只有显示名。`sender_info()` 的 `id` 是微信号（如 `<微信号>`）不是 `wxid_`，且**观测到滞后一条消息、有时返回 `null`** | Policy 的 wxid 名单在 L0 上不可执行 |
| `at`（消息时间） | 普通消息无时间字段，只有 `TimeMessage` 分隔符带 `time` | 只能用服务端接收时间 |
| `/members` | 无群成员 API（`_api` 只有 `add_group_members`） | 成员表退化为空 |

**因此 L0 的准入门槛没有通过，而且不只是 `@` 一项**：即使只做单聊，身份与时序也达不到契约。
Node 侧严格的 `WXID_PATTERN` 在这里不是缺陷而是**准入闸门**——它挡住了不达标的部署。

**下一步（二选一，都要外部条件）**

- **L2（pad）**：唯一能同时给出 chatroomId、wxid、结构化 `ats`、真实时间的路径。需要业务方提供
  WeChatPadPro 一类的 iPad 协议服务（§6 前置 1 的另一面）。sidecar 的 `--backend pad` 已留桩：
  `available:false` + 数据端点 `501`，切换只需改配置 + 重启，不动 Node 代码。
- **L1（DB 读取器）**：本机已确认消息库位置与加密形态，是**不注入进程也能拿到全部结构化字段**的
  唯一路线。证据与做法见下。

#### L1 可行性证据（已确认，未实施）

```
C:\Users\Administrator\Documents\xwechat_files\<account>_<hash>\db_storage\
  message\message_0.db   11,882,496 B   ← 群/单聊消息
  contact\contact.db     23,150,592 B   ← 联系人、群成员
  ...
```

`message_0.db` 前 64 字节是随机字节（`79 4b ad 98 12 22 ba 23 …`），**不是** `SQLite format 3`
→ 确认 SQLCipher 加密（微信 4.x 用 SQLCipher v4：4096 字节页、AES-256-CBC、页尾 HMAC-SHA512）。
文件在客户端运行时被独占打开，读取需 `FileShare.ReadWrite`。

一旦拿到密钥，协议层自带的结构化字段即可直接映射契约：会话 `username`（= chatroomId）、
发送者 `sender`（= wxid）、`create_time`（= 真实时间）、以及消息 proto 里的 at 列表
（= `ats`）。**这一条同时解决 Q1 与 Q2**，也是唯一不违反「禁止文本反解」的 L0 替代方案。
密钥需要从 `Weixin.exe` 进程内存取出（本机是管理员会话，具备条件），属于 L1 的
「注入/内存读取」风险档，需业务方书面接受后才能做。

### 2026-11-07 群消息图片：已落地（commit cfa971e）

链路（每一段都有测试）：sidecar `/messages` 只为**能下载**的构建列 `media:[{id:'<nativeId>#0',kind:'image'}]`
→ `bridge.toChatEvent` 映射进 `ChatEvent.media` → `weixin-watch` 把 id 放进 `Trigger.meta.media`
→ `weixinThreadContext.read()` 在图片消息正文尾追加不可见 `[image:<id>]` → `images(text)` 用同一正则提取
→ `image()` 走 `GET /media/<id>` → 魔数判定 → `attachments.saveImage` → 模型可见。

不可让步的约定：只按魔数（PNG/JPEG/WebP/GIF）判定，**不信**远端 Content-Type；超 `imageLimits.maxImageBytes`
或格式不接受时**在 saveImage 之前**抛错（不落盘、不进上下文）；`/media` 与 `/send` 共用 UI 串行锁；
无下载能力的构建 `/media` 返回 **501**，定位失败 **404**，绝不返回空字节。

遗留 Minor（评审 t54，均低危，记录在案）：
- IMG-1 仅按单图 `maxImageBytes`，未叠加 `maxMessageImageBytes`/每消息图片数上限
- IMG-2 bridge 先整块 `arrayBuffer` 再查限，未做流式上限
- IMG-3 sidecar `/media` 成功分支未显式拒零字节
- IMG-4 `imageIds()` 从正文解析，用户可自造 `[image:x]` 触发一次请求（sidecar 404 兜底；建议后续只接受 `meta.media` 里的 id）
