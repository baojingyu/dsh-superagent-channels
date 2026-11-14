# Release and Directory Listing Materials (Draft for review)

> Language: [English](README.en-US.md) · [中文](README.md)

**Status: docs reviewed and open-sourced (2026-11-14); npm publish is blocked by login state; the package has not yet been submitted for listing on any platform.**

## Completed

- [x] Open-sourced: `main` pushed (commits `5f2ade3`, `15565ac`), tag `v2.4.0` pushed
- [x] Repository: https://github.com/baojingyu/dsh-superagent-multi-channel (PUBLIC)
- [x] Release v2.4.0 with a directly installable tarball:
      https://github.com/baojingyu/dsh-superagent-multi-channel/releases/download/v2.4.0/dsh-superagent-multi-channel-2.4.0.tgz
- [x] GitHub topics added: `dsh-plugin`, `deepseek-harness`, etc. (dshfind / 1024Store scan by topic)
- [x] **dsh-desktop Issue #1650**: https://github.com/anywhere-labs/dsh-desktop/issues/1650
- [x] **dshfind Issue #80**: https://github.com/hikariming/dshfind/issues/80
- [x] **npm published**: `dsh-superagent-multi-channel@2.4.0`, latest points to 2.4.0
      https://www.npmjs.com/package/dsh-superagent-multi-channel
- [x] GitHub Pages enabled (main /docs); catalog manifest:
      https://baojingyu.github.io/dsh-superagent-multi-channel/distribution/catalog/catalog-source.json
      endpoint: https://baojingyu.github.io/dsh-superagent-multi-channel/distribution/catalog/v1/plugins
      (manifest measured `application/json`; endpoint measured `application/octet-stream`; if the Host strictly checks content-type, host on
      Cloudflare/Vercel or use path B)

## Blockers

- [ ] **npm login/2FA**: signed in as `juelianyu`; both access tokens can read (`npm whoami` works) but `npm publish` both report
      `403 Two-factor authentication or granular access token with bypass 2fa enabled is required`. Need:
      ① npmjs → Access Tokens → generate a **Granular Access Token** with **Bypass 2FA** checked and Read and write permission; or
      ② provide the current **6-digit OTP code** (not a token); or ③ run `npm publish --access public` in a local terminal.
      Before publishing, dshfind's "npm package matches the repository" is unsatisfied; Issue #80 notes it is in first release.
- [ ] **deepseek1024**: the site has no public submission form; it auto-indexes by GitHub repository/topic (14k+ plugins); the repository
      has the `dsh-plugin` topic added and is expected to be scanned in. If you have a site contact/form, give me the entry point and I'll submit.
- [ ] **Community Market hosting**: `transport.endpoint` must be HTTPS with a path ending in `/v1/plugins` (no `.json`) and return a JSON
      content-type; GitHub Pages returns extensionless files as `application/octet-stream`, which the Host may reject. Before sending, deploy to a
      static host that can set content-type (Cloudflare Pages / Vercel / self-hosted reverse proxy), or switch to path B (reviewed adapter). Noted in Issue #1650.

## Pre-release checklist (checked by Lead)

- [x] `pnpm typecheck` 0, `pnpm test` 102 files / 1624 passed / 0 failed, `pnpm build` 8 entries
- [x] `package.json` name `dsh-superagent-multi-channel`, version `2.4.0`, `files` includes `lib`, `cordis.patch.yml`, `locale`, `skills`, `icon.svg`
- [x] README rewritten in both Chinese and English to the current 2.4.0 state, with real screenshots (sensitive info redacted) and diagrams
- [x] Capability matrix and platform limits documented (`docs/extensions/capability-matrix.md`)
- [x] All six Source Skills present; `docs/images/` contains only redacted screenshots
- [x] Repository URL confirmed as `github.com/baojingyu/dsh-superagent-multi-channel`
- [x] npm package name confirmed as the unscoped `dsh-superagent-multi-channel`
- [x] Open-sourced: `main` pushed (`5f2ade3`) + tag `v2.4.0` pushed
- [ ] npm publish — **pending local `npm login`** (currently `ENEEDAUTH`)
- [ ] Submit for listing on the platforms below — **do this after npm publish**

## Listing targets and materials

| Platform | Entry | Which material |
| --- | --- | --- |
| DSH Community Market | Directory integration (path A: static manifest + `/v1/plugins`) | The manifest and page in [`catalog/`](catalog/), hosted on GitHub Pages; or path B per [market-adapter-request.md](market-adapter-request.md) |
| dshfind | Submit via the site / its GitHub repo | [dshfind-submission.md](dshfind-submission.md) |
| deepseek1024 | Site listing / contact | [1024-submission.md](1024-submission.md) |
| dsh-desktop Issues | New issue | [dsh-desktop-issue.md](dsh-desktop-issue.md) |

## Unified one-line description

> dsh-superagent multi-channel: adds WeChat, WeCom, DingTalk, and Yunxiao Projex to DSH's superagent, and unifies the six Sources into an "Assessment → Ticket → Execution → Reply" loop; installs alongside the official Feishu/GitHub channels.

## Shared key points (common to all platforms)

- Package name: `dsh-superagent-multi-channel`; version 2.4.0; license MIT.
- Relation to the official `dsh-superagent`: installs alongside, with independent entry id / panel entry / state directory; only one superagent is enabled on a Host at a time (the same Source kind can be registered only once).
- Data and privacy: all state is in the local `stateDir`; tokens prefer 0600 files; replies are passive only — no mass sending, no group creation, no friend requests.
- Platform limits (stated openly, not exaggerated): WeChat/WeCom/DingTalk have no message deep links; WeCom and DingTalk have no history backfill; DingTalk Stream requires deploying an injected SDK connection; WeChat is third-party UI automation.
- Screenshots: three real screenshots in the README (Policy, Yunxiao Source card, Prompts), sensitive info redacted.
