# Listing/Introduction Request to deepseek1024 (send after open-sourcing)

> Language: [English](1024-submission.en-US.md) · [中文](1024-submission.md)

The site's submission entry follows its current page; if there is no public form, use the email/direct-message template below.

## Subject

`Plugin listing request: dsh-superagent multi-channel (six-Source extension for DSH superagent)`

## Body

> Hello,
>
> I'd like to submit a DSH plugin to deepseek1024: **dsh-superagent multi-channel**.
>
> - Repository: https://github.com/baojingyu/dsh-superagent-multi-channel
> - npm: `dsh-superagent-multi-channel`, version 2.4.0, MIT
> - In one line: adds WeChat, WeCom, DingTalk, and Alibaba Cloud Yunxiao Projex to DSH's superagent while keeping the official Feishu/GitHub channels; the six Sources are unified into an "Assessment → Ticket → Execution → Reply" loop and can be installed alongside the official superagent.
> - Whose scenario it fits: teams that spread requirements across Feishu/WeChat/WeCom/DingTalk/Yunxiao and want one agent to take tickets uniformly, execute in an isolated directory, return results to the original Thread, and optionally advance Yunxiao work item statuses.
> - Safety and boundaries: all state is in the local stateDir, tokens are in 0600 files, replies are passive only — no mass sending, no group creation; platform limits (no deep links, no history for WeCom/DingTalk, DingTalk needs an injected SDK connection) are stated openly in the README and capability matrix.
> - Screenshots and docs: repository README (real screenshots, sensitive info redacted), the full `docs/` set, and the capability comparison in `docs/extensions/capability-matrix.md`.
>
> If your site needs a specific format (title, summary length, category, icon, demo video) or a submission form, please let me know, and I'll fill it in accordingly. Thanks!

## Short fallback version (form fields)

- Name: dsh-superagent multi-channel
- Type: DSH plugin / collaboration and workflow
- Links: repository + npm
- Summary (≤120 chars): Adds WeChat, WeCom, DingTalk, and Yunxiao Projex to DSH superagent, coexists with the official Feishu/GitHub channels, and unifies the Assessment→Ticket→Execution→Reply loop.
