# ADR-007 Aligning WeChat channel capabilities: SiverWXBot's feature surface vs this repository

> Language: [English](ADR-007-weixin-capability-alignment.en-US.md) · [中文](ADR-007-weixin-capability-alignment.md)

- **Status**: Accepted, all three phases implemented (2026-11-08): P1 `7b4e316`, P2 `c4350a8`, P3 this commit
- **Decision scope**: the WeChat source's (`src/sources/chat/weixin/`) panel fields, sidecar outbound capabilities, and the ownership of keyword-based routing
- **Related**: ADR-005 (L0 backend and the @ criterion), ADR-006 (health entry keys), `sidecar/wxauto-bridge/contract.md`

## 1. Summary of conclusions

1. **One-to-one chats**: listening, text and images are all usable (verified on a real machine). "Add contact" in the panel simply selects that person from the chat dropdown — the bridge only lists **chats it has actually seen**, and there is no entry point for typing a wxid by hand (the display-name-derived `wxname_…` is not a real wxid).
2. **Group chats**: listening, reply-only-on-@, and group images are all usable; @ is at the `markup` tier (client marker), not a structured mention.
3. **Two library limitations**, not configuration problems:
   - **Quoting a message when replying: not doable**. Among `wxautox4`'s `SendMsg(msg: str, who, clear, at, exact)` and all of `Chat`'s public members there is **no quote/ref parameter at all** (`Chat` members: `SendMsg` `SendFiles` `SendAudio` `AtAll` `GetNewMessage` …). WeChat 4.x's "quote" can only be done through right-click menu UI interaction, which is fragile and not exposed. Substitute: write the quote into the body prefix (`「引用 @张三」原文…`).
   - **@-ing the speaker when replying: doable**. `SendMsg(..., at: Union[str, List[str]])` supports it, and `at` takes a display name; this repository previously **deliberately** did not wire it (the `send()` docstring states "never put `at=`"), because inbound `FriendMessage.at` is a "nudge" action and was once misused as a group @. Outbound `at=` is a different path, and wiring it requires separate real-machine verification.
4. **Speech recognition**: inbound is already implemented (`to_text`, 8-second cap, tried once, degrading to `（语音转写失败）` on failure), but it **has not been verified on a real voice message**; every call occupies the client UI for up to 8 seconds, so it needs a switch rather than being always on by default.
5. **Keywords**: this repository has none at all; it is a new capability, not a checkbox. It can be done in two layers, see §5.

## 2. Item-by-item alignment

| SiverWXBot's capability | Current state in this repository | Configurable in the panel? | Conclusion |
|---|---|---|---|
| Enable group listening | Already present (`rooms` collection, `/listen` replaces the set, idempotent) | ✅ present | Aligned |
| Reply only when @-ed | Already present (`atOnly`, criterion is `markup`) | ✅ present | Aligned; applies to groups only, one-to-one chats have no @ concept |
| One-to-one listening / one-to-one reply | Already present (`room: ""` one-to-one stream, id → stream mapping) | ✅ present (pick a person from the chat dropdown) | Aligned; missing the wording and hint for the "one-to-one" case |
| Group images | Already present (inbound `media` + `/media` download, PNG magic number verified on a real machine) | 🔶 no switch | Needs an `images` switch (when off, keep only the `[图片]` placeholder) |
| One-to-one images | The same chain, verified on a real machine (69-byte PNG) | 🔶 no switch | Same as above |
| Speech recognition | Implemented, **not verified on a real machine**; occupies the UI for ≤8s each time | 🔶 no switch | Needs a `voice` switch, on by default, and acceptance on real voice messages |
| @ the speaker when replying | **Not implemented** (the sidecar explicitly does not pass `at`) | ❌ | Doable: a `mentionBack` switch + sidecar `at=[sender display name]`; groups only, and needs real-machine verification |
| Quote the message when replying | **Not implemented** | ❌ | **The library does not support it**: no quote parameter. Substitute `quoteStyle: 'text'`, writing the quote into the body |
| Group keyword replies | Not implemented | ❌ | Doable, see §5 |
| One-to-one keyword replies | Not implemented | ❌ | Doable, see §5 |
| Outbound images/files | Not implemented (the contract sends text only) | ❌ | Doable (`SendFiles(filepath, who)` exists), but requires the core `OutboundMessage` to support attachments, which is another order of magnitude |
| Adding contacts by hand in the panel | Can only pick from chats the bridge has seen | ✅ present (candidate dropdown) | There is no real wxid to take, so hand entry cannot be validated; keeping "pick from candidates only" is safer |

## 3. Technical evidence (real-machine verification this round)

```text
WeChat.SendMsg(self, msg: str, who: str = None, clear: bool = True,
                at: Union[str, List[str]] = None, exact: bool = False,
                max_retries: int = 3) -> WxResponse
Chat.SendMsg(self, msg: str, who: str = None, clear: bool = True,
             at: Union[str, List[str]] = None, exact: bool = False) -> WxResponse
Chat 公开成员：AddGroupMembers AtAll CancelCall ChatInfo Close EditFriendInfo
              GetAllMessage GetDialog GetNewMessage LoadMoreCache SendAudio
              SendFavorite SendFiles SendMsg SetGroupAnnouncement
              SetGroupMyNickname SetGroupName SetGroupRemark Show VideoCall
              VoiceCall chat_type
```

- One-to-one text: `/messages?room=<wxname person id>` returns an event with `room: ""` (already fixed).
- One-to-one images: the event carries `media: [{"id":"<nativeId>#0","kind":"image"}]`, and `/media` returns 69 bytes, `89 50 4e 47` = a valid PNG.
- Repeated `/listen` pushes already return within 0.02s without touching the UI (the repeatedly popping-up contacts window was fixed).

## 4. Panel field design (proposed additions)

| key | type | default | purpose |
|---|---|---|---|
| `rooms` | rows (existing) | `[]` | **Relabel** as "Groups and one-to-one"; picking a group = group chat, picking a person = one-to-one |
| `atOnly` | switch (existing) | `true` | Reply only when @-ed (groups) |
| `mentionBack` | switch | `true` | Include @ when replying to whoever @-ed me in a group (**groups only**) |
| `quoteStyle` | select `none`/`text` | `text` | There is no real quote API; `text` = note the quoted target in the body prefix |
| `images` | switch | `true` | Whether to hand images to the model as attachments |
| `voice` | switch | `true` | Whether to transcribe voice (when off, use the `[语音消息]` placeholder and save UI) |
| `keywords` | rows `[{ any, note }]` | `[]` | Hitting any keyword counts as an **explicit request** (goes through the existing admission model) |
| `autoReplies` | rows `[{ any, reply, stopAgent }]` | `[]` | On a hit, **reply with fixed text directly** (without the agent), optionally suppressing the hand-off to the agent at the same time |

## 5. Phasing

| Phase | Content | Impact surface | Estimate |
|---|---|---|---|
| **P1** | Panel wording and hints (groups and one-to-one, explanation of the auto-filled `姓名`); wire the `images` / `voice` switches into inbound rendering | `kind.ts`, the branches before the sidecar's `_render_text`/`_to_event` | 0.5 day |
| **P2** | `mentionBack`: sidecar `send(..., at=[name])` + contract field + Node side passing the sender per the switch + **in-group real-machine verification** | sidecar, `bridge.ts`, `contract.md` | 1 day |
| **P3** | `keywords` → admission (a hit is explicit); `autoReplies` → the listen loop calls `/send` directly | `kind.ts`'s scope/explicit, `weixin-watch.ts` | 1.5 days |
| **Implemented** | P1: wording + `voice`/`images` switches | `kind.ts`, sidecar `options`, `verify/options-check.py` | done |
| **Implemented** | P2: `mentionBack` (sidecar `at`, contract, panel, `verify/mention-check.py`) | sidecar, `bridge.ts`, `kind.ts` | done (not run in a real group, to avoid speaking in a real group) |
| **Implemented** | P3: `keywords` + `autoReplies` | `scope()`, `weixin-watch.ts`, `ports.ts` | done |
| **Implemented** | P4: immediate receipt + in-progress reminder (`acknowledge`/`ackText`/`progressAfterSeconds`) | `weixin-watch.ts`'s `pollChat`, `kind.ts` | done |
| **Implemented** | P5: listener self-healing (10 minutes with no event → detach then attach, at most once per 15 minutes; `/health` reports "latest event / re-attach count") | `server.py`'s `_reattach_if_quiet`, `_start_listener_watchdog`; `verify/listener-check.py` | done |
| **Implemented** | P6: cursor monotonic across restarts (sequence clock seeding + responses carry `head`); when a client cursor is ahead, read from the start | `server.py`, `bridge.ts`, `weixin-watch.ts` | done |
| — | `quoteStyle: 'text'` | The current state is already "quote written into the body", with no separate switch | not needed |
| — | Outbound images/files | Requires the core `OutboundMessage` attachment model | separate ADR |

## 5.1 The basis for P4 (measured timeline, from `state/superagent/orchestrator.sqlite`)

| Message | System action | Latency |
|---|---|---|
| 07:14 a "test" | 07:14:53 judged ignore | 53 seconds, no receipt (correct: no request) |
| 07:14 "make a web page…" | 07:16:09 judged accept, and a receipt is sent at the same time | **2 minutes 09 seconds** |
| 07:30 "publish to the public internet…" | 07:32:00 merged into an existing ticket, **with no receipt at all** | 2 minutes of total silence |

Conclusion: the sense of waiting comes from two places — **the assessment itself takes tens of seconds to two minutes**, and **a message appended to an existing ticket carries no receipt**. So the receipt is sent by the source side before the assessment, and an in-progress reminder is added for "the bot has not spoken in this session yet". Shortening the assessment itself is out of scope for this phase (it involves model choice and prompt size).

## 6. Risks

1. **The semantic trap of `at=`**: inbound `Message.at` is a "nudge", outbound `SendMsg(at=…)` is a mention — same name, different meaning. P2 must use a dedicated case to prove "after sending, a real @ notification appears in the group and no nudge was triggered".
2. **Speech transcription occupies the UI**: `to_text` seizes the client interface for up to 8 seconds, during which listen callbacks may be delayed. On by default but must be switchable off, and "transcribing" must be exposed in `detail`.
3. **Keyword auto-replies bypass the admission model**: `autoReplies` are sent directly by the listen loop, meaning anyone can trigger a send with one configured phrase. It must be restricted to sessions already configured for this source, and constrained by the sidecar's ≥1s send interval.
4. **Quotes can only be rendered as text**: if a user expects WeChat's native "quote" style, it cannot be done here, and the panel hint must say so.

## 7. 2026-11-10 wrap-up: receiving is per group, the roster carries no source, sync follows backend capability

After getting the WeChat path working on a real machine, three design points converged from first principles:

- **The source governs perception, the assessment governs authorisation.** The source decides "what is visible": which groups are received, whether one-to-one is received, and how much each group hands over (only messages that `@` the bot, or all messages).
  The assessment decides "what counts as work": who may originate, in which scope, and at what strength. So the group list, the one-to-one switch and each group's receive mode live in the source; the roster and the admission table live in the assessment.
- **"Receive only @" sinks down to each group.** A single global switch would express the same thing as "in the roster but not @-ed" in the admission table (with the switch on, those two cells in the admission table are always "—").
  It changes to "Receive: only @ / all messages" on the group row, consistent with Feishu's group list; the old `atOnly` degrades to "the default receive mode for new groups", taking effect only when a group has none set,
  so old configurations behave unchanged.
- **The roster carries no "source" column.** Whether a message is a group message or a one-to-one message is a property of the message itself (whether it has a `room`), and the admission table splits rows accordingly; the roster holds only authorisation,
  consistent with Feishu, with just "user ID + name". The provenance marker used by sync (which rows were written by sync) becomes internal data and takes no interface space.
- **Sync works according to the backend's real capability.** wxautox4's `capabilities.members` is `observed`: it has no group member table interface
  (`GetAllRecentGroups()` only gives group names and member counts), so `/members` can only return **the people who have spoken in this group**. Measured:
  `GET /health` → `{"mentions":"markup","members":"observed","media":true}`; `GET /members?room=AI研究群` → `{"members":[]}`.
  Therefore on an `observed` backend, sync is a **union** (add only, never delete, so quiet members are not wrongly removed), and it replaces only when a full roster (`full`) is returned; when 0 people are obtained it
  reports an error explicitly with the reason, and `none` is refused outright.
- **The two schema layers must describe the same shape consistently.** The source's own schema generates the form, and only the settings layer's `AllowedSchema` really validates what is saved; if the two do not match,
  a row the panel can produce cannot be saved (this round's real fault: `via` was judged an unknown field by the settings layer, making the whole row invalid and the roster permanently empty). Tests now put every source's
  part and marked roster rows through the settings-layer schema to catch this.

Evidence surface: `tests/admission-tables.spec.ts` (admission table shape and cross-schema), `tests/weixin-kind.spec.ts` (receiving per group, merge semantics).
