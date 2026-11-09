# Changelog

Versions follow semantic versioning; each release is published to the plugin market under the package name
`dsh-superagent-channels`, so a user upgrades by installing the new version.

## 1.0.0

First standalone release under its own name, installable next to the official superagent.

- Seven Sources: WeChat, Feishu, DingTalk, WeCom, GitLab, Yunxiao Projex and GitHub.
- One admission table shape for every Source: rows are reception ranges with a short annotation, and only the cells that range
  really has are offered.
- A chat Source names one admission row per conversation; GitLab gained a Policy (account list, bot list, four ranges).
- A work item the agent wrote is no longer read back as a new request (self-write ledger).
- A ticket that ends tells the conversation it started in, when the main Session did not.
- A refusal notice reaches a conversation only, never somebody's work item.
- The state lock tolerates a restart; the settings page survives one Source's bad configuration.
- Sources sort enabled first, then by English name; no Markdown markers in panel copy.
