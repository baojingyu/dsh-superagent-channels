# Extensions: the multi-channel layer

> Language: [English](EXTENSIONS.md) · [中文](EXTENSIONS.zh-CN.md)

**English** · [简体中文](EXTENSIONS.zh-CN.md)

This repository is a downstream distribution of a research prototype built on
[DeepSeek Harness](https://dsh.dev) (see [REPOSITORY.md](REPOSITORY.md)). The prototype listens to one
GitHub repository and, optionally, Feishu. This edition keeps every prototype behaviour and adds the
channels a team in mainland China actually runs on, plus the ability to run several instances of one
channel.

Upstream's numbered documents still describe the agent itself. This file is the map of what was
added, and the reference for anyone extending it further.

## 1. What is added, and where it lives

| Gap | What this edition adds | Where |
| --- | --- | --- |
| only GitHub | **GitLab** (self-hosted or gitlab.com): merge requests, notes, pipelines | `src/sources/hosting/gitlab/*`, `src/infra/hosting-api.ts` |
| no work items | **Yunxiao Projex**: requirement / bug / task, comments, status | `src/sources/work/projex/*`, `src/infra/yunxiao-api.ts` |
| only Feishu | **WeChat** personal account: group `@`, message images, voice transcripts | `src/sources/chat/weixin/*`, sidecar |
| — | **DingTalk** Stream, **WeCom** encrypted callback | `src/sources/chat/{dingtalk,wecom}/*` |
| one instance per channel | **many instances per channel**, config / health / cursors scoped per instance | `src/sources/instance.ts`, `src/sources/registry.ts` |

Every Source plugin loads (`weixin`, `gitlab`, `projex`, `dingtalk`, `wecom`, `feishu`, `github`) and is built as a
separate entry (`lib/*-watch.js`), so the panel lists them all and its switch - not the profile - decides whether
one runs. A Source with no configuration reports `sourceOff` and idles, so enabling one is a switch plus
change plus a saved instance, not a rebuild of the bundle.

## 2. The one assumption that had to change

The prototype has a single extension point, `SourceKind`, but it treats *a kind* as *an instance*:
`registry.resolve()` hard-codes `id: kind.kind`, which makes "two GitLab projects" or "two WeChat
accounts" impossible. This edition separates the **settings key** (the instance id) from the
**behaviour id** (the channel id) and keeps one compatibility rule:

> the default instance id stays equal to the channel id, so stored triggers, threads, mandates and
> policies keep resolving without a migration.

Everything else follows from three narrow ports rather than three ad-hoc integrations:

```
src/sources/hosting/   HostAdapter  →  change requests, notes, CI
src/sources/work/      WorkAdapter  →  work items, comments, status
src/sources/chat/      ChatAdapter  →  messages, threads, media
                       InboundTransport (poll | stream | webhook), DeliveredRing
```

Adding a provider means writing an adapter of a few hundred lines. The trigger shape, the
change-request lifecycle, the CI summary, comment idempotency, cards and prompts are reused
unchanged; identity and scope are the only provider-specific parts. Section 6 is the recipe.

## 3. Feature points, channel by channel

### 3.1 GitLab — `hosting/gitlab`

| Aspect | Detail |
| --- | --- |
| What it listens to | merge requests of the configured project, their notes, and pipeline status |
| Transport | polling (`pollSeconds`, default 30) |
| Identity | `hostUrl` + `project` (`group/name`); self-hosted instances are first class |
| Credentials | a personal access token (`api` scope) in a **file**, read per call, owner-only (`0600`, or an ACL on Windows) |
| Path safety | every request path is confined to the configured project; a path that escapes it is refused before any request |
| Error mapping | a non-JSON body becomes a status error, never a token echo; 401 maps to `unauthorized` |
| Outbound | comments and review-thread replies, **marker-idempotent** (the reply carries a marker, so a retry that already landed is detected) |
| Known gap | write-back against a real instance is unverified here (no PAT) |

### 3.2 Yunxiao Projex — `work/projex`

| Aspect | Detail |
| --- | --- |
| What it listens to | work items in the configured project space, by category, plus their comments |
| Categories | requirement / bug / task are polled by default; other categories are dropped rather than guessed |
| Transport | polling (`pollSeconds`) |
| Identity | `organizationId` + `project`; `assignedTo` is an Aliyun **accountID**, so the configuration must hold the bot's own accountID |
| Credentials | a `pt-…` personal token in a file, owner-only, reread per call; or **Sign in with Yunxiao** on the source card, which runs OAuth 2.0 (authorization code + PKCE, the browser signs in, a loopback listener takes the callback) and writes the token to the same file - 24 hours, renewed automatically, refresh token 90 days |
| Path safety | confined to `/oapi/v1/`, with an organization allowlist; dot-segment escapes are refused before any request, plain or percent-encoded |
| Outbound | comments, marker-idempotent |
| Status write-back | Both status fields are **dropdowns**: press **Read Yunxiao status list** on the source card (or the refresh beside a field), which lists the work item types per category (`ListWorkitemTypes`) and each type's workflow (`GetWorkitemWorkflow`, central form), then stores the statuses as `id -> name` for the pickers — the board name is shown, the status id is stored; a name or an id is accepted, and statuses seen in a poll are the fallback. A name neither place has seen is refused with the action that fills the vocabulary, never sent to Yunxiao as a status |
| Comment attachments | With "Let the model attach files to comments" on, a file in the worker's report (inside the ticket directory, ≤10 MiB, not an executable) is uploaded to the item's attachments, and the comment is posted as **RICHTEXT**: escaped paragraphs, the host's `embedHtml` for an image (a native `<img>`) plus a caption link to the file, a link for any other file - always the **permanent `embedUrl`**, never the expiring `url` - and the marker as an HTML comment. A comment with no attachment stays plain text, so Markdown the agent writes is unchanged. Off by default |
| Member list | With "Sync the list from project members" on, "Sync project members" replaces the list with the project's members (`userId`, the id an item is assigned to), keeping your order, refreshing names, and appending new members; one sync runs at startup. Like Feishu's, the sync applies to the **default instance** only (instance id `projex`) |
| Panel search | A serial (`ESFX-6228`) or a work-item page address finds that item's triggers and tickets (the page is addressed by serial while a thread is keyed by the internal id, so linking to a thread still goes through the conversation id) |
| Deleted items | A work item in the recycle bin answers a comment/status call with HTTP 400 "已进回收站"; the plugin treats that as **gone** - it marks the Thread `gone`, stops reading it, and never counts it as a poll error (deleting an item is a person's act, not a plugin failure) |
| Site | Empty uses the central site `https://openapi-rdc.aliyuncs.com`; a Region deployment names its instance domain under "API site", and sign-in and calls use the same site |
| Known gap | the write paths (status PUT, attachment upload and the RICHTEXT body) are unverified against a real instance here (no token); `GetWorkitemWorkflow` needs a work item type the project actually has |

Two ready ways to check against a real organisation: **Sign in with Yunxiao** on the source card, or
`python verify/oauth-check.py --token-file <path>` in a terminal (the same OAuth flow; it prints the authorization URL and
writes the same token file, never a token value). With a token,
`LIVE=1 YUNXIAO_ORG=… YUNXIAO_PROJECT=… YUNXIAO_TOKEN_FILE=… npx vitest run tests/live/projex-contract.live.spec.ts`
checks work items, comments, the member roster and the workflow status list, read-only.

#### 3.2.1 The three-stage loop: assess / execute / feed back

This channel used to do "receive and reply" and nothing else, and each of the three stages was missing one
piece. All three now have a defined landing place.

| Stage | What was missing | What it does now | Where |
| --- | --- | --- | --- |
| **Assess** | A Trigger carried only its own text. An assessment of a comment saw no title, no description and no earlier answer - the model faced "any news on this?" and had to guess the whole thing, so it either took on the wrong work or ignored everything; and a comment Trigger carried no category, so the admission table judged it on its defaults and an operator's decision about a category did not reach that category's comments | **The item is read as one conversation**: the description is the root message (`[ESFX-6228] title` plus body), comments follow in time order and continue across the host's pages, the agent's own marked comments are `bot` (never a person's request), and embedded images are read back from the local archive as attachments. A comment Trigger also carries its item's **category**, so a comment and its item fall in the same admission row | `src/sources/work/context.ts`, `src/sources/work/stream.ts` |
| **Execute** | A worker on such a ticket did not know which item it was on: it could not name the item in a commit message, a PR or a reply | **Every ticket carries the item's identity**: `DSH_SUPERAGENT_PROJEX_PROJECT / _WORKITEM / _SERIAL / _CATEGORY / _STATUS / _URL` (plus `_ORG`), in the execution-environment prompt where the GitHub kind puts `DSH_SUPERAGENT_GITHUB_REPOSITORY / _NUMBER` | `src/sources/work/environment.ts` |
| **Feed back** | Outside the comments the board was dead: an item sat in its original column from acceptance to delivery, so a person had to open the comments to learn whether the agent was on it | **The status follows the ticket**: with `writeBack` on and the two status ids named, the start status is written as soon as a ticket starts and the done status once it ends (completed, merged, dropped). Each phase is written once per ticket (KV ledger), the item is read first so a status already current is not rewritten, and a failure is recorded in the poll result and retried next round | `src/sources/work/feedback.ts` |

Why each of them matters:

- **An assessment needs a conversation, not a sentence.** Yunxiao has no `@`, so the admission table decides from
  whether the assignee (or the creator) is on the list - which makes the assessment the only place that can read what
  the person actually wants. Handing it half a sentence makes an accurate table useless.
- **Execution has to be able to name things.** The serial (`ESFX-6228`) is what people search, review and quote; without
  it a deliverable cannot be tied back to the board item.
- **Feedback belongs on the board.** A comment is written to one person, a status to a team: a stand-up reads columns,
  not comments. Write-back is therefore **opt-in** (`writeBack` is false by default), does nothing until the statuses
  are named, and **never touches a ticket a person stopped** - whoever stopped it knows.

#### 3.2.2 Against the GitHub and Feishu channels

| Capability | GitHub | Feishu | Yunxiao Projex |
| --- | --- | --- | --- |
| Assessment context | `threadContext`: the whole Issue / PR discussion | `threadContext`: messages and images in the topic | **added here**: description, every comment, embedded images |
| Who may originate work | accounts on the list | members on the list | the assignee's (else the creator's) accountID |
| Execution environment | repository, account, commit email, number, PR head | - (a chat channel relies on the source context in its prompt) | **added here**: project, work item, serial, category, status, URL, organisation |
| Feedback - acknowledgement | a comment | a message | a comment |
| Feedback - result | a comment (`announceEnd` speaks on its own when the ticket ends) | a message | the same: "completed / merged / dropped" is posted when the ticket ends |
| Feedback - status | expressed by the PR merging or closing | - | **added here**: board status write-back, a name taken from the project's workflow |
| Feedback - attachments | files in the PR | message attachments | **added here**: a file is uploaded to the item's attachments and embedded in a RICHTEXT comment (switch off by default) |
| Panel lists | accounts that may originate work + bots whose comments may become candidates | members (synced from the chat) | members' accountIDs, **syncable from project members** (switch off by default) |
| Panel search | `#12` / an Issue or PR address | - (a chat searches by message) | `ESFX-6228` / a work-item page address |
| Refusal notice | not sent (public record) | sent (a conversation) | not sent (public record) |

What stays different on purpose: a work item has no `@`, so the "outsider who addresses the agent" cell of the
admission table is always a dash; and the sync takes the project's members only, never the whole organization. Why a
status resolves through the project's workflow, how an attachment reaches a comment, why the sync is limited to the
default instance, and what is still unverified, are in
[ADR-009](docs/extensions/ADR-009-projex-feedback-and-parity.md) and
[ADR-010](docs/extensions/ADR-010-yunxiao-signin-status-and-identity.md).

### 3.3 WeChat — `chat/weixin`

The desktop client cannot be driven from Node, so it sits behind a **loopback HTTP sidecar** with a
frozen contract. The Node side knows only the contract; the backend is replaceable. Sections 4 and 5
are the detail.

| Aspect | Detail |
| --- | --- |
| What it listens to | the chats configured in the panel: groups (judged on the structured `@`) and direct chats (a direct message needs no mention to be addressed to the bot) |
| Transport | polling the sidecar (`pollSeconds`, minimum 5) which is itself **push-fed** by the client's listener |
| Identity | `selfWxid` is the account whose `@`s count; chats and senders are the sidecar's ids |
| Credentials | the sidecar's bearer token in a file, owner-only |
| Group `@` | decided on `ats`, never on the message body — see §5.2 |
| Outbound (files) | `/send` takes one optional `file` (base64, ≤ 20 MiB, name reduced to a basename); verified on the live client, where it arrives as an image message. The core carries them (`OutboundMessage.files`). **The worker names what it produced in its ready report** (`files`, relative to the ticket directory) and the main Session's result reply **attaches them by default** (or `orchestrator_reply` takes an explicit `files`): **only from the ticket's own directory**, ≤ 20 MiB, executables refused, and gated by the panel's `sendFiles` switch (off by default) - see ADR-008 |
| Outbound | text, **keyed** idempotency (the OutboundMessage id is sent as `Idempotency-Key`), ≥1 s serialized spacing. A group reply may mention the sender under a switch (`mentionBack`), resolved from the sender's id to the display name the sidecar observed; **no native quote** - the client library's `SendMsg` takes no quote argument, see ADR-007 |
| Inbound media | images, downloaded through the sidecar and judged by magic bytes; groups and direct chats share one `/media` path. A switch turns it off, leaving a `[图片]` placeholder and downloading nothing |
| Inbound voice | transcribed into text (`to_text`, up to eight seconds of the client's UI per message, degrading to a placeholder). A switch turns it off, leaving `[语音消息]` |
| Our own writes are not new requests | A work-item Trigger is derived from `gmtModified`, and the agent's own comment or status write bumps it - so it triggers itself (measured: one item, two Triggers, the second caused by a status write six minutes later, which started a duplicate Assignment). The adapter therefore reads the item back after its own write, records the resulting revision in an in-process ledger, and a poll skips that revision; a person's later edit is a new revision and still triggers. The ledger is keyed by host, organisation, item and revision, capped at 512 entries with a 24-hour expiry |
| The request lives in the description | Projex's **list** endpoint returns `description: ''` with `formatType: null`; only the **detail** endpoint has it, as RICHTEXT JSON (`{"htmlValue":"<article>…"}`). A polled item with no body is therefore read back by id and its HTML stripped to text - without that the agent sees the title alone and never the instruction (this is how ESFX-6228 lost "tell me the URL") |
| The end is announced | The acceptance is sent by the Engine; the **result used to depend on the main Session calling `orchestrator_reply`**, so a model that answered in its own chat left the Source with an acceptance comment and silence. A ticket that ends now posts "已完成/已合并/已放弃：<the worker's summary>" to the conversation it started in, and stays quiet when the main Session already sent the result (the ticket remembers), when a machine asked for it, and when a person stopped it. A channel with a length limit gets the summary first and a short line second, then silence plus a `result.announceFailed` event |
| The settings page tolerates a bad row | A Source's admission rows are derived from its own configuration, and a mistake there must not cost the operator the whole page - the panel cannot open, so nothing can be saved (incident of 09 Nov: the Projex rows validated the whole instance config with a strict schema, `organizationId` was an unknown key, and saving reported `Invalid settings:`). The view now falls back to no table when the rows cannot be built, and everything else saves as usual |
| Rows must match scope | DingTalk and WeCom have no chat list of their own, so their admission rows are the three scope reports: a mention, an unmentioned group message, and a direct message. When the two disagreed nobody read what a person set, which is why both tables showed only dashes before. atOnly decides whether the unmentioned row is configurable |
| Reception versus authorization | A Source decides only what it can see: which groups, whether direct messages, and how much each group hands over (only messages that mention the agent, or all of them). The Policy decides what counts as work: who may originate it, in which range, at what strength. So the group list, the direct-message switch and each group's reception live in the Source; the allowed-people list and the admission table live under Eval. Reception is per group, like Feishu's chat list; the old global "receive only @s" is now the default for a new group. The card carries no "may originate work" switch - that was a third place to grant work and is gone |
| The WeChat list shows no source | The list is user id plus name, the same as Feishu. Whether a message came from a group or a direct chat is a property of the message, and the admission table splits on it; there is no group/direct column in the list. The sync keeps that bookkeeping internally (rows it wrote are replaced by the next sync, hand-added rows stay, merged by id with the manual row winning) |
| Who starts the WeChat bridge | All in the panel: point Advanced -> Bridge launcher at the machine's start script, and Start launches it detached and windowless through the plugin, so the bridge outlives a DSH restart; Stop finds the process listening on the bridge's port, verifies its command line is the sidecar, then ends it; Restart is stop-then-start; Check reads /health and says what the backend can do or why it cannot. The launcher's contents stay on the machine - the client library and shim never enter the repository. Without a launcher it falls back to the scheduled task |
| Who starts the WeChat bridge (old) | The sidecar is a separate long-lived process: it must run in the signed-in interactive desktop session, outlive a DSH restart, and keep its local shim out of the repository, so the plugin never spawns it. The card's Start / Stop / Restart buttons ask the machine's scheduled task (default `DSH-WeChat-Bridge`, editable under Advanced) to run or end it with `schtasks /run|/end /tn <task>`; the task name is validated in the schema and again in the runner, so a button never becomes a free-form command. Check bridge reads `/health` once and states the backend's capabilities or why it is unavailable |
| What WeChat Sync now does | It reads only the member roster of the group you pick (through the wxauto-bridge member endpoint), writes those members into the users-who-may-originate-work list marked as coming from a group, and keeps people already marked as direct. It reads no message content, sends nothing, does not change the groups you receive, and does not touch the admission table below. The point is to skip typing IDs by hand; the list takes whatever identifier the bridge reports - a stable wxid when there is one, the display name when there is not |
| WeChat list and sync | The users-who-may-originate-work list carries a Source column (group or direct) and gains Sync from group with Sync now: the group members join the list marked as coming from a group, and people you marked as direct are kept. Group members and direct users are therefore distinguishable: group people are written by the sync, direct-only people are marked by hand; the admission table also keeps every group and the direct row on separate lines |
| One table shape everywhere | All five Sources read the same way: **rows are reception ranges** (one per configured chat, plus other chats and direct messages; requirements/bugs/tasks for Yunxiao; new Issues/merge requests/comments/CI for GitLab), each with a 仅 @ / 全部消息 / 接收 / 不接收 annotation, and **only the cells that range really has** - the rest render as a dash. A chat now names one row per conversation (its scope reports the conversation id; it used to share one `chats` row). GitLab had **no Policy at all** - `hostingKind` declared none - so it could be neither configured nor authorized; it now has the account list and the bots-whose-comments-count list |
| The Projex table | The same interaction as Feishu and GitHub: **rows are the reception ranges** (requirements, bugs, tasks - each labelled 接收 or 不接收 by the instance's categories), and **only the cells that apply are offered**. No field of a work item names the agent, so the "an outsider addresses the agent" column is a dash here; the two unaddressed columns are configurable. Whether the person responsible (the assignee, else the creator) is listed decides the column, and each column is handled exactly as configured - ignore, or an inferred candidate accepted in auto mode. An assignment is no longer a request by itself |
| What counts as work | A work item carries no mention: **being assigned to somebody** is the explicit request. Three gates: eval mode is not off; the assignee is on "Eval → Policy → per Source → members who may originate work" (the account id from the item's assignee field). An item assigned to a listed member is accepted outright, with no auto mode; an unassigned item is ambient and only reaches the agent as an inferred candidate, which needs auto mode; and a rule must match, or the decision is `noRuleMatched`. With the list empty every item is refused as unlisted |
| The Projex API | Polling uses `POST /oapi/v1/projex/organizations/{org}/workitems:search` with the project as `spaceId`, a bare array in reply, and `page`/`perPage` paging; the time window goes in `conditionGroups` (an array of arrays with `className: dateTime` and `format: input`). The old `GET /listWorkitems` is gone from the gateway and answers 404 for every category. A comment keeps its text in `content` as a `htmlValue` JSON string and names its author `user`; the status write-back is `PUT /workitems/{id}` carrying `{status: <statusId>}` |
| Ticket directory root | An **absolute** path: `/srv/work`, `D:\Work`, `D:/Work` and `\\server\share` all count, a relative one is refused, and empty means `<stateDir>\work`. Until 09 Nov only a path starting with `/` was accepted - in the schema and in the input's own `pattern` - so a Windows drive letter could not be entered at all |
| The state lock | One dsh-superagent per state directory. A lock untouched for `LOCK_STALE_MS` (5 s; its holder refreshes every 2.5 s) is swept and taken; a held one is waited out for up to 6 s, and the failure names the remedy. This is the most common restart failure: the killed process leaves the lock, the new one is told it is held, and the whole plugin does not apply - which the panel reports as the plugin not responding |
| The state lock | One dsh-superagent per state directory. A lock untouched for `LOCK_STALE_MS` (5 s; its holder refreshes every 2.5 s) is swept and taken; a held one is waited out for up to 6 s, and the failure names the remedy. This is the most common restart failure: the killed process leaves the lock, the new one is told it is held, and the whole plugin does not apply - which the panel reports as the plugin not responding |
| Catch-up after a re-attach | A message that arrives while the listener is detached is lost for good - no callback, no queue, no record in the Engine. After every re-attach the sidecar reads the last twenty messages of each watched chat and queues the unseen ones (three chats, once a minute, reported as "重挂后补读 N 条") |
| What gets watched | The sidecar's queue is filled by its listener, and the listener fires only for chats named in `/listen`, so the watch set is the configured groups **plus** the people the Policy lists. A person on the list is watched automatically, which is what makes their direct messages arrive - and what was missing when a message left no trace at all |
| Direct messages | WeChat delivers direct messages as **one stream** (`/messages?room=<person>` and `room=` return the same batch), so a person needs no entry among the groups: with "Receive direct messages" on, the round reads that stream and the Policy list decides who may originate work - **people are configured once** |
| One list per question | **Groups** are configured under "Source → Groups to receive"; **people** are configured only under "Eval → Policy → per Source", like every other channel. A direct message needs no Source entry: it arrives anyway, and answering it needs none either. The policy card warns while that list is empty |
| Panel configuration | `POST /listen` replaces the chat set and carries `options.voice` / `options.images`; adding a chat or flipping a switch needs no restart |
| Keywords | a chat message naming one of `keywords` is treated as addressed to the bot **without an `@`** (case-insensitive); whether it becomes work is still the admission model's decision |
| Canned replies | a match on `autoReplies` sends a fixed text from the polling loop, without the model; the message is **still handed to the model**, so a template never swallows the rest of what a person said |
| Cursor | `/messages` carries `head`, so a client can notice that the sidecar restarted and its sequence went backwards, and start over; the sequence is seeded from the clock and stays monotonic across restarts |
| A refusal goes to a conversation only | "这条我没有接：…" reaches the person who wrote to the agent: chat channels opt in with `channel.acceptsNotice`, and **work items (Yunxiao, GitHub issues) never take one** - a work item is a public record, where that comment is not an answer and also broadcasts the Source's configuration. One incident posted sixteen such comments on other people's requirements, tasks and bugs. Two gates now: the Engine asks `SourceScope.acceptsNotice` before queueing, and the registry refuses again at delivery (`gone`, receipt settled as dropped) |
| Refusal notice | When a decision **ignores** a message that addressed the bot (`@` or a direct message), one line goes back saying it was not taken and why (not on the list, no request found, a ticket already running). Ambient group messages get none, or a busy group would be answered on every line |
| Receipt | when someone mentions the bot or messages it directly, a receipt goes out **before** the assessment (`acknowledge` / `ackText`, once per chat per 30 s). Measured here, the assessment takes 53 s to 2 min 09 s; the receipt does not shorten it, it removes the guessing |
| Still-working note | after the receipt, if the bot has said nothing in that chat, one note every `progressAfterSeconds`, at most 3; it stops as soon as the bot speaks |
| Config from the panel | `POST /listen` replaces the watched set; adding or removing a chat needs no restart |

> **One UI-automation client per machine.** A listener is only as alive as the client's window: when the window is
> stuck, or another tool of this kind drives it, `AddListenChat` and `StartListening` still answer while the callback
> stops firing - which looks exactly like a quiet chat. So ten minutes without a real event is treated as a stale
> attach: every watched chat is removed and re-added and `StartListening` is called again, at most once per fifteen
> minutes. `/health`'s `detail` reports `recent event K s ago` and `re-attached M times`; a rising M means something
> else is taking the window.
>
> **Switching accounts replaces the window.** Every thirty seconds the sidecar checks that the window it attached to
> still exists; when it does not, everything cached per account goes (chats, groups, members, the event queue, the
> listen set) and it attaches again, which `detail` reports as "检测到客户端窗口更换…已重建连接 N 次". A failed attach
> no longer exits the process: `/health` reports `available:false` with the library's own reason (such as "no signed-in
> main window found") and retries, so completing the sign-in needs no bridge restart.
>
> **The client build matters.** `wxautox4 41.2.3` attaches to the 4.1.9 generation; a client updated to 4.1.15.56 keeps
> answering "no signed-in main window found" while its window sits visible with the account signed in. `/status`
> carries `client` for exactly that reason: check the build before blaming the configuration.

#### 3.3.1 Alignment with the Feishu channel (this round)

WeChat already had: structured `@` detection, groups and direct messages, inbound images, voice transcripts, outbound text
and files, keyed idempotency, instant acknowledgement, still-working notes, keyword listening and canned replies, mentioning
the sender in a reply, per-instance isolation, and a listener that re-attaches itself. After comparing it with Feishu item by
item, these were added:

| Capability | Feishu | WeChat (now) |
| --- | --- | --- |
| Worker reads of the conversation | `feishu/<trigger-id>/message|root|parent|thread|around` | **added** `weixin/<trigger-id>/message|thread|around`, with `next_resource` paging |
| Source skill | `dsh-superagent-feishu` | **added** `dsh-superagent-weixin` (the resource grammar and image markers; WeChat has no CLI and no message deep link) |
| Assessment context | thread/root/parent/around | thread/**parent**/root; WeChat has no topic root, so `root` answers `no_root` instead of inventing one |
| Panel search by message | `om_…` becomes a term | **added** a platform message ID becomes a term; `meta.nativeId` matches exactly |
| Reply mapping | `repliesTo` from the parent | **added** `repliesTo`, so a thread shows which message an answer replies to |
| Messages per page | `readPageSize` | **added** `readPageSize` (1–50, the bridge's ceiling), shared by assessment reads and resources |
| Member roster sync | `syncChat` + Sync now | already present (`syncChat` + Sync now, from the members the bridge has seen) |
| Panel facts | bot identity | already present (signed-in account and mention evidence strength) |
| Inbound images | yes | already present; the assessment can attach `[image:<id>]`, and a worker downloads one with a single `curl`/`Invoke-WebRequest` against `GET /media/<id>` from its environment, then reads it |
| History backfill | a bot added to a chat recovers recent history | **present**: after a re-attach or first listen the bridge reads back the last 20 messages (up to 3 chats a round), now marked `historical` so they reach the assessment without a receipt or a canned reply |
| Message deep link | AppLink | **not possible**: the sidecar exposes no deep link, so `link` returns an empty address (ADR-007) |
| Bot list | bot messages can become candidates | **not possible**: WeChat has no bot-account concept, the bridge always reports `bot:false`, and pretending otherwise would be a lie |

Two limits are the backend's, not omissions: there is **no message deep link** (the sidecar exposes none) and **no bot list**
(WeChat has no bot-account concept; the bridge always reports `bot:false`). Both are recorded in
[ADR-011](docs/extensions/ADR-011-weixin-feishu-alignment.md).

### 3.4 DingTalk — `chat/dingtalk`

| Aspect | Detail |
| --- | --- |
| What it listens to | group messages addressed to the bot, and direct messages |
| Transport | **Stream** (long-lived connection), with an interruptible reconnect |
| Identity | `clientId` + `robotCode` |
| Credentials | `clientSecret` inline or in a file, owner-only |
| Capabilities | `idempotency: none`, `maxChars: 5000`, `markdown: true`, `proactive: false` |
| Honest weakness | outbound is **at-least-once**: there is no server-side idempotency key and the session webhook cannot dedupe a retry, so a retry may duplicate. The kind declares this instead of pretending |
| Known gap | the Stream transport needs a `dingtalk-stream` SDK injected as `connect`; without it the kind registers but does not start |

### 3.5 WeCom — `chat/wecom`

| Aspect | Detail |
| --- | --- |
| What it listens to | the application's messages: group chats by `chatid`, and direct messages |
| Transport | **webhook** (signed, encrypted callback) |
| Identity | `corpId` + `agentId` |
| Credentials | `corpSecret` inline or in a file; the callback `token` and the 43-character `encodingAesKey` (or `encodingAesKeyFile`) verify and decrypt |
| Callback URL | `<public origin>/wecom/<instance>`: the plugin mounts that public route; ops points the application's receive URL at it |
| Conversation context | the assessment reads the one message the callback carried (`thread`); `root`/`parent` answer `no_root`/`no_parent` because a callback has neither a topic nor a quote, and no history to page |
| Inbound images | an `image` callback's `MediaId` becomes `[image:<id>]`, and the assessment downloads it through `GET /cgi-bin/media/get` as an attachment |
| Panel search | a decimal `MsgId` becomes a search term; `repliesTo` exists, but a callback carries no quoted message so it is normally empty |
| Worker read | `wecom/<trigger-id>/message` (Feishu's resource grammar, one message and no next page) |
| Crypto | signature check, AES-CBC decryption, replay rejection (a redelivered message yields no second event) |
| Capabilities | `idempotency: none`, `maxChars: 2048`, `markdown: false`, `proactive: true` |
| Honest weakness | outbound is at-least-once; the message API has no idempotency key |
| Known gap | no history backfill, no message deep link and no chat member roster; a worker reads only the one message the callback carried |

### 3.6 Prompt skills — one set for six sources

Every Session (main and executor) registers six built-in Source skills, each viewable and overridable in **Prompts → team
prompts**, exactly like Feishu and GitHub (the dimension-by-dimension comparison is in
[capability-matrix.md](docs/extensions/capability-matrix.md)):

| Skill | File | What it covers |
| --- | --- | --- |
| Feishu `dsh-superagent-feishu` | `skills/dsh-superagent-feishu/SKILL.md` | `feishu/<trigger-id>/message|root|parent|thread|around`, lark-cli usage, following attachments and documents |
| GitHub `dsh-superagent-github` | `skills/dsh-superagent-github/SKILL.md` | reading with `gh`, issue/PR context, pre-publish checks |
| WeChat `dsh-superagent-weixin` | `skills/dsh-superagent-weixin/SKILL.md` | `weixin/<trigger-id>/message|thread|around`, `[image:<id>]` and a `GET /media` download, the honest no-deep-link limit |
| Yunxiao Projex `dsh-superagent-projex` | `skills/dsh-superagent-projex/SKILL.md` | the work item is the thread root and comments are replies; `DSH_SUPERAGENT_PROJEX_*` identity; deliver with `orchestrator_reply`, the plugin owns status write-back |
| WeCom `dsh-superagent-wecom` | `skills/dsh-superagent-wecom/SKILL.md` | the callback carries only that message (no history, no deep link), plain text up to 2048, no idempotency key so a retry duplicates |
| DingTalk `dsh-superagent-dingtalk` | `skills/dsh-superagent-dingtalk/SKILL.md` | the stream carries only that message (no history, no deep link), Markdown up to 5000, at-least-once delivery, `@` judged on staffId |

`composeSkill` now composes every built-in Source skill from its `skill/<name>` part (which is what the panel shows and
overrides), while a team skill keeps its own text; `tests/model-surface.spec.ts` unions the environment variables every kind
declares, so a new source never fails the "variable is not registered" check again.

## 4. The WeChat sidecar

A separate Python process (standard library only) on `127.0.0.1`, authenticated with a bearer token
read from an owner-only file. The contract is frozen and versioned; the Node side is the reference
consumer.

| Endpoint | Purpose |
| --- | --- |
| `GET /health` | whether the sidecar and its backend are usable, plus `capabilities` |
| `GET /status` | the signed-in account, and the mention name being judged against |
| `GET /rooms` | the chats the backend **can see** (the picker's candidates), not the ones it watches |
| `GET /members?room=` | the people it has seen in that chat (or the full roster, per capability) |
| `GET /messages?room=&cursor=&limit=` | events since a cursor, with a `next` cursor |
| `POST /send` | send text, optional quote, optional `Idempotency-Key` |
| `GET /media/<id>` | one message image's bytes; `404` when gone, `501` when the build cannot download |
| `POST /listen` | replace the watched set; idempotent, acts only on the difference |

Invariants the contract keeps:

- **`ats` is never derived from the message body.** A backend that cannot produce a mention list says
  so; it does not fall back to matching `@name` in the text.
- **`/media` never returns zero bytes with 200.** An empty payload is `404`.
- **`/send` is serialized** process-wide with at least one second between sends, and `/media` shares
  that lock, because both drive the same client UI.
- **`/rooms` is read-only.** It never starts a listener as a side effect.
- **The bearer token never appears in a log line.**

## 5. WeChat backend tiers

### 5.1 The ladder

| Tier | Backend | When it applies |
| --- | --- | --- |
| L0 | `wxauto` / `wxauto4` / `wxautox4` (UI automation) | default; needs an interactive Windows desktop session |
| L1 | a `wxhelper`-class hook | **ruled out**: it targets WeChat 3.9.x only, and its message payload carries no mention list, so it would not deliver `@` either (ADR-005 §7) |
| L2 | a `WeChatPadPro`-class iPad protocol service | no Windows machine available |
| L3 | a hosted API | everything else is down and the work cannot stop |

Only **L0** is implemented. L2 is a stub that answers `available: false` and `501` on data endpoints,
so switching to it later is a configuration change plus a restart, not a code change.

### 5.2 Group `@`, and why it is graded

WeChat 4.x exposes **no structured mention list**: the message bubble is a flat accessibility leaf
(`childCount == 0`, no text/value/legacy pattern), and the message object carries no mention field. So
a group `@` is read from the client's **own markup** — a name picked from the mention list is followed
by `U+2005` (four-per-em space), while a typed `@name` uses `U+0020` — plus `@所有人`.

That is stronger than substring matching, and weaker than a structured list, so the capability report
says which it is:

| Value | Meaning |
| --- | --- |
| `structured` | the client gave a mention list (the `fake` reference backend, and future L1/L2) |
| `markup` | the client's own markup, resolved against this account (L0 today) |
| `none` | the backend cannot tell at all |

The account's own display name is reread on a 60-second TTL, forced on every `/listen`, and refreshed
on the polling path, so renaming the account heals without a restart. A failed read keeps the old name
rather than clearing it — clearing would make detection never match, which is worse than a stale name.

### 5.3 What L0 cannot supply

| Contract field | L0 reality |
| --- | --- |
| `room` (chatroom id) | not available; chats are named `wxname_<sha1(display name)[:16]>` |
| `sender.id` | a display name, namespaced the same way; `sender_info()` returns a WeChat ID, lags one message and is sometimes null |
| `at` (message time) | the client's time separators where they exist, otherwise the receive time |
| `/members` | only the senders seen so far (`members: observed`) |

The namespacing is deliberate: it keeps the settings' id patterns strict instead of widening them to
accept a display name, and `refreshLabels` resolves the ids back to names for the panel's pickers. The
cost is that renaming a chat changes its id.

## 6. Adding a provider

1. Implement the port. For chat, an adapter needs: list chats, read messages since a cursor, send, and
   (optionally) download media. For work, list/read/comment. For hosting, change requests, notes, CI.
2. Declare `capabilities` honestly — `idempotency` (`keyed` / `marker` / `none`), `maxChars`,
   `markdown`, `proactive`. The panel shows these; a wrong value becomes a wrong promise.
3. Write the `kind` with its schema, its fields (every schema key needs a field), its `scope` rule and
   its environment variables.
4. Add a `*-watch.ts` plugin entry and a `cordis.patch.yml` insert. Do not ship it `disabled: true`: a kind only
   exists in the panel once its plugin registers it, and the panel's switch is what turns a Source on.
5. Add the file rows to `docs/007-architecture.md` — `tests/docs.spec.ts` fails if a module or a spec
   file is missing from those tables.
6. Add a spec. Live behaviour goes in `tests/live/*.live.spec.ts` behind `LIVE=1`.

## 7. Verification matrix

| What | How it is proven |
| --- | --- |
| the whole suite | `vitest run --maxWorkers=2`, green on macOS arm64 and Windows 11 |
| the WeChat contract | a real sidecar process over loopback: 9 live cases (endpoints, `ats`, idempotent send, image bytes, `/listen`) |
| the WeChat client | a real WeChat 4.x client: listener callbacks, own identity, send round trip, image download, five markup cases proving a typed `@name` does not count |
| GitLab | the real `gitlab.com` API: merge-request mapping, a bogus token mapped to 401 without echoing it |
| WeCom / DingTalk / Yunxiao | real authentication failures surfaced as diagnosable errors, with no secret in the message |
| the panel data layer | two instances of one channel, deleting one, legacy settings without a channel id |
| Windows | the measured baseline and the 16 files that failed on a first clone, in [HANDOVER-WIN11.md](HANDOVER-WIN11.md) |

**Not verified, and not claimed:** any write against a real code host or work item; the WeCom callback
over a public reverse proxy; DingTalk Stream with its SDK plugged in; WeChat `structured` mentions
(no tier that provides them is implemented); WeCom/DingTalk message images.

## 8. Conventions to keep

- **Never key `@` on text.** Scope reads `ats`. A backend may derive `ats` from the client's own
  markup, but the strength must be declared in `capabilities.mentions`, so a person can see whether a
  group `@` is proof or a hint.
- **One writer per state.** Sources change a Ticket only through `SourceContext.tickets`; health
  entries are claimed per instance; the outbox alone writes receipts.
- **Idempotency is declared.** `keyed` / `marker` / `none`, and the panel shows what the code does.
- **Secrets come from files**, read per call, owner-only, and never appear in a message or a log line.
- **Backend differences stay in the sidecar.** Identity normalisation belongs there, not in the
  settings schema.
- **`src/sources` does not import `src/app`.** Types both sides need live in `src/sources`.
- **No personal data, no machine-specific paths.** Placeholders in docs and fixtures; flags or
  environment variables for paths.

## 9. License

MIT, the same as the prototype this edition grew from; the upstream copyright notice is kept. WeChat
automation through UI automation is third-party tooling: it is not authorised by Tencent, may be
limited by the client or the platform, and must stay inside the boundaries recorded in
[ADR-005](docs/extensions/ADR-005-weixin-backend.md) — reply only when addressed, never broadcast,
never bulk-add contacts, one account signed in at a time.
