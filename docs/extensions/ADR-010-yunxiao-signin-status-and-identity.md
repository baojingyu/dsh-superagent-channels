# ADR-010: Yunxiao sign-in, the real status vocabulary, RICHTEXT attachments, and an independent plugin identity

Status: accepted (2026-11-14) · Scope: `src/infra/yunxiao-oauth.ts`, `src/infra/yunxiao-api.ts`,
`src/sources/work/**`, `cordis.patch.yml`, `src/client/**`, `package.json`, `locale/**`

## Context

Four gaps remained after the work-item feedback work: an operator still pasted a personal access token by hand; the
status names came from what recent items happened to show rather than from the project's own workflow; an attachment was
pasted into a plain comment body as Markdown, which a rich-text reader does not render; and the bundle kept the official
superagent's internal ids, so the two could not be installed in one profile without sharing a panel slot, a preset id or a
state lock.

## Decisions

### 1. Sign in through Yunxiao's OAuth 2.0 server, and keep the token file as the credential

Yunxiao documents an OAuth 2.0 authorization server: authorization code, mandatory PKCE S256, public clients only
(`token_endpoint_auth_method: none`), dynamic client registration, metadata discovery, opaque tokens (`oat-` 24 h,
`ort-` 90 days). That is exactly a desktop plugin's shape, so `yunxiao-oauth.ts` implements it: discover the endpoints,
register a client with the loopback redirect, open the browser, take the code on `127.0.0.1:<ephemeral>/callback`, and
exchange it.

The result is written to the **same owner-only token file** every reader already uses; the refresh token, client id,
token endpoint and expiry go in a sibling `<tokenFile>.oauth.json`. This keeps one contract for both credential kinds: a
personal access token still works (no sibling file, no renewal), and the OAuth path adds renewal. The client renews once
after a 401 and retries, so a 24-hour access token does not require a daily visit to the panel; the browser is needed only
every 90 days.

Not chosen: DSH's `ctx.credentials` records. They would tie the token to one profile and leave the headless/CLI path with a
different mechanism; the file is already how this plugin is operated, and it keeps the token out of configuration, out of
logs and out of the panel. The token never passes through the panel: the browser talks to the loopback listener.

### 2. The status vocabulary is the project's workflow, not the recent items' statuses

`GetWorkitemWorkflow` has two forms. The Region form (`/oapi/v1/projex/projects/{id}/workitemTypes/{id}/workflows`) has no
organization segment, which the client's path confinement refuses by design. The **central** form does:
`/oapi/v1/projex/organizations/{org}/projects/{id}/workitemTypes/{typeId}/workflows`, and `ListWorkitemTypes`
(`?category=Req|Bug|Task`) supplies `typeId`. So `listStatuses` reads the enabled types per category and each type's
statuses, and the source card's action stores them.

The earlier "observed statuses" (statuses seen on polled items) remain as a fallback: a status never used by an item is in
the workflow but not observed, and a project whose types cannot be read still resolves what it has read. A name that is in
neither place is refused with the action that fills the vocabulary.

### 3. An attachment comments as RICHTEXT, using the host's own embed

`CreateWorkitemComment` documents `content` plus `formatType` (`RICHTEXT` or `MARKDOWN`, default `RICHTEXT`), and
`CreateWorkitemAttachment` returns `embedHtml`, `embedMarkdown`, `embedUrl` and `url`. Pasting `embedMarkdown` into a
plain body was the bug: a rich-text reader never renders it.

A comment **with** attachments is now `formatType: 'RICHTEXT'`: the text is escaped into `<p>` blocks (single newlines
become `<br/>`), each upload's `embedHtml` (an `<img>` for images, a link otherwise) follows, and the idempotency marker
rides as an HTML comment. A comment **without** attachments keeps the plain text it always had, so Markdown the agent
writes stays as it was. Reading back, `noteBody` strips HTML when the stored content is HTML, so the model sees text.
The marker is detected by the raw payload before any stripping, so a retry still posts once.

### 4. The plugin gets its own identity, so both superagents can be installed

Bundle entry ids (`dsh-superagent-multi-channel`, `…-<source>`), preset ids (`…-worker`, `…-router`), the panel slot and
the locale namespace are now unique to this bundle; `locale/*.json` describe it ("Superagent multi-channel") and
`icon.svg` is exported. Two bundles inserting the same row ids, or defining the same preset ids, or registering the same
panel slot, collide; with unique ids they coexist, and each instance simply needs its own `stateDir` (one directory admits
one instance, and the lock says so).

Kept on purpose because they live **inside this plugin's own state**, invisible to the other bundle: the
`dsh-superagent:` message-source kind on delivered messages, the `dsh-superagent-` skill-name prefix, and the
`scripts/dsh-superagent` service script. Renaming those would break resumes of existing sessions and existing skills for
no coexistence benefit.

Upgrading an existing installation: rename the profile's `dsh-superagent` block to `dsh-superagent-multi-channel` and keep
its `stateDir`; the SQLite database, tickets, cursors and settings are all in that directory, so no data migration is
needed. Install paths (plugin manager, community market, custom index, tarball, local directory) are in
`docs/006-deployment.md`.

## Consequences

- The token file now has a second, optional companion file; an operator who copied only the token file keeps working until
  the access token expires, and the 401 then asks for a new sign-in instead of renewing.
- The status action makes one request per type per category on demand; a project with many types costs a few calls, never
  a poll.
- An attachment is only as good as the host's `embedHtml`; a host that returns none falls back to a link, which is visible
  in the comment but is not the host's own preview.
- Tests cover all four: the OAuth flow (including a forged-state rejection and a real loopback callback), the status list,
  the RICHTEXT body and its marker detection, and the renamed ids in the bundle patch, presets, client registration and
  docs. Discovery and dynamic client registration were also exercised against the production central site
  (`https://openapi-rdc.aliyuncs.com` → an `account-devops.aliyun.com` authorization endpoint, a real `client_id`); the
  consent step and token exchange need a person, which is what `verify/oauth-check.py` and the panel action provide.
