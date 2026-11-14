# Listing Request to dshfind (send after open-sourcing)

> Language: [English](dshfind-submission.en-US.md) · [中文](dshfind-submission.md)

dshfind's plugin store is maintained by the site and its GitHub repository (https://github.com/hikariming/dshfind). First submit the following information via an Issue/PR in its repository or the submission entry the site provides; if the site has no public submission entry, send the "General request" below to the site maintainers.

## Plugin entry (structured)

```yaml
name: dsh-superagent-multi-channel
displayName: dsh-superagent multi-channel
version: 2.4.0
license: MIT
repo: https://github.com/baojingyu/dsh-superagent-multi-channel
npm: dsh-superagent-multi-channel
categories: [collaboration, chat, work-items]
keywords: [dsh, superagent, wechat, wecom, dingtalk, yunxiao, projex, feishu, github]
summary: Adds WeChat, WeCom, DingTalk, and Yunxiao Projex to DSH superagent, coexists with the official Feishu/GitHub channels, and unifies it into an "Assessment → Ticket → Execution → Reply" loop.
```

## General request (ready to paste)

> Hello, I'd like to apply to list a DSH plugin: **dsh-superagent multi-channel**.
>
> - Repository: https://github.com/baojingyu/dsh-superagent-multi-channel
> - npm: `dsh-superagent-multi-channel` (2.4.0, MIT)
> - Purpose: the official superagent only has Feishu and GitHub; this plugin adds WeChat, WeCom, DingTalk, and Alibaba Cloud Yunxiao Projex, and unifies the six Sources into an "Assessment → Ticket → Execution → Reply" loop; it can be installed alongside the official superagent.
> - Panel: a standalone sidebar entry "Superagent multi-channel", with Sources / Triggers / Assessment / Execution / Prompts / Deployment.
> - Data and boundaries: all state is local; tokens in 0600 files; passive replies only; capabilities the platform cannot do (deep links, WeCom/DingTalk history, DingTalk SDK connection) are stated explicitly in the README and capability matrix.
> - Screenshots: real screenshots in the README (sensitive info redacted).
>
> If listing needs specific fields (category, labels, icon, license, demo URL) or a particular submission template, please let me know, and I'll fill it in to spec.

## Notes

- Only includes plugins where "the npm package matches the repository": after publishing to npm, ensure `package.json`'s `repository` matches the repository (already filled in).
- After listing, if indexing to `https://api.dshfind.com/market/dsh-index.json` is needed, just submit the repository info per its instructions.
