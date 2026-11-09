# Changelog

Versions follow semantic versioning; each release is published to the plugin market under the package name
`dsh-superagent-channels`, so a user upgrades by installing the new version.

## 1.0.3

The WeChat bridge is controlled entirely from the panel, with no command line and no scheduled-task setup.

- Advanced -> Bridge launcher holds the absolute path of the machine's start script. Start launches it detached and windowless, so the
  bridge survives a DSH restart; the script's contents (client library, local shim) never enter the repository.
- Stop finds the process listening on the bridge's own port and ends it only after its command line proves it is the sidecar.
- Restart is stop-then-start; Check still reads /health. A configured task name remains the fallback when no launcher is set.

## 1.0.2

The WeChat bridge can be started and stopped from the panel, without the plugin owning the process.

- Source cards may declare fixed actions; the panel renders them as buttons and the host runs one named action, never a command.
- The WeChat card offers Start / Stop / Restart / Check: the first three ask the machine's scheduled task (`schtasks /run|/end /tn`)
  to run or end wxauto-bridge, which stays a separate process because it needs the interactive desktop session and must outlive a
  DSH restart; Check reads /health and reports the backend's capabilities or why it is unavailable.
- The task name is a validated field (Advanced), checked in the schema and again in the runner.

## 1.0.1

WeChat path brought to "configure it and it works", and the panel tells the truth about what a backend can do.

- Reception is per group and lives in the Source: each group hands over only messages that mention the agent, or all of them; the
  old global switch is the default for a new group. Sources decide what they can see, the Policy decides what counts as work.
- The WeChat allow list is user id plus name, the same as Feishu; its group/direct marking became internal bookkeeping.
- Sync from group follows the backend's real capability: a full roster replaces, an observed backend (wxautox4 reports only who has
  spoken) only adds, and fetching nobody explains why instead of reporting success.
- A saved Policy is validated by the settings schema as well as the Source's own; the two are now held in agreement by a test, after
  a field one accepted made every WeChat list row unsaveable.
- GitLab gained a Policy (account list, bot list, four reception ranges); DingTalk and WeCom offer the rows their scope reports.
- Source cards order enabled first, then by English name; no Markdown markers in panel copy.

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
