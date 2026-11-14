# 微信接入方案调研（2026-11-14）

> 语言：[中文](wechat-transport-research.zh-CN.md) · [English](wechat-transport-research.en-US.md)

> 目标：让普通用户**免费**用上微信通道，不依赖 `wxautox4` 付费授权，并解决**只能跑 Windows**的问题，最终让 DSH 插件在 macOS / Linux / Windows 上都能用。
>
> 本文只做调研与方案分析，不改代码。所有外部项目均为公开仓库；星数与状态取自 2026-11-14。

---

## 0. 结论先行

1. **没有“一个方案同时满足 免费 + 跨 OS + 个人微信群/@ + 稳定”**。微信个人号没有官方开放的消息 API，所有方案都是在四个维度上做取舍：**账号身份、操作系统、费用、平台能力**。
2. 当前项目的微信方案是 **Windows 客户端自动化**：`wxautox4 + UIAutomation`（`sidecar/wxauto-bridge` 的 `pc-uia` 后端）。它能力最全（真实账号、群、@、文件），但**必须 Windows + 已登录桌面微信 + wxautox4 授权**，这是“普通人免费用 + 跨 OS”的两个硬约束。
3. 2026 年生态出现了一个**新的官方通道**：腾讯开源的 **`@tencent-weixin/openclaw-weixin`（iLink Bot，MIT）**。它**免费、跨 OS（纯 Node）、扫码即用、不需要桌面微信**，DSH 社区已有 4 个以上插件基于它实现。但它以**单聊/个人助手**为主，**群聊与多成员 @ 不保证**，还有**24 小时互动窗口、连续 10 条需用户先说话**等平台限制。
4. **最现实的路线是“双后端 + 可选远程网关”**：
   - **iLink 后端**：默认给普通用户，免费、跨 OS、免装微信客户端，做个人助理/远程控制；
   - **免费 Windows 后端**：把 `wxautox4` 换成 **`wechatauto-replica`（Apache-2.0）**，保留群/@ 能力，零授权费，但仍需 Windows 与登录客户端；
   - **远程网关**：DSH 跑在 macOS/Linux，Windows/安卓设备作为“微信网关”通过 HTTP 接入，实现事实上的跨 OS；复用现有冻结契约。
5. **不要基于 Gewechat**：3503 星但项目已停止维护、服务端未开源、只留 Java 调用示例，社区明确不可用；协议类方案（iPad/Android 破解）普遍收费或已死，风险与维护成本最高。

---

## 1. 第一性原理：微信消息到底能从哪来？

微信个人号（不是企业微信/公众号）没有对外开放“收发消息”的官方 API。任何“微信机器人”只能从以下五层之一拿消息：

| 层 | 消息从哪来 | 账号身份 | OS 依赖 | 费用 | 典型能力 | 典型风险 |
| --- | --- | --- | --- | --- | --- | --- |
| **A. 官方 Bot 通道** | 腾讯 iLink / ClawBot 云端长轮询 | 扫码绑定你本人微信的 Bot | 无（纯 HTTP/WS） | 免费 | 单聊、文本/图片/语音/文件、typing | 平台限制（24h、10 条）、群聊不保证 |
| **B. 客户端 UI 自动化** | 驱动已登录的桌面微信窗口（UIA/OCR/剪贴板） | 你本人的真实微信 | **Windows**（macOS/Linux 无成熟方案） | 开源免费 / 商业授权 | 群、@、文件、朋友圈 | 微信升级、窗口焦点、封号、需常开桌面 |
| **C. 客户端数据库读取** | 解密本地 SQLCipher 数据库（只读） + UI 发送 | 你本人的真实微信 | **Windows** | 开源免费 | 全量历史、群成员、图片/语音、发送 | 仍需 Windows 客户端；发送靠 UI |
| **D. 进程 Hook/注入** | 注入 DLL，截获收发回调 | 你本人的真实微信 | **Windows** | 免费（MIT） | 群、@、富媒体、最全 | 版本锁死、反作弊/封号、维护成本高 |
| **E. 协议模拟/网关** | 模拟 iPad/Android/Mac 协议，或云手机/真机 | 你本人的真实微信 | 服务端任意，客户端需设备/协议服务 | 免费或付费 | 群、@、多端 | 项目多已停更/收费、封号风险最高 |
| **F. 官方企业接口** | 企业微信/公众号/客服消息 | 企业主体 | 无 | 免费/按量 | 企业通讯录、客户群 | 不是个人微信，用户要迁移 |

> 关键判断：**“免费 + 跨 OS”只能走 A（iLink）或 E（协议/云手机）；“个人微信群 + 多成员 @”只能走 B/C/D（Windows）或 E（设备）**。这不是实现问题，是微信的产品边界。

---

## 2. 你给的 6 个项目 + 我补充的项目

### 2.1 逐个结论

| 项目 | 路线 | OS | 费用/许可 | 群/@ | 备注 |
| --- | --- | --- | --- | --- | --- |
| [fanyuantaier/wechatauto-replica](https://github.com/fanyuantaier/wechatauto-replica)（671★） | C+B：解密 SQLCipher 数据库读 + UIA/OCR 发 | **Windows 10/11** | **Apache-2.0 免费** | 群、`SendMsg(at=...)`、群成员、历史、图片/语音/文件、朋友圈 | 目前最成熟的 **wxauto 免费替代**；支持微信 4.1.12+；不做 DLL 注入（仅 1 字节无障碍开关） |
| [thawline/dsh-wechat-bridge](https://github.com/thawline/dsh-wechat-bridge)（19★） | C+B，底层就是 `wechatauto-replica` + UIA | **Windows** | MIT 免费 | 群（@ 靠昵称匹配）、文件、图片 | 证明“免费 Windows 路线”可落地；带 Python 运行时打包；发图以数据库回读为准 |
| [pan17/wechat-bridge-opencode](https://github.com/pan17/wechat-bridge-opencode)（17★） | A：iLink Bot | **跨 OS** | MIT 免费 | **仅私聊**（README 明确群聊忽略） | OpenCode 桥；证明 iLink 的 DM 能力与限流（10 条/轮） |
| [pan17/dsh-wechat](https://github.com/pan17/dsh-wechat)（57★） | A：iLink Bot | **跨 OS** | MIT 免费 | 仅私聊 | DSH 原生体验（slash 命令、会话/模型切换）；README 写明 10 条、24h、语音不投递 |
| [panqing0313/dsh-plugin-weixin](https://github.com/panqing0313/dsh-plugin-weixin)（20★） | A：iLink（vendor 官方 `openclaw-weixin`） | **跨 OS** | NOASSERTION（仓库声明 MIT；vendor MIT） | 群聊“有限支持”：需群主拉机器人，收不到群成员名册/@ 列表 | 功能最全的 DSH 微信插件之一：多账号、语音 ASR、媒体、白名单、审计；群聊能力受 iLink 限制 |
| [gtaifu/dsh-wechat-bridge](https://github.com/gtaifu/dsh-wechat-bridge)（16★） | A：iLink 纯 Node 实现 | **Windows/macOS/Linux** | MIT 免费 | 仅 direct（README 声明群消息不保证） | 零依赖；协议逐项对照官方 SDK；适合做 iLink 后端参考 |
| [xcisxc29/dsh-wechat](https://github.com/xcisxc29/dsh-wechat)（**434★**，我补充） | A：iLink | **跨 OS** | MIT 免费 | 私聊 | 目前最成熟的 DSH 微信插件：权限审批、主动推送、文件双向、多会话；明确“只绑定你本人账号，别人加不了机器人” |
| [SoledadAki/dsh-im-qq-wechat](https://github.com/SoledadAki/dsh-im-qq-wechat)（98★） | A 等：微信扫码（iLink 路线） | 跨 OS | MIT | 私聊为主 | 多平台（QQ/微信/企微/飞书/Telegram）聚合；微信为扫码授权 |
| [zhuiyueya/dsh-im-gateway](https://github.com/zhuiyueya/dsh-im-gateway)（59★） | A：微信走 iLink | 跨 OS | MIT | 私聊 | 25+ 渠道聚合网关；微信“完整*”标注 iLink，媒体/语音转文字 |
| [openilink/openilink-hub](https://github.com/openilink/openilink-hub)（1613★） | A：iLink Bot 管理平台 | 自托管（Go） | MIT | 取决于 App | 7 语言 SDK、20+ App；适合做企业级网关参考 |
| [epiral/weixin-bot](https://github.com/epiral/weixin-bot)（488★） | A：iLink SDK（Node/Python） | 跨 OS | 无 license 字段（需确认） | 私聊 | 轻量 SDK，可做 iLink 后端底座 |
| [corespeed-io/wechatbot](https://github.com/corespeed-io/wechatbot)（701★） | A：iLink SDK | 跨 OS | MIT | 私聊 | 腾讯 iLink Bot SDK for OpenClaw/AI Agent |
| [photon-hq/wechat-ilink-client](https://github.com/photon-hq/wechat-ilink-client)（84★） | A：独立 TS 客户端（逆向官方 SDK） | 跨 OS | 未标 | 私聊 | 可参考协议细节，但“逆向”意味着协议漂移风险 |
| [lich0821/WeChatFerry](https://github.com/lich0821/WeChatFerry)（6806★） | D：Windows Hook | **Windows** | MIT 免费 | 群、@、富媒体 | 能力强但版本锁死、封号/维护风险最高 |
| [scottfly189/WeChatAuto.SDK](https://github.com/scottfly189/WeChatAuto.SDK)（311★） | B：Windows RPA | **Windows** | MIT | 群、@ | C# SDK，可做 Windows 网关 |
| [Devo919/Gewechat](https://github.com/Devo919/Gewechat)（3503★） | E：协议/REST | 任意（需服务端） | Apache-2.0（仅示例代码） | 曾经有群 | **已停止维护**，服务端未开源；不要作为新项目依赖 |
| [cluic/wxauto](https://github.com/cluic/wxauto)（7454★） | B：UIA | **Windows** | Apache-2.0 | 群/@（旧版） | 4.x 自绘 UI 导致 UIA 树不可用；`wechatauto-replica` 是它的 4.x 替代 |

### 2.2 官方 iLink 的关键事实（`@tencent-weixin/openclaw-weixin`）

- 仓库：[Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin)，1025★，MIT；npm `@tencent-weixin/openclaw-weixin` **2.4.10**。
- 协议：`https://ilinkai.weixin.qq.com/ilink/bot/*`；`get_bot_qrcode`/`get_qrcode_status` 扫码 → `getupdates` 35s 长轮询 → `sendmessage`（必须回传 `context_token`）→ `sendtyping`。
- 媒体：`getuploadurl` + CDN 上传/下载，`AES-128-ECB`；支持 image/video/file/voice（voice 有服务端转写文本）。
- 限制（来自官方文档与社区插件实测）：
  - 扫码绑定的是**你本人微信的一个 Bot**，不是通讯录好友，别人无法搜索/添加；
  - **单聊为主**：官方协议类型里有 `group_id`，但文档明确“字段存在不代表插件功能支持”；社区插件多声明“仅私聊/群消息不保证”；[panqing0313](https://github.com/panqing0313/dsh-plugin-weixin) 说只有被群主拉进去且权限允许才可能收群消息，且没有群成员名册、没有结构化 @ 列表。
  - 连续 10 条后需用户先发一条（`/next` 缓存）；24 小时互动窗口；出站语音服务端接受但不投递；原生表情包不可用。
  - `errcode -14` → token 失效，需重新扫码（社区实测约 24h~30h，官方无承诺）。
- **优点**：免费、官方通道、跨 OS、纯 Node/Python、扫码即用、无需桌面微信、无 Windows 依赖。**这是普通用户“免费 + 跨 OS”的现实答案。**

---

## 3. 与当前 `dsh-superagent-multi-channel` 的微信方案对比

当前实现：

- DSH 侧：`src/sources/chat/weixin/*`（`kind.ts` + `pc-uia` 适配器）→ 本机 `sidecar/wxauto-bridge`（Python）→ **`wxautox4` + UIAutomation**，监听模式 `AddListenChat + StartListening`（[server.py](../../sidecar/wxauto-bridge/server.py)）。
- 契约：8 个 loopback HTTP 端点（`/health`、`/status`、`/rooms`、`/members`、`/messages`、`/send`、`/media`、`/listen`），见 [contract.md](../../sidecar/wxauto-bridge/contract.md)。
- 能力：`pc-uia` 上报 `mentions: markup`（读客户端@分隔符，非结构化）、`members: observed`（只能看到发过言的人）、`media: 取决于该构建是否有 download()`。
- 依赖：`wxautox4` PyPI 包明确带 **授权系统**（`--auth` 授权码/授权文件），且仅 Windows x64、微信 4.0.5 目标（[PyPI](https://pypi.org/project/wxautox4/)）。

逐项对比：

| 维度 | 当前 wxautox4 + UIA | iLink（官方 Bot） | wechatauto-replica | WeChatFerry（可选） |
| --- | --- | --- | --- | --- |
| 费用 | **需 wxautox4 授权** | **免费** | **Apache-2.0 免费** | 免费（MIT） |
| OS | **仅 Windows** | **任意 OS** | **仅 Windows** | **仅 Windows** |
| 需要桌面微信 | **是（已登录）** | **否** | **是（已登录）** | **是（已登录）** |
| 群聊 | ✅ | ⚠️ 有限/不保证 | ✅（`GetGroupMembers`、`SendMsg(at=)`） | ✅ |
| 结构化 @ | ⚠️ `markup` | ⚠️ 无 @ 列表（群） | ⚠️ 需 PoC（DB/标记） | ✅ 通常最全 |
| 历史 | 取决于构建 | ❌ 仅实时 | ✅ 全量 DB 历史 | ✅ |
| 媒体 | 取决于构建 `download()` | ✅ 图片/文件/语音/视频 | ✅ 图片/语音/文件 | ✅ |
| 稳定性 | 中（UI/版本） | 中（限流/24h） | 中（DB 解密/UI 发送） | 低（版本锁/封号） |
| 维护成本 | 中 | 低 | 中 | 高 |
| 封号风险 | 中 | 低（官方通道） | 中 | 高 |

> 结论：**wxautox4 是唯一“必须付费 + 只能 Windows”的环节**；`wechatauto-replica` 是目前最合适的免费 Windows 替代；`iLink` 是唯一免费跨 OS 的选项，但牺牲群/@。

---

## 4. 目标形态建议：三后端 + 一个网关

### 4.1 后端分型

| 后端 | 定位 | OS | 费用 | 依赖 | 群/@ |
| --- | --- | --- | --- | --- | --- |
| **`ilink`**（新增） | 普通用户默认：个人助理/远程控制 | 任意 | 免费 | 无（Node 内实现或 vendor 官方 SDK） | 私聊为主；群有限 |
| **`pc-db`**（新增，替换 `pc-uia` 的收费库） | 团队/群助手：保留群/@/媒体 | Windows | 免费（Apache-2.0） | Windows 微信 + Python | 群 ✅，@ 需 PoC |
| **`pc-hook`**（可选） | 高级：最强群/@/媒体 | Windows | 免费 | WeChatFerry + 特定微信版本 | ✅ |
| **`gateway`**（新增传输） | 远程网关：DSH 在 mac/Linux，微信端在 Windows/安卓/云手机 | 任意 DSH | 取决于网关 | 复用现有 8 端点契约 | 取决于网关后端 |

### 4.2 复用现有抽象

当前 DSH 侧已经有 `WeixinBackend`/`BridgeClient` 抽象和冻结契约，**不需要重写业务层**。建议：

1. 把 sidecar 的 `Backend` 从 `fake / pc-uia / pad` 扩展到 `fake / pc-uia(legacy) / pc-db(free) / ilink / gateway`。
2. `ilink` 后端实现同一份 8 端点：
   - `/rooms`：iLink 只有单聊会话（可按联系人列出），没有群名册时返回空或单聊集合；
   - `/messages`：把 `getupdates` 的长轮询 + 游标持久化映射为事件；
   - `/send`：`sendmessage` 回传 `context_token`；`/media`：CDN 下载解密；
   - `/members`：私聊返回对方；群聊若平台不提供则 `501 unsupported`（契约已有此语义）。
3. `pc-db` 后端用 `wechatauto-replica`：
   - `WeChatDB` 解密读 `message_*.db`（历史/群成员/媒体）；
   - `Listener`/`GetNewMessage` 映射 `/messages`；
   - `WeChat().SendMsg(at=...)`/`SendFiles` 映射 `/send`；
   - `/health.capabilities` 如实上报 `mentions: markup|none`、`members: full`（它有 `get_group_members`）、`media: true`；
   - 这是**改动集中在 sidecar，DSH 侧零改动**的路径。
4. `gateway` 传输：
   - 允许 `bridgeUrl` 为 `http(s)://host:port`，不再限制 loopback；加 `bridgeToken`、TLS/反向代理（Tailscale/WireGuard）；
   - 远端可以是一台 Windows 小主机/VM、安卓云手机网关，或 iLink 常驻服务；
   - DSH 在 macOS/Linux 只连 `bridgeUrl`，实现“跨 OS”。

### 4.3 产品分层

- **普通用户（免费/零安装）**：iLink，扫码就用；明确“个人助手，不是群机器人”。
- **团队群助手（免费/Windows）**：`pc-db`（wechatauto-replica）；提供一键安装包（内置 Python 运行时，像 thawline 那样）。
- **macOS/Linux 团队**：Windows 网关（小主机/VM）+ `gateway`；或安卓云手机（后续评估）。
- **高级/极致能力**：`pc-hook`（WeChatFerry）作为可选，不默认。

---

## 5. 需要先验证的 PoC（建议 1–2 周）

### P0：iLink 能力边界（决定能否作为默认后端）

1. 用 `@tencent-weixin/openclaw-weixin`（MIT）或 `epiral/weixin-bot` 实现最小客户端：扫码、`getupdates`、`sendmessage`、媒体。
2. 实测并记录：
   - 私聊：文本/图片/文件/语音入站、出站媒体；
   - 群：机器人能否被拉群、能否收群消息、`group_id` 是否出现、能否 @ 人（预计不能）；
   - 限制：连续 10 条、24h 窗口、`-14` 续期、出站语音。
3. 输出：iLink 能力矩阵（DM/群/媒体/@/历史/限流）与失败场景。

### P1：wechatauto-replica 替换 wxautox4

1. 在 Windows 测试机安装微信 4.x + `wechatauto-replica`；
2. 实现 `pc-db` 后端并跑通：`/status`、`/rooms`、`/messages`、`/send`、`/members`、`/media`；
3. 对比当前 `pc-uia`：群 @ 判定、群成员全量、历史回填、图片/语音、发送成功率、节流；
4. 输出：功能对照表 + 性能/风险记录。

### P2：gateway 远程契约

1. 把 sidecar 的 `127.0.0.1` 扩展为可配置 `bridgeUrl` + token + TLS；
2. 用 Tailscale/ZeroTier 连接 Windows 网关与 macOS/Linux DSH；
3. 验证断线重连、token 轮换、媒体下载。

---

## 6. 风险与边界（必须先说清）

- **iLink**：官方通道但有平台条款（不得营销/高频群发）；24h + 10 条限制；群能力不确定；token 24h 级过期；Bot 绑定你本人账号，不能给“群里所有人”用。
- **UI 自动化/DB 读取**：微信升级会破坏；需要桌面登录、锁屏/焦点/DPI 问题；账号有被限制风险；不适合服务器无头运行。
- **Hook（WeChatFerry）**：版本锁死、封号风险最高；只建议测试号。
- **协议/云手机**：Gewechat 已停更；其他方案收费或封号风险；不建议作为默认。
- **合规**：个人微信自动化不是腾讯官方支持的开放能力（iLink 除外）；对外产品化时应提供“企业微信/公众号”作为合规替代，并在 UI 中明确能力边界（我们已在能力矩阵里坚持“不伪装”）。

---

## 7. 参考链接

- 官方 iLink SDK：[Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin)（MIT，npm 2.4.10）
- 官方协议：[docs/protocol.md](https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol.md)
- 免费 Windows 底座：[fanyuantaier/wechatauto-replica](https://github.com/fanyuantaier/wechatauto-replica)（Apache-2.0）
- 免费 Windows DSH 参考：[thawline/dsh-wechat-bridge](https://github.com/thawline/dsh-wechat-bridge)
- iLink DSH 插件：[xcisxc29/dsh-wechat](https://github.com/xcisxc29/dsh-wechat)（434★）、[pan17/dsh-wechat](https://github.com/pan17/dsh-wechat)、[panqing0313/dsh-plugin-weixin](https://github.com/panqing0313/dsh-plugin-weixin)、[gtaifu/dsh-wechat-bridge](https://github.com/gtaifu/dsh-wechat-bridge)
- 聚合网关：[zhuiyueya/dsh-im-gateway](https://github.com/zhuiyueya/dsh-im-gateway)、[SoledadAki/dsh-im-qq-wechat](https://github.com/SoledadAki/dsh-im-qq-wechat)
- iLink 基础设施：[openilink/openilink-hub](https://github.com/openilink/openilink-hub)、[epiral/weixin-bot](https://github.com/epiral/weixin-bot)、[corespeed-io/wechatbot](https://github.com/corespeed-io/wechatbot)
- Windows Hook：[lich0821/WeChatFerry](https://github.com/lich0821/WeChatFerry)（MIT）
- 已停更、勿用：[Devo919/Gewechat](https://github.com/Devo919/Gewechat)
- `wxautox4` 授权系统：[PyPI](https://pypi.org/project/wxautox4/)
- 免费 UIA 原版：[cluic/wxauto](https://github.com/cluic/wxauto)（Apache-2.0，4.x UIA 已失效）

---

## 8. 待你拍板的三个问题

1. **产品主场景**：普通用户“个人微信助手”（可以接受只用 iLink、无群） vs 团队“微信群 @ 机器人”（必须保留 Windows/设备后端）？两者都要，就按“双后端”做。
2. **是否接受 Windows 仍是群能力的必要条件**：如果接受，免费路径就是 `wechatauto-replica`；如果不接受，群能力只能走“远程 Windows 网关/云手机”，成本是硬件/运维。
3. **优先顺序**：先做 iLink（最快让普通人免费用、跨 OS）还是先替换 `wxautox4`（保住群能力、先去掉授权费）？我建议 **先 iLink PoC + 并行 wechatauto-replica 替换**，两条腿走。
