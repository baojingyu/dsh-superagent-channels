# WeChat Integration Options Research (2026-11-14)

> Language: [English](wechat-transport-research.en-US.md) · [中文](wechat-transport-research.zh-CN.md)

> Goal: Let ordinary users use the WeChat channel **for free**, without depending on the paid `wxautox4` license, and solve the problem of **only being able to run on Windows**, so that the DSH plugin ultimately works on macOS / Linux / Windows.
>
> This document is research and option analysis only, with no code changes. All external projects are public repositories; star counts and status are as of 2026-11-14.

---

## 0. Conclusions Up Front

1. **There is no "single solution that simultaneously satisfies free + cross-OS + personal WeChat group/@ + stable"**. WeChat personal accounts have no official open messaging API; all solutions make trade-offs across four dimensions: **account identity, operating system, cost, platform capability**.
2. The current project's WeChat solution is **Windows client automation**: `wxautox4 + UIAutomation` (the `pc-uia` backend of `sidecar/wxauto-bridge`). It has the most complete capabilities (real account, groups, @, files), but **requires Windows + a logged-in desktop WeChat + a wxautox4 license**, and these are the two hard constraints of "ordinary users free + cross-OS".
3. In 2026 the ecosystem saw a **new official channel**: Tencent's open-source **`@tencent-weixin/openclaw-weixin` (iLink Bot, MIT)**. It is **free, cross-OS (pure Node), usable by scanning a QR code, and requires no desktop WeChat**; more than 4 DSH community plugins are already built on it. But it is mainly for **direct chat / personal assistant**, **group chat and multi-member @ are not guaranteed**, and there are platform limits such as a **24-hour interaction window and requiring the user to speak first after 10 consecutive messages**.
4. **The most realistic route is "dual backend + optional remote gateway"**:
   - **iLink backend**: default for ordinary users, free, cross-OS, no need to install the WeChat client, for personal assistant/remote control;
   - **Free Windows backend**: replace `wxautox4` with **`wechatauto-replica` (Apache-2.0)**, retaining group/@ capabilities with zero license fee, but still requiring Windows and a logged-in client;
   - **Remote gateway**: DSH runs on macOS/Linux, and a Windows/Android device acts as a "WeChat gateway" accessed via HTTP, achieving de facto cross-OS; reuses the existing frozen contract.
5. **Do not build on Gewechat**: 3503 stars but the project is no longer maintained, the server side is not open source, only Java call examples remain, and the community explicitly deems it unusable; protocol-based solutions (iPad/Android cracking) are generally paid or already dead, with the highest risk and maintenance cost.

---

## 1. First Principles: Where Can WeChat Messages Actually Come From?

WeChat personal accounts (not WeCom/Official Accounts) have no official API open to the outside for "sending and receiving messages". Any "WeChat robot" can only get messages from one of the following five layers:

| Layer | Where messages come from | Account identity | OS dependency | Cost | Typical capabilities | Typical risks |
| --- | --- | --- | --- | --- | --- | --- |
| **A. Official Bot channel** | Tencent iLink / ClawBot cloud long polling | A Bot bound to your own WeChat via QR scan | None (pure HTTP/WS) | Free | Direct chat, text/image/voice/file, typing | Platform limits (24h, 10 messages), groups not guaranteed |
| **B. Client UI automation** | Drive the logged-in desktop WeChat window (UIA/OCR/clipboard) | Your own real WeChat | **Windows** (no mature solution on macOS/Linux) | Open-source free / commercial license | Groups, @, files, Moments | WeChat upgrades, window focus, account ban, requires desktop always on |
| **C. Client database reading** | Decrypt local SQLCipher database (read-only) + UI sending | Your own real WeChat | **Windows** | Open-source free | Full history, group members, images/voice, sending | Still requires Windows client; sending relies on UI |
| **D. Process Hook/injection** | Inject a DLL, intercept send/receive callbacks | Your own real WeChat | **Windows** | Free (MIT) | Groups, @, rich media, most complete | Version lock, anti-cheat/account ban, high maintenance cost |
| **E. Protocol emulation/gateway** | Emulate iPad/Android/Mac protocol, or cloud phone/real device | Your own real WeChat | Server side any, client needs device/protocol service | Free or paid | Groups, @, multi-device | Most projects discontinued/paid, highest ban risk |
| **F. Official enterprise interface** | WeCom/Official Account/customer service messages | Enterprise entity | None | Free/pay-per-use | Enterprise contacts, customer groups | Not personal WeChat, users must migrate |

> Key judgment: **"free + cross-OS" can only go through A (iLink) or E (protocol/cloud phone); "personal WeChat group + multi-member @" can only go through B/C/D (Windows) or E (device)**. This is not an implementation problem; it is the product boundary of WeChat.

---

## 2. The 6 Projects You Gave + Projects I Added

### 2.1 Individual conclusions

| Project | Route | OS | Cost/License | Group/@ | Notes |
| --- | --- | --- | --- | --- | --- |
| [fanyuantaier/wechatauto-replica](https://github.com/fanyuantaier/wechatauto-replica)（671★） | C+B: decrypt SQLCipher DB read + UIA/OCR send | **Windows 10/11** | **Apache-2.0 free** | Groups, `SendMsg(at=...)`, group members, history, image/voice/file, Moments | Currently the most mature **free wxauto replacement**; supports WeChat 4.1.12+; no DLL injection (only a 1-byte accessibility switch) |
| [thawline/dsh-wechat-bridge](https://github.com/thawline/dsh-wechat-bridge)（19★） | C+B, the underlying layer is `wechatauto-replica` + UIA | **Windows** | MIT free | Groups (@ relies on nickname matching), files, images | Proves the "free Windows route" is feasible; ships with a bundled Python runtime; sending images is based on DB read-back |
| [pan17/wechat-bridge-opencode](https://github.com/pan17/wechat-bridge-opencode)（17★） | A: iLink Bot | **Cross-OS** | MIT free | **Direct chat only** (README explicitly ignores groups) | OpenCode bridge; proves iLink's DM capability and rate limit (10 messages/round) |
| [pan17/dsh-wechat](https://github.com/pan17/dsh-wechat)（57★） | A: iLink Bot | **Cross-OS** | MIT free | Direct chat only | Native DSH experience (slash commands, session/model switching); README states 10 messages, 24h, voice not delivered |
| [panqing0313/dsh-plugin-weixin](https://github.com/panqing0313/dsh-plugin-weixin)（20★） | A: iLink (vendors the official `openclaw-weixin`) | **Cross-OS** | NOASSERTION (repo declares MIT; vendor MIT) | Group chat "limited support": requires the group owner to add the bot, cannot receive a group member roster/@ list | One of the most feature-complete DSH WeChat plugins: multi-account, voice ASR, media, whitelist, audit; group capabilities limited by iLink |
| [gtaifu/dsh-wechat-bridge](https://github.com/gtaifu/dsh-wechat-bridge)（16★） | A: iLink pure Node implementation | **Windows/macOS/Linux** | MIT free | Direct only (README states group messages not guaranteed) | Zero dependencies; protocol compared item by item against the official SDK; suitable as an iLink backend reference |
| [xcisxc29/dsh-wechat](https://github.com/xcisxc29/dsh-wechat)（**434★**, I added） | A: iLink | **Cross-OS** | MIT free | Direct chat | Currently the most mature DSH WeChat plugin: permission approval, proactive push, two-way files, multi-session; explicitly "only binds your own account, others cannot add the bot" |
| [SoledadAki/dsh-im-qq-wechat](https://github.com/SoledadAki/dsh-im-qq-wechat)（98★） | A etc.: WeChat QR scan (iLink route) | Cross-OS | MIT | Mainly direct chat | Multi-platform (QQ/WeChat/WeCom/Feishu/Telegram) aggregation; WeChat is QR authorization |
| [zhuiyueya/dsh-im-gateway](https://github.com/zhuiyueya/dsh-im-gateway)（59★） | A: WeChat via iLink | Cross-OS | MIT | Direct chat | 25+ channel aggregation gateway; WeChat marked "complete*" with iLink, media/voice-to-text |
| [openilink/openilink-hub](https://github.com/openilink/openilink-hub)（1613★） | A: iLink Bot management platform | Self-hosted (Go) | MIT | Depends on the App | 7-language SDK, 20+ Apps; suitable as an enterprise-grade gateway reference |
| [epiral/weixin-bot](https://github.com/epiral/weixin-bot)（488★） | A: iLink SDK (Node/Python) | Cross-OS | No license field (needs confirmation) | Direct chat | Lightweight SDK, can serve as the iLink backend foundation |
| [corespeed-io/wechatbot](https://github.com/corespeed-io/wechatbot)（701★） | A: iLink SDK | Cross-OS | MIT | Direct chat | Tencent iLink Bot SDK for OpenClaw/AI Agent |
| [photon-hq/wechat-ilink-client](https://github.com/photon-hq/wechat-ilink-client)（84★） | A: Independent TS client (reverse-engineered official SDK) | Cross-OS | Unmarked | Direct chat | Can reference protocol details, but "reverse-engineered" means protocol drift risk |
| [lich0821/WeChatFerry](https://github.com/lich0821/WeChatFerry)（6806★） | D: Windows Hook | **Windows** | MIT free | Groups, @, rich media | Powerful but version-locked, highest ban/maintenance risk |
| [scottfly189/WeChatAuto.SDK](https://github.com/scottfly189/WeChatAuto.SDK)（311★） | B: Windows RPA | **Windows** | MIT | Groups, @ | C# SDK, can serve as a Windows gateway |
| [Devo919/Gewechat](https://github.com/Devo919/Gewechat)（3503★） | E: protocol/REST | Any (needs a server) | Apache-2.0 (example code only) | Once had groups | **No longer maintained**, server not open source; do not depend on it for new projects |
| [cluic/wxauto](https://github.com/cluic/wxauto)（7454★） | B: UIA | **Windows** | Apache-2.0 | Groups/@ (old versions) | The 4.x self-drawn UI makes the UIA tree unusable; `wechatauto-replica` is its 4.x replacement |

### 2.2 Key facts about the official iLink (`@tencent-weixin/openclaw-weixin`)

- Repository: [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin), 1025★, MIT; npm `@tencent-weixin/openclaw-weixin` **2.4.10**.
- Protocol: `https://ilinkai.weixin.qq.com/ilink/bot/*`; `get_bot_qrcode`/`get_qrcode_status` QR scan → `getupdates` 35s long polling → `sendmessage` (must return `context_token`) → `sendtyping`.
- Media: `getuploadurl` + CDN upload/download, `AES-128-ECB`; supports image/video/file/voice (voice has server-side transcribed text).
- Limits (from official docs and community plugin real-world testing):
  - The QR scan binds **a Bot of your own WeChat**, not a contact friend; others cannot search for or add it;
  - **Mainly direct chat**: the official protocol types include `group_id`, but the docs explicitly state "the field's existence does not mean the plugin supports the feature"; community plugins mostly declare "direct chat only/group messages not guaranteed"; [panqing0313](https://github.com/panqing0313/dsh-plugin-weixin) says group messages can only possibly be received if the bot is pulled in by the group owner and permissions allow, and there is no group member roster and no structured @ list.
  - After 10 consecutive messages the user must send one first (`/next` cache); 24-hour interaction window; outbound voice is accepted by the server but not delivered; native sticker packs unavailable.
  - `errcode -14` → token invalid, requires re-scanning the QR code (community testing about 24h~30h, no official commitment).
- **Advantages**: free, official channel, cross-OS, pure Node/Python, usable by QR scan, no desktop WeChat needed, no Windows dependency. **This is the realistic answer for ordinary users' "free + cross-OS".**

---

## 3. Comparison with the Current `dsh-superagent-multi-channel` WeChat Solution

Current implementation:

- DSH side: `src/sources/chat/weixin/*` (`kind.ts` + `pc-uia` adapter) → local `sidecar/wxauto-bridge` (Python) → **`wxautox4` + UIAutomation**, listen mode `AddListenChat + StartListening` ([server.py](../../sidecar/wxauto-bridge/server.py)).
- Contract: 8 loopback HTTP endpoints (`/health`, `/status`, `/rooms`, `/members`, `/messages`, `/send`, `/media`, `/listen`), see [contract.md](../../sidecar/wxauto-bridge/contract.md).
- Capabilities: `pc-uia` reports `mentions: markup` (reads the client's @ delimiter, non-structured), `members: observed` (can only see people who have spoken), `media: depends on whether that build has download()`.
- Dependency: the `wxautox4` PyPI package explicitly ships with a **license system** (`--auth` authorization code/authorization file), and targets only Windows x64 and WeChat 4.0.5 ([PyPI](https://pypi.org/project/wxautox4/)).

Item-by-item comparison:

| Dimension | Current wxautox4 + UIA | iLink (official Bot) | wechatauto-replica | WeChatFerry (optional) |
| --- | --- | --- | --- | --- |
| Cost | **Requires a wxautox4 license** | **Free** | **Apache-2.0 free** | Free (MIT) |
| OS | **Windows only** | **Any OS** | **Windows only** | **Windows only** |
| Requires desktop WeChat | **Yes (logged in)** | **No** | **Yes (logged in)** | **Yes (logged in)** |
| Group chat | ✅ | ⚠️ Limited/not guaranteed | ✅ (`GetGroupMembers`, `SendMsg(at=)`) | ✅ |
| Structured @ | ⚠️ `markup` | ⚠️ No @ list (groups) | ⚠️ Needs PoC (DB/marker) | ✅ Usually most complete |
| History | Depends on build | ❌ Real-time only | ✅ Full DB history | ✅ |
| Media | Depends on build `download()` | ✅ Image/file/voice/video | ✅ Image/voice/file | ✅ |
| Stability | Medium (UI/version) | Medium (rate limit/24h) | Medium (DB decryption/UI sending) | Low (version lock/ban) |
| Maintenance cost | Medium | Low | Medium | High |
| Ban risk | Medium | Low (official channel) | Medium | High |

> Conclusion: **wxautox4 is the only link that "must be paid + can only be Windows"**; `wechatauto-replica` is currently the most suitable free Windows replacement; `iLink` is the only free cross-OS option, but it sacrifices groups/@.

---

## 4. Recommended Target Shape: Three Backends + One Gateway

### 4.1 Backend typology

| Backend | Positioning | OS | Cost | Dependency | Group/@ |
| --- | --- | --- | --- | --- | --- |
| **`ilink`** (new) | Default for ordinary users: personal assistant/remote control | Any | Free | None (implemented in Node or vendors the official SDK) | Mainly direct chat; groups limited |
| **`pc-db`** (new, replaces `pc-uia`'s paid library) | Team/group assistant: retain group/@/media | Windows | Free (Apache-2.0) | Windows WeChat + Python | Groups ✅, @ needs PoC |
| **`pc-hook`** (optional) | Advanced: strongest group/@/media | Windows | Free | WeChatFerry + specific WeChat version | ✅ |
| **`gateway`** (new transport) | Remote gateway: DSH on mac/Linux, WeChat side on Windows/Android/cloud phone | Any DSH | Depends on the gateway | Reuses the existing 8-endpoint contract | Depends on the gateway backend |

### 4.2 Reuse existing abstractions

The DSH side already has the `WeixinBackend`/`BridgeClient` abstraction and the frozen contract, **no need to rewrite the business layer**. Recommendations:

1. Extend the sidecar's `Backend` from `fake / pc-uia / pad` to `fake / pc-uia(legacy) / pc-db(free) / ilink / gateway`.
2. The `ilink` backend implements the same 8 endpoints:
   - `/rooms`: iLink has only direct-chat sessions (can be listed by contact); when there is no group roster, return empty or a direct-chat set;
   - `/messages`: map `getupdates` long polling + cursor persistence to events;
   - `/send`: `sendmessage` returns `context_token`; `/media`: CDN download and decrypt;
   - `/members`: return the other party for direct chat; if the platform does not provide it for group chat, return `501 unsupported` (the contract already has this semantics).
3. The `pc-db` backend uses `wechatauto-replica`:
   - `WeChatDB` decrypts and reads `message_*.db` (history/group members/media);
   - `Listener`/`GetNewMessage` maps `/messages`;
   - `WeChat().SendMsg(at=...)`/`SendFiles` maps `/send`;
   - `/health.capabilities` truthfully reports `mentions: markup|none`, `members: full` (it has `get_group_members`), `media: true`;
   - This is the path where **changes are concentrated in the sidecar, with zero changes on the DSH side**.
4. `gateway` transport:
   - Allow `bridgeUrl` to be `http(s)://host:port`, no longer restricted to loopback; add `bridgeToken`, TLS/reverse proxy (Tailscale/WireGuard);
   - The remote end can be a small Windows host/VM, an Android cloud-phone gateway, or a resident iLink service;
   - DSH on macOS/Linux only connects to `bridgeUrl`, achieving "cross-OS".

### 4.3 Product layering

- **Ordinary users (free/zero install)**: iLink, use it by scanning a QR code; clearly "a personal assistant, not a group bot".
- **Team group assistant (free/Windows)**: `pc-db` (wechatauto-replica); provide a one-click installer (bundled Python runtime, like thawline).
- **macOS/Linux teams**: Windows gateway (small host/VM) + `gateway`; or Android cloud phone (to be evaluated later).
- **Advanced/ultimate capabilities**: `pc-hook` (WeChatFerry) as an option, not default.

---

## 5. PoCs to Validate First (recommend 1–2 weeks)

### P0: iLink capability boundary (decides whether it can be the default backend)

1. Use `@tencent-weixin/openclaw-weixin` (MIT) or `epiral/weixin-bot` to implement a minimal client: QR scan, `getupdates`, `sendmessage`, media.
2. Real-world test and record:
   - Direct chat: text/image/file/voice inbound, outbound media;
   - Groups: whether the bot can be pulled into a group, whether it can receive group messages, whether `group_id` appears, whether it can @ people (expected: no);
   - Limits: 10 consecutive messages, 24h window, `-14` renewal, outbound voice.
3. Output: iLink capability matrix (DM/group/media/@/history/rate limit) and failure scenarios.

### P1: wechatauto-replica replaces wxautox4

1. Install WeChat 4.x + `wechatauto-replica` on a Windows test machine;
2. Implement the `pc-db` backend and get it working: `/status`, `/rooms`, `/messages`, `/send`, `/members`, `/media`;
3. Compare with the current `pc-uia`: group @ detection, full group members, history backfill, image/voice, send success rate, throttling;
4. Output: feature comparison table + performance/risk records.

### P2: gateway remote contract

1. Extend the sidecar's `127.0.0.1` to a configurable `bridgeUrl` + token + TLS;
2. Connect the Windows gateway and macOS/Linux DSH using Tailscale/ZeroTier;
3. Verify disconnect/reconnect, token rotation, media download.

---

## 6. Risks and Boundaries (must be stated clearly first)

- **iLink**: an official channel but with platform terms (no marketing/high-frequency mass sending); 24h + 10-message limits; group capability uncertain; token expires on a ~24h scale; the Bot binds your own account and cannot be used by "everyone in the group".
- **UI automation/DB reading**: WeChat upgrades will break it; requires desktop login, lock screen/focus/DPI issues; accounts risk being restricted; not suitable for headless server operation.
- **Hook (WeChatFerry)**: version-locked, highest ban risk; only recommended for test accounts.
- **Protocol/cloud phone**: Gewechat no longer maintained; other options are paid or carry ban risk; not recommended as default.
- **Compliance**: personal WeChat automation is not an officially supported open capability of Tencent (except iLink); when productizing externally, "WeCom/Official Account" should be provided as a compliant alternative, and the capability boundaries should be made clear in the UI (we already insist on "no disguising" in the capability matrix).

---

## 7. Reference Links

- Official iLink SDK: [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin) (MIT, npm 2.4.10)
- Official protocol: [docs/protocol.md](https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol.md)
- Free Windows foundation: [fanyuantaier/wechatauto-replica](https://github.com/fanyuantaier/wechatauto-replica) (Apache-2.0)
- Free Windows DSH reference: [thawline/dsh-wechat-bridge](https://github.com/thawline/dsh-wechat-bridge)
- iLink DSH plugins: [xcisxc29/dsh-wechat](https://github.com/xcisxc29/dsh-wechat) (434★), [pan17/dsh-wechat](https://github.com/pan17/dsh-wechat), [panqing0313/dsh-plugin-weixin](https://github.com/panqing0313/dsh-plugin-weixin), [gtaifu/dsh-wechat-bridge](https://github.com/gtaifu/dsh-wechat-bridge)
- Aggregation gateways: [zhuiyueya/dsh-im-gateway](https://github.com/zhuiyueya/dsh-im-gateway), [SoledadAki/dsh-im-qq-wechat](https://github.com/SoledadAki/dsh-im-qq-wechat)
- iLink infrastructure: [openilink/openilink-hub](https://github.com/openilink/openilink-hub), [epiral/weixin-bot](https://github.com/epiral/weixin-bot), [corespeed-io/wechatbot](https://github.com/corespeed-io/wechatbot)
- Windows Hook: [lich0821/WeChatFerry](https://github.com/lich0821/WeChatFerry) (MIT)
- Discontinued, do not use: [Devo919/Gewechat](https://github.com/Devo919/Gewechat)
- `wxautox4` license system: [PyPI](https://pypi.org/project/wxautox4/)
- Free UIA original: [cluic/wxauto](https://github.com/cluic/wxauto) (Apache-2.0, 4.x UIA no longer works)

---

## 8. Three Questions Awaiting Your Decision

1. **Main product scenario**: ordinary users' "personal WeChat assistant" (can accept using only iLink, no groups) vs teams' "WeChat group @ bot" (must retain Windows/device backend)? If both, do the "dual backend".
2. **Whether to accept that Windows is still a necessary condition for group capability**: if accepted, the free path is `wechatauto-replica`; if not, group capability can only go through a "remote Windows gateway/cloud phone", with the cost being hardware/operations.
3. **Priority**: do iLink first (the fastest way to let ordinary people use it for free, cross-OS) or replace `wxautox4` first (keep group capability, remove the license fee first)? I recommend **iLink PoC first + parallel wechatauto-replica replacement**, walking on two legs.
