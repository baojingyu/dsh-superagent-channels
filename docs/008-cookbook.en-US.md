# Common practices and troubleshooting

> Language: [English](008-cookbook.en-US.md) · [中文](008-cookbook.md)

## Let only people on the allowed list start work

1. Panel → Assessment → select the Source on each Source (DingTalk / Feishu / GitHub / GitLab / Yunxiao Projex / WeCom / WeChat).
2. Add people under "users who may start work". For WeChat and WeCom you can click "立即同步 / 刷新名单" (Sync now / Refresh the list) to pull them in from chat members or the contact directory.
3. The admission table is defined row by row: on the list / not on the list × mentioned in the chat / not mentioned / direct message. A person who is not on the list does not become a Ticket even when they mention the bot.

## In a chat, respond only when mentioned

- WeChat / DingTalk / WeCom: set that chat's or Source's "receive" to "mentions only" (set the "not mentioned in the chat" row of the admission table to "ignore").
- Feishu: set the chat's "receive" to "mentions only"; work items and GitHub have no such concept.

## Turn off status write-back to the board

Panel → Sources → Yunxiao Projex → turn off "write the work item status back". It is off by default: the agent only delivers in comments and does not change the board. Once it is on, you must choose two statuses (the dropdowns show the names on the board, while the status IDs are what is actually written).

## Let the Executor read the original context

| Source | Resources |
| --- | --- |
| Feishu | `feishu/<trigger-id>/message`, `/root`, `/parent`, `/thread`, `/around` |
| GitHub | `github/<trigger-id>/…` |
| WeChat | `weixin/<trigger-id>/message`, `/thread`, `/around` (images as `[image:<id>]`, downloadable with `GET /media`) |
| WeCom | `wecom/<trigger-id>/message` |
| DingTalk | `dingtalk/<trigger-id>/message` |
| Yunxiao Projex | `projex/<trigger-id>/item`, `/comments` (paginated) |

Resources are read-only: reading creates no Trigger, sends no reply and changes no remote state.

## Troubleshooting

| Symptom | What to look at first |
| --- | --- |
| The panel shows "dsh-superagent 没有响应" (dsh-superagent is not responding) | Most likely the plugin is not mounted: check the DSH log for `dsh-superagent ready`; a common cause is that a preset name of an old Session in the state directory no longer exists (fixed in 2.3.0, presets use shared ids), or that `stateDir` is configured wrongly. |
| Yunxiao reports `操作失败，当前工作项已进回收站` (Operation failed, the current work item is in the recycle bin) | A person deleted the work item. The plugin treats it as "gone": the Thread is marked `gone`, is no longer read and no longer reports errors; after restoring the work item, delete the old Thread so it appears again. |
| The Yunxiao authorization page shows `invalid client_id or redirect_uri` | Before 2.4.0, Windows `cmd start` truncated the URL at `&`; this now uses `rundll32 url.dll,FileProtocolHandler`. After upgrading, restart DSH and then authorize. |
| WeCom receives no messages | The app's "receive messages" URL must be `https://<公网>/wecom/<实例>` and reverse-proxied to this service; `回调 Token` (callback Token) and `EncodingAESKey` must match the admin console, and everything is rejected (403) when the Token is missing. |
| DingTalk does not listen | This bundle does not include the Stream SDK: a deployment must inject `connect()` (the `dingtalk-stream` client); `facts` and the health check say "not injected". |
| The WeChat bridge drops offline | The panel's "check" reads `/health`; with no events for a long time it re-attaches by itself; after switching accounts or logging in again the bridge re-attaches, with no need to restart the plugin. |
| A status name is reported as "never seen" | First click "read the Yunxiao status vocabulary" on the Source card (or refresh next to the field), then select the name from the dropdown. |
| After an upgrade both sets of plugins are enabled | Only one registration per Source kind is allowed: stop the old `dsh-superagent-channels` first, then enable this plugin; leaving `stateDir` empty keeps the original directory. |

## Add a Source yourself

1. Implement `ChatAdapter` (polling/stream/callback) or `WorkAdapter`, and define `SourceKind` (scope / policy / channel / threadContext / find / refreshLabels).
2. Add one line to `cordis.patch.yml`: `- id: ... name: dsh-superagent-multi-channel/<name>-watch`.
3. Add resources for the worker: `RESOURCES` and the routes in `src/app/resources.ts`, and document them in `skills/dsh-superagent-<name>/SKILL.md`.
4. Add unit tests: reading, reference syntax, the three context parts, and the troubleshooting fields; run `pnpm check`.
