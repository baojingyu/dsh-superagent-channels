# ADR-007 微信渠道能力对齐：SiverWXBot 的功能面 vs 本仓库

- **状态**：Accepted，三期均已实施（2026-11-08）：P1 `7b4e316`、P2 `c4350a8`、P3 本提交
- **决策范围**：微信来源（`src/sources/chat/weixin/`）的面板字段、sidecar 出站能力、按关键词分流的归属
- **关联**：ADR-005（L0 后端与 @ 判据）、ADR-006（健康条目键）、`sidecar/wxauto-bridge/contract.md`

## 1. 结论摘要

1. **私聊**：监听、文本、图片都已可用（真机验证）。面板上"添加联系人"就是把他从会话下拉里选中——桥只会把**真见过的会话**列出来，没有手填 wxid 的入口（显示名派生的 `wxname_…` 不是真 wxid）。
2. **群聊**：监听、仅 @ 回复、群图片都可用；@ 是 `markup` 档（客户端标记），不是结构化提及。
3. **两处库限制**，不是配置问题：
   - **回复时引用消息：做不了**。`wxautox4` 的 `SendMsg(msg: str, who, clear, at, exact)` 与 `Chat` 的全部公开成员里**没有任何 quote/ref 参数**（`Chat` 成员：`SendMsg` `SendFiles` `SendAudio` `AtAll` `GetNewMessage` …）。微信 4.x 的"引用"只能靠右键菜单的 UI 交互，脆弱且未暴露。替代：把引用写进正文前缀（`「引用 @张三」原文…`）。
   - **回复时 @ 发言人：能做**。`SendMsg(..., at: Union[str, List[str]])` 支持，且 `at` 收显示名；本仓库之前**故意**没接（`send()` 的 docstring 写明"绝不放 `at=`"），因为入站的 `FriendMessage.at` 是"拍一拍"动作，曾被误用成群内 @。出站 `at=` 是另一条路径，接它需要单独的真机验证。
4. **语音识别**：入站已实现（`to_text`，8 秒上限、只试一次、失败降级为 `（语音转写失败）`），但**还没在真实语音消息上验证过**；它每次都会占用客户端 UI 最多 8 秒，所以需要一个开关而不该无脑常开。
5. **关键词**：本仓库完全没有，属于新能力，不是勾选项。可分两层做，见 §5。

## 2. 逐项对齐

| SiverWXBot 的能力 | 本仓库现状 | 面板可配置？ | 结论 |
|---|---|---|---|
| 启用群聊监听 | 已有（`rooms` 集合，`/listen` 集合替换、幂等） | ✅ 已有 | 已对齐 |
| 仅 @ 时回复 | 已有（`atOnly`，注释判据 `markup`） | ✅ 已有 | 已对齐；仅对群生效，私聊没有 @ 概念 |
| 私聊监听 / 私聊回复 | 已有（`room: ""` 单聊流，id → 流有映射） | ✅ 已有（从会话下拉选人） | 已对齐；缺"私聊"这一处的措辞与提示 |
| 群组图片 | 已有（入站 `media` + `/media` 下载，真机验过 PNG 魔数） | 🔶 无开关 | 需加 `images` 开关（关掉只留 `[图片]` 占位） |
| 私聊图片 | 同一条链路，真机验过（69 字节 PNG） | 🔶 无开关 | 同上 |
| 语音识别 | 已实现，**未真机验证**；每次占用 UI ≤8s | 🔶 无开关 | 需加 `voice` 开关，默认开，并在真机语音消息上验收 |
| 回复时 @ 发言人 | **未实现**（sidecar 明确不传 `at`） | ❌ | 可做：`mentionBack` 开关 + sidecar `at=[发送人显示名]`；仅群聊、且需真机验证 |
| 回复时引用消息 | **未实现** | ❌ | **库不支持**：无 quote 参数。替代方案 `quoteStyle: 'text'`，把引用写进正文 |
| 群聊关键词回复 | 未实现 | ❌ | 可做，见 §5 |
| 私聊关键词回复 | 未实现 | ❌ | 可做，见 §5 |
| 出站图片/文件 | 未实现（契约只发文本） | ❌ | 可做（`SendFiles(filepath, who)` 存在），但需要核心 `OutboundMessage` 支持附件，属于另一个量级 |
| 面板手动添加联系人 | 只能从桥见过的会话里挑 | ✅ 已有（候选下拉） | 没有真 wxid 可取，手填无从校验，保持"只挑候选"更安全 |

## 3. 技术证据（本次真机核对）

```text
WeChat.SendMsg(self, msg: str, who: str = None, clear: bool = True,
                at: Union[str, List[str]] = None, exact: bool = False,
                max_retries: int = 3) -> WxResponse
Chat.SendMsg(self, msg: str, who: str = None, clear: bool = True,
             at: Union[str, List[str]] = None, exact: bool = False) -> WxResponse
Chat 公开成员：AddGroupMembers AtAll CancelCall ChatInfo Close EditFriendInfo
              GetAllMessage GetDialog GetNewMessage LoadMoreCache SendAudio
              SendFavorite SendFiles SendMsg SetGroupAnnouncement
              SetGroupMyNickname SetGroupName SetGroupRemark Show VideoCall
              VoiceCall chat_type
```

- 私聊文本：`/messages?room=<wxname 人 id>` 返回 `room: ""` 的事件（已修）。
- 私聊图片：事件带 `media: [{"id":"<nativeId>#0","kind":"image"}]`，`/media` 返回 69 字节、`89 50 4e 47` ＝合法 PNG。
- `/listen` 重复推送已在 0.02s 内返回且不触界面（修掉了通讯录窗口反复弹出）。

## 4. 面板字段设计（拟新增）

| key | 类型 | 默认 | 作用 |
|---|---|---|---|
| `rooms` | rows（已有） | `[]` | **改标签**为「群与私聊」；选群＝群聊，选人＝私聊 |
| `atOnly` | switch（已有） | `true` | 仅 @ 时回复（群） |
| `mentionBack` | switch | `true` | 回复群里 @ 我的人时带上 @（**仅群**） |
| `quoteStyle` | select `none`/`text` | `text` | 无真引用接口；`text` = 正文前缀注明引用对象 |
| `images` | switch | `true` | 是否把图片作为附件交给模型 |
| `voice` | switch | `true` | 是否转写语音（关掉用 `[语音消息]` 占位，省 UI） |
| `keywords` | rows `[{ any, note }]` | `[]` | 命中任一关键词即视为**明确请求**（走既有准入模型） |
| `autoReplies` | rows `[{ any, reply, stopAgent }]` | `[]` | 命中即**直接回固定文案**（不经 agent），可选是否同时抑制交给 agent |

## 5. 分期

| 期 | 内容 | 影响面 | 估计 |
|---|---|---|---|
| **P1** | 面板措辞与提示（群与私聊、`姓名` 自动填的说明）；`images` / `voice` 两个开关接到入站渲染 | `kind.ts`、sidecar `_render_text`/`_to_event` 之前的分支 | 0.5 天 |
| **P2** | `mentionBack`：sidecar `send(..., at=[名])` + 契约字段 + Node 侧按开关传发送人 + **真机群内验证** | sidecar、`bridge.ts`、`contract.md` | 1 天 |
| **P3** | `keywords` → 准入（命中即 explicit）；`autoReplies` → 由监听循环直接 `/send` | `kind.ts` 的 scope/explicit、`weixin-watch.ts` | 1.5 天 |
| **已实施** | P1：措辞 + `voice`/`images` 开关 | `kind.ts`、sidecar `options`、`verify/options-check.py` | 完成 |
| **已实施** | P2：`mentionBack`（sidecar `at`、契约、面板、`verify/mention-check.py`） | sidecar、`bridge.ts`、`kind.ts` | 完成（真机群内未跑，避免在真实群里发言） |
| **已实施** | P3：`keywords` + `autoReplies` | `scope()`、`weixin-watch.ts`、`ports.ts` | 完成 |
| **已实施** | P4：即时回执 + 处理中提醒（`acknowledge`/`ackText`/`progressAfterSeconds`） | `weixin-watch.ts` 的 `pollChat`、`kind.ts` | 完成 |
| — | `quoteStyle: 'text'` | 现状已是「引用写进正文」，没有独立开关 | 不需要 |
| — | 出站图片/文件 | 需要核心 `OutboundMessage` 附件模型 | 另立 ADR |

## 5.1 P4 的依据（实测时间线，来自 `state/superagent/orchestrator.sqlite`）

| 消息 | 系统动作 | 时延 |
|---|---|---|
| 07:14 一条「test」 | 07:14:53 判定 ignore | 53 秒，无回执（正确：没有请求） |
| 07:14 「用网页做一个…」 | 07:16:09 判定 accept，同时发出回执 | **2 分 09 秒** |
| 07:30 「发布到公网…」 | 07:32:00 并入已有工单，**没有任何回执** | 2 分钟全程无声 |

结论：等待感来自两处——**评估本身就是几十秒到两分钟**，以及**追加到已有工单的消息不带回执**。所以回执由源侧在评估前发出，并对「机器人还没在这个会话里开口」补处理中提醒。缩短评估本身不在本期范围（涉及模型选择与提示词规模）。

## 6. 风险

1. **`at=` 的语义陷阱**：入站 `Message.at` 是"拍一拍"，出站 `SendMsg(at=…)` 是提及——两者同名不同义。P2 必须用专门的用例证明"发送后群里出现真正的 @ 提醒，且没有触发拍一拍"。
2. **语音转写占用 UI**：`to_text` 会抢客户端界面最多 8 秒，期间监听回调可能延迟。默认开但必须可关，并在 `detail` 里暴露"正在转写"。
3. **关键词自动回复绕开准入模型**：`autoReplies` 由监听循环直接发送，意味着任何人都能用一句配置好的话触发一次发送。必须限制为该来源已配置的会话，并受 sidecar 的 ≥1s 发送间隔约束。
4. **引用只能以文本呈现**：如果使用者期待微信原生的"引用"样式，这里做不到，需要在面板提示里写明。
