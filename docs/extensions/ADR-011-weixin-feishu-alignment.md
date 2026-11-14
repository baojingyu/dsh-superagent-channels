# ADR-011: Aligning WeChat with Feishu

> Language: [English](ADR-011-weixin-feishu-alignment.md) · [中文](ADR-011-weixin-feishu-alignment.zh-CN.md)

Status: accepted (2026-11-14) · Scope: `src/sources/chat/weixin/**`, `src/app/resources.ts`, `src/app/prompts.ts`,
`src/app/skill-files.ts`, `skills/dsh-superagent-weixin/**`

## Context

The Feishu channel lets an agent read the original conversation while it works: `feishu/<trigger-id>/message`, `/root`,
`/parent`, `/thread` and `/around`, described by the bundled `dsh-superagent-feishu` skill; its assessment reads
`thread`/`root`/`parent`; the panel can search by message ID; and a reply's parent is mapped back to the Trigger it
answers. WeChat could already receive, judge `@` structurally, send text and files, transcribe voice, sync members, and
re-attach its listener, but an agent could not read a WeChat conversation, the panel could not find a message by ID, and a
reply chain was not linked.

## Decisions

### 1. The same resource grammar, implemented over the sidecar

`weixin/<trigger-id>/message`, `/thread` and `/around` mirror Feishu's names and response shapes (`{ status, message }`,
`{ status, messages, next_resource }`), so a worker reads either channel the same way and the skills differ only in what
the backend can do. `/thread` pages with the bridge cursor; `/around` is the page that holds the Trigger's message (WeChat
offers no time-window query, so the holding page stands in for Feishu's five-before/five-after window). Reads are
trigger-scoped: `readWeixin` refuses a resource whose trigger id does not match, the same guard Feishu's reader uses.

### 2. `root` answers `no_root`, because there is no topic

A Feishu message can belong to a topic rooted at an earlier message; a WeChat conversation is one flat stream. Returning
the room's first message as "root" would be an invented anchor, and a model told "this is the root" would reason from the
wrong message. So `/root` and the `root` thread part answer `no_root`, and `parent` answers the quoted message **only when
the bridge reports one**; otherwise `no_parent`. The skill says the same, so a model does not treat a missing root as a
failed read.

### 3. Search by platform message ID; map a reply to its parent

The shared chat kind already turns ID-shaped words into search terms and maps `meta.parentId` to a Trigger ID; the WeChat
kind had neither wired. Both are now wired, and `Store.read.search` matches `meta.nativeId` exactly, alongside the Feishu
`meta.messageId` it already matched. A pasted message ID therefore finds the Trigger, and a quoted reply shows the same
exchange Feishu shows.

### 4. `readPageSize` and a WeChat skill

`readPageSize` (1–50, the bridge's ceiling) joins the configuration so assessment reads and worker resources page the same
size, as Feishu's `readPageSize` does. A bundled `dsh-superagent-weixin` skill is registered in every Session next to the
Feishu and GitHub skills; it documents the resources, the `[image:<id>]` markers, and the two things WeChat cannot do.

## What stays impossible, and is stated rather than faked

- **No message deep link.** The sidecar exposes none, so `ChannelLink.url` is empty and the panel names the Source. A
  fabricated `weixin://` URL would not open the message.
- **No bot list.** Feishu can tell a bot sender by `sender_type`; WeChat has no such concept and the bridge reports
  `bot:false` for everyone. A "bots whose messages may become candidates" list would be a control that never matches.
- **No topic root** — see decision 2.

## What became possible, and how

- **Image bytes reach a worker.** The skill documents a download: `DSH_SUPERAGENT_WEIXIN_BRIDGE` and
  `DSH_SUPERAGENT_WEIXIN_TOKEN_FILE` are exported into the worker's environment, and one `curl`/`Invoke-WebRequest` against
  `GET /media/<id>` (percent-encoded, bearer token from the 0600 file) writes a file `read_image` opens. That is Feishu's
  "download with lark-cli, then read it" without shipping a CLI, because the bridge is already the authenticated endpoint.
  `/media` serialises with `/send`, so downloads stay one at a time, and a 401 is reported rather than guessed.
- **First-sight backfill exists, and is now marked.** The sidecar already reads a chat's last messages back after a re-attach
  (or when a chat starts being listened) and queues them; that is WeChat's `backfillChat`, capped at `CATCHUP_MAX_MESSAGES`
  (20) per chat for at most `CATCHUP_MAX_CHATS` (3) chats a round, because each read opens the client window. Those events now
  carry `historical: true` (contract §3), and `pollChat` hands them to the assessment without a receipt, a canned reply or a
  still-working note: old words must be readable but must not be answered. It is not a full history scan - a chat that was
  never listened has no queue to read - and the skill says so.

## Consequences

- A worker can read its ticket's WeChat conversation and page it, which is what Feishu's resource grammar gave.
- Two channel-specific skills now ship; `Prompts.skills` registers `weixin` unconditionally (it needs no bot, unlike Feishu)
  and the panel lists its part for overrides.
- The resource route builds the bridge from the instance configuration (`weixinBridge`), so a resource read costs one
  sidecar call per page and never starts the bridge.
- Tests cover the reference/grammar, each read shape and its status (`ok`, `no_room`, `not_found`), the ThreadContext parts
  (`root`/`parent`/`thread`), search terms and reply mapping.
