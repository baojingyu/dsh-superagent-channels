# Issue for dsh-desktop (send after open-sourcing)

> Language: [English](dsh-desktop-issue.en-US.md) · [中文](dsh-desktop-issue.md)

**Title**: `[Plugin listing] dsh-superagent multi-channel: add WeChat / WeCom / DingTalk / Yunxiao Projex to superagent`

**Body (Markdown, ready to paste)**

```markdown
## What this is

`dsh-superagent-multi-channel` is an extension bundle for the official superagent: it keeps the Feishu and GitHub Sources and **adds** WeChat personal accounts, WeCom,
DingTalk, and Alibaba Cloud Yunxiao Projex, unifying the six Sources into the same "Assessment → Ticket → Execution → Reply" loop. It can be installed alongside the official `dsh-superagent`
(independent entry id, panel entry, and state directory).

- Repository: https://github.com/baojingyu/dsh-superagent-multi-channel
- Package: npm `dsh-superagent-multi-channel`, version `2.4.0`, license MIT
- Catalog manifest (path A): https://baojingyu.github.io/dsh-superagent-multi-channel/catalog-source.json

## Capability overview

| Source | Receiving | Highlights |
| --- | --- | --- |
| Feishu / GitHub | Official channels | Kept as-is |
| WeChat | sidecar polling | Structured @, voice transcription, downloadable images, worker reads `weixin/<id>/…` |
| WeCom | Signed callback (the plugin mounts `/wecom/<instance>`) | @ detection, inbound images, contact-list roster |
| DingTalk | Stream (deploy an injected SDK connection) | staffId @, Markdown 5000 |
| Yunxiao Projex | Work item polling | Comments, status write-back, attachments, worker reads `projex/<id>/item·comments` |

Panel: a standalone sidebar entry "Superagent multi-channel", with Overview / Sources / Triggers / Assessment / Execution / Settings / Prompts / Deployment.
Screenshots are in the repository README (real screenshots, sensitive info redacted).

## Data and security

- All state is in the local `stateDir`; tokens prefer 0600 files; the panel and logs do not print secrets.
- Passive replies only: no mass sending, no group creation, no friend requests; comments carry an idempotency marker, and events are deduplicated by platform message ID.
- Platform limits stated openly: WeChat/WeCom/DingTalk have no message deep links; WeCom and DingTalk have no history backfill; DingTalk Stream requires deploying an injected SDK connection; the WeChat channel is third-party UI automation, not authorized by Tencent.

## Verification

`tsc` 0; `vitest` 102 files / 1624 passed / 0 failed; `tsdown` 8 entries.

## Request

I would like:
1. This plugin to be listed in the Community Market catalog (the path A static source is being prepared);
2. If there are listing rules or additional field requirements, please point them out, and I'll adjust the manifest and README accordingly.
```

**Pre-send check**: the repository is public, the npm package is published (or note "the catalog points to the repository; npm is in first release"), and the manifest URL is reachable.
