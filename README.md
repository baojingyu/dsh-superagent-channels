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

Verified on `main` (node 22.23.2):

```bash
tsc --noEmit                      # 0
vitest run --maxWorkers=2         # 83 files (80 passed + 3 skipped) / 1435 tests (1421 passed + 14 skipped), 0 failed
tsdown                            # build complete, 8 entries: index + 7 watch plugins
LIVE=1 vitest run tests/live      # 13 passed + 1 skipped against real services
```

Verified against real things, not only mocks: a real sidecar process over loopback (six endpoints,
idempotent send, `0600` token, image bytes); the real `gitlab.com` public API (MR mapping, a bogus
token mapped to 401 without echoing it); real WeCom / DingTalk / Yunxiao authentication failures
surfaced as diagnosable errors; and the panel data layer (two instances of one kind, deleting one,
legacy settings without `kind`).

**Not claimed:** WeChat against a real client (whether a structured `@` mention list exists is still
being probed, and it decides the backend), any write against a real code host or work item, the
WeCom callback over a public reverse proxy, DingTalk Stream without its SDK, pixel-level GUI
acceptance, and message images for WeCom/DingTalk (only the WeChat path exists).

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
| `sidecar/` | WeChat sidecar (contract + zero-dependency implementation) |
| `tests/live/*.live.spec.ts` | live suites, gated by `LIVE=1` |

## Conventions to keep

- **Never key `@` on text.** Group scope reads a structured mention list; a renamed bot must keep
  working. A backend that cannot expose one is not eligible.
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
