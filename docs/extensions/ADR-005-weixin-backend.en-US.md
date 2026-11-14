# ADR-005 Backend selection and switchover strategy for WeChat personal-account group messages

> Language: [English](ADR-005-weixin-backend.en-US.md) · [中文](ADR-005-weixin-backend.md)

- **Status**: Accepted (2026-11-06, confirmed by the solution owner)
- **Decision scope**: the backend form, primary/standby strategy and deployment prerequisites of `src/sources/chat/weixin/*`
- **Related**: design document §6.7, §6.7.9, §6.7.10; this document does not repeat the background, it only fixes the decision

## 1. Background (one sentence)

The WeChat group `@` bot is a **must-have** for this project, but the official ClawBot channel only covers one-to-one chats, and the open-source community's main backends have kept exiting over the past three years (itchat → gewechat → wcf). Therefore **any solution that "picks one backend and depends on it for the long term" is unacceptable**.

## 2. Decision

### 2.1 Form: a resident Windows sidecar + loopback HTTP

WeChat client automation runs on a **resident Windows machine**, exposing an HTTP contract on
`127.0.0.1` as an independent process (`sidecar/wxauto-bridge`) (see `sidecar/wxauto-bridge/contract.md`); dsh-superagent-multi-channel calls it through the
`src/sources/chat/weixin/pc-uia/*` adapter.

Reasons:
1. Client automation and the Agent runtime are **isolated in failure domain** — a WeChat disconnection should not drag down ticket execution;
2. The sidecar can be implemented in any language with any library, so switching backends does not touch DSH-side code;
3. The contract has few endpoints (one group each for read, send, media and listener set), so the deserialisation surface is small and the security surface is small.

### 2.2 The primary/standby ladder (by priority, not parallel candidates)

| Tier | Backend | Condition that triggers enabling |
|---|---|---|
| **L0** | `pc-uia` (the wxauto kind, UIAutomation, no process injection) | default |
| **L1** | `pc-hook` (the wxhelper kind, DLL injection + HTTP) | **struck out**: it only adapts 3.9.x, and the messages it hooks out have no `atuserlist`, so even installed it cannot get `@` (see §7 audit) |
| **L2** | `pad` (WeChatPadPro / community fork, iPad protocol) | no Windows machine, only Linux; the business accepts the protocol risk control in writing |
| **L3** | `hosted` (paid API) | L0–L2 all down and the business cannot stop |
| Bypass | WeCom customer group / official ClawBot one-to-one chat | the customer is willing to migrate the group / only one-to-one is needed (this is a requirement change, not a technical downgrade) |

**Only one instance holds the login state of the same WeChat account at any moment** (double-send / risk-control red line).

### 2.3 Hard constraints (written into the DoD; if unmet, "switchable" does not hold)

1. `WeixinBackend` ≤ 8 methods; a single backend implementation ≤ 400 lines.
2. On the dsh side, `replyConcurrency = 1` for the WeChat instance; `/send` is serialised by the bridge + 1s interval + jitter.
3. Switching backends = change the configuration + restart that instance, **without changing DSH code**; target ≤ 2 person-days.
4. Group `@` judgement recognises only `ats`; reverse-parsing the text `@nickname` is **forbidden**. `ats` may be derived from the client's own mention
   markers (see the `markup` tier in §7), but the strength must be declared in `/health.capabilities.mentions`,
   and it must not degrade into "the substring `@name` appeared in the body".
5. Permission boundary: passive replies only; no mass sending, no group creation, no friend adding.

## 3. Consequences

**Positive**
- If any backend exits, the business recovers within 60s (primary/standby takeover) to 2 person-days (cross-backend migration).
- Group messages, `@` and group members are three things fixed at the contract layer; the Node side depends only on the contract.

**Negative / costs**
- A Windows machine (or a real Android device) must stay resident; this is an **ops cost**, not a code cost.
- wxauto's author disclaimer prohibits production/commercial use → written confirmation from business + legal is required, otherwise L0 is unusable and it falls straight to L1.
- The bridge side adds one more process + one set of credentials (token + login state) to manage.

**Not doing**
- Not doing "multiple backends online simultaneously with double writes" (double sending in the same group).
- Not embedding client automation into the dsh process (mixing failure domains).
- Not promising "no risk control", only promising "switchable when limited".

## 4. Acceptance (the standard for this ADR being complete)

1. `poc/probe_wxauto.py` produces `probe-report.json` on the target Windows machine, and both **Q1 (group message fields + whether a structured ats exists)** and **Q2 (group member table)** have evidence.
2. `sidecar/wxauto-bridge` passes the contract self-test with `--backend fake` (already runnable in this repo, see the README).
3. After the real backend is connected, the six scenarios of design document §6.7.8 pass (including "`@` still works after a nickname change" and "a retry does not send twice").
4. Primary/standby switchover drill: stop the L0 process → L1 takes over within 60s, with no duplicate messages in the group.

## 5. Rollback

- Single-instance rollback: set the instance to `enabled:false` → that group is no longer connected, other channels are unaffected.
- Cross-backend rollback: change the `backend` configuration back to the previous tier, restart the instance; the login state requires re-scanning the QR code (WeChat does not allow two places online at the same time).
- Complete rollback: delete the `weixin` instance configuration and set the plugin to `disabled`; behaviour equals the v1.0 solution (no WeChat integration).

## 6. Open prerequisites (blocking items that the business side must provide)

| # | Prerequisite | Who provides it | Consequence of not providing it |
|---|---|---|---|
| 1 | Commitment of a resident Windows machine (or a real Android device) | business/ops | L0/L1 are all unavailable; the only options are L2 (highest risk) or the bypass |
| 2 | Confirmation of the wxauto production/commercial licence (legal) | business + legal | L0 is unavailable and it falls straight to L1 (injection risk) |
| 3 | A version-freeze policy for the target WeChat PC client (auto-upgrade not allowed) | ops | A client upgrade may break it immediately, and the switching cost goes back to "measured in weeks" |
| 4 | **The probe and the client must be in the same interactive desktop session** (physical console or an unlocked RDP; it cannot be run from an SSH/service/CI session) | ops | `wxauto` reads the client window through UIAutomation; across sessions the window is never visible, manifesting as `WindowDiscoveryError` |

## 7. Real-machine probe measurement records

### 2026-11-06 first run (Windows 11 / Python 3.13.17)

- Environment: `Windows-11-10.0.26200-SP0`, wxauto **3.9.11.17+dsh1** (built from `wxauto-fork/wxauto-main`)
- Result: `import wxauto` ✅; `attach client` ❌
  `WindowDiscoveryError: No visible Weixin/WeChat top-level window is accessible in Windows session 21. Discovered client window sessions: (none).`
- Verdict: **not a code defect, but a session/window visibility problem**. The probe process is in session 21 (a typical RDP/remote session), and UIAutomation can only enumerate top-level windows of its own session; if the client is in another session, or not started, or only in the tray, it all manifests as `(none)`.
- Therefore `poc/win_diag.py` was added: `python win_diag.py` directly reports the current process session, the session the WeChat window is in, whether it is administrator, and the next action; `probe_wxauto.py --diag` is equivalent. When attach fails it automatically prints next steps.
- **Admission status: still not passed** (Q1/Q2 both lack evidence). The next run must satisfy §6 prerequisite 4, and requires the client version to match the wxauto build (3.9.x and 4.x are two different UI sets).

### 2026-11-06 second run (same machine, session problem resolved)

- The probe can now **see and attach to the window**: `Weixin.exe`, pid 46576, session 21, class `Qt51514QWindowIcon`, title 微信;
  but `RuntimeError: Attached to Weixin/WeChat HWND 0x1F0C2A, but the wxauto 3.9 accessibility tree was not found`,
  root children = `MMUIRenderSubWindowHW` (the new UI container of WeChat 4.x).
- **Verdict: the client is WeChat 4.x, and `wxauto` (the 3.9 line) cannot drive it**. This is a version-generation problem, not a session problem (the window was visible this time).
- Feasible paths (choose one; costs/risks differ):
  | Path | Approach | Cost | Risk |
  | --- | --- | --- | --- |
  | **4.x route (do not touch the client)** | `pip install wxauto4` (free, Python 3.9–3.12, client ≤ 4.1.8.107) or `pip install wxautox4` (paid, Python ≤ 3.13) | Need to install Python 3.12 or buy an activation code; the client may need to be downgraded to ≤4.1.8.107 | The free version is sensitive to the client version |
  | **3.9 route (do not touch the toolchain)** | Install WeChat 3.9.11.17 + disable auto-update, keep using the existing `wxauto` fork | Need to lock the version on the client | The vendor may force an upgrade |
- **Q1 open risk (important)**: wxauto4's documented `Message` only has `attr/type/id/sender/content/info`, with **no documented structured `@` list** (`at` only appears on the sending side in `quote(text, at=[...])`). Therefore whether a group `@` can be judged structurally depends on whether the runtime `info` carries an at list — this must be decided after the probe dumps it. If it indeed does not, per the §6 prerequisite rule **the text `@nickname` reverse-parse must not be used**; switch to L2 (pad) or choose another backend.
- Tools upgraded: `poc/win_diag.py` judges 4.x as soon as it recognises `Weixin.exe`/`Qt51514QWindowIcon` and gives package advice; `poc/probe_wxauto.py` tries `import wxauto4` first and falls back to `wxauto`, and writes the package name into the report.

### 2026-11-07 probe v3: first guarantee that "a report always comes out"

- Symptom: running the old probe on Windows **did not generate `probe-report.json`**. Three reasons (all fixed):
  1) The old version's top-level `import win_diag` was a hard dependency, so copying only `probe_wxauto.py` gave `ModuleNotFoundError` and not a single line was written;
  2) The old version only tried `wxauto4` / `wxauto`, **not `wxautox4` (Plus)**, so even with the commercial version installed it judged "no package";
  3) `--out` defaulted to a filename relative to cwd, so the report might land in another directory.
- Since v3: `win_diag` is optional; packages are tried in the order `wxauto4 → wxautox4 → wxauto`; the report is always written in `finally` and prints the **absolute path**; `--selftest` was added (does not touch WeChat, only verifies the file-writing path).
- At the same time `@` detection was tightened: `attr` (message source system/self/friend) was removed from the candidates, and values in `atListCandidates` are required to really look like a list — otherwise the old logic would treat `attr` as an at list and **directly fool Q1**.
- Also, per user feedback: **after licensing the commercial version, WeChat message sending and receiving succeeded**. This shows the client and the Plus library are usable on that machine, but "the product can receive messages" does not equal "we can get a structured @ list"; Q1 still needs `atListCandidates` evidence.

### 2026-11-07 group message images (Q4): the capability is confirmed to exist; measure three metrics before implementing

- Based on the v4.0 documentation: in the message class table, `✨图片消息 ImageMessage` carries ✨ (exclusive to the Plus build); that class provides
  `download(dir_path, original)` and `ocr(timeout)`; an image in a group is an ordinary message with `type='image'`, `sender` is the group member,
  and `chat_info()` returns `chat_type='group'`. So the "recognise → download → OCR" chain holds, but **the commercial version is required**.
- Three constraints that must be measured first: ① the free build may only give `type='image'` without `download()`;
  ② `GetAllMessage()` only covers messages already rendered in the current window, and earlier images require `roll_into_view()` first, so with too large a polling interval the image may already have scrolled out of view;
  ③ downloading occupies the client UI and must be serialised with switching chats/sending messages, and becomes slower when the user is operating at the same time.
- The probe adds `--media`: it reports `media.imageCount / hasDownload / download.bytes / download.ms / ocr`,
  and on builds without `download()` it explicitly outputs `image messages need the Plus build`, never a false green.
- Implementation design (to be implemented once the data confirms the parameters): `ChatEvent.media` + sidecar `GET /media/<nativeId>` (download cache + TTL)
  + `weixinKind.threadContext.image()` to fetch the image as a model attachment (reusing the existing pattern of `feishu-image.ts`); outbound image sending is not done for now.

### 2026-11-07 Q1 verdict: L0 (pc-uia) has **no** structured `@`; but the conclusion "L0 is unusable" **is wrong**

> This section keeps two layers: first make clear **which part of the conclusion holds**, then make clear **which part was my misjudgement**. The latter is more important,
> because following the wrong conclusion would shut down a backend that works.

#### The part that holds: there is no structured `@` list

**Environment**: Windows 11 (session 1, console, Active) / Python 3.12.10 / `wxautox4` 41.2.3 /
WeChat 4.x (`C:\Program Files\Tencent\Weixin\Weixin.exe`, `Qt51514QWindowIcon`) / logged-in account `<wxid>`.
Probe: `poc/win_diag.py` → `a WeChat window is visible in this session`;
`poc/probe_wxauto.py --group "<群名>" --media` → `poc/probe-report.json`.

> **Privacy**: `probe-report.json` and the message dump contain **real chat content**. They are only used for local forensics, are not committed,
> and do not go into documents. Everything cited in this document is the **shape of the value** (`<wxid>`, `<昵称>`, `<群名>`, `<成员>`, `<显示名>`,
> `<微信号>`), not who exactly it is.

**Conclusion: `atListCandidates` is empty → per §4.1 the backend should switch to L2 (pad); a group `@` must not be text reverse-parsed.**

Three independent pieces of evidence (any one alone is enough to rule out L0's structured `@`):

1. **The UI tree is flat leaves.** The message control `mmui::ChatTextItemView` (`AutomationId`
   `chat_message_list.qt_scrollarea_viewport.chat_bubble_item_view`) has `childCount == 0`, and
   `TextPattern` / `ValuePattern` / `LegacyIAccessiblePattern` / `SelectionPattern` **are all absent**.
   `@nickname` and the body are the same `Name` string; the client does not render the mention as a separate element.
2. **The message object has no at list.** All fields of `FriendTextMessage` are
   `id / content / hash_text / hash / sender / chat_info / type / attr` (`attr` is the `friend|self|system` source marker).
3. **`FriendMessage.at` is an action, not a field.** It is a bound method; executing it is a "nudge" (拍一拍) and returns
   `WxResponse{"status":"成功"}`. Treating it as a value getter would **nudge a group member once per poll** — a real side effect.

> The only structural clue carrying `@` is the `U+2005` (four-per-em space) separator in the body, for example `@<成员>\u2005妈`.
> It is a **text** feature and can be forged by copy-paste, so it is recorded only as evidence in the report's `textSeparator`
> (`textDerived: true, usable: false`) and **does not constitute a judgement basis** (§2.3 hard rule 4).

**Four other L0 gaps clarified along the way** (also written into the contract, so they are not misjudged as bugs later):

| Contract field | Actual L0 situation | Consequence |
|---|---|---|
| `room` (chatroomId) | Unobtainable. `ChatInfo()` only has `chat_type/chat_name/group_member_count`; `SessionElement` only has `name/time/content/isnew/new_count/ismute` | `rooms[].id` can only use the display name, and the Node schema's `^[A-Za-z0-9_-]+$` rejects Chinese group names → **it simply cannot be expressed at the configuration layer** |
| `sender.id` | Display name only. `sender_info()`'s `id` is the WeChat ID (e.g. `<微信号>`), not `wxid_`, and it was **observed lagging by one message, sometimes returning `null`** | The Policy's wxid list is not enforceable on L0 |
| `at` (message time) | Ordinary messages have no time field, but the `TimeMessage` separator carries `time`; remembering the most recent separator per room gives minute-level alignment, and only historical messages from before the listener started fall back to the server receive time | Already implemented this way, see §3.2 |
| `/members` | No group member API (`_api` only has `add_group_members`) | The member table degrades to empty |

**Therefore L0 did not pass its admission bar, and not only on `@`**: even for one-to-one chats only, identity and timing do not reach the contract.
The strict `WXID_PATTERN` on the Node side is not a defect here but an **admission gate** — it blocks deployments that do not meet the bar.

#### The part I judged wrongly (corrected on the evening of 2026-11-07)

The analysis above **has correct evidence but a wrong conclusion**. Wrong in two places:

**Mistake one: I used `GetAllMessage()` to poll for messages.** It only returns messages **already rendered** in the current window,
and `ChatWith()` does not redraw when the target is already the current chat, so it periodically read 0 messages. I took this phenomenon
as "L0 cannot receive group messages". The owner pointed out that there is a working production implementation on this machine
(`D:\<wxauto4-env>\<wxbot-dir>\wxbot_core.py`), and it uses **listening mode**:

```python
self.wx.AddListenChat(nickname=..., callback=self.message_handle_callback)
self.wx.StartListening()
```

A real-machine retest (self-test with "文件传输助手" only, nothing sent into a group) confirmed: `AddListenChat` returns the chat name,
after `StartListening()` one `SendMsg` triggers the callback **twice in real time** (`TimeMessage` + `SelfTextMessage`),
the `chat` object gives `{'who': '文件传输助手', 'chat_type': 'friend'}`, and `msg.chat_info` gives
`{'chat_type': 'friend', 'chat_name': '文件传输助手'}`. **Push-based, does not depend on window rendering.**

**Mistake two: I inferred "no structured list" straight into "not admitted".** The production implementation uses text substring matching:

```python
self.config.AtMe = "@" + self.wx.nickname      # 2714 行
if self.config.AtMe in message.content: ...    # 3381 / 3405 / 3729 / 3748 行
```

It does work. But substring matching even misjudges "he just said the sentence `@<nickname>`". **A better criterion is the client's own marker**:
when you really pick a person from the mention list, WeChat inserts `@<显示名>` + **`U+2005` (four-per-em space)**; typing by hand uses
`U+0020`. Two pieces of evidence from the real-machine dump:

```
"@<成员>\u2005一会儿带两个豆浆回来，我们吃过了"
"@<成员>\u2005妈"
```

So "`@this account's display name` + `U+2005`" or "ends with `@this account's display name`" is the criterion, and additionally
`@所有人\u2005` also counts as speaking to this account. This is not text reverse-parsing — it requires a marker generated by the client itself,
which cannot be typed by hand (but can be pasted, see below).

#### The corrected decision

`capabilities.mentions` changes from a boolean to three states, writing "how strong the proof is" into the contract instead of hiding it in code:

| Value | Meaning | Who |
|---|---|---|
| `structured` | a mention list given by the client | `fake` (reference implementation), future L2/L1 |
| `markup` | the client's own mention marker + this account's display name | **`pc-uia` (L0)** |
| `none` | cannot be judged at all | the `pad` stub |

The cost of `markup` must be stated, because it affects "whether a group `@` can be treated as authorisation":

1. **The criterion name changes**: the criterion contains this account's display name, so the display name gets a **60-second TTL re-read**, is **force re-read** on `/listen`,
   and is refreshed incidentally by `/messages` polling; changing the nickname **requires no restart**, and the current criterion name can be seen directly in the `detail` of `/health` and `/status`.
   If the read fails, keep the old name and record a note (clearing it would make the judgement never match, which is worse than an old value);
2. **Forgeable**: the separator can be pasted, so it is stronger than substring matching, but **not unforgeable**;
3. Therefore the wording of §2.3 hard rule 4 changes to: **must not reverse-parse by `@nickname` text; judging by client markers is allowed,
   and the strength must be declared in the capability self-description**. §8's invariants are consistent with this.

The identity problem is solved with a **namespace** rather than loosening the Node-side id regex: the sidecar names chats and
senders that have no stable ID as `wxname_<sha1(display name)[:16]>`, with the display name in the `name` field; the Node side's
`^[A-Za-z0-9_-]+$` stays unchanged, and `weixinKind.refreshLabels` resolves the id back to a display name for panel display.
The cost must likewise be stated: **if the display name changes, the id changes**, and the configuration must follow.

**L2 / L1 are still the stronger paths**, but no longer "the only usable path":

- **L2 (pad)**: can simultaneously give chatroomId, wxid, structured `ats` and real time. It requires the business side to provide
  an iPad-protocol service such as WeChatPadPro. The sidecar's `--backend pad` already has a stub:
  `available:false` + data endpoints `501`; switching only needs a configuration change + restart, without touching Node code.
- **L1 (DB reader)**: the message DB location and encryption form are already confirmed on this machine; it is a route that obtains **all structured fields without injecting into the process**.
  The evidence and approach follow. It solves the `structured` tier, not "whether it is usable".

#### Tier feasibility audit: L1 and L2 checked against the real documentation (2026-11-07)

§2.2's ladder assumes "L1 (injection) can get a structured `@`" and "L2 (pad) can solve everything". After checking the **real documentation**,
both assumptions need correction — this step exists so nobody does wasted work following the ladder.

**L1 (an injection plugin such as `wxhelper`) = unusable on this machine, and even if usable it does not solve `@`.**

- It only adapts to **WeChat 3.9.x** (`WeChat.exe`): the repo README explicitly lists 3.8.0.41 / 3.8.1.26 / 3.9.0.28 /
  3.9.2.23 / 3.9.2.26 / 3.9.5.81, `doc/` only has 3.9.2.23 and 3.9.5.81, the highest tag on jsDelivr is
  `3.9.10.19-v1`, and the whole repo has **no** trace of 4.x / `Weixin.exe`. This machine is 4.x.
- More critically: the message JSON it hooks out has **11 fields**
  (`pid/fromUser/toUser/content/signature/msgId/msgSequence/createTime/displayFullContent/type/base64Img`),
  with **no `atuserlist` / `atList`**, and no endpoint returning a structured `@` list. In other words: after switching to the 3.9 client and
  accepting the injection risk, the field we want **still does not exist**.
- It listens on `0.0.0.0:19088` by default with **no authentication whatsoever** (source `StartHttpServer`), which amounts to exposing the entire WeChat account to the LAN.
  The author himself writes in the README that it "may cause consequences such as account bans".

**L2 (a pad service such as `WeChatPadPro`) = it passes the version gate, but the documentation does not give the `@` gate.**

- It does not drive a local client; it is an iPad-protocol endpoint (iOS 18.61 / build 861), so "this machine has 4.x installed" is irrelevant to it.
- The public Cloud swagger (`gwpad.com/Cloudswagger/swagger.json`) can be checked for **401 endpoints**:
  `basePath=/v1`, response envelope `{Code, Data, Message, Success, request_id}`,
  auth header `X-Cloud-Access-Token`.
- **But a full-text search for `atuserlist` hits 0**; `at_list` / `AtList` are all false hits on `chat_list`; the only field related to `@` is
  the **sending-side** `Msg.SendNewMsgParamDoc.At`. The inbound `sync_message` event **has no field-level schema**.
  In other words: **whether a structured `@` list exists in inbound events cannot be confirmed from the public documentation**.
- Group id and sender wxid are documented: `Msg.QuoteContextDoc.chat_user_id` (`room@chatroom` for group chats),
  `from_user_id` (the member wxid for group chats). So L2 can indeed fill L0's gaps on **identity**.
- Closed-source binary + licence-code billing, the latest version only in the sponsor group; still maintained (v2.01 released 2025-08-22).
  The documentation has traps: the local swagger file the README points to is no longer in the repo, the old documentation site is 404, and only the swagger above is trustworthy.

**Conclusion**: the ladder changes from "L1 first, L2 second" to — **L1 is struck out** (unusable on 4.x, and it does not provide an `@` list);
**L2 is the only candidate**, but whether it can give a structured `@` can only be confirmed by the licence holder in a real test.

**A one-off verification for the licence holder (10 minutes; decides whether L2 is worth adopting)**: log in a test account with the pad service, pull a group,
have a group member @ that account once, then look at the raw JSON of that message in `sync_message` (or a synonymous inbound event):

- If fields shaped like `atuserlist` / `at_list` / wxid-carrying fields inside `msgsource` appear → L2 holds, and `mentions` can be upgraded to `structured`;
- If not → L2 can only fill identity and time, `mentions` stays at the `markup` tier, and then there is **no need to switch backends for `@`**.

#### L1 feasibility evidence (confirmed, not implemented)

```
%USERPROFILE%\Documents\xwechat_files\<account>_<hash>\db_storage\
  message\message_0.db   11,882,496 B   ← 群/单聊消息
  contact\contact.db     23,150,592 B   ← 联系人、群成员
  ...
```

The first 64 bytes of `message_0.db` are random bytes (`79 4b ad 98 12 22 ba 23 …`), **not** `SQLite format 3`
→ confirming SQLCipher encryption (WeChat 4.x uses SQLCipher v4: 4096-byte pages, AES-256-CBC, page-tail HMAC-SHA512).
The file is opened exclusively while the client runs; reading requires `FileShare.ReadWrite`.

Once the key is obtained, the structured fields built into the protocol layer map directly to the contract: chat `username` (= chatroomId),
sender `sender` (= wxid), `create_time` (= real time), and the at list in the message proto
(= `ats`). **This single item solves Q1 and Q2 at once**, and it is also the only L0 alternative that does not violate "text reverse-parsing forbidden".
The key must be taken from `Weixin.exe` process memory (this machine is an administrator session, so the conditions exist); it belongs to L1's
"injection/memory reading" risk tier and requires written acceptance from the business side before doing it.

#### L1 assault: how far we got, and why we stopped (2026-11-07 real test, **key not obtained**)

Approach: SQLCipher accepts a **raw key** (`x'<64 hex>'`); in that case the KDF is skipped, and the key bytes serve as both the encryption key and
the HMAC key, so **one HMAC-SHA512 verifies one candidate** (measured about 31 µs/candidate on this machine). This makes "scanning" feasible,
unlike PBKDF2 (256000 rounds ≈ 0.1 s/candidate), which can only rely on known offsets.

Already ruled out:

1. **`login\<account>\key_info.db` is plaintext SQLite** (`SQLite format 3`), with only one table
   `LoginKeyInfoTable(user_name_md5, key_md5, key_info_md5, key_info_data BLOB)`, 5 rows,
   `key_info_data` is 180 bytes per row, isomorphic to `%APPDATA%\Tencent\xwechat\login\<account>\key_info.dat`.
   → This shows what is stored here is the **wrapped** key, not plaintext.
2. **Brute-forcing that blob failed completely**: treating the 180 bytes at the five lengths 16/24/32/40/48 and at every offset as candidates
   (27660 raw-key attempts, 0.22 s), then using the `user_name_md5` ASCII and raw bytes, the first/middle/last slices of the blob,
   and the whole blob to try PBKDF2 (64000 and 256000 rounds × two page layouts SHA512/SHA256, 810 attempts, 143 s) — **all missed**.
   Across the 5 rows + `.dat` there is also no shared 32-byte window.
3. **Process memory scan: done but not enough to conclude**. `Weixin.exe` has 6 instances; within a 180-second budget only 46 MB was scanned
   (5,857,300 candidates, 8-byte aligned), no hit. At 31 µs/candidate, scanning these processes fully at stride 8 takes about
   30–60 minutes; this run did not finish.

**Why stop here**: the credibility of a negative result depends on the verifier itself, and I **have no known-good SQLCipher library** to
calibrate it against (page layout 4096/reserve 80 vs 48, whether the page number participates in the HMAC, whether the salt skips 16 bytes — all inferred from documentation).
Getting "not found" after 40 minutes on an uncalibrated verifier cannot be written as "does not exist". The correct order to continue is:

1. First build a database with a known key using the sqlcipher CLI and align the verifier to it (this is 10 minutes of work, but it must be done first);
2. Then write the scanner in C/Rust (Python's 31 µs/candidate is the lower bound; C can reach the 1 µs order), full scan at stride 1;
3. Only after obtaining the key discuss the DB reader: the schema of `message/message_*.db`, the mention field of group messages,
   and the member table of `contact.db` — that is another independent workload.

Conclusion: **L1 is still the strongest path, but it is an engineering task that needs calibration before implementation, not something one session can close**.
Before that the `markup` tier is usable, and its three costs have been reduced to two (rename self-healing, the id will change, forgeable).

### 2026-11-07 group message images: implemented (commit cfa971e)

Chain (every segment has tests): the sidecar `/messages` lists `media:[{id:'<nativeId>#0',kind:'image'}]` only for builds that **can download**
→ `bridge.toChatEvent` maps it into `ChatEvent.media` → `weixin-watch` puts the id into `Trigger.meta.media`
→ `weixinThreadContext.read()` appends an invisible `[image:<id>]` at the end of the image message body → `images(text)` extracts it with the same regex
→ `image()` goes through `GET /media/<id>` → magic-number detection → `attachments.saveImage` → visible to the model.

Non-negotiable conventions: judge only by magic number (PNG/JPEG/WebP/GIF) and **do not trust** the remote Content-Type; when it exceeds `imageLimits.maxImageBytes`
or the format is unacceptable, **throw before saveImage** (nothing is written to disk, nothing enters the context); `/media` and `/send` share the UI serialisation lock;
builds without download capability return **501** for `/media`, **404** for a location failure, and never return empty bytes.

Legacy Minor items (review t54, all low risk, recorded):
- IMG-1 applies only the single-image `maxImageBytes`, without stacking `maxMessageImageBytes`/the per-message image count cap
- IMG-2 the bridge reads the whole `arrayBuffer` first and then checks the limit, without a streaming cap
- IMG-3 the sidecar `/media` success branch does not explicitly reject zero bytes
- IMG-4 `imageIds()` parses from the body, so a user can fabricate `[image:x]` to trigger one request (the sidecar 404 catches it; suggest later accepting only ids in `meta.media`)
