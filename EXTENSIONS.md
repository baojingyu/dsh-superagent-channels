# Extensions: the multi-channel layer

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
| Credentials | a `pt-…` personal token in a file, owner-only, reread per call |
| Path safety | confined to `/oapi/v1/`, with an organization allowlist; dot-segment escapes are refused before any request, plain or percent-encoded |
| Read-only by default | `writeBack` defaults to **false**, so the adapter never changes a work item's status unless asked |
| Outbound | comments, marker-idempotent |
| Known gap | read/write against a real instance is unverified here (no token) |

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
| Outbound | text, **keyed** idempotency (the OutboundMessage id is sent as `Idempotency-Key`), ≥1 s serialized spacing. A group reply may mention the sender under a switch (`mentionBack`), resolved from the sender's id to the display name the sidecar observed; **no native quote** - the client library's `SendMsg` takes no quote argument, see ADR-007 |
| Inbound media | images, downloaded through the sidecar and judged by magic bytes; groups and direct chats share one `/media` path. A switch turns it off, leaving a `[图片]` placeholder and downloading nothing |
| Inbound voice | transcribed into text (`to_text`, up to eight seconds of the client's UI per message, degrading to a placeholder). A switch turns it off, leaving `[语音消息]` |
| Panel configuration | `POST /listen` replaces the chat set and carries `options.voice` / `options.images`; adding a chat or flipping a switch needs no restart |
| Keywords | a chat message naming one of `keywords` is treated as addressed to the bot **without an `@`** (case-insensitive); whether it becomes work is still the admission model's decision |
| Canned replies | a match on `autoReplies` sends a fixed text from the polling loop, without the model; the message is **still handed to the model**, so a template never swallows the rest of what a person said |
| Receipt | when someone mentions the bot or messages it directly, a receipt goes out **before** the assessment (`acknowledge` / `ackText`, once per chat per 30 s). Measured here, the assessment takes 53 s to 2 min 09 s; the receipt does not shorten it, it removes the guessing |
| Still-working note | after the receipt, if the bot has said nothing in that chat, one note every `progressAfterSeconds`, at most 3; it stops as soon as the bot speaks |
| Config from the panel | `POST /listen` replaces the watched set; adding or removing a chat needs no restart |

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
| Credentials | `corpSecret` inline or in a file; `encodingAesKeyFile` holds the 43-character EncodingAESKey |
| Crypto | signature check, AES-CBC decryption, replay rejection (a redelivered message yields no second event) |
| Capabilities | `idempotency: none`, `maxChars: 2048`, `markdown: false`, `proactive: true` |
| Honest weakness | outbound is at-least-once; the message API has no idempotency key |
| Known gap | the callback needs a public reverse-proxied route; only the pure `handleWebhook` function exists today |

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
