# Changelog

## 1.0.6

A blocked ticket now resumes when a person answers its question, and a routed attach is shown as "attached to a ticket".

- Person reply fixes: `Tickets.addInput` clears a stale `attention` when a human Trigger reaches a ticket still in
  `person/answer`, withdraws the unanswered attention reply, ends the stalled Assignment (`reason=resumed`) and starts a
  new one with the reply waiting. Bot/CI inputs neither wake nor clear it; duplicate inputs stay idempotent.
- Panel: a routed attach (recorded as an `ignore` whose reason is `routed`) now renders as "已转工单 / Attached to ticket"
  with its target ticket, instead of being shown as an ignore.
- Includes the 1.0.5 `backfillComments` change and the package-root double-name fix.

## 1.0.5

Projex comment collection backfills the newest N person comments on first sight (default 20, configurable per Source).

- First sight of a followed, live work item now delivers its newest `backfillComments` person comments (default 20)
  instead of only the newest one; older comments are dropped. Bot comments and the agent's own
  `<!-- dsh-superagent:` marked comments never count towards N. After the per-item comment watermark is written, only
  comments newer than it are delivered, so a restart re-delivers nothing already seen.
- `backfillComments` is an advanced per-Source setting (0 disables the first-sight backfill).
- No other behaviour changes from 1.0.4.

## 1.0.4

Projex work items now deliver their comments as Triggers and archive inline images.

- A live ticket's work item is polled for comments (`/comments`) with a per-item watermark; a person's comment becomes a
  human Trigger (text = the comment, actor = its author) and the agent's own marked comments are skipped.
- Work-item and comment images (`<img … fileIdentifier=…>`) are fetched through the Projex files API, de-duplicated by
  sha256 under `<stateDir>/projex-images`, and named in the Trigger text by marker plus local path so the assessment
  window (`image_id`) and the Executor's `read_image` can both read them. Failed or oversized images are recorded and
  never block the text Trigger.

## Packaging

The bundle is published as `dsh-superagent-channels-<version>.tgz`. A DSH profile installs it through a `file:`
dependency in its `package.json`, keeping `node_modules` and `pnpm-lock.yaml` in step, then restarts the client. Roll
back by restoring the previous tgz and `node_modules` directory together with the saved `package.json` /
`pnpm-lock.yaml`, then restarting.
