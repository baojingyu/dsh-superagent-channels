# ADR-012: Aligning WeCom with Feishu

Status: accepted (2026-11-14) · Scope: `src/sources/chat/wecom/**`, `src/sources/wecom-watch.ts`, `src/app/resources.ts`,
`skills/dsh-superagent-wecom/**`

## Context

The Feishu channel receives messages, carries images, lets an agent read the original message (and its thread/topic), maps a
reply to its parent and can be searched by message ID. WeCom had a kind, an XML parser, a sender and a pure callback handler,
but **no route mounted it**, so nothing arrived; it carried text only; it had no ThreadContext, no worker read, and no image
handling. This ADR closes the gap where the backend can, and states the rest.

## Decisions

### 1. The plugin mounts the callback route itself

`wecom-watch` now registers a public `prefix` route at `/wecom/<instance>` on the Host web server. It looks the instance's
configuration up in the Source registry, reads the body with a 1 MB ceiling, calls the existing `handleWebhook` (signature →
decrypt → parse → dedupe ring per instance), turns each event into a Trigger with `wecomTriggerOf`, and hands it to that
kind's `SourceContext.receive`. The reply is the encrypted `success` (or the decrypted `echostr` for URL verification). The
route is public because WeCom signs every call; ops points the application's receive URL at it. This is the one place the
plugin serves an untrusted request, and a bad signature yields no event.

### 2. Images travel by `MediaId`, and the assessment can download them

An `image` callback carries a `MediaId` and no text. `parseXml` now returns such an event with `media: [{ id, kind: 'image' }]`;
the reader and the ThreadContext render `[image:<id>]`, and the ThreadContext's `image` downloads the bytes with the sender's
`media` call (`GET /cgi-bin/media/get`), whose JSON error shape is detected before the body is treated as bytes. The worker
sees the marker; the assessment, which holds the instance configuration, attaches the image. Text and other message types are
unchanged, and voice/video/file/location still produce no event — stated, not faked.

### 3. What a callback can and cannot answer

A callback is one message: `thread` is that message, `root` answers `no_root`, `parent` answers `no_parent`, there is no
history backfill and no next page. `wecom/<trigger-id>/message` is the worker read (one message). Search turns a decimal
`MsgId` into a Trigger term, and `repliesTo` exists but a callback carries no quoted ID, so it is normally empty.

## What stays impossible on this backend

- **No history.** The receive API is a push callback; there is no read-back endpoint to page a conversation, so no backfill
  and no `/thread` pages.
- **No message deep link.** There is no per-message URL; the channel link is empty and the panel names the Source.
- **No chat member roster.** Enumerating a group's members is not available to a self-built application without the customer
  contact APIs and permissions that differ per enterprise; equating the app's visible users with a chat's members would be
  wrong, so no sync is offered.
- **Worker image bytes.** A worker has the marker but not the corp secret, so it cannot call the media API; the assessment
  downloads the image instead.

## Consequences

- WeCom is functional for the first time: a callback becomes a Trigger, and a reply goes back to the same chat or person.
- Two config fields (`token`, inline `encodingAesKey`) were added for signature verification, both optional so an existing
  stored configuration still parses; without `token` every callback is refused, which `facts` and the field hint say.
- Tests cover the image parse, the Trigger address (`chatid` vs `touser`), the resource grammar, and the ThreadContext parts.
