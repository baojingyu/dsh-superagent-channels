# ADR-008 微信出站附件：桥已经能发，模型还不能用它发

- **状态**：Accepted 并按方案 A 实施（2026-11-08；桥层真机验证，核心层见 §6）
- **决策范围**：`OutboundMessage` 是否引入附件、由谁决定发什么文件、以及目录/大小护栏
- **关联**：ADR-007（微信能力对齐，其「出站图片/文件」一项指向本文）

## 1. 现状（已实现，已验）

- **客户端库**：`wxautox4` 的 `Chat.SendFiles(filepath, who=None, exact=False)` 与 `WeChat.SendFiles(filepath, who=None, ...)`
  都在，不需要逆向；同类还有 `SendAudio`、`SendFavorite`。
- **桥**：`POST /send` 接受可选的 `file: {name, data(base64)}`，写临时文件后 `SendFiles`，随后删除；文字与文件可同时给（先文字后文件）。
  护栏：解码后 ≤ 20 MiB（413）、请求体 ≤ ~27 MiB（`MAX_SEND_BODY_BYTES`）、文件名只留 basename 且过滤到 `[A-Za-z0-9._-]`。
- **真机**：一张 2×2 PNG 经 `/send` 发出，客户端渲染为图片消息，队列回显 `text="图片"`。
- **测试**：`verify/file-check.py` 11 项（文件名逃逸、上限、只发文件、文字+文件）。

## 2. 缺口：模型不能用它

`OutboundMessage` 只有 `id / channel / text / kind / ticketId`，`Channel.send(host, message)` 也只读 `message.text`。
所以「让 agent 回一张图/一个文件」不是桥的问题，而是**核心出站模型没有附件**：

1. `OutboundMessage` 需要可选的附件（名字 + 字节或附件引用）；
2. `engine.reply(...)` 与 `reply` 工具需要一个参数（或一个独立工具 `send_file`）带上它；
3. 各通道声明自己是否支持附件（`capabilities`），不支持的要么拒绝要么降级为文字说明；
4. 微信通道把它转成 `BridgeSend.file`；飞书/钉钉/企微等按各自 API 另做。

估计：核心 + 微信 + 测试与文档约 **1.5～2 个工作日**；其余通道各 0.5 天。

## 3. 两条路，以及为什么不建议捷径

| 方案 | 做法 | 问题 |
|---|---|---|
| **A（建议）核心附件模型** | 上面 1–4，附件是一个受控对象，通道各自实现 | 改动面大、要过一遍所有通道；但语义一致、可审计 |
| **B 路径直传捷径** | 给 agent 一个工具，直接把「本机路径」交给 sidecar 的 `SendFiles` | **等于给模型一个把任意本机文件发出去的口子**（凭据、源码、会议记录）；且路径语义只在 sidecar 所在机器成立 |

## 4. 若走 A，必须同时定的护栏

1. **来源限制**：只允许发工单工作区内的文件（解析后必须落在该 ticket 的 worktree 里），符号链接按解析后的真实路径判断。
2. **大小与类型**：沿用 20 MiB；对可执行后缀（`.exe/.bat/.ps1/...`）默认拒绝，需要显式开关。
3. **次数与频率**：沿用 sidecar 的 ≥1 秒发送间隔；每个工单设上限（如 20 个附件），防刷屏。
4. **默认关闭**：面板开关 `sendFiles`，默认关；开启时提示「模型可以把你工作区里的文件发到这个会话」。
5. **可审计**：每次发送记一条 `outbound file` 事件（名字、大小、sha256 前 8 位），进 `/health`/工单日志，便于事后追。

## 6. 方案 A 已实施的内容

- `OutboundFile { name, data(base64) }`；`OutboundMessage.files`；base64 而不是字节，因为回复先落 outbox 再发送，
  字节数组过不了那条 JSON 记录。
- `ReplyRequest` 的 `answer`/`result`/`attention` 可带 `files`，`Replies` 原样交给 outbox。
- `SourceChannel.capabilities.files = { maxBytes }`：通道自己声明能不能带文件。
- 微信通道：`sendFiles` 开关打开时把第一个文件挂在这条回复上，其余按序另发（`/send` 每次一个文件）；关着就只发文字。
- **位置：`orchestrator_reply` 的 `files`**（主 Session 回复人的那条），不是 worker 的独立工具。
  真机第一版把工具放在 worker 侧、`purpose` 固定为 `result`，结果 worker 在**进行中**就想发，两次都被
  「Ticket is not ready for delivery」拒掉——那条规则本来就是拦「把进展当结果发出去」的。回复人是主 Session 的事，
  文件跟着那条回复走；worker 侧的工具已删除，避免再把人引到同一个坑里。

- 闸门集中在 `resolveTicketFile`（有专门的测试）：真实路径必须在工单目录内（符号链接也算），普通文件、非空、
  ≤20 MiB、拒绝可执行后缀。
- `Runtime.canSendFiles(ticket)`：读**面板开关**（默认关）与通道能力，工具在动手前先问它。

## 6.1 第二版：文件从「报告」来，不靠模型临场记得

第一版把工具放在 worker 侧且固定 `result`，被「未 ready」拒；第二版挪到主 Session 的 `orchestrator_reply`，但真机上
worker 仍在调**已删除**的旧工具名，得到 `UNKNOWN_TOOL`，于是它对用户说「这个环境没有附件上传通道」——能力在，工具不在。

所以现在的链路是：**worker 在 ready 报告的 `files` 里声明产出物**（相对工单目录）→ 报告存进 assignment → 转给主 Session
的 relay 带上这份清单 → 结果回复**默认自动附上**（也可以显式给 `files`）。`sendFiles` 开关与 `resolveTicketFile` 的
边界照旧。这样即使模型忘了说，产出物也会跟着结果走；模型也没有「看起来能做但一定失败」的工具可调用。

## 7. 真机教训（第一版为什么不对）

| 现象 | 原因 |
|---|---|
| worker 调 `orchestrator_send_file` 两次都失败，`execute.failed` 写着 `Ticket is not ready for delivery` | 工具把 `purpose` 固定成 `result`，而 `result` 需要先有 verified ready report；worker 想的是「边做边发」 |
| 微信里只看到「已打包发到本对话（附件 …zip）」，没有附件 | 工具没成功，文本是模型自己说的 |

结论：附件属于**回复**，而回复由主 Session 写进 `orchestrator_reply`；放在那里既符合准入规则，也让「说到」和
「发到」由同一次调用决定。

## 5. 结论

- **能做**：库有 `SendFiles`，桥已经实现并真机验过；剩下的是核心出站模型与一个受控工具。
- **不建议**先用路径直传把功能糊上去：那会把「模型决定发什么」变成「模型能读任何本机文件并发出」，风险与一个受控附件模型完全不是一个量级。
- 下一步：确认是否走 A；确认后我按 §4 的护栏实现，并把「文件只能来自 ticket 工作区」做成测试（越界必须失败）。
