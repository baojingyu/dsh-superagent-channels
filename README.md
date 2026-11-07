# open-dsh-superagent — self-hosted source fork

**English** · [简体中文](README.zh-CN.md)

A secondary development of the **open-dsh-superagent** research prototype published by the DeepSeek
Harness team. That prototype is a proactive coding agent for **one GitHub repository** (optionally
Feishu), packaged as a bundle for [DeepSeek Harness](https://www.deepseek.com/en/harness/).
This fork keeps all of its behaviour and adds the sources a team in mainland China actually runs on.

> Upstream is **research code, not an official DeepSeek product**, and this fork is not affiliated
> with DeepSeek either. Both are MIT. Review and adapt before using them anywhere that matters.

## What this fork adds

| Upstream | This fork |
| --- | --- |
| only GitHub | **GitLab** (self-hosted): merge requests, notes, pipelines |
| only Feishu | **WeChat** personal account (group `@`, message images), **DingTalk** Stream, **WeCom** encrypted callback |
| no work items | **Yunxiao Projex**: requirement / bug / task, comments, paging |
| one instance per kind | **many instances per kind**, with config, health and KV scoped per instance |

Five new plugins ship with the bundle and are **disabled by default** in `cordis.patch.yml`:
`weixin`, `gitlab`, `projex`, `dingtalk`, `wecom`.

## Status

Verified on `main`, on both platforms:

| | macOS arm64 / node 22.23.2 | Windows 11 / node 22.21.1 |
| --- | --- | --- |
| `tsc --noEmit` | 0 | 0 |
| `vitest run --maxWorkers=2` | 83 files, 1435 tests, 1421 passed, 14 skipped, 0 failed | 84 files, 1456 tests, 1421 passed, 35 skipped, 0 failed |
| `tsdown` | build complete, 8 entries: index + 7 watch plugins | same |
| `LIVE=1 vitest run tests/live` | 13 passed + 1 skipped | 13 passed + 1 skipped |

The 21 extra Windows skips are recorded per file in [HANDOVER-WIN11.md](HANDOVER-WIN11.md) §2: the
POSIX service manager (`scripts/dsh-superagent`) and the Feishu stub that needs a live child
process. Nothing was skipped to make a failure disappear.

Verified against real things, not only mocks: a real sidecar process over loopback (six endpoints,
idempotent send, `0600` token, image bytes); the real `gitlab.com` public API (MR mapping, a bogus
token mapped to 401 without echoing it); real WeCom / DingTalk / Yunxiao authentication failures
surfaced as diagnosable errors; and the panel data layer (two instances of one kind, deleting one,
legacy settings without `kind`).

**WeChat against a real client, measured:** the sidecar's `pc-uia` backend drives WeChat 4.x through
`wxautox4` in **listener mode** (`AddListenChat` + `StartListening`), so messages arrive by push
instead of being scraped from whatever the window happens to have rendered. Verified on this
machine: real group and direct messages, the account's own identity, and image download.

What that backend can and cannot prove is published per instance as `capabilities`, so nobody has
to guess:

| capability | `pc-uia` | meaning |
| --- | --- | --- |
| `mentions` | `markup` | group `@` is read from the client's own mention markup (`@name` + `U+2005`), not from a typed `@name`; a renamed account breaks it and a pasted separator can forge it |
| `members` | `observed` | only the senders seen so far, never the full roster |
| `media` | per build | the Plus build has `download()`; the free one does not |

Configuring a chat happens once, in the panel: every round the polling loop pushes the configured chats to
`POST /listen`, and the sidecar acts only on the difference, so adding or removing a group takes effect
without restarting it. A chat the sidecar cannot resolve is reported back by name instead of looking like
a quiet group.
The honest gap: there is **no structured mention list** on WeChat 4.x. The message bubble is a flat
accessibility leaf (`childCount == 0`, no text/value/legacy pattern), so `ats` can only be
`markup`-grade. A backend that reports `mentions: none` is still usable for direct messages, and
its group chats are then judged by the Policy's rules alone.

**Not claimed:** any write against a real code host or work item, the WeCom callback over a public
reverse proxy, DingTalk Stream without its SDK, pixel-level GUI acceptance, a stable chat id or
sender `wxid` on WeChat (both are display names, namespaced as `wxname_<hash>`), and message
images for WeCom/DingTalk (only the WeChat path exists).

## Quick start

```bash
npm install --ignore-scripts --legacy-peer-deps     # pnpm 11 stalls on ERR_PNPM_IGNORED_BUILDS here
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/vitest run --maxWorkers=2
./node_modules/.bin/tsdown                          # produces lib/*-watch.js
```

The upstream setup guide still applies: [SETUP.md](SETUP.md) installs and configures the bundle with
an agent. The WeChat client cannot be driven from Node, so it sits behind a loopback sidecar with a
frozen contract — see [EXTENSIONS.md](EXTENSIONS.md) for the backend ladder and the probe.

## Enabling a source

1. Set `disabled: false` on the plugin's insert in `cordis.patch.yml`.
2. Rebuild (`tsdown`) and restart the harness.
3. Save an instance in the panel (Settings → Source). The settings key is the instance id; `kind`
   names the behaviour, and the default instance id stays equal to the kind id.

Credentials are never stored in settings: each client takes a `tokenFile` (or `keyFile`) path, reads
it per call, and refuses anything that is not a `0600` regular file.

## Layout

| Path | What |
| --- | --- |
| `src/sources/instance.ts` | instance id vs kind id, and the compatibility helper |
| `src/sources/{hosting,work,chat}/port.ts` | the three provider contracts |
| `src/sources/{weixin,gitlab,projex,dingtalk,wecom}-watch.ts` | the five optional plugins |
| `src/infra/{hosting-api,yunxiao-api}.ts` | token-file HTTP clients with path allowlists |
| `../open-dsh-superagent-ext/sidecar/` | WeChat sidecar (contract + zero-dependency implementation). It lives in the sibling directory because the live test resolves it there; see [HANDOVER-WIN11.md](HANDOVER-WIN11.md) §3.2 |
| `tests/live/*.live.spec.ts` | live suites, gated by `LIVE=1` |

## Conventions to keep

- **Never key `@` on text.** Group scope reads `ats`, never a substring of the body. `ats` may
  come from the client's own mention markup, but the strength must be declared in
  `capabilities.mentions` (`structured` / `markup` / `none`) so a person can see whether a
  group `@` is proof or a hint.
- **Backend differences stay in the sidecar.** A backend without stable IDs names chats and people
  `wxname_<hash>` and lets `refreshLabels` resolve them, so the id patterns in settings stay
  strict instead of being widened to fit a display name.
- **One writer per state.** Sources change a Ticket only through `SourceContext.tickets`; health
  entries are claimed per instance; the outbox alone writes receipts.
- **Idempotency is declared.** `capabilities.idempotency` is `keyed` / `marker` / `none`, and the
  panel shows what the code really does.
- **Media is judged by magic bytes**, never by the remote content type; oversized or unknown
  payloads are refused before anything is saved.
- **`src/sources` does not import `src/app`.** Types both sides need live in `src/sources`.

## Documentation

The upstream numbered guide still describes the agent itself — read it in order:

- [000 Philosophy](docs/000-philosophy.md) · [001 Domain](docs/001-domain.md) · [002 Authorization](docs/002-authorization.md) · [003 Execution](docs/003-execution.md)
- [004 Prompts](docs/004-prompts.md) · [005 Panel](docs/005-panel.md) · [006 Deployment](docs/006-deployment.md) · [007 Architecture](docs/007-architecture.md) · [008 Cookbook](docs/008-cookbook.md)

Decisions this fork made, and why:

- [docs/extensions/ADR-005-weixin-backend.md](docs/extensions/ADR-005-weixin-backend.md) — WeChat backend ladder, the interactive-session requirement, the probe history and the image capability
- [docs/extensions/ADR-006-health-key-compatibility.md](docs/extensions/ADR-006-health-key-compatibility.md) — why health keys are asymmetric for the default instance
- [EXTENSIONS.md](EXTENSIONS.md) — the fork's map in English, [EXTENSIONS.zh-CN.md](EXTENSIONS.zh-CN.md) in Chinese

## License

MIT, the same as upstream. WeChat automation through UI Automation is third-party tooling: it is
not authorised by Tencent, may be limited by the client or the platform, and must stay inside the
boundaries recorded in ADR-005 — reply only when addressed, never broadcast, never bulk-add contacts.
