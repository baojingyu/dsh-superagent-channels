# Changelog

Versions follow semantic versioning; each release is published to the plugin market under the package name
`dsh-superagent-multi-channel`, so a user upgrades by installing the new version.

## 2.4.0

The WeChat channel now carries what the Feishu channel carries for the agent: it can read the original conversation, and
the panel can find a message and follow a reply.

- **Worker reads of a WeChat conversation.** `weixin/<trigger-id>/message`, `/thread` and `/around` mirror Feishu's
  resource grammar (`{ status, message }` / `{ status, messages, next_resource }`), with `/around` answering the page that
  holds the Trigger. Reads are trigger-scoped and cost one sidecar call per page; `weixinBridge` builds the client from the
  instance configuration.
- **A `dsh-superagent-weixin` skill** is registered next to the Feishu and GitHub skills, documenting the resources, the
  `[image:<id>]` markers, and the two limits below.
- **The assessment's ThreadContext now honours its parts**: `thread` (a page), `parent` (the quoted message, when the
  bridge reports one) and `root` (which answers `no_root`, because WeChat has no topic root rather than an invented one).
- **Search and reply mapping.** A platform message ID becomes a panel search term (`meta.nativeId` matches exactly), and
  `repliesTo` maps a quoted reply to the Trigger it answers, so a thread shows the exchange.
- **`readPageSize`** (1–50) joins the configuration, shared by assessment reads and worker resources.
- **A deleted work item stops shouting.** Projex answers a comment or status call on an item in the recycle bin with HTTP
  400 `InvaildData.Failed`; `isWorkItemGone` recognises it, so the Thread is marked `gone` and never read again, the phase is
  remembered as settled, and the operator's deletion is no longer reported as a poll error. Before, one deleted item would
  repeat the same 400 on every round.
- **All six sources read the same way.** The four added sources now match the two official ones on the read model:
  `projex/<trigger-id>/item` and `/comments` (paged, the agent's own comment marked), `dingtalk/<trigger-id>/message` with a
  DingTalk ThreadContext (`thread` = the callback message, `no_root`, `no_parent`), WeCom `refreshLabels` over a department's
  users plus a `departmentId` setting, and a `dsh-superagent-dingtalk` skill. `docs/extensions/capability-matrix.md` lists
  every dimension for Feishu, GitHub, WeChat, WeCom, DingTalk and Projex, and names the remaining platform limits (no history
  on WeCom/DingTalk, no deep link on the three chat backends, DingTalk's stream SDK still injected by the deployment).
- **WeCom is wired and reads like Feishu.** The plugin now mounts the signed callback route at `/wecom/<instance>` and turns
  each callback into a Trigger (a group reply by `chatid`, a person by `touser`); an `image` callback's `MediaId` becomes
  `[image:<id>]` and the assessment downloads it through the media API; `wecom/<trigger-id>/message` is the worker read; and
  the ThreadContext answers `thread` (the one message), `no_root` and `no_parent`. Two optional config fields (`token`, inline
  `encodingAesKey`) verify the callback. No history, deep link or chat member roster on this backend - stated in ADR-012.
- **Every Source has a prompt skill.** WeChat, Yunxiao Projex and WeCom now ship a bundled skill beside Feishu and GitHub,
  registered in every Session and editable under Prompts: WeChat covers its reads and image download, Projex the item/comment
  model and its `DSH_SUPERAGENT_PROJEX_*` identity, WeCom the callback's limits (no history, plain text, no idempotency key).
  `composeSkill` composes all built-in skills from their part (previously only Feishu and GitHub did, so the WeChat skill had
  been registered empty).
- **Status write-back is picked, not typed.** The two Projex write-back fields are dropdowns of the project's workflow
  statuses: **Read Yunxiao status list** on the card (or the refresh beside a field) rereads them and stores `id -> name` for
  the pickers, so a person chooses "处理中" and the id is what is written. A name or an id still works, and a status seen only
  in a poll remains a fallback.
- **A worker can download a message's images.** The WeChat skill uses `DSH_SUPERAGENT_WEIXIN_BRIDGE` and
  `DSH_SUPERAGENT_WEIXIN_TOKEN_FILE` (new environment variables) with one `curl`/`Invoke-WebRequest` against `GET /media/<id>`,
  then reads the file; `/media` serialises with `/send`, and a 401 is reported instead of guessed.
- **Backfilled messages are marked historical.** The sidecar's post-re-attach / first-listen read-back (last 20 messages, up to
  3 chats a round) now carries `historical: true`, so `pollChat` hands them to the assessment without a receipt, a canned reply
  or a still-working note — old words are readable but never answered.
- Not possible on this backend, and stated rather than faked: no message deep link (the sidecar exposes none), no bot list
  (WeChat has no bot concept; the bridge reports `bot:false`), and no topic root. See ADR-011.

## 2.3.0

Four things an operator asked for: a real sign-in instead of pasting a token, the project's real status list instead of a
guess, comments that render attachments properly, and a plugin that is truly independent of the official superagent.

- **Sign in with Yunxiao (OAuth 2.0).** `src/infra/yunxiao-oauth.ts` implements the flow Yunxiao documents: endpoint
  discovery from `/.well-known/oauth-authorization-server`, dynamic client registration (public client, no secret),
  authorization code with PKCE S256, a loopback callback on `127.0.0.1`, and a token exchange. The Projex source card gains
  **Sign in with Yunxiao**, which opens the browser, takes the redirect, and writes the access token to the configured token
  file; the refresh token and expiry go in a sibling `<tokenFile>.oauth.json`, and the client renews the 24-hour access token
  in place when the API answers 401 (refresh token: 90 days). No token is typed, and none passes through the panel.
- **The real status vocabulary.** `GetWorkitemWorkflow` was out of reach earlier because only its Region form is reachable
  without an organization segment; the central form
  (`GET …/organizations/{org}/projects/{id}/workitemTypes/{typeId}/workflows`) is reachable once the type id is known, and
  `ListWorkitemTypes` supplies it. `listStatuses` reads the types per category and each type's workflow statuses, and the
  source card's **Read Yunxiao status list** action stores them, so the two write-back fields can be filled by the name a
  person reads. The poll's observed statuses remain as a fallback.
- **Attachments render as the host documents them.** `CreateWorkitemComment` takes `content` plus `formatType`; a comment
  carrying attachments is now `RICHTEXT`, with the text escaped into paragraphs, each upload's own `embedHtml` (an `<img>`)
  or a link appended, and the idempotency marker riding along as an HTML comment. Previously the Markdown string was pasted
  into a plain body, where a rich-text reader never rendered it.
- **A nearly independent plugin.** Bundle entry ids and the panel slot are now `dsh-superagent-multi-channel*` instead of
  `dsh-superagent*`, and `stateDir` defaults to an existing `~/.dsh/state/superagent` (else this plugin's own), so an
  installation can be installed beside another superagent bundle without overwriting its rows or panel slot, and a switch
  carries the data along. The **agent preset ids stay `dsh-superagent-worker`/`-router`** on purpose: a Session persisted by
  an older bundle stores that id in its header, and a renamed preset made `resume` fail with `Unknown agent preset`; keeping
  the ids lets a switch resume every existing Session. A Host holds one Source kind per id, so only one superagent bundle is
  **enabled** at a time; that is documented rather than papered over. Display metadata (`locale/*.json`) now
  names it "Superagent multi-channel" / "Superagent 多通道", and `icon.svg` is exported. `docs/006-deployment.md` gained
  "Install beside the official superagent" and "Install from a plugin market or a tarball". Upgrading: rename the old
  `dsh-superagent` profile block to `dsh-superagent-multi-channel` and keep its `stateDir`; with both installed, each needs
  its own `stateDir`.
- `package.json` exports the icon and lists it in `files`; the version is 2.3.0.

## 2.2.0

The Projex channel no longer needs a status id hunted out of the web UI, can attach a deliverable to a comment, syncs its
member list from the project, and can be searched by the serial people actually use.

- **Status write-back by name or id.** `work/feedback.ts` resolves the two configured statuses against the status names
  this instance has read on its items (`KV.work.statuses`, filled by every poll). A name that has never been seen is
  refused with the place to find one - the source card's new **Observed statuses** action - instead of being sent to
  Yunxiao as a status; an opaque ASCII token is still passed through as an id.
- **Comment attachments.** `POST …/workitems/{id}/attachments` (multipart) is implemented in the Projex adapter and the
  API client (`postForm`). With the new **sendFiles** switch on, a file a worker reports from its ticket directory is
  uploaded and the host's `embedMarkdown` (images) or a Markdown link (other files) is appended to the comment. Off by
  default, and gated twice: the tool refuses earlier, the channel refuses again.
- **Member sync.** `GET …/projects/{id}/members` is implemented. `policy.sync` is generated by the shared work factory;
  the Projex kind adds a **syncMembers** switch to its Policy part, and the sync keeps the operator's order, refreshes
  names in place, appends new members, and runs at startup only when the switch is on.
- **Search by serial or page address.** `projexKind.find` turns `ESFX-6228` or a `…/workitem/…` address into a search
  term, and the trigger store matches `meta.serial` exactly, so the panel's search box finds the item and its comments.
- Docs: `EXTENSIONS.md` / `EXTENSIONS.zh-CN.md` §3.2 and the parity table describe all four; the Projex kind's fields
  gained `sendFiles` and its Policy part gained `syncMembers`.

## 2.1.0

The Yunxiao Projex channel now covers all three stages of a collaboration - assess, execute, feed back - instead of
receiving a work item and commenting on it. Each stage was missing one piece, and each piece is now in place.

- **Assess**: `workThreadContext` (`src/sources/work/context.ts`) reads a work item as one conversation rather than one
  Trigger's text. The description is the root message (`[ESFX-6228] title` plus body), the comments follow in time order
  and continue across the host's pages, the agent's own marked comments are marked `bot` so they never read as a
  person's request, the item's structured facts (`serial`, `category`, `status`, `assignee`, `url`) travel beside the
  messages, and embedded images come back from the local archive as attachments. An assessment of a comment can now see
  what the comment is about; before, it saw the comment alone - no title, no description, no earlier answer. A comment
  Trigger also carries the item's category, so a comment and its item are judged in the same admission row instead of a
  comment falling back to the table's defaults.
- **Execute**: `workEnvironment` (`src/sources/work/environment.ts`) exports the item a worker is on -
  `DSH_SUPERAGENT_PROJEX_PROJECT / _WORKITEM / _SERIAL / _CATEGORY / _STATUS / _URL`, with `_ORG` from the Projex kind -
  where the GitHub kind puts its repository and number. A worker can now name the work item in a commit message, a pull
  request and a reply, instead of writing "this change" about an item it cannot identify.
- **Feed back**: `reflectWorkTickets` (`src/sources/work/feedback.ts`) writes the configured statuses onto the item: the
  start status while a ticket works on it, the done status once it ended (completed, merged, dropped; never for a ticket
  a person stopped). Each phase is written once per ticket through a KV ledger, the item is read first so a status
  already current is not rewritten, and a failure is recorded in the poll result and retried on the next round. The
  board therefore follows the ticket instead of sitting untouched from acceptance to delivery.
- The two statuses are new configuration (`statusOnStart`, `statusOnDone`), gated by the existing `writeBack` switch,
  which stays **off** by default: the agent still delivers in comments unless the operator asks for status write-back.
- The rest of the work port is unchanged: Projex remains the only host implemented on it, and the shared pieces it grew
  (`workThreadContext`, `workEnvironment`) are what a second work host would build on.

## 2.0.0

Renamed from `dsh-superagent-channels` to `dsh-superagent-multi-channel`, repository included. A major version because
the package name an installation pins changes with it.

- Package, repository, bundle module names, panel entry and documentation now say `dsh-superagent-multi-channel`. The
  repository moved to `github.com/baojingyu/dsh-superagent-multi-channel`.
- The internal bundle identifier stays `dsh-superagent`. It is what `cordis.patch.yml` inserts, what a profile's
  `stateDir` setting targets and what `scripts/dsh-superagent` is named after; renaming it would orphan every saved
  setting and Ticket, so it is deliberately unchanged.
- `src/infra/paths.ts` resolves all three names this package has shipped under - `dsh-superagent-multi-channel`,
  `dsh-superagent-channels` and `dsh-superagent` - so a deployment installed before the rename keeps working.
- Upgrading an existing installation: remove the old `dsh-superagent-channels` package and install
  `dsh-superagent-multi-channel`; settings, Tickets and the state directory are untouched because the identifier did not
  change.

## 1.0.7

A ticket's question for a person now reaches the Source even when the main Session never sends an attention reply, so a
work item no longer goes silent while the work waits on someone.

- `Replies.announceAttention`: when a worker reports a new question, the question is queued to the conversation that must
  hear it - where the person who raised it wrote, else the ticket's starting conversation - under the same
  `attention-reply` id an attention reply uses. Whichever is queued first wins, so the question is never posted twice,
  and replacing or clearing the question withdraws the queued one as before. A ticket a machine asked for is skipped,
  because there is no person to tell. This matches what `announceEnd` already did for an ending.
- Prompts: `work.md` now says that ending a turn to wait for a person is the same mistake as leaving the question only in
  a summary, and `replies.md` tells the main Session that a reported question is already queued, so
  `orchestrator_reply` attention is for wording it better rather than for posting it.

## 1.0.6


Projex work items now deliver their comments and inline images, and a blocked ticket resumes when a person answers.

- Comment polling: for every work item a live ticket follows, read `/comments` every 60 s; a person's comment becomes a
  human Trigger on the item's thread (text = the comment, actor = the author). Deduplicated by comment id + creation
  time; comments carrying the agent's `<!-- dsh-superagent:` marker, and bots, are skipped.
- First-sight backfill `backfillComments` (default 20, per-Source advanced setting, 0 disables): the newest N person
  comments are delivered oldest first; older ones are dropped. After the per-item watermark (`KV.work.notes`) only newer
  comments are delivered, so a restart re-delivers nothing.
- Inline images in a description or comment (`<img src="...fileIdentifier=...">`) are resolved through the Projex files
  API, de-duplicated by sha256 and archived under `<stateDir>/projex-images` (0600; PNG/JPEG/WebP/GIF, 10 MiB default
  cap). Failed or oversized images are recorded and never block the text Trigger; the Trigger text names each image so
  the assessment window (`image_id`) and an Executor's `read_image` can read it. Images stay local.
- Resume fix: when a human Trigger reaches a ticket still in `person/answer`, `Tickets.addInput` clears the stale
  `attention`, withdraws its unanswered reply, ends the stalled Assignment (`reason=resumed`) and starts a new one with
  the reply waiting. Bot/CI inputs do not wake it; duplicate inputs stay idempotent.
- Panel: a routed attach (recorded as an `ignore` with a `routed` reason) renders as "已转工单 / Attached to ticket" with
  its target ticket, instead of as an ignore.
- `packageRoot()` accepts both `dsh-superagent-multi-channel` and `dsh-superagent`.

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
