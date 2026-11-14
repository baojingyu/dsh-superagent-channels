# ADR-009: Projex feedback, attachments, member sync and search — the routes we could reach

Status: accepted (2026-11-13) · Scope: `src/sources/work/**`, `src/infra/yunxiao-api.ts`, `src/app/store-read.ts`

## Context

The Projex channel could receive a work item and comment on it, but the three stages of a collaboration were each missing
one piece: an assessment of a comment saw only that comment; a worker did not know which item it was on; and the board
never moved. Completing them raised four questions whose answers are not obvious from the code, because the official
OpenAPI puts some routes out of reach of the client's own safety rules. This ADR records what we call, what we do not,
and why.

## Decisions

### 1. A status is configured by name, resolved against statuses this instance has read

Yunxiao publishes a workflow-status list, but the reachable form is
`GET /oapi/v1/projex/projects/{projectId}/workitemTypes/{id}/workflows` — **Region edition only**: no organization
segment (the client refuses any path without `/oapi/v1/organizations/{whitelisted}/`), and it needs a `workitemTypeId`
the adapter does not have. The old `GET /organization/{org}/workitems/workflow/listWorkflowStatus` predates `/oapi/v1/`
and the gateway has already retired other old paths (`GET /listWorkitems` answers 404), so it is not a route to build on.

What every work item **does** carry is its current status: `{id, name}`. A poll therefore records the status names and
ids it read (`KV.work.statuses`, bounded to 200) and the two write-back fields accept a name or an id. An opaque ASCII
token is passed through as an id we have not seen; a human name we have not seen is refused with the place to get one
(the source card's **Observed statuses** action, which lists what the last read returned). This trades completeness for
reachability: the vocabulary is what the project's recent items show, which is exactly the set an operator would pick
from.

### 2. An attachment is uploaded to the item, then embedded in the comment

`POST /oapi/v1/projex/organizations/{org}/workitems/{id}/attachments` (multipart `file`) is reachable and documented. It
returns `embedMarkdown` / `embedUrl` / `url`; the comment body is the only write surface a work channel has, so the
upload's Markdown embed (images) or a Markdown link (other files) is appended to the comment text.

Three guards, because this is a channel for files to leave the machine: the worker's `orchestrator_report` already
resolves each path inside the ticket directory and refuses executables and files over 20 MiB; the Source's `sendFiles`
switch (default **off**) is read again in the channel; and the channel's own 10 MiB cap is enforced in the provider,
which names an over-cap file in the comment instead of failing the delivery. Projex's true size limit is unknown, so the
host's rejection stays the final word — that failure surfaces through the outbox like any other reply failure.

### 3. The member list syncs from the project, not the organization

`GET /oapi/v1/platform/organizations/{org}/members` is reachable, but a whole organization is the wrong scope for
"who may originate work on this project". The new-style `GET /oapi/v1/projex/organizations/{org}/projects/{id}/members`
returns project members with `userId` and `userName`, which is the right set and the right id shape: the Policy compares
`allowed[].id` with the work item's `assignedTo`, and in the central edition that is the member `userId`. The assumption
is documented rather than proven (no live token here); a mismatch would show up as every item refused as unlisted, which
the Policy card already warns about.

The sync is a `policy.sync` on the shared work factory, gated by a new `syncMembers` switch (default **off**), because a
sync **replaces** a hand-kept list. Like Feishu's, it applies to the default instance only: `Settings.syncable()` resolves
`kind(instance.id)`, which only finds a kind whose id equals its instance id.

### 4. Search resolves a serial, not a thread

The panel searches triggers and threads; a work item's human number (`ESFX-6228`) is what people type. `projexKind.find`
turns a bare serial or a `…/workitem/…` address into a search term, and `Store.read.search` matches `meta.serial`
exactly, the same way it already matched a Feishu `meta.messageId`. A work-item page is addressed by serial while a
thread is keyed by the internal item id, so this resolution finds the item's triggers and tickets but does not bind a
thread from a pasted URL; binding still goes through the conversation id the poll wrote.

## Consequences

- Two things stay unverified against a real organization: the status write (id resolution from names is proven, the PUT
  is not) and the attachment embed's layout in a RICH TEXT comment. Both are marked as gaps in `EXTENSIONS.md`; the
  adapter's shapes come from the published request syntax.
- The status vocabulary grows only as items are read. A project whose items have never used a status cannot name it
  until one does; typing its id still works.
- `sendFiles` and `syncMembers` are off by default, so upgrading changes no behaviour until an operator asks for it.
