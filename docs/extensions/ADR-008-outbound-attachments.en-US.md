# ADR-008 WeChat outbound attachments: the bridge can already send them, the model cannot yet use it to send

> Language: [English](ADR-008-outbound-attachments.en-US.md) · [中文](ADR-008-outbound-attachments.md)

- **Status**: Accepted and implemented per option A (2026-11-08; bridge layer verified on a real machine, core layer see §6)
- **Decision scope**: whether `OutboundMessage` introduces attachments, who decides which file to send, and the directory/size guardrails
- **Related**: ADR-007 (WeChat capability alignment, whose "outbound images/files" item points to this document)

## 1. Current state (implemented, verified)

- **Client library**: `wxautox4`'s `Chat.SendFiles(filepath, who=None, exact=False)` and `WeChat.SendFiles(filepath, who=None, ...)`
  both exist, no reverse engineering needed; the same family also has `SendAudio` and `SendFavorite`.
- **Bridge**: `POST /send` accepts an optional `file: {name, data(base64)}`, writes a temporary file, calls `SendFiles`, then deletes it; text and a file can be given at the same time (text first, then the file).
  Guardrails: ≤ 20 MiB after decoding (413), request body ≤ ~27 MiB (`MAX_SEND_BODY_BYTES`), the filename is reduced to its basename and filtered to `[A-Za-z0-9._-]`.
- **Real machine**: a 2×2 PNG sent through `/send` was rendered by the client as an image message, and the queue echoed `text="图片"`.
- **Tests**: `verify/file-check.py` 11 items (filename escape, upper limit, file only, text + file).

## 2. The gap: the model cannot use it

`OutboundMessage` only has `id / channel / text / kind / ticketId`, and `Channel.send(host, message)` also only reads `message.text`.
So "let the agent reply with an image/a file" is not a bridge problem, but **the core outbound model having no attachments**:

1. `OutboundMessage` needs optional attachments (name + bytes, or an attachment reference);
2. `engine.reply(...)` and the `reply` tool need a parameter (or a separate `send_file` tool) to carry it;
3. Each channel declares whether it supports attachments (`capabilities`); unsupported ones either refuse or degrade to a text explanation;
4. The WeChat channel turns it into `BridgeSend.file`; Feishu/DingTalk/WeCom etc. do their own per their respective APIs.

Estimate: core + WeChat + tests and docs about **1.5–2 working days**; each remaining channel 0.5 day.

## 3. Two paths, and why the shortcut is not advisable

| Option | Approach | Problem |
|---|---|---|
| **A (recommended) core attachment model** | Items 1–4 above; an attachment is a controlled object, each channel implements it | Large change surface, must go through every channel; but semantics are consistent and auditable |
| **B path pass-through shortcut** | Give the agent a tool that hands a "local path" straight to the sidecar's `SendFiles` | **This amounts to giving the model a hole through which it can send any local file out** (credentials, source code, meeting notes); and path semantics only hold on the machine where the sidecar runs |

## 4. If taking A, the guardrails that must be fixed at the same time

1. **Source restriction**: only files inside the ticket workspace may be sent (after resolution they must land in that ticket's worktree); symlinks are judged by their resolved real path.
2. **Size and type**: keep 20 MiB; refuse executable extensions (`.exe/.bat/.ps1/...`) by default, requiring an explicit switch.
3. **Count and rate**: keep the sidecar's ≥1 second send interval; set a per-ticket cap (e.g. 20 attachments) to prevent flooding.
4. **Off by default**: a panel switch `sendFiles`, off by default; when turned on, warn that "the model can send files from your workspace into this session".
5. **Auditable**: record an `outbound file` event for every send (name, size, first 8 characters of sha256), into `/health`/the ticket log, for later tracing.

## 6. What option A has implemented

- `OutboundFile { name, data(base64) }`; `OutboundMessage.files`; base64 rather than bytes, because a reply lands in the outbox before being sent,
  and a byte array cannot get through that JSON record.
- `ReplyRequest`'s `answer`/`result`/`attention` can carry `files`, and `Replies` hands them to the outbox as-is.
- `SourceChannel.capabilities.files = { maxBytes }`: the channel itself declares whether it can carry files.
- WeChat channel: when the `sendFiles` switch is on, the first file is attached to this reply and the rest are sent separately in order (`/send` takes one file at a time); when off, only text is sent.
- **Location: `orchestrator_reply`'s `files`** (the one for the main Session replying to the person), not a separate worker tool.
  The first real-machine version put the tool on the worker side with `purpose` fixed to `result`, and the result was that the worker wanted to send while **in progress**, and both attempts were rejected by
  "Ticket is not ready for delivery" — that rule exists precisely to stop "sending progress out as a result". Replying to the person is the main Session's business,
  and the file travels with that reply; the worker-side tool has been deleted, to avoid leading people into the same pit again.

- The gate is centralised in `resolveTicketFile` (with dedicated tests): the real path must be inside the ticket directory (symlinks included), an ordinary file, non-empty,
  ≤20 MiB, and executable extensions are refused.
- `Runtime.canSendFiles(ticket)`: reads the **panel switch** (off by default) and the channel capability, and the tool asks it before acting.

## 6.1 Second version: the file comes from the "report", not from the model remembering on the spot

The first version put the tool on the worker side with `result` fixed, and it was rejected as "not ready"; the second version moved it to the main Session's `orchestrator_reply`, but on a real machine
the worker was still calling the **deleted** old tool name, got `UNKNOWN_TOOL`, and therefore told the user "this environment has no attachment upload channel" — the capability was there, the tool was not.

So the chain is now: **the worker declares its outputs in the ready report's `files`** (relative to the ticket directory) → the report is stored in the assignment → relayed to the main Session
with that list → the result reply **automatically attaches them by default** (an explicit `files` may also be given). The `sendFiles` switch and `resolveTicketFile`'s
boundary stay as before. This way, even if the model forgets to say so, the outputs travel with the result; and the model has no tool that "looks usable but always fails".

## 7. Real-machine lessons (why the first version was wrong)

| Symptom | Cause |
|---|---|
| The worker called `orchestrator_send_file` twice and both failed, with `execute.failed` saying `Ticket is not ready for delivery` | The tool fixed `purpose` to `result`, and `result` requires a verified ready report first; the worker's idea was "send as I go" |
| WeChat only showed "已打包发到本对话（附件 …zip）", with no attachment | The tool did not succeed; the text was the model's own claim |

Conclusion: attachments belong to the **reply**, and the reply is written by the main Session into `orchestrator_reply`; putting it there both conforms to the admission rules and lets "saying it" and
"sending it" be decided by the same call.

## 5. Conclusion

- **Doable**: the library has `SendFiles`, the bridge has implemented it and verified it on a real machine; what remains is the core outbound model and one controlled tool.
- **Not advisable** to patch the feature on with path pass-through first: that turns "the model decides what to send" into "the model can read any local file and send it out", a completely different order of risk from a controlled attachment model.
- Next step: confirm whether to take A; once confirmed I will implement per §4's guardrails, and make "files can only come from the ticket workspace" a test (crossing the boundary must fail).
