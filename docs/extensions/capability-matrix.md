# Capability matrix: the four added sources against Feishu and GitHub

> Language: [English](capability-matrix.md) · [中文](capability-matrix.zh-CN.md)

Reference for what "aligned" means. Feishu and GitHub are the two sources the upstream superagent ships; the other four are
this bundle's additions. ✅ present · ➖ not applicable to the platform · ❌ impossible on the backend (stated, never faked).

| Capability | Feishu (official) | GitHub (official) | WeChat | WeCom | DingTalk | Yunxiao Projex |
| --- | --- | --- | --- | --- | --- | --- |
| Receive messages | ✅ poll history + events | ✅ poll notifications | ✅ sidecar poll | ✅ signed callback (plugin mounts `/wecom/<instance>`) | ✅ stream (needs a `connect` injected; no SDK shipped) | ✅ poll work items/comments |
| Assess / decide / execute / reply loop | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Structured `@` judgement | ✅ open_id | ➖ | ✅ `ats` (markup fallback, strength in facts) | ✅ `mentionsAgent` | ✅ `ats` staffId | ➖ |
| Direct messages | ✅ | ➖ | ✅ | ✅ | ✅ | ➖ |
| Outbound text | ✅ markdown | ✅ comment | ✅ + mention-back | ✅ plain 2048 | ✅ markdown 5000 | ✅ RICHTEXT/Markdown comment |
| Outbound files | ➖ (CLI) | ➖ | ✅ `sendFiles` | ❌ API text only | ➖ (webhook) | ✅ attachments |
| Idempotent send | ✅ keyed | ✅ marker | ✅ keyed | ❌ none (stated) | ❌ none (stated) | ✅ marker |
| Thread context for the assessment | ✅ thread/root/parent | ✅ PR/issue | ✅ thread/parent; `root`→`no_root` | ✅ thread; `root`/`parent`→`no_*` | ✅ thread; `root`/`parent`→`no_*` | ✅ item body + comments |
| Worker reads of the original | ✅ `feishu/<t>/…` | ✅ `github/<t>/…` | ✅ `weixin/<t>/…` | ✅ `wecom/<t>/message` | ✅ `dingtalk/<t>/message` | ✅ `projex/<t>/item`, `/comments` |
| Inbound images for the assessment | ✅ | ➖ | ✅ `[image:<id>]`, `/media` | ✅ `MediaId`, `/cgi-bin/media/get` | ➖ (text stream) | ✅ item/comment images archived |
| Panel search | ✅ message id | ✅ issue/PR number | ✅ native id | ✅ decimal `MsgId` | ✅ `msgId` | ✅ serial or page URL |
| Reply→parent mapping | ✅ | ✅ | ✅ (quote id) | ➖ no quote in callback | ➖ | ➖ |
| Display-name refresh | ✅ chat names | ✅ repo names | ✅ rooms/members | ✅ department users (`refreshLabels`) | ❌ needs contact permission API, not offered | ✅ status vocabulary |
| Member/roster sync into Policy | ✅ chat members | ✅ collaborators | ✅ group members | ❌ group members unreadable; user list only fills names | ❌ same | ✅ project members |
| Health entries | `feishu` + `history` | `github` | `weixin` | `wecom` | `dingtalk` | `projex` |
| History backfill | ✅ chat history | ✅ notifications | ✅ post re-attach catch-up (marked `historical`) | ❌ callback only | ❌ stream only | ✅ first-sight comments |
| Message deep link | ✅ AppLink | ✅ issue/PR URL | ❌ | ❌ | ❌ | ✅ item page |
| Multiple instances | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

## Platform limits, and why they are not bugs

- **No deep link** on WeChat, WeCom and DingTalk: none of the three exposes a per-message URL; the panel names the Source.
- **No history** on WeCom and DingTalk: both deliver by push (callback / stream) and offer no read-back endpoint, so no
  backfill and no `/thread` pages. WeChat reads history through its sidecar; Feishu through the history API; Projex through the
  work-item APIs.
- **DingTalk transport**: the WebSocket client is the `dingtalk-stream` SDK, which this bundle deliberately does not vendor.
  A deployment injects `connect()` (see `src/sources/wecom…` no - see `src/sources/dingtalk-watch.ts`); without it the kind is
  registered but nothing listens, and health says so. Everything downstream of the stream (Trigger, ThreadContext, worker
  read, reply, policy) is aligned.
- **WeCom / DingTalk member sync**: a self-built app cannot enumerate a chat's members; WeCom fills Policy *names* from a
  department it is allowed to read, and both refuse to pretend a visible-user list is a chat roster.
- **WeCom / DingTalk / WeChat images**: WeChat and WeCom deliver images with a media id the deployment can download; DingTalk
  stream events carry text, so no image is claimed.

## What this round added

1. `projex/<trigger-id>/item` and `/comments` worker reads (`src/sources/work/projex/read.ts`), with paging and the agent's own
   comment marked `bot`.
2. `dingtalk/<trigger-id>/message` worker read and a DingTalk ThreadContext (`thread` = the one message, `no_root`,
   `no_parent`) — `src/sources/chat/dingtalk/{read,kind}.ts`.
3. WeCom `refreshLabels` over the contact user list, plus a `departmentId` setting, so Policy rows show names.
4. A `dsh-superagent-dingtalk` skill, and the Projex skill now names its two resources.
5. Tests: `tests/projex-read.spec.ts`, `tests/dingtalk-read.spec.ts`, plus the existing WeCom/WeChat/Projex suites.
