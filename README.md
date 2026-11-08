# dsh-superagent-channels · multi-channel edition

**English** · [简体中文](README.zh-CN.md)

A proactive agent for a software team, packaged as a [DeepSeek Harness](https://dsh.dev) (DSH)
bundle. It listens to the places a team already talks and keeps its work items — a code host, a
work-item tracker, four chat platforms — evaluates each incoming message under a Policy, turns the
authorized ones into Tickets, and executes every Ticket in its own DSH Session.

The upstream project listens to one GitHub repository and optionally Feishu. **This edition keeps
every upstream behaviour and adds the channels a team in mainland China actually runs on**: GitLab,
Yunxiao Projex, WeChat, DingTalk, WeCom, plus many instances of one channel.

This is an **independent repository**, not a pull-request fork: upstream states it does not merge
outside contributions, so this edition is maintained on its own. See
[REPOSITORY.md](REPOSITORY.md) for how the repository is managed, what provenance it keeps, and how
to detach a copy from the prototype.

## What it adds

| Upstream | This edition |
| --- | --- |
| only GitHub | **GitLab** (self-hosted): merge requests, notes, pipelines |
| only Feishu | **WeChat** personal account: group `@` and direct messages, images, voice transcripts, **instant receipt and still-working notes**, **keyword listening and canned replies**, **mention the sender in a reply**, per-chat switches for images and voice; **a listener that re-attaches itself**, and **a cursor that survives a restart** |
| no work items | **Yunxiao Projex**: requirement / bug / task, comments, paging |
| — | **DingTalk** Stream and **WeCom** encrypted callback |
| one instance per channel | **many instances per channel**, with config, health and cursors scoped per instance |

Every Source plugin loads and is built as a separate entry (`lib/*-watch.js`), so the panel can list them all;
its switch decides which ones run, and a Source that is off reports `sourceOff` and idles. Turning one on is a
switch in the panel plus whatever setup that Source needs - never a profile edit.

Every capability of the WeChat channel, why it is shaped that way, and the two traps found on real hardware (one
UI-automation client per machine; a bridge restart must never let the stored cursor swallow the chat) are recorded
in [ADR-007](docs/extensions/ADR-007-weixin-capability-alignment.md).

Full feature detail — every field, endpoint, idempotency rule, capability state and known gap — is
in [EXTENSIONS.md](EXTENSIONS.md).

## Status

Measured on `main`, on both platforms this project is developed on:

| Check | macOS arm64 / node 22.23.2 | Windows 11 / node 22.21.1 |
| --- | --- | --- |
| `tsc --noEmit` | 0 | 0 |
| `vitest run --maxWorkers=2` | 83 files, 1435 tests, 1421 passed, 14 skipped, 0 failed (last run **before** the WeChat work) | 85 files, 1479 tests, 1443 passed, 36 skipped, 0 failed |
| `tsdown` | build complete, 8 entries: index + 7 watch plugins | same |
| `LIVE=1 vitest run tests/live` | 13 passed + 1 skipped (before) | 14 passed + 1 skipped |

The 21 extra Windows skips are recorded per file in [HANDOVER-WIN11.md](HANDOVER-WIN11.md) §2: the
POSIX service manager and one Feishu stub that needs a live child process. Nothing was skipped to
make a failure disappear.

Verified against real systems, not only mocks: a real WeChat 4.x client through a real sidecar
process (group and direct messages by push, group `@`, image download, idempotent send), the real
`gitlab.com` API (merge-request mapping, a bogus token mapped to 401 without echoing it), and real
WeCom / DingTalk / Yunxiao authentication failures surfaced as diagnosable errors.

## Quick start

```bash
npm install --ignore-scripts --legacy-peer-deps   # pnpm 11 stalls on ERR_PNPM_IGNORED_BUILDS here
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/vitest run --maxWorkers=2     # use --maxWorkers=2: unlimited parallelism flakes timing-sensitive specs
./node_modules/.bin/tsdown                        # produces lib/*-watch.js
```

Then follow [SETUP.md](SETUP.md) to install the bundle into a profile, and turn a channel on in the panel
(Settings → Source). Every Source is listed there already; the ones that are off are collapsed.

Two optional dependencies are not in `package.json` because the canonical lockfile is pnpm's and it
cannot be regenerated on Windows: `@deepseek-ai/cordis-plugin-include` and
`@deepseek-ai/dsh-http-proxy`. Install them by hand if `tests/environment.spec.ts` or
`tests/bundle-patch.spec.ts` cannot resolve them.

## WeChat, and why it has a sidecar

The WeChat desktop client cannot be driven from Node, so it sits behind a loopback HTTP sidecar with
a frozen contract (JSON events, a `0600` bearer token, loopback only). The Node side knows only the
contract, which is what keeps the backend replaceable:

| Tier | Backend | When it applies |
| --- | --- | --- |
| L0 | `wxauto` / `wxauto4` / `wxautox4` (UI automation) | default; needs an interactive Windows desktop session |
| L1 | a `wxhelper`-class hook | **ruled out**: it only targets WeChat 3.9.x and its message payload has no mention list, so it would not deliver `@` either (ADR-005 §7) |
| L2 | a `WeChatPadPro`-class iPad protocol service | no Windows machine available |
| L3 | a hosted API | everything else is down and the work cannot stop |

`L0` is implemented and runs against a real client. It receives by **listening**
(`AddListenChat` + `StartListening`), so a message arrives when it is sent instead of being scraped
from whatever the window happens to have rendered.

What a backend can prove is **published per instance**, so nobody has to guess:

| Capability | L0 today | Meaning |
| --- | --- | --- |
| `mentions` | `markup` | group `@` is read from the client's own mention markup (`@name` + `U+2005`), not from a typed `@name`; a pasted separator can still forge it |
| `members` | `observed` | only the senders seen so far, never the full roster |
| `media` | per build | the paid build has `download()`; the free one does not |

The honest gap: WeChat 4.x exposes **no structured mention list** — the message bubble is a flat
accessibility leaf — so `ats` cannot be `structured` grade on this tier. That, and what would fix it,
is recorded in [ADR-005 §7](docs/extensions/ADR-005-weixin-backend.md).

Configuring a chat happens once, in the panel: the polling loop pushes the configured chats to
`POST /listen` every round and the sidecar acts only on the difference, so adding or removing a group
needs no restart. The chat and sender rows are pickers, because a `wxname_<hash>` id keeps the id
patterns strict but is not something a person can type.

## Layout

| Path | What |
| --- | --- |
| `src/sources/{hosting,work,chat}/port.ts` | the three provider contracts: change requests, work items, chat |
| `src/sources/instance.ts` | instance id vs channel id, and the compatibility rule |
| `src/sources/{weixin,gitlab,projex,dingtalk,wecom}-watch.ts` | the five optional plugins |
| `src/infra/{hosting-api,yunxiao-api,secret-file}.ts` | token-file HTTP clients, path allowlists, the owner-only rule |
| `sidecar/wxauto-bridge/` | the WeChat sidecar and its frozen contract; the live test runs it |
| `tests/live/*.live.spec.ts` | live suites, gated by `LIVE=1` |

The bundle's own identifier stays `dsh-superagent`: it is what `cordis.patch.yml` inserts and what
`scripts/dsh-superagent` is named after. The repository is `dsh-superagent-channels`; the plugin is not.

## Documentation

- [EXTENSIONS.md](EXTENSIONS.md) — the feature detail: what each channel adds, and how to add another
- [REPOSITORY.md](REPOSITORY.md) — how this repository is managed, provenance, and how to detach a copy
- [HANDOVER-WIN11.md](HANDOVER-WIN11.md) — running it on Windows: the measured baseline, the failures that had to be fixed, and the WeChat probe
- [SETUP.md](SETUP.md) — installing the bundle into a profile
- Decisions: [ADR-005 WeChat backend](docs/extensions/ADR-005-weixin-backend.md) · [ADR-006 health keys](docs/extensions/ADR-006-health-key-compatibility.md)
- The upstream numbered guide still describes the agent itself: [000](docs/000-philosophy.md) · [001](docs/001-domain.md) · [002](docs/002-authorization.md) · [003](docs/003-execution.md) · [004](docs/004-prompts.md) · [005](docs/005-panel.md) · [006](docs/006-deployment.md) · [007](docs/007-architecture.md) · [008](docs/008-cookbook.md)

## License and boundaries

MIT, the same as the prototype this edition grew from; the upstream copyright notice is kept. See
[REPOSITORY.md](REPOSITORY.md) for provenance.

WeChat automation through UI automation is third-party tooling. It is not authorised by Tencent, it
may be limited by the client or the platform at any time, and it must stay inside the boundaries
recorded in ADR-005: reply only when addressed, never broadcast, never bulk-add contacts, one
account signed in at a time.
