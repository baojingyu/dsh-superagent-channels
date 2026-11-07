# Extensions: self-hosted sources

**English** · [简体中文](EXTENSIONS.zh-CN.md)

This fork is a secondary development of
[`open-dsh-superagent`](https://github.com/baojingyu/open-dsh-superagent) (a research prototype,
not an official DeepSeek product) built on DeepSeek Harness. Upstream listens to one GitHub
repository and, optionally, Feishu. This branch keeps every upstream behaviour and adds the
sources a team in mainland China actually runs on.

Upstream's own documents still describe the agent; this file is the map of what was added.

## What is added

| Gap upstream | What this branch adds | Where |
| --- | --- | --- |
| only GitHub | **GitLab** (self-hosted): merge requests, notes, pipelines | `src/sources/hosting/*` |
| no work items | **Yunxiao Projex**: requirement / bug / task, comments, paging | `src/sources/work/*` |
| only Feishu | **WeChat** personal account: group `@`, message images | `src/sources/chat/weixin/*` |
| — | **DingTalk** Stream, **WeCom** encrypted callback | `src/sources/chat/{dingtalk,wecom}/*` |
| one instance per kind | **many instances per kind**, config/health/KV scoped per instance | `src/sources/instance.ts`, `src/sources/registry.ts` |

Five optional plugins ship with the bundle and are **disabled by default** in
`cordis.patch.yml`: `weixin`, `gitlab`, `projex`, `dingtalk`, `wecom`. They are built as separate
entries (`lib/*-watch.js`), so enabling one is a patch file change plus a saved instance.

## The one assumption that had to change

Upstream has a single extension point, `SourceKind`, but it treats *a kind* as *an instance*:
`registry.resolve()` hard-codes `id: kind.kind`. That makes "two GitLab projects" or "two WeChat
accounts" impossible. This branch separates the settings key (the instance id) from the behaviour
id (the kind id) and keeps one compatibility rule:

> the default instance id stays equal to the kind id, so stored triggers, threads, mandates and
> policies keep resolving without a migration.

Everything else follows from three narrow ports rather than three ad-hoc integrations:

```
src/sources/hosting/   HostAdapter  → hostingKind()   change requests, notes, CI
src/sources/work/      WorkAdapter  → workKind()      work items, comments, status
src/sources/chat/      ChatAdapter  → chatKind()      messages, threads, media
                       InboundTransport (poll | stream | webhook), DeliveredRing
```

A new provider is an adapter of a few hundred lines: the trigger shape, merge-request lifecycle,
CI summary, comment idempotency, cards and prompts are reused unchanged. Identity and scope are
the only provider-specific parts.

## WeChat needs a sidecar

The WeChat desktop client cannot be driven from Node, so it sits behind a loopback HTTP sidecar
with a frozen contract (seven endpoints, JSON events, `0600` bearer token). The Node side only
knows the contract, which keeps the backend replaceable:

| Layer | Backend | When |
| --- | --- | --- |
| L0 | `wxauto` / `wxauto4` / `wxautox4` (UIAutomation) | default; needs an interactive Windows desktop session |
| L1 | `wxhelper`-class hook | L0 blocked by window or version limits |
| L2 | `WeChatPadPro` (iPad protocol) | no Windows machine available |
| L3 | hosted API | everything else is down and the business cannot stop |

Three facts learned the hard way, all recorded in this branch's behaviour:

1. **The client generation decides the package.** WeChat 4.x (`Weixin.exe`, `Qt51514QWindowIcon`)
   has no 3.9 accessibility tree; `wxauto` 3.9 cannot attach to it. Use `wxauto4`/`wxautox4`, or pin
   the client to 3.9.11.17.
2. **The probe must run in the same interactive desktop session as the client.** From SSH, a
   service or a disconnected RDP session it sees no window at all.
3. **Group `@` is never keyed on text.** Scope reads a structured `ats`/mention list; a renamed bot
   must keep working. A backend that cannot expose such a list is not eligible — that rule is why
   the backend is a ladder instead of a single dependency.

## Message images

An image posted in a group is often the whole bug report. The path:

```
sidecar /messages  →  ChatEvent.media  →  Trigger.meta.media
                   →  threadContext.read() appends [image:<id>]
                   →  images(text) extracts it  →  image() downloads  →  attachment for the model
```

Guarantees: media is judged by **magic bytes**, never by the remote content type; payloads beyond
the attachment byte limit or of an unknown format are refused **before** anything is saved; `/media`
shares one UI lock with `/send`; a backend without `ImageMessage.download()` answers `501` and
reports no media rather than handing out ids it cannot fetch.

## Verification status

Measured on this branch (node 22.23.2):

```bash
tsc --noEmit                      # 0
vitest run --maxWorkers=2         # 83 files (80 passed + 3 skipped) / 1435 tests (1421 passed + 14 skipped), 0 failed
tsdown                            # build complete, 8 entries: index + 7 watch plugins
LIVE=1 vitest run tests/live      # 13 passed + 1 skipped against real services
```

Verified against real things, not mocks only:

- a real sidecar process over loopback: six endpoints, idempotent send, `0600` token, `/media` PNG
- real `gitlab.com` public API: merge-request mapping; a bogus token maps to 401 without echoing it
- real WeCom / DingTalk / Yunxiao: authentication failures surfaced as diagnosable errors
- the panel data layer: two instances of one kind, deleting one, legacy settings without `kind`

**Not verified, and not claimed here:**

- WeChat against a real client: whether a structured `@` list exists is still open, and it decides
  L0 vs L2
- any write against a real code host or work item (no credentials here)
- WeCom callback over a public reverse proxy; DingTalk Stream without its SDK plugged in
- WeCom/DingTalk message images (only the WeChat path is implemented)

## Conventions to keep when changing this

- **Never key `@` on text.** Read the structured mention list; if a backend has none, it is out.
- **One writer per state.** Sources change a Ticket only through `SourceContext.tickets`; health
  entries are claimed per instance; the outbox alone writes receipts.
- **Idempotency is declared.** `capabilities.idempotency` is `keyed` / `marker` / `none`, and the
  panel shows what the code really does; WeCom is at-least-once and says so.
- **Secrets come from files**, read per call with a `0600` check, and never appear in a message.
- **`src/sources` does not import `src/app`.** Types that both sides need live in `src/sources`.

## Where things are

| Path | What |
| --- | --- |
| `src/sources/instance.ts` | instance id vs kind id, and the compatibility helper |
| `src/sources/{hosting,work,chat}/port.ts` | the three provider contracts |
| `src/sources/{weixin,gitlab,projex,dingtalk,wecom}-watch.ts` | the optional plugins |
| `src/infra/{hosting-api,yunxiao-api}.ts` | token-file HTTP clients with path allowlists |
| `cordis.patch.yml` | the five inserts, all `disabled: true` |
| `docs/007-architecture.md` | upstream's module and test tables, extended for every new file |
| `tests/live/*.live.spec.ts` | live suites, gated by `LIVE=1` |

## License

Upstream is MIT and a research prototype. This fork keeps that license and adds no guarantees.
WeChat automation through UI Automation is third-party tooling: it is not authorised by Tencent,
may be limited by the client or the platform, and must stay inside the boundaries above — reply
only when addressed, never broadcast, never bulk-add contacts.
