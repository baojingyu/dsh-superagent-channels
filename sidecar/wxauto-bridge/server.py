#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""wxauto-bridge —— 微信个人号 sidecar（冻结契约见同目录 contract.md）。

只依赖 Python 3.12 标准库：http.server / socketserver / json / argparse / threading / hmac /
zlib / struct / queue。后端阶梯见 ADR-005 §2.2：

    fake    契约自测用的确定性数据，不碰微信、不碰 Windows
    pc-uia  L0：wxautox4 + UIAutomation，**监听模式**（AddListenChat + StartListening）
    pad     L2：未实现，只回答 available:false

硬约束（ADR-005 §2.3）：发送进程内串行 + ≥1s 间隔 + 抖动；`/media` 与 `/send` 共用同一把锁；
群 `@` 判定不得退化成裸子串匹配；本 sidecar 不做主动 @，也绝不调用 `msg.at()`（那是「拍一拍」）。
"""
from __future__ import annotations

import argparse
import base64
import concurrent.futures
import hashlib
import hmac
import importlib.util
import json
import os
import queue
import random
import re
import shutil
import signal
import socketserver
import struct
import sys
import tempfile
import threading
import time
import traceback
import zlib
from collections import OrderedDict, deque
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlsplit

VERSION_FALLBACK = "0.1.0"
PROBE_TIMEOUT_S = 25.0
WX_CALL_TIMEOUT_S = 15.0
MAX_BODY_BYTES = 1 << 20
SEND_MIN_INTERVAL_S = 1.0
SEND_JITTER_S = 0.15
IDEM_MAX_ITEMS = 256
IDEM_TTL_S = 600.0
MEDIA_MAX_ITEMS = 64
ROOMS_LIMIT = 500
# How long a `/rooms` answer is reused, and how long the expensive recent-groups half is kept.
ROOMS_CACHE_S = 120.0
RECENT_GROUPS_TTL_S = 300.0
# After a slow or failed collection, wait this long before paying for it again.
RECENT_GROUPS_RETRY_S = 60.0
VOICE_TIMEOUT_S = 8.0
# What the inbound renderer does unless `/listen` says otherwise. Turning voice transcription off spares the
# client's UI up to VOICE_TIMEOUT_S per voice message; turning images off keeps `media` empty and leaves the
# `[图片]` placeholder in the text.
INBOUND_DEFAULTS = {"voice": True, "images": True}
# A listener that has delivered nothing for this long, while it is supposed to be listening, is treated as stale.
# One outbound file, decoded. WeChat itself refuses large files, and a bridge that accepted a gigabyte would be a way
# to fill the disk of whatever machine runs it.
MAX_OUTBOUND_FILE_BYTES = 20 * 1024 * 1024
# Base64 inflates by 4/3, and the JSON envelope adds a little on top, so the body ceiling has to be larger than the
# payload ceiling or the payload ceiling is never reached.
MAX_SEND_BODY_BYTES = MAX_OUTBOUND_FILE_BYTES * 4 // 3 + 64 * 1024
# Where an outbound file waits while the client uploads it. Long enough for a slow upload, and swept on the next send
# rather than deleted when the call returns - see `outbound_path`.
OUTBOUND_DIR_NAME = "wxbridge-outbound"
OUTBOUND_FILE_TTL_S = 900.0
LISTENER_QUIET_S = 600.0
# At most one re-attach per window: a chat that is simply silent must not turn into a fight with the client.
LISTENER_REATTACH_GAP_S = 900.0
WATCHDOG_TICK_S = 60.0
# How often the main loop asks whether the client it attached to still exists.
MAINTAIN_TICK_S = 30.0
# A catch-up opens each watched chat, so it is bounded: three chats, the last twenty messages, once a minute at most.
CATCHUP_GAP_S = 60.0
CATCHUP_MAX_CHATS = 3
CATCHUP_MAX_MESSAGES = 20
SEEN_MAX = 512
ISO_FORMAT = "%Y-%m-%dT%H:%M:%SZ"

# 非文本消息的空 content 占位：绝不产出 `text: ""` 的空事件
PLACEHOLDERS = {
    "image": "[图片]", "voice": "[语音消息]", "video": "[视频消息]", "file": "[文件消息]",
    "link": "[链接消息]", "location": "[位置消息]", "emotion": "[表情消息]",
    "merge": "[合并转发消息]", "quote": "[引用消息]", "other": "[其他消息]",
}
GENERIC_PLACEHOLDER = "[消息]"
LOOPBACK_HOSTS = ("127.0.0.1", "::1", "localhost")
def default_venv() -> str:
    """Where wxautox4 lives, discovered rather than hardcoded.

    A machine-specific path in the source breaks every other machine and names one operator's
    directories, so there is no built-in default: pass `--venv`, or set `WXBRIDGE_VENV`, or simply
    start the sidecar with the interpreter that already has wxautox4 installed - which is the usual
    case, and the reason an empty answer is valid.
    """
    explicit = os.environ.get("WXBRIDGE_VENV", "")
    if explicit:
        return explicit
    # The usual case: the sidecar is started with the interpreter that already has wxautox4, so its own
    # environment is the answer, so a checkout on another machine needs no configuration.
    if os.path.exists(os.path.join(sys.prefix, "pyvenv.cfg")):
        return sys.prefix
    return ""


# Kept as a name so the two call sites read the same, but its value is computed, never a literal.
DEFAULT_VENV = ""
WECHAT_VERSION = "微信"


# --------------------------------------------------------------------------- 通用小工具


def package_version() -> str:
    """`/health.version`：优先读宿主仓库 package.json 的版本，读不到用回退值。"""
    here = os.path.dirname(os.path.abspath(__file__))
    for rel in (("..", "..", "..", "open-dsh-superagent", "package.json"), ("..", "..", "package.json")):
        try:
            with open(os.path.abspath(os.path.join(here, *rel)), "r", encoding="utf-8") as handle:
                value = json.load(handle).get("version")
            if isinstance(value, str) and value:
                return value
        except (OSError, ValueError, AttributeError):
            continue
    return VERSION_FALLBACK


_SAFE_NAME = re.compile(r"[^A-Za-z0-9._-]+")


_CLIENT_VERSION_DIR = re.compile(r"^\d+\.\d+\.\d+\.\d+$")


def outbound_path(name: str) -> str:
    """A path for one outbound file that is not deleted under the client's upload.

    `SendFiles` returns as soon as the client has taken the file; the upload carries on afterwards. Deleting the file when
    the call returns turned every file over a few kilobytes into "发送中断" in the chat, while images - which the client copies
    immediately - went through. So the file stays here, and files older than `OUTBOUND_FILE_TTL_S` are swept on the next send.
    """
    base = os.path.join(tempfile.gettempdir(), OUTBOUND_DIR_NAME)
    os.makedirs(base, exist_ok=True)
    now = time.time()
    # One directory per send, swept by age: the file keeps the name its sender gave it, because the person on the other side
    # sees that name and a random prefix is not part of the document.
    for entry in os.listdir(base):
        full = os.path.join(base, entry)
        try:
            if now - os.path.getmtime(full) > OUTBOUND_FILE_TTL_S:
                if os.path.isdir(full):
                    shutil.rmtree(full, ignore_errors=True)
                else:
                    os.remove(full)
        except OSError:
            pass
    directory = os.path.join(base, os.urandom(4).hex())
    os.makedirs(directory, exist_ok=True)
    return os.path.join(directory, safe_filename(name))


def client_version() -> str:
    """The installed WeChat build, read from the version directory the installer leaves beside the executable.

    A client update is invisible from the window, and an unsupported build only shows up as "no signed-in main
    window". One `listdir` costs nothing, needs no elevation, and turns that into something a person can see."""
    roots = []
    for variable in ("ProgramFiles", "ProgramFiles(x86)"):
        base = os.environ.get(variable)
        if base:
            roots.append(os.path.join(base, "Tencent", "Weixin"))
    for root in roots:
        try:
            versions = [name for name in os.listdir(root) if _CLIENT_VERSION_DIR.match(name)]
        except OSError:
            continue
        if versions:
            versions.sort(key=lambda name: tuple(int(part) for part in name.split(".")))
            return versions[-1]
    return ""


def safe_filename(name: str) -> str:
    """The basename, stripped to characters a file system will not interpret.

    `SendFiles` is handed a path we just created, so the name only has to be safe - but a name like `../../x` written
    into a temp directory would still be a way out of it, so separators never survive.
    """
    base = os.path.basename(str(name or "").replace("\\", "/"))
    cleaned = _SAFE_NAME.sub("_", base).strip("._")
    if not cleaned:
        cleaned = "file"
    return cleaned[:120]


def field(obj, name):
    """同时兼容 dict 与对象属性的取值。"""
    return obj.get(name) if isinstance(obj, dict) else getattr(obj, name, None)


def iso_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


# --------------------------------------------------------------------------- 异常 → 状态码


class SendGone(Exception):
    """会话已不能接收 → 409 {"error":"gone"}。"""


class MediaGone(Exception):
    """媒体 id 不在当前可见窗口 / 载荷为空 → 404。"""


class MediaUnsupported(Exception):
    """该后端整体没有下载能力 → 501。"""


class Unsupported(Exception):
    """端点在该后端上不存在（pad 桩）→ 501。"""


class Unavailable(Exception):
    """后端不可用 → 502（Node 侧视为可重试）。"""


class TTLCache:
    """有界 TTL 缓存（幂等键、媒体字节共用）。"""

    def __init__(self, ttl: float, max_items: int):
        self.ttl = ttl
        self.max_items = max_items
        self._data: "OrderedDict[str, tuple[float, object]]" = OrderedDict()
        self._lock = threading.Lock()

    def get(self, key: str):
        now = time.monotonic()
        with self._lock:
            hit = self._data.get(key)
            if hit is None:
                return None
            expires, value = hit
            if expires < now:
                self._data.pop(key, None)
                return None
            self._data.move_to_end(key)
            return value

    def put(self, key: str, value) -> None:
        with self._lock:
            self._data[key] = (time.monotonic() + self.ttl, value)
            self._data.move_to_end(key)
            while len(self._data) > self.max_items:
                self._data.popitem(last=False)


# --------------------------------------------------------------------------- 后端基类


class Backend:
    """契约面 6 个方法 + 生命周期 probe/run_main_loop/close（ADR-005 §2.3 第 1 条）。"""

    name = "base"
    supports_media = False

    def probe(self) -> "tuple[bool, str]":
        return True, ""

    def prepare(self) -> None:
        """在 HTTP 线程起来**之前**调用：只做不阻塞的准备（真正的 attach 在 run_main_loop 里）。"""

    def run_main_loop(self) -> None:
        """在主线程上跑的后端循环；默认只是阻塞到 close()。

        `pc-uia` 覆盖它：微信 4.x 的监听（`StartListening`）**必须**在主线程注册，且之后
        任何一次跨线程的微信调用都会让回调彻底不再触发（实测三种组合，见
        verify/live-pc-uia.py 的真机自测），所以主线程归微信，HTTP 由后台线程服务。
        """
        event = getattr(self, "_stop_event", None)
        if event is None:
            event = self._stop_event = threading.Event()
        # 必须带超时轮询：主线程无限阻塞在 Event.wait() 上时收不到控制台信号
        # （SIGBREAK/SIGINT 只有在主线程回到解释器循环时才会被处理）。
        while not event.wait(0.2):
            pass

    def close(self) -> None:
        """退出前释放监听/线程；可重复调用。"""
        event = getattr(self, "_stop_event", None)
        if event is not None:
            event.set()

    def capabilities(self) -> dict:
        """诚实报告该后端能兑现哪些契约字段（三态，见 contract.md §3.1）。"""
        return {"mentions": "none", "members": "none", "media": bool(self.supports_media)}

    def detail(self) -> str:
        """`/health` 与 `/status` 的附加说明（动态，每次请求现算）；默认没有。"""
        return ""

    def status(self) -> dict:
        raise Unsupported()

    def rooms(self) -> list:
        raise Unsupported()

    def members(self, room: str) -> list:
        raise Unsupported()

    def messages(self, room: str, cursor: str, limit: int) -> "tuple[list, str, str]":
        raise Unsupported()

    def send(self, room: str, wxid: str, text: str, quote_id: str = "", at: "list[str] | None" = None,
             file: "tuple[str, str] | None" = None) -> str:
        """只发文本；`at` 是可选的**群内提及**列表（显示名或其 `wxname_` id），单聊忽略。

        入站的 `Message.at` 是「拍一拍」，出站的 `SendMsg(at=[...])` 是提及——同名不同义，别混。
        """
        raise Unsupported()

    def media(self, media_id: str) -> "tuple[bytes, str]":
        raise MediaUnsupported()

    def listen(self, rooms: "list[str]", options: "dict | None" = None) -> dict:
        """集合替换式下发监听配置；`options` 可选（`voice` / `images`），返回 {listening, added, removed, failed}。"""
        raise Unsupported()


# --------------------------------------------------------------------------- fake 后端

FAKE_ROOM = "chatroom_fake_dev"
FAKE_ROOM_NAME = "研发-交付群"
FAKE_SELF_WXID = "wxid_fake_self"
FAKE_SELF_NAME = "智能助手"
FAKE_ALICE = ("wxid_alice", "阿黎")
FAKE_MEMBERS = [(FAKE_SELF_WXID, FAKE_SELF_NAME), FAKE_ALICE, ("wxid_bob", "王博")]


def _event(native_id, sender, text, at, ats, own=False, quote_id="", media=None) -> dict:
    return {
        "nativeId": native_id,
        "room": FAKE_ROOM,
        "sender": {"id": sender[0], "name": sender[1]},
        "text": text,
        "at": at,
        "ats": list(ats),
        "own": own,
        "quoteId": quote_id,
        "media": list(media or []),
    }


# 注意：m4 的 media 项**不带** mime —— 契约测试断言 `media` 精确等于 [{id,kind}]，mime 是可选字段
# （bridge.ts 只在非空时带进 ChatEvent），真实类型由 /media 的 Content-Type 给出。
FAKE_MESSAGES = [
    _event("m1", FAKE_ALICE, "@智能助手 把 timeout 改成 3s", "2026-11-06T04:01:02Z", [FAKE_SELF_WXID]),
    _event("m2", FAKE_ALICE, "收到，我先看下定时器那段实现", "2026-11-06T04:03:10Z", []),
    _event("m3", (FAKE_SELF_WXID, FAKE_SELF_NAME), "好，3s 已改，等下跑一遍回归", "2026-11-06T04:05:00Z", [], own=True),
    _event("m4", FAKE_ALICE, "[图片]", "2026-11-06T04:06:12Z", [], media=[{"id": "m4#0", "kind": "image"}]),
]


def _png_chunk(tag: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)


def make_png(width: int = 1, height: int = 1) -> bytes:
    """在代码里生成 1×1 RGB PNG（不随包携带二进制）。"""
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    raw = b"".join(b"\x00" + b"\x1e\x6b\xd6" * width for _ in range(height))
    return (b"\x89PNG\r\n\x1a\n" + _png_chunk(b"IHDR", ihdr)
            + _png_chunk(b"IDAT", zlib.compress(raw, 9)) + _png_chunk(b"IEND", b""))


class FakeBackend(Backend):
    name = "fake"
    supports_media = True

    def __init__(self) -> None:
        self._png = make_png()

    def capabilities(self):
        # fake 是契约的参考实现：ats 是真结构化列表，成员表是全量。
        return {"mentions": "structured", "members": "full", "media": True}

    def status(self):
        return {
            "loggedIn": True, "wxid": FAKE_SELF_WXID, "name": FAKE_SELF_NAME,
            "backend": self.name, "available": True, "lastEventAt": FAKE_MESSAGES[-1]["at"],
        }

    def rooms(self):
        return [{"id": FAKE_ROOM, "name": FAKE_ROOM_NAME}]

    def members(self, room):
        return [{"id": w, "name": n} for w, n in FAKE_MEMBERS] if room == FAKE_ROOM else []

    def messages(self, room, cursor, limit):
        if room != FAKE_ROOM:
            return [], (cursor or "0"), str(len(FAKE_MESSAGES))
        try:
            start = int(cursor)
        except (TypeError, ValueError):
            start = 0
        start = max(0, min(start, len(FAKE_MESSAGES)))
        page = [dict(item) for item in FAKE_MESSAGES[start:start + limit]]
        return page, str(start + len(page)), str(len(FAKE_MESSAGES))

    def send(self, room, wxid, text, quote_id="", at=None, file=None):
        if room and room != FAKE_ROOM:
            raise SendGone(room)
        return "fake_" + os.urandom(5).hex()

    def media(self, media_id):
        if media_id == "m4#0":
            return self._png, "image/png"
        raise MediaGone(media_id)

    def listen(self, rooms, options=None):
        """幂等且**不改变固定数据集**：认识的会话报在 listening 里，不认识的进 failed。

        fake 的 /rooms 与 /messages 是写死的契约参考数据，`/listen` 只做“认不认得”的答复，
        不做增删——否则 live 测试断言的数据集会被改掉。
        """
        listening, failed, seen = [], [], set()
        for room in rooms:
            if room in (FAKE_ROOM, FAKE_ROOM_NAME):
                if FAKE_ROOM not in seen:
                    seen.add(FAKE_ROOM)
                    listening.append({"id": FAKE_ROOM, "name": FAKE_ROOM_NAME})
            else:
                failed.append({"room": room, "detail": "会话不存在或 AddListenChat 返回失败"})
        return {"listening": listening, "added": [], "removed": [], "failed": failed}


# --------------------------------------------------------------------------- pc-uia（L0）

MENTION_SEPARATOR = "\u2005"  # 客户端在 @ 后插入的四分宽空格；人工手打是 U+0020


def wxname(display_name: str) -> str:
    """显示名 → 稳定 id：`wxname_<sha1[:16]>`。

    L0 拿不到 chatroomId 也拿不到发送人 wxid，而 Node 侧的 `rooms[].id` / `policy.allowed[].id`
    是 `^[A-Za-z0-9_-]+$`（中文名过不了）。身份归一留在 sidecar（ADR-005 §2.1「后端差异不外溢」）。
    代价：**显示名改了 id 就变**，配置要跟着改 —— 这是没有 chatroomId 的必然结果，不是 bug。
    """
    return "wxname_" + hashlib.sha1(display_name.encode("utf-8")).hexdigest()[:16]


def marked_mentions(msg, self_display_name: str, self_wxid: str) -> "list[str]":
    """按**客户端标记**判定「这条消息 @ 了本账号」，命中返回 `[self_wxid]`，否则 `[]`。

    背景（2026-11-07 真机 dump）：微信 4.x 真正 @ 某人时插入的是 `@<显示名>` + `U+2005`
    （四分宽空格），不是普通空格：
        "@<成员>\\u2005一会儿带两个豆浆回来，我们吃过了"
        "@<成员>\\u2005妈"
    人工手打 `@名字 ` 用的是 `U+0020`。所以「标记」比子串匹配强一档：子串匹配连
    「他刚才说了 @<昵称> 这句话」都会误判成被 @。

    规则（**只认标记**）：
      1. `msg.content` 不是 str → `[]`；
      2. `@<本账号显示名>\\u2005` 出现在 content → 命中；或 content 以 `@<本账号显示名>` 结尾
         → 命中（mention 在句末时客户端不补分隔符）；
      3. `@所有人\\u2005`（或以此结尾）→ 命中（@所有人 确实是对本账号说话）；
      4. 命中返回 `[self_wxid]`，否则 `[]`。
    **不允许**退回 `display_name in content` 这类子串判断；找不到标记就是 `[]`。

    已知残留风险：正文恰好以 `@<显示名>` 结尾（例如复述别人的话）会被判成命中；显示名可被
    任意群成员改成与机器人同名，标记因此可被伪造 —— 这是 markup 能力的固有代价（契约 §7.1）。

    铁律：本函数**只读** `content`，绝不调用 `msg.at()` —— 那是「拍一拍」，有真实副作用。
    """
    content = getattr(msg, "content", None)
    if not isinstance(content, str) or not content or not self_wxid:
        return []
    name = (self_display_name or "").strip()
    if name:
        marker = "@" + name
        if marker + MENTION_SEPARATOR in content or content.endswith(marker):
            return [self_wxid]
    everyone = "@所有人"
    if everyone + MENTION_SEPARATOR in content or content.endswith(everyone):
        return [self_wxid]
    return []


def _msg_native_id(msg, room: str) -> str:
    for candidate in (getattr(msg, "id", None), field(getattr(msg, "info", None), "id")):
        if isinstance(candidate, str) and candidate:
            return candidate
    seed = "%s|%s|%s|%s" % (room, getattr(msg, "sender", ""), getattr(msg, "content", ""), getattr(msg, "time", ""))
    return "pc" + hashlib.sha1(seed.encode("utf-8", "replace")).hexdigest()[:12]


def _msg_time(msg) -> str:
    """消息自带的时间字段（多数普通消息没有）→ ISO8601 UTC；没有就返回空串，由调用方回落到服务端时间。"""
    value = getattr(msg, "time", None) or field(getattr(msg, "info", None), "time")
    if isinstance(value, str) and value:
        return value
    if hasattr(value, "strftime"):
        try:
            return value.strftime(ISO_FORMAT)
        except (ValueError, OSError):
            pass
    return ""


def _marker_time(msg) -> str:
    """`TimeMessage` 分隔符的时间 → ISO8601 UTC。

    微信给的是**本地墙钟**（形如 `2026-11-07 15:15:00`），这里保留完整日期（跨天也不会错）
    并换算成 UTC，与 `at` 的 `Z` 语义保持一致。
    """
    value = getattr(msg, "time", None) or field(getattr(msg, "info", None), "time")
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc).strftime(ISO_FORMAT)
    if isinstance(value, str) and value.strip():
        raw = value.strip()
        for fmt in ("%Y-%m-%d %H:%M:%S", "%Y/%m/%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y/%m/%d %H:%M"):
            try:
                return datetime.strptime(raw, fmt).astimezone().astimezone(timezone.utc).strftime(ISO_FORMAT)
            except ValueError:
                continue
    return ""


def _as_text_value(value) -> str:
    """把 `to_text()` 之类的返回值收成字符串；认不出就返回空串（绝不 `str(dict)` 糊上去）。"""
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, dict):
        for key in ("text", "content", "data", "result"):
            inner = value.get(key)
            if isinstance(inner, str) and inner.strip():
                return inner.strip()
    return ""


def _as_quote_text(value) -> str:
    """被引内容的候选值 → 文本；认不出就空串。**只读**，绝不调用可调用对象。"""
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, dict):
        for key in ("content", "text", "title", "desc"):
            inner = value.get(key)
            if isinstance(inner, str) and inner.strip():
                return inner.strip()
        return ""
    if isinstance(value, (list, tuple)):
        parts = [str(item).strip() for item in value if isinstance(item, str) and str(item).strip()]
        return " ".join(parts)
    return ""


def _quoted_text(msg) -> str:
    """尽力取「被引用的原文」；取不到返回空串，**不编造**。

    只读属性与 dict 字段；`quote`/`refer` 在个别构建上可能是方法，`_as_quote_text` 对非
    str/dict/list 一律返回空串，因此不会被误调用（同 `at()` 那条铁律）。
    """
    keys = ("quote", "quoted", "refer", "quote_content", "refer_text")
    candidates = [getattr(msg, attr, None) for attr in keys]
    for holder in ("info", "detail", "raw", "payload"):
        value = getattr(msg, holder, None)
        if isinstance(value, dict):
            candidates.extend(value[key] for key in keys if key in value)
    api = getattr(msg, "_api", None)
    if api is not None and not callable(api):
        data = getattr(api, "data", None)
        if isinstance(data, dict):
            candidates.extend(data[key] for key in keys if key in data)
    for candidate in candidates:
        text = _as_quote_text(candidate)
        if text:
            return text
    return ""


def _guess_mime(name: str) -> str:
    suffix = os.path.splitext(name)[1].lower()
    return {
        ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
        ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp",
    }.get(suffix, "application/octet-stream")


class _MainThreadExecutor:
    """把微信调用全部排到**主线程**执行（HTTP 线程只提交任务并等结果）。

    实测结论（2026-11-07 真机，只用内置的单聊自测会话）：
      * 全部在主线程 → `AddListenChat` + `StartListening` 回调正常触发；
      * 在 worker 线程做 setup（STA / MTA 都试过）→ 回调 **0 次**；
      * 主线程做 setup、worker 线程只 `SendMsg` → 回调 **0 次**。
    监听一旦建立，**任何**跨线程的微信调用都会让回调失效。所以主线程归微信所有，
    HTTP 由后台线程服务（见 `main()`），顺带满足 ADR-005「UI 串行化」。
    """

    def __init__(self, setup, maintain=None) -> None:
        self._setup = setup
        # Runs on the main thread between calls; returns the client to use from now on, which lets a stale attach be
        # replaced without stopping the process.
        self._maintain = maintain
        self._queue: "queue.Queue" = queue.Queue()
        self._ready = threading.Event()
        self._wx = None
        self._error: "BaseException | None" = None
        self._thread: "threading.Thread | None" = None

    def run(self) -> None:
        """**只能在主线程调用**：先 attach，再循环执行排队的微信调用。"""
        self._thread = threading.current_thread()
        self._co_initialize()
        try:
            self._wx = self._setup()
        except BaseException as error:  # noqa: BLE001 —— 由 probe() 转成 available:false
            # Not fatal: the client may be switching accounts or still opening its window. The loop stays up so `/health`
            # can say why, and the maintenance tick keeps trying.
            self._error = error
        self._ready.set()
        while True:
            try:
                # 带超时：主线程无限阻塞在 Queue.get() 上时收不到 SIGBREAK/SIGINT。
                item = self._queue.get(timeout=0.2)
            except queue.Empty:
                if self._maintain is not None:
                    try:
                        self._wx = self._maintain(self._wx) or self._wx
                        if self._wx is not None:
                            self._error = None
                    except BaseException as error:  # noqa: BLE001 —— 维护失败不能停掉主循环
                        self._error = error
                continue
            if item is None:
                return
            fn, future = item
            if not future.set_running_or_notify_cancel():
                continue
            try:
                future.set_result(fn(self._wx))
            except BaseException as error:  # noqa: BLE001
                future.set_exception(error)

    @staticmethod
    def _co_initialize() -> None:
        # UIAutomation 走 COM，每个碰它的线程都要先 CoInitialize（否则 WinError -2147221008）。
        if os.name != "nt":
            return
        try:
            import ctypes  # noqa: PLC0415

            ctypes.windll.ole32.CoInitializeEx(None, 0x2)  # STA；已初始化也无妨
        except BaseException:
            pass

    @property
    def client(self):
        return self._wx

    def wait_ready(self, timeout: float) -> bool:
        return self._ready.wait(timeout)

    @property
    def error(self) -> "BaseException | None":
        return self._error

    def call(self, fn, timeout: float = WX_CALL_TIMEOUT_S):
        if not self._ready.is_set():
            raise Unavailable("the wx main loop has not attached yet")
        if self._error is not None:
            raise Unavailable("%s: %s" % (type(self._error).__name__, self._error))
        future: "concurrent.futures.Future" = concurrent.futures.Future()
        self._queue.put((fn, future))
        try:
            return future.result(timeout=timeout)
        except concurrent.futures.TimeoutError:
            raise Unavailable("微信调用超过 %ss 未返回（UI 卡住？）" % timeout)

    def stop(self, timeout: float = 5.0) -> None:
        self._queue.put(None)
        if self._thread is not None and self._thread is not threading.current_thread():
            self._thread.join(timeout)


class PcUiaBackend(Backend):
    """L0：wxautox4 驱动微信 4.x，走**监听模式**（`AddListenChat` + `StartListening`）。

    为什么不用 `GetAllMessage()` 轮询：它只返回当前窗口**已渲染**的消息，而 `ChatWith()`
    在目标已是当前会话时不重绘，于是周期性读到 0 条 —— 这是「L0 收不到群消息」的直接原因。
    监听模式是推送式的，不依赖窗口渲染，`chat.chat_type` 还直接给出 `friend` / `group`。
    """

    name = "pc-uia"

    def __init__(self, venv=None, verbose=False,
                 listen=None, queue_size=500, self_name_ttl=60.0) -> None:
        self.verbose = verbose
        self._venv = venv or default_venv()
        self._listen_names = [n for n in (listen or []) if n]
        self._self_name_ttl = max(0.0, float(self_name_ttl))
        self._self_name_at = 0.0
        self._self_name_note = ""
        self._executor: "_MainThreadExecutor | None" = None
        self._closed = False
        self._close_lock = threading.Lock()
        self._listen_note = ""
        self._self_wxid = ""
        self._self_name = ""
        self._last_event_at = ""
        self._queue: "deque[tuple[int, dict]]" = deque(maxlen=max(1, int(queue_size)))
        # Seeded from the clock, not from zero: a client stores the cursor, and a restart that restarted the count
        # would leave that cursor ahead of every future event - which reads as a silent chat, not as an error.
        self._seq = int(time.time())
        self._queue_lock = threading.Lock()
        self._observed: "OrderedDict[str, OrderedDict]" = OrderedDict()
        self._room_names: "dict[str, str]" = {}
        # Listener liveness: when a real event last arrived, when we last re-attached, and how often.
        self._last_inbound_at = time.monotonic()
        self._last_reattach_at = 0.0
        self._reattach_count = 0
        # nativeId -> when it was queued: the callback and the catch-up both pass through here, so a message already
        # delivered is not handed over a second time.
        self._seen = OrderedDict()
        self._catchup_due = False
        self._catchup_at = 0.0
        self._catchup_total = 0
        # The window we attached to, and how many times a different one replaced it (an account switch or a re-login).
        self._hwnd = 0
        self._account_switch_count = 0
        self._last_maintain_at = 0.0
        self._watchdog: "threading.Thread | None" = None
        # Chat id -> the client's own `chat_type`. A direct chat reports `room: ""` in its events while
        # the panel stores the person's id, so the mapping between the two has to be remembered.
        self._chat_kind: "dict[str, str]" = {}
        # What `/listen` last asked the inbound renderer to do; `INBOUND_DEFAULTS` until someone says otherwise.
        self._options: "dict[str, bool]" = dict(INBOUND_DEFAULTS)
        self._rooms_note = ""
        self._rooms_cache = []        # last answer /rooms served, so a repeat press is instant
        self._rooms_cache_at = 0.0
        self._recent_groups_cache = []      # the expensive half, kept for minutes
        self._recent_groups_at = 0.0
        self._time_markers: "dict[str, str]" = {}  # room -> 最近的 TimeMessage 时间（ISO UTC）
        self._raw: "dict[str, object]" = {}
        self._listening = False
        for name in self._listen_names:  # 先登记 id→显示名，/send 在 attach 前也能解析
            self._room_id_for(name)
        self._probe: "tuple[bool, str] | None" = None
        self._probe_lock = threading.Lock()
        self._download_capable: "bool | None" = None
        self._cap_lock = threading.Lock()

    # -- 能力与身份 -------------------------------------------------------
    def _detect_download(self) -> bool:
        """该构建的图片消息类有没有 `download()`（免费构建可能只有 type='image'）。只导入，不 attach。

        注意：wxautox4 41.2.3 的 `msgs/__init__.py` 首次导入会因循环依赖抛
        `ImportError: cannot import name 'BaseMessage'`，而**第二次**导入就能成功
        （`wxautox4.msgs.base` 已进 sys.modules，循环解开）。所以这里重试一次，
        再认 `sys.modules`，而不是一次失败就判「无下载能力」。
        """
        try:
            self._prepare_sys_path()
        except BaseException:
            pass
        for _ in range(2):
            try:
                import wxautox4.msgs  # noqa: F401,PLC0415
                break
            except BaseException:
                continue
        module = sys.modules.get("wxautox4.msgs")
        if module is None:
            return False
        for name in dir(module):
            cls = getattr(module, name, None)
            if isinstance(cls, type) and "image" in name.lower() and callable(getattr(cls, "download", None)):
                return True
        return False

    def _has_download(self) -> bool:
        with self._cap_lock:
            if self._download_capable is None:
                self._download_capable = self._detect_download()
            return self._download_capable

    def capabilities(self):
        # mentions="markup"：没有结构化列表，靠客户端 `@名字␅` 标记判定（见 marked_mentions）。
        # members="observed"：GetAllRecentGroups() 只有 (群名, 成员数)，没有成员表 API，
        #   只能返回该会话里实际发过言的发送人。
        return {"mentions": "markup", "members": "observed", "media": self._has_download()}

    def _prepare_sys_path(self) -> None:
        here = os.path.dirname(os.path.abspath(__file__))
        candidates = [os.path.join(self._venv, "Lib", "site-packages")] if self._venv else []
        candidates += [os.path.abspath(os.path.join(here, "..", "..", "poc")), here]
        for path in candidates:
            if path and os.path.isdir(path) and path not in sys.path:
                sys.path.append(path)

    def _room_id_for(self, name: str) -> str:
        room_id = wxname(name)
        if name:
            self._room_names[room_id] = name
        return room_id

    def _normalize_room(self, room: str) -> str:
        """`/messages` / `/media` 的 `room`：空串 = 单聊；`wxname_…` 或显示名 = 该会话。

        单聊事件的 `room` 是空串（契约如此），而面板里存的是那个人的 `wxname_…`。所以这里要把
        「人」的 id 映射回单聊流，否则按人 id 取永远是空的。判断依据是消息到达时客户端报的
        `chat_type`；还没见过消息时退化为「不在最近群列表里就不是群」，且只在群列表非空时采用。
        """
        if not room:
            return ""
        room_id = room if room.startswith("wxname_") else wxname(room)
        kind = self._chat_kind.get(room_id, "")
        if kind == "friend":
            return ""
        if kind == "group":
            return room_id
        name = self._room_names.get(room_id) or room
        if self._recent_groups_cache and name not in set(self._recent_groups_cache):
            return ""
        return room_id

    # -- 身份（判据名） ---------------------------------------------------
    def _refresh_identity(self, wx, force: bool = False) -> None:
        """重读 `GetMyInfo()` 的 `display_name` / `id`。**只能在主线程执行器里调用。**

        - TTL 内且不 force 时直接返回（`/health`、`/messages` 每轮都会问，不能每轮都打微信）；
        - 读失败**保留旧值**并记 note —— 清空会让 `marked_mentions` 永远不命中，比旧值更糟；
        - `wxid` 与显示名同源同处读，不做两套缓存（它本来也不会变）。
        """
        now = time.monotonic()
        if not force and self._self_name and (now - self._self_name_at) < self._self_name_ttl:
            return
        try:
            info = wx.GetMyInfo() or {}
        except BaseException as error:
            self._self_name_note = "GetMyInfo 失败，判据名沿用 %s（%s: %s）" % (
                self._self_name or "(空)", type(error).__name__, error)
            self._self_name_at = now  # 别每轮请求都撞一次失败
            return
        display = str(field(info, "display_name") or field(info, "nickname") or "")
        wxid = str(field(info, "id") or field(info, "wxid") or "")
        if not display or not wxid:
            self._self_name_note = "GetMyInfo 缺 id/display_name，判据名沿用 %s" % (self._self_name or "(空)")
            self._self_name_at = now
            return
        if self._self_name and display != self._self_name:
            self._self_name_note = "判据名已刷新：%s → %s" % (self._self_name, display)
        else:
            self._self_name_note = ""
        self._self_name = display
        self._self_wxid = wxid
        self._self_name_at = now

    def _self_display_name(self) -> str:
        """当前判据名；过期就经主线程执行器重读一次。失败保留旧值。"""
        if self._self_name and (time.monotonic() - self._self_name_at) < self._self_name_ttl:
            return self._self_name
        executor = self._executor
        if executor is not None:
            try:
                executor.call(lambda wx: self._refresh_identity(wx, force=True), timeout=5.0)
            except BaseException:
                pass  # 失败时 _refresh_identity 已记 note，名字保持旧值
        return self._self_name

    def detail(self) -> str:
        """`/health` 与 `/status` 共用：把当前判据名摆到明面上，改名后一眼能看出来。"""
        parts = []
        version = client_version()
        if version:
            parts.append("客户端 %s" % version)
        name = self._self_display_name()
        if name:
            parts.append("群 @ 判据：@%s" % name)
        if self._self_name_note:
            parts.append(self._self_name_note)
        for note in (self._rooms_note, getattr(self, "_rooms_at_note", "")):
            if note:
                parts.append(note)
        if self._listen_names:
            quiet = int(time.monotonic() - self._last_inbound_at)
            parts.append("监听 %d 个会话，最近事件 %d 秒前" % (len(self._listen_names), quiet))
        if self._catchup_total:
            parts.append("重挂后补读 %d 条" % self._catchup_total)
        if self._reattach_count:
            parts.append("监听已自动重挂 %d 次（客户端界面卡住，或另一个 UI 自动化工具抢过窗口）" % self._reattach_count)
        switches = int(getattr(self, "_account_switch_count", 0))
        if switches:
            parts.append("检测到客户端窗口更换（换号/重新登录），已重建连接 %d 次" % switches)
        return "；".join(parts)

    # -- 挂载与监听（全部在主线程上执行） ---------------------------------
    def _setup_wx(self):
        """在主线程里构造 WeChat 并开始监听；返回值交给 `_MainThreadExecutor.call`。"""
        from wxautox4.wx import WeChat  # noqa: PLC0415 —— 只在这个后端、这个时刻导入

        wx = WeChat(version=WECHAT_VERSION)
        self._hwnd = int(getattr(getattr(wx, "_api", None), "HWND", 0) or 0)
        self._refresh_identity(wx, force=True)
        if not self._self_wxid or not self._self_name:
            raise RuntimeError("已 attach 客户端但拿不到 id/display_name（%s）"
                               % (self._self_name_note or "GetMyInfo 无有效返回"))
        self._listen_note = self._start_listening(wx)
        return wx

    def _add_listen(self, wx, name: str) -> None:
        try:
            wx.AddListenChat(nickname=name, callback=self._on_message)
        except TypeError:
            wx.AddListenChat(name, self._on_message)
        self._room_id_for(name)

    def _window_alive(self, wx) -> bool:
        """Whether the client window this process attached to still exists.

        A signed-out or switched account closes that window and opens another; the object we hold keeps answering from its
        own cache, which is why the identity and the chat list both looked frozen. One `IsWindow` call settles it.
        """
        if os.name != "nt":
            return True
        hwnd = int(getattr(self, "_hwnd", 0) or 0)
        if not hwnd:
            return True
        try:
            import ctypes  # noqa: PLC0415

            return bool(ctypes.WinDLL("user32").IsWindow(hwnd))
        except BaseException:
            return True

    def _reset_for_new_account(self) -> None:
        """Drop everything that belongs to the account that just went away. **Main thread only.**"""
        with self._queue_lock:
            self._queue.clear()
        self._room_names.clear()
        self._observed.clear()
        self._chat_kind.clear()
        self._rooms_cache = []
        self._rooms_cache_at = 0.0
        self._recent_groups_cache = []
        self._recent_groups_at = 0.0
        self._listen_names = []
        self._listening = False
        self._self_wxid = ""
        self._self_name = ""
        self._self_name_at = 0.0
        self._self_name_note = ""
        self._hwnd = 0
        self._account_switch_count = int(getattr(self, "_account_switch_count", 0)) + 1
        self._last_inbound_at = time.monotonic()
        self._last_reattach_at = self._last_inbound_at

    def _catchup(self, wx) -> None:
        """**Main thread only.** Queue what arrived while the listener was detached.

        The listener is push-only, so a message sent during a gap is delivered to nobody and the queue never learns it
        existed. After a re-attach each watched chat's last messages are read and anything unseen is queued; the Engine keys a
        Trigger by message id, so a redelivery is harmless and a missed one is not.
        """
        if not self._catchup_due:
            return
        now = time.monotonic()
        if now - self._catchup_at < CATCHUP_GAP_S:
            return
        names = [name for name in list(self._listen_names) if name][:CATCHUP_MAX_CHATS]
        if not names:
            # Nothing is watched yet; the polling loop pushes the set on its next round, so keep the flag.
            return
        self._catchup_at = now
        self._catchup_due = False
        for name in names:
            try:
                chat = wx.ChatWith(name)
            except BaseException:
                if self.verbose:
                    traceback.print_exc()
                continue
            try:
                history = list((chat or wx).GetAllMessage() or [])
            except BaseException:
                if self.verbose:
                    traceback.print_exc()
                continue
            room = self._room_id_for(name) if self._chat_kind.get(wxname(name)) == "group" else ""
            added = 0
            for msg in history[-CATCHUP_MAX_MESSAGES:]:
                if self._enqueue_event(msg, room, historical=True) is not None:
                    added += 1
            self._catchup_total += added
            if added and self.verbose:
                sys.stderr.write("[catchup] %s: %d\n" % (name, added))

    def _maintain(self, wx):
        """**Main thread only.** Attach when there is no client, replace one whose window is gone, else keep the listener honest."""
        now = time.monotonic()
        if now - float(getattr(self, "_last_maintain_at", 0.0)) < MAINTAIN_TICK_S:
            return wx
        self._last_maintain_at = now
        if wx is None:
            self._reset_for_new_account()
            attached = self._setup_wx()
            self._probe = None      # 让 `/health` 重新问一次，而不是继续报旧失败
            self._catchup_due = True
            return attached
        if self._window_alive(wx):
            self._reattach_if_quiet(wx)
            self._catchup(wx)
            return wx
        self._reset_for_new_account()
        try:
            attached = self._setup_wx()
            self._catchup_due = True
            return attached
        except BaseException:
            if self.verbose:
                traceback.print_exc()
            return wx

    def _reattach_if_quiet(self, wx) -> None:
        """Re-attach a listener that has gone silent. **Main thread only.**

        The client can stop delivering without the process noticing: `AddListenChat` still answers, `StartListening` still
        returns, and the only symptom is that nothing arrives - which looks exactly like a quiet chat. So a stale attach
        is inferred from silence, re-attached once per window, and reported in `detail()`.
        """
        if not self._listen_names or not self._listening:
            return
        now = time.monotonic()
        if now - self._last_inbound_at < LISTENER_QUIET_S:
            return
        if now - self._last_reattach_at < LISTENER_REATTACH_GAP_S:
            return
        self._last_reattach_at = now
        for name in list(self._listen_names):
            try:
                self._remove_listen(wx, name)
            except BaseException:
                pass
            try:
                self._add_listen(wx, name)
            except BaseException:
                if self.verbose:
                    traceback.print_exc()
        try:
            wx.StartListening()
            self._listening = True
        except BaseException:
            if self.verbose:
                traceback.print_exc()
        self._reattach_count += 1
        self._last_inbound_at = now
        # Silence is what a gap looks like: whatever arrived during it was never pushed, so read it back.
        self._catchup_due = True

    def _start_listener_watchdog(self) -> None:
        """Runs the quiet check on a timer, submitting it to the main thread like every other WeChat call."""
        if self._watchdog is not None:
            return
        # The base loop creates this lazily, and `_setup_wx` runs before it does.
        event = getattr(self, "_stop_event", None)
        if event is None:
            event = self._stop_event = threading.Event()

        def loop() -> None:
            while not event.wait(WATCHDOG_TICK_S):
                try:
                    self._executor.call(lambda wx: self._reattach_if_quiet(wx), timeout=120.0)
                except BaseException:
                    pass

        self._watchdog = threading.Thread(target=loop, daemon=True, name="wxbridge-listener-watchdog")
        self._watchdog.start()

    def _remove_listen(self, wx, name: str) -> None:
        removed = False
        for attempt in (lambda: wx.RemoveListenChat(nickname=name), lambda: wx.RemoveListenChat(name)):
            try:
                attempt()
                removed = True
                break
            except TypeError:
                continue
        if not removed:
            raise RuntimeError("this wxauto build exposes no RemoveListenChat(nickname=…)")

    def _candidate_names(self, wx) -> "list[str]":
        """收集候选显示名：已观测到的 room + GetAllRecentGroups() + GetSession()。

        `wxname_…` 只能靠「对候选名算一次哈希」反查回显示名，没有反函数。
        """
        names = [n for n in self._room_names.values() if n]
        # The cached half: this list is expensive and opens the client's contact window, so it is shared with
        # `/rooms` and refreshed on its own schedule rather than on every lookup.
        names.extend(self._recent_groups(wx))
        try:
            for item in wx.GetSession() or []:
                name = field(item, "name")
                if isinstance(name, str) and name:
                    names.append(name)
        except BaseException:
            pass
        seen, out = set(), []
        for name in names:
            if name not in seen:
                seen.add(name)
                out.append(name)
        return out

    def _start_listening(self, wx) -> str:
        """启动时对 --listen 里的每个会话挂监听；单个失败只记 note，不整进程失败。"""
        notes = []
        for name in self._listen_names:
            try:
                self._add_listen(wx, name)
            except BaseException as error:
                notes.append("AddListenChat(%s) 失败: %s" % (name, error))
                continue
        try:
            wx.StartListening()
            self._listening = True
        except BaseException as error:
            notes.append("StartListening 失败: %s" % error)
        if not self._listen_names:
            notes.append("未配置 --listen：监听模式下不会收到任何消息")
        self._last_inbound_at = time.monotonic()
        self._start_listener_watchdog()
        self._warm_rooms_in_background()
        return "；".join(notes)

    def _warm_rooms_in_background(self) -> None:
        """Fill the `/rooms` cache before anyone presses refresh.

        The first listing walks the client's contact pages - measured at 19 s on this account - so it
        happens here, on a daemon thread after the listener is up, instead of during the one click a
        person is watching.
        """
        def run() -> None:
            try:
                self.rooms()
            except BaseException:
                pass

        threading.Thread(target=run, daemon=True, name="wxbridge-warm-rooms").start()

    def _apply_listen(self, wx, requested: "list[str]", options: "dict | None" = None) -> dict:
        """集合替换（幂等）：只对差异发微信调用；集合与选项都相同时一个调用都不发。"""
        changes = {name: value for name, value in (options or {}).items()
                   if name in INBOUND_DEFAULTS and isinstance(value, bool)}
        chosen = {**self._options, **changes}
        options_changed = chosen != self._options
        self._options = chosen
        failed = []
        # Resolve from what is already known first: `/rooms` and every earlier `/listen` recorded id → name, so the
        # common case needs no client call at all.
        target: "OrderedDict[str, str]" = OrderedDict()
        unresolved = []
        for entry in requested:
            if entry.startswith("wxname_"):
                name = self._room_names.get(entry)
                if not name:
                    unresolved.append(entry)
                    continue
            else:
                name = entry
            if name:
                target[wxname(name)] = name

        current: "OrderedDict[str, str]" = OrderedDict()
        for name in self._listen_names:
            current[wxname(name)] = name

        # The polling loop pushes the same configuration every few seconds. When it is unchanged and every id was
        # resolvable, this returns without touching the client: `GetAllRecentGroups()` opens the contact window, and
        # calling it on a timer makes that window reopen and scroll for ever.
        if not unresolved and list(target) == list(current) and not options_changed:
            return {"listening": [{"id": room_id, "name": name} for room_id, name in current.items()],
                    "added": [], "removed": [], "failed": []}

        # A change is worth the client's UI; the identity refresh rides along with it, which is also the moment an
        # operator has just renamed the account.
        self._refresh_identity(wx, force=True)
        if unresolved:
            by_id = {wxname(name): name for name in self._candidate_names(wx)}
            for entry in unresolved:
                name = by_id.get(entry)
                if not name:
                    failed.append({"room": entry, "detail": "无法把 id 解析回显示名（候选表里没有）"})
                    continue
                target[wxname(name)] = name

        added, removed = [], []
        for room_id, name in target.items():
            if room_id in current:
                continue
            try:
                self._add_listen(wx, name)
            except BaseException as error:
                failed.append({"room": name, "detail": "会话不存在或 AddListenChat 返回失败: %s" % error})
                continue
            added.append(name)

        for room_id, name in current.items():
            if room_id in target:
                continue
            try:
                self._remove_listen(wx, name)
            except BaseException as error:
                failed.append({"room": name, "detail": "RemoveListenChat 失败: %s" % error})
                continue
            removed.append(name)

        final: "OrderedDict[str, str]" = OrderedDict(
            (room_id, name) for room_id, name in current.items() if name not in removed)
        for name in added:
            final[wxname(name)] = name
        self._listen_names = list(final.values())
        return {
            "listening": [{"id": room_id, "name": name} for room_id, name in final.items()],
            "added": added,
            "removed": removed,
            "failed": failed,
        }

    def _transcribe(self, msg) -> "str | None":
        """语音转文字。`to_text()` 会占 UI，**必须**经主线程执行器，且只尝试一次（不重试）。"""
        to_text = getattr(msg, "to_text", None)
        if not callable(to_text):
            return None
        executor = self._executor
        if executor is None:
            return None
        try:
            value = executor.call(lambda wx: to_text(), timeout=VOICE_TIMEOUT_S)
        except BaseException:
            return None
        return _as_text_value(value) or None

    def _render_text(self, msg, room: str) -> str:
        """把一条消息渲染成 `text`：语音转写、引用拼接、非文本占位。绝不返回空串。"""
        kind = str(getattr(msg, "type", "") or "")
        content = getattr(msg, "content", "")
        text = content.strip() if isinstance(content, str) else ""

        if kind == "voice":
            if not self._options.get("voice", True):
                return (text + "（语音未转写）") if text else PLACEHOLDERS["voice"]
            transcribed = self._transcribe(msg)
            if transcribed:
                return transcribed
            return (text + "（语音转写失败）") if text else "（语音转写失败）"

        if kind == "quote":
            quoted = _quoted_text(msg)
            if quoted:
                return "「引用」%s\n%s" % (quoted, text) if text else "「引用」%s" % quoted
            return text or PLACEHOLDERS["quote"]

        if text:
            return text
        return PLACEHOLDERS.get(kind, GENERIC_PLACEHOLDER)

    def _enqueue_event(self, msg, room, historical=False):
        """Convert one client message into a queued event, or `None` when it is already queued.

        The listener callback and the post-re-attach catch-up both come through here: same conversion, same dedupe, same
        observation, so the order in which a message reaches us cannot change what the Engine sees. A catch-up message is
        marked `historical` so the Node side hands it to the assessment without receipting or auto-replying to old words.
        """
        event = self._to_event(msg, room)
        if historical:
            event["historical"] = True
        native = event["nativeId"]
        if native in self._seen:
            return None
        self._seen[native] = time.monotonic()
        while len(self._seen) > SEEN_MAX:
            self._seen.popitem(last=False)
        if event["media"]:
            self._raw[native] = msg
        with self._queue_lock:
            self._seq += 1
            self._queue.append((self._seq, event))
            while len(self._raw) > 256:
                self._raw.pop(next(iter(self._raw)), None)
        self._last_event_at = event["at"]
        self._last_inbound_at = time.monotonic()
        self._observe(room, event["sender"])
        return event

    def _on_message(self, msg, chat=None):
        """监听回调（wxautox4 的线程）：只做入队，不碰微信 API，绝不抛异常。"""
        try:
            kind = str(getattr(msg, "type", "") or "")
            chat_type = str(field(chat, "chat_type") or "")
            who = str(field(chat, "who") or field(chat, "_last_chat") or "")
            room = self._room_id_for(who) if chat_type == "group" else ""
            if who and chat_type:
                self._chat_kind[wxname(who)] = chat_type
            if kind == "time":
                # 时间分隔符不是消息：记下来给后续事件当 `at`，自己不进事件流。
                marker = _marker_time(msg)
                if marker:
                    self._time_markers[room] = marker
                return
            event = self._enqueue_event(msg, room)
            if event is None:
                return
            if self.verbose:
                sys.stderr.write("[listen] %s room=%r %s\n" % (event["nativeId"], room, chat_type))
        except BaseException:
            if self.verbose:
                traceback.print_exc()

    def _observe(self, room: str, sender: dict) -> None:
        """记录「该会话里见过这个发送人」，供 `members` 用（observed 语义）。"""
        sender_id = sender.get("id") or ""
        if not sender_id:
            return
        bucket = self._observed.get(room)
        if bucket is None:
            bucket = self._observed[room] = OrderedDict()
        bucket[sender_id] = sender.get("name") or sender_id

    def prepare(self) -> None:
        # 先把执行器建好，避免 /health 抢在 run_main_loop 之前看到 None。
        if self._executor is None:
            self._executor = _MainThreadExecutor(self._setup_wx, self._maintain)

    def run_main_loop(self) -> None:
        """主线程：attach + 监听，然后循环执行 HTTP 线程提交的微信调用。"""
        self._prepare_sys_path()
        self.prepare()
        self._executor.run()

    def probe(self):
        with self._probe_lock:
            if self._probe is not None:
                return self._probe
            executor = self._executor
            if executor is None:
                return False, "the pc-uia main loop has not started yet"  # 不缓存：主循环可能稍后才起
            if not executor.wait_ready(PROBE_TIMEOUT_S):
                self._probe = (False, "attach 超过 %ss 未返回（客户端窗口不在当前交互式会话？见 ADR-005 §6 前置 4）"
                               % PROBE_TIMEOUT_S)
                return self._probe
            # A failed attach is retried in the background, so its reason must not be cached as the final answer.
            if executor.client is None:
                error = executor.error
                return False, ("attach 失败：%s: %s（每 %ss 重试一次；换号后请确认客户端已登录并只开一个主窗口）"
                               % (type(error).__name__, error, MAINTAIN_TICK_S) if error else
                               "attach 尚未完成；每 %ss 重试一次" % MAINTAIN_TICK_S)
            if executor.error is not None:
                self._probe = (False, "%s: %s" % (type(executor.error).__name__, executor.error))
                return self._probe
            self._probe = (True, self._listen_note)
            return self._probe

    def close(self) -> None:
        super().close()
        with self._close_lock:
            if self._closed:
                return
            self._closed = True
            executor = self._executor
            if executor is None:
                return
            try:
                if self._listening:
                    executor.call(lambda wx: wx.StopListening(), timeout=5.0)
            except BaseException:
                if self.verbose:
                    traceback.print_exc()
            self._listening = False
            executor.stop()

    def _require(self):
        ok, detail = self.probe()
        if not ok:
            raise Unavailable(detail or "the pc-uia backend is not available")

    # -- 契约方法 ---------------------------------------------------------
    def status(self):
        ok, detail = self.probe()
        name = self._self_display_name() if ok else self._self_name
        state = {
            "loggedIn": bool(ok), "wxid": self._self_wxid, "name": name,
            "backend": self.name, "available": bool(ok),
        }
        version = client_version()
        if version:
            state["client"] = version
        if self._last_event_at:
            state["lastEventAt"] = self._last_event_at
        detail = "；".join(part for part in (detail, self.detail()) if part)
        if detail:
            state["detail"] = detail
        return state

    @staticmethod
    def _window_minimized(wx) -> bool:
        """Whether the client's main window is minimised, read with one Win32 call.

        `GetAllRecentGroups()` must find the Contacts page's list control; a minimised window never
        renders it, so the call fails after its own ten-second lookup timeout. Knowing that up front
        is the difference between "the picker is empty in 0.05 s" and "the bridge did not answer".
        """
        try:
            import ctypes
            import ctypes.wintypes as wt

            hwnd = int(getattr(getattr(wx, "_api", None), "HWND", 0) or 0)
            if not hwnd:
                return False
            ctypes.WinDLL("user32").IsIconic.argtypes = [wt.HWND]
            return bool(ctypes.WinDLL("user32").IsIconic(hwnd))
        except BaseException:
            return False

    def _recent_groups(self, wx) -> list:
        """`GetAllRecentGroups()` behind a cache: it costs ~10 s and sometimes returns nothing.

        A slow or failing collection keeps the previous answer and is not retried for a minute, so one
        bad call cannot turn every later refresh into another ten seconds.
        """
        now = time.monotonic()
        if self._recent_groups_cache and now - self._recent_groups_at < RECENT_GROUPS_TTL_S:
            return self._recent_groups_cache
        if now - self._recent_groups_at < RECENT_GROUPS_RETRY_S:
            return self._recent_groups_cache
        if self._window_minimized(wx):
            # Not a failure: the window simply cannot render the list it needs. Keep whatever was
            # learned before, and say why the list is short instead of stalling for ten seconds.
            self._rooms_note = "客户端窗口最小化，群列表暂不可枚举；先在微信里打开目标群，再点刷新"
            return self._recent_groups_cache
        self._recent_groups_at = now
        collected = []
        try:
            for item in wx.GetAllRecentGroups() or []:
                name = item[0] if isinstance(item, (list, tuple)) and item else field(item, "name")
                if isinstance(name, str) and name:
                    collected.append(name)
        except BaseException:
            if self.verbose:
                traceback.print_exc()
        if collected:
            self._recent_groups_cache = collected
            self._rooms_note = ""
        return self._recent_groups_cache

    def _visible_rooms(self, wx) -> list:
        """客户端**能看到的**会话：`GetAllRecentGroups()` 的群 + `GetSession()` 里的会话。

        只读——不 `AddListenChat`，不切会话，不改任何状态。「正在听哪些」由 `/listen` 的
        `listening` 表达，不混进这里（面板下拉要的是候选全集，不是订阅状态）。
        """
        names = list(self._recent_groups(wx))
        try:
            for item in wx.GetSession() or []:
                name = field(item, "name")
                if isinstance(name, str) and name:
                    names.append(name)
        except BaseException:
            if self.verbose:
                traceback.print_exc()

        out, seen = [], set()
        for name in names:
            room_id = wxname(name)
            if room_id in seen:
                continue
            seen.add(room_id)
            self._room_names.setdefault(room_id, name)
            out.append({"id": room_id, "name": name})
        # 按显示名排序：`GetSession()` 是 MRU 序，新消息一来就抖，面板下拉需要稳定顺序。
        out.sort(key=lambda item: (item["name"], item["id"]))
        total = len(out)
        if total > ROOMS_LIMIT:
            self._rooms_note = "可见会话 %d 个，已截断到前 %d" % (total, ROOMS_LIMIT)
            out = out[:ROOMS_LIMIT]
        elif not self._rooms_note:
            self._rooms_note = ""
        return out

    def rooms(self):
        """`GET /rooms`：本后端**能看到的**会话（不是正在听的，见 contract.md §1）。

        答案缓存 `ROOMS_CACHE_S`；刷新超时或失败时返回上一次的答案——「稍旧的候选列表」远好过
        让面板把它变成「桥没有响应」，而候选列表本来就只用于人工挑选。
        """
        self._require()
        now = time.monotonic()
        if self._rooms_cache and now - self._rooms_cache_at < ROOMS_CACHE_S:
            return self._rooms_cache
        try:
            answer = self._executor.call(lambda wx: self._visible_rooms(wx), timeout=25.0)
        except Unavailable:
            if self._rooms_cache:
                return self._rooms_cache
            raise
        except BaseException as error:
            if self._rooms_cache:
                self._rooms_at_note = "上次刷新失败（%s），这是上一份候选列表" % error
                return self._rooms_cache
            raise Unavailable("GetSession/GetAllRecentGroups failed: %s" % error)
        self._rooms_cache = answer
        self._rooms_cache_at = time.monotonic()
        self._rooms_at_note = ""
        return answer

    def members(self, room):
        """observed 语义：返回该会话里实际发过言的发送人（没有成员表 API）。"""
        self._require()
        bucket = self._observed.get(self._normalize_room(room)) or {}
        return [{"id": sender_id, "name": name} for sender_id, name in bucket.items()]

    def _to_event(self, msg, room):
        native = _msg_native_id(msg, room)
        own = str(getattr(msg, "attr", "") or "") == "self"
        sender_name = str(getattr(msg, "sender", "") or "")
        if own and sender_name in ("", "self"):
            sender_name = self._self_name  # 自己的消息里 sender 是字面量 'self'，不是名字
        if not sender_name:
            sender_name = "未知发送人"
        # 只列“这个构建真的能下载”的图片（ADR-005 §7：免费构建可能只有 type='image' 而无 download()）
        downloadable = str(getattr(msg, "type", "") or "") == "image" and callable(getattr(msg, "download", None))
        return {
            "nativeId": native,
            "room": room,
            "sender": {"id": wxname(sender_name), "name": sender_name},
            "text": self._render_text(msg, room),
            # 取值顺序：房间内最近的 TimeMessage 时间 → 消息自带时间 → 服务端接收时间
            "at": self._time_markers.get(room) or _msg_time(msg) or iso_now(),
            "ats": marked_mentions(msg, self._self_name, self._self_wxid),
            "own": own,
            "quoteId": "",
            "media": [{"id": "%s#0" % native, "kind": "image"}]
            if downloadable and self._options.get("images", True) else [],
        }

    def messages(self, room, cursor, limit):
        """监听队列出队；游标是单调递增序号（字符串整数），语义与 fake 一致。"""
        self._require()
        self._self_display_name()  # 轮询路径顺带按 TTL 刷新判据名（改名后无需重启）
        target = self._normalize_room(room)
        try:
            after = int(cursor) if cursor else 0
        except (TypeError, ValueError):
            after = 0
        with self._queue_lock:
            head = str(self._seq)
            page = [(seq, dict(event)) for seq, event in self._queue
                    if seq > after and event["room"] == target][:limit]
        if not page:
            return [], (cursor or "0"), head
        return [event for _, event in page], str(page[-1][0]), head

    def send(self, room, wxid, text, quote_id="", at=None, file=None):
        """只发文本，且在**主线程**上发（跨线程调微信会让监听失效）。

        `at` 只对群有用：单聊没有"提及"，传了也只会让客户端困惑，所以这里直接丢掉。群里的条目可以是
        `wxname_…` id 或显示名；id 只能靠 `_observed` 里该会话观测过的发送人来解析，解析不出来就不提，
        绝不把 id 原样塞进客户端。
        """
        self._require()
        target = ""
        if room:
            target = self._room_names.get(room) or ("" if room.startswith("wxname_") else room)
        if not target and wxid:
            target = self._room_names.get(wxid) or wxid
        if not target:
            raise SendGone(room)
        mentions = []
        if room and at:
            known = self._observed.get(room) or {}
            for entry in at:
                if not isinstance(entry, str) or not entry:
                    continue
                name = known.get(entry) if entry.startswith("wxname_") else entry
                if name and name not in mentions:
                    mentions.append(name)
        try:
            if text:
                self._executor.call(lambda wx: wx.SendMsg(text, who=target, **({"at": mentions} if mentions else {})))
            if file is not None:
                path, name = file
                self._executor.call(lambda wx: wx.SendFiles(filepath=path, who=target))
        except Unavailable:
            raise
        except BaseException as error:
            raise Unavailable("SendMsg failed: %s" % error)
        return "pcui_" + os.urandom(5).hex()

    def media(self, media_id):
        """`<nativeId>#<index>` → 原始消息对象 download()。无 download() → 501，定位不到 → 404。"""
        self._require()
        native, _, index = media_id.partition("#")
        if not native or (index and index != "0"):
            raise MediaGone(media_id)
        with self._queue_lock:
            message = self._raw.get(native)
        if message is None:
            raise MediaGone(media_id)
        download = getattr(message, "download", None)
        if not callable(download):
            raise MediaUnsupported("this wxauto build exposes no download()")
        try:
            return self._executor.call(lambda wx: self._download(message, download))
        except Unavailable:
            raise
        except BaseException as error:
            raise MediaGone("download failed: %s" % error)

    def listen(self, rooms, options=None):
        """`POST /listen`：集合替换式下发。微信调用全部走主线程执行器。"""
        self._require()
        requested = [room for room in rooms if isinstance(room, str) and room]
        changes = {name: value for name, value in (options or {}).items()
                   if name in INBOUND_DEFAULTS and isinstance(value, bool)}
        try:
            return self._executor.call(lambda wx: self._apply_listen(wx, requested, changes), timeout=30.0)
        except Unavailable:
            raise
        except BaseException as error:
            raise Unavailable("listen failed: %s" % error)

    @staticmethod
    def _download(message, download):
        """在主线程里把图片下到临时目录再读回字节。"""
        import tempfile  # noqa: PLC0415

        with tempfile.TemporaryDirectory(prefix="wxmedia-") as directory:
            try:
                download(directory, True)
            except TypeError:
                download(directory)
            for name in sorted(os.listdir(directory)):
                path = os.path.join(directory, name)
                if os.path.isfile(path):
                    with open(path, "rb") as handle:
                        return handle.read(), _guess_mime(name)
        raise MediaGone("download produced no file")


# --------------------------------------------------------------------------- pad（L2）


class PadBackend(Backend):
    name = "pad"
    supports_media = False
    reason = "the pad backend is not implemented"  # 不能叫 detail：会遮蔽 Backend.detail()

    def probe(self):
        return False, self.reason

    def capabilities(self):
        return {"mentions": "none", "members": "none", "media": False}

    def status(self):
        return {"loggedIn": False, "wxid": "", "name": "", "backend": self.name, "available": False, "detail": self.reason}

    def rooms(self):
        raise Unsupported(self.reason)

    def members(self, room):
        raise Unsupported(self.reason)

    def messages(self, room, cursor, limit):
        raise Unsupported(self.reason)

    def send(self, room, wxid, text, quote_id="", at=None, file=None):
        raise Unsupported(self.reason)

    def media(self, media_id):
        raise MediaUnsupported(self.reason)

    def listen(self, rooms, options=None):
        raise Unsupported(self.reason)


# --------------------------------------------------------------------------- 应用层


class Sender:
    """进程内唯一的发送闸门：一把锁 + ≥1s 间隔 + 抖动；`/media` 复用同一把锁。"""

    def __init__(self, backend: Backend) -> None:
        self.backend = backend
        self.lock = threading.Lock()
        self._next_at = 0.0
        self._idem = TTLCache(IDEM_TTL_S, IDEM_MAX_ITEMS)

    def send(self, room: str, wxid: str, text: str, quote_id: str, key: str,
             at: "list[str] | None" = None, file: "tuple[str, str] | None" = None) -> "tuple[str, bool]":
        with self.lock:
            if key:
                cached = self._idem.get(key)
                if isinstance(cached, str):
                    return cached, True
            wait = self._next_at - time.monotonic()
            if wait > 0:
                time.sleep(wait)
            msg_id = self.backend.send(room, wxid, text, quote_id, at, file)
            self._next_at = time.monotonic() + SEND_MIN_INTERVAL_S + random.uniform(0.0, SEND_JITTER_S)
            if key:
                self._idem.put(key, msg_id)
            return msg_id, False


class App:
    def __init__(self, backend: Backend, token: str, media_ttl: float, verbose: bool = False) -> None:
        self.backend = backend
        self.token = token
        self.verbose = verbose
        self.started = time.time()
        self.sender = Sender(backend)
        self.media_cache = TTLCache(media_ttl, MEDIA_MAX_ITEMS)
        self._probe_lock = threading.Lock()
        self._probe: "tuple[bool, str] | None" = None

    def available(self) -> "tuple[bool, str]":
        with self._probe_lock:
            if self._probe is None:
                self._probe = self.backend.probe()
            return self._probe

    def media(self, media_id: str) -> "tuple[bytes, str]":
        cached = self.media_cache.get(media_id)
        if cached:
            return cached
        with self.sender.lock:
            cached = self.media_cache.get(media_id)
            if cached:
                return cached
            payload, mime = self.backend.media(media_id)
            if not payload:  # 零字节绝不带 200 出去（ADR-005 §7 遗留项 IMG-3）
                raise MediaGone(media_id)
            self.media_cache.put(media_id, (payload, mime))
            return payload, mime


# --------------------------------------------------------------------------- HTTP


class BridgeHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "wxauto-bridge/1"
    sys_version = ""

    def log_message(self, fmt, *args):
        if self.server.app.verbose:
            sys.stderr.write("[http] %s\n" % (fmt % args))

    def _drain(self) -> None:
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except (TypeError, ValueError):
            length = 0
        if 0 < length <= MAX_BODY_BYTES:
            try:
                self.rfile.read(length)
            except OSError:
                pass

    def _send(self, status: int, body: bytes, content_type: str, extra=None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for name, value in (extra or {}).items():
            self.send_header(name, value)
        self.end_headers()
        if self.command != "HEAD" and body:
            self.wfile.write(body)

    def _json(self, status: int, payload, extra=None) -> None:
        self._send(status, json.dumps(payload, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8", extra)

    def _authorized(self) -> bool:
        header = self.headers.get("Authorization") or ""
        if not header.startswith("Bearer "):
            return False
        return hmac.compare_digest(header[7:].strip().encode("utf-8"), self.server.app.token.encode("utf-8"))

    def do_GET(self):
        self._dispatch("GET")

    def do_HEAD(self):
        self._dispatch("HEAD")

    def do_POST(self):
        self._dispatch("POST")

    def do_PUT(self):
        self._dispatch("PUT")

    def do_PATCH(self):
        self._dispatch("PATCH")

    def do_DELETE(self):
        self._dispatch("DELETE")

    def do_OPTIONS(self):
        self._dispatch("OPTIONS")

    def _dispatch(self, method: str) -> None:
        try:
            if not self._authorized():
                self._drain()
                self._json(401, {"error": "unauthorized"})
                return
            parts = urlsplit(self.path)
            path = parts.path.rstrip("/") or "/"
            try:
                self._route(method, path, parse_qs(parts.query, keep_blank_values=True))
            except SendGone:
                self._json(409, {"error": "gone"})
            except MediaGone:
                self._json(404, {"error": "not_found"})
            except (MediaUnsupported, Unsupported) as error:
                self._json(501, {"error": "unsupported", "detail": str(error)})
            except Unavailable as error:
                self._json(502, {"error": "unavailable", "detail": str(error)})
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            self.close_connection = True
        except BaseException:
            traceback.print_exc()
            try:
                self._json(500, {"error": "internal"})
            except OSError:
                self.close_connection = True

    def _method_not_allowed(self, allow: str) -> None:
        self._drain()
        self._json(405, {"error": "method_not_allowed"}, {"Allow": allow})

    def _route(self, method: str, path: str, query) -> None:
        app = self.server.app
        if path == "/health":
            if method not in ("GET", "HEAD"):
                return self._method_not_allowed("GET")
            ok, detail = app.available()
            body = {"ok": bool(ok), "available": bool(ok), "version": package_version(), "sidecar": "1",
                    "backend": app.backend.name, "uptimeSec": int(time.time() - app.started),
                    "capabilities": app.backend.capabilities()}
            # 不可用原因 / 挂监听告警 + 后端自述（如「群 @ 判据：@<昵称>」）
            detail = "；".join(part for part in (detail, app.backend.detail()) if part)
            if detail:
                body["detail"] = detail
            return self._json(200, body)
        if path == "/status":
            if method not in ("GET", "HEAD"):
                return self._method_not_allowed("GET")
            return self._json(200, app.backend.status())
        if path == "/rooms":
            if method not in ("GET", "HEAD"):
                return self._method_not_allowed("GET")
            return self._json(200, {"rooms": app.backend.rooms()})
        if path == "/members":
            if method not in ("GET", "HEAD"):
                return self._method_not_allowed("GET")
            return self._json(200, {"members": app.backend.members((query.get("room") or [""])[0])})
        if path == "/messages":
            if method not in ("GET", "HEAD"):
                return self._method_not_allowed("GET")
            return self._messages(query)
        if path == "/send":
            if method != "POST":
                return self._method_not_allowed("POST")
            return self._send_message()
        if path == "/listen":
            if method != "POST":
                return self._method_not_allowed("POST")
            return self._listen()
        if path == "/media" or path.startswith("/media/"):
            if method not in ("GET", "HEAD"):
                return self._method_not_allowed("GET")
            media_id = unquote(path[len("/media/"):]) if path.startswith("/media/") else ""
            if not media_id:
                return self._json(404, {"error": "not_found"})
            payload, mime = app.media(media_id)
            return self._send(200, payload, mime or "application/octet-stream", {"X-Media-Id": media_id})
        return self._json(404, {"error": "not_found"})

    def _messages(self, query) -> None:
        room = (query.get("room") or [""])[0]
        cursor = (query.get("cursor") or [""])[0]
        try:
            limit = int((query.get("limit") or ["50"])[0])
        except (TypeError, ValueError):
            limit = 50
        events, nxt, head = self.server.app.backend.messages(room, cursor, max(1, min(limit, 200)))
        self._json(200, {"events": events, "next": nxt, "head": head})

    def _listen(self) -> None:
        """`POST /listen`：`{"rooms": [名字或 wxname_id, …]}`，集合替换、幂等、部分失败仍 200。"""
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except (TypeError, ValueError):
            length = 0
        if length <= 0 or length > MAX_BODY_BYTES:
            return self._json(400, {"error": "bad_request"})
        try:
            body = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            return self._json(400, {"error": "bad_request"})
        if not isinstance(body, dict):
            return self._json(400, {"error": "bad_request"})
        rooms = body.get("rooms")
        if not isinstance(rooms, list) or any(not isinstance(room, str) for room in rooms):
            return self._json(400, {"error": "bad_request"})
        options = body.get("options", {})
        if not isinstance(options, dict):
            return self._json(400, {"error": "bad_request"})
        for name, value in options.items():
            if name in INBOUND_DEFAULTS and not isinstance(value, bool):
                return self._json(400, {"error": "bad_request"})
        self._json(200, self.server.app.backend.listen(rooms, options))

    def _send_message(self) -> None:
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except (TypeError, ValueError):
            length = 0
        if length <= 0 or length > MAX_SEND_BODY_BYTES:
            return self._json(413, {"error": "too_large"})
        try:
            body = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            return self._json(400, {"error": "bad_request"})
        if not isinstance(body, dict):
            return self._json(400, {"error": "bad_request"})
        pick = lambda name: body.get(name) if isinstance(body.get(name), str) else ""  # noqa: E731
        at = body.get("at")
        if at is None:
            at = []
        elif isinstance(at, str):
            at = [at]
        if not isinstance(at, list) or any(not isinstance(entry, str) for entry in at):
            return self._json(400, {"error": "bad_request"})
        text = pick("text")
        raw_file = body.get("file")
        if raw_file is None and not text:
            return self._json(400, {"error": "bad_request"})
        file = None
        if raw_file is not None:
            if not isinstance(raw_file, dict):
                return self._json(400, {"error": "bad_request"})
            name, data = raw_file.get("name"), raw_file.get("data")
            if not isinstance(name, str) or not isinstance(data, str) or not data:
                return self._json(400, {"error": "bad_request"})
            try:
                payload = base64.b64decode(data, validate=True)
            except (ValueError, TypeError):
                return self._json(400, {"error": "bad_request"})
            if not payload or len(payload) > MAX_OUTBOUND_FILE_BYTES:
                return self._json(413, {"error": "too_large"})
            path = outbound_path(name)
            with open(path, "wb") as handle:
                handle.write(payload)
            file = (path, os.path.basename(path))
        msg_id, deduped = self.server.app.sender.send(
            pick("room"), pick("wxid"), text, pick("quoteId"),
            (self.headers.get("Idempotency-Key") or "").strip(),
            [entry for entry in at if entry],
            file,
        )
        self._json(200, {"msgId": msg_id, "deduped": deduped})


class BridgeServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True
    request_queue_size = 64

    def __init__(self, address, handler, app: App) -> None:
        self.app = app
        super().__init__(address, handler)


def install_signal_handlers(server, on_stop=None) -> None:
    """SIGTERM/SIGINT/SIGBREAK → on_stop() + server.shutdown()，由另一个线程执行。"""

    def shutdown(signum, _frame):
        sys.stderr.write("wxauto-bridge: 收到信号 %s，正在停止\n" % signum)
        sys.stderr.flush()

        def stop():
            if on_stop is not None:
                try:
                    on_stop()
                except BaseException:
                    traceback.print_exc()
            server.shutdown()

        threading.Thread(target=stop, daemon=True).start()

    for name in ("SIGTERM", "SIGINT", "SIGBREAK"):
        sig = getattr(signal, name, None)
        if sig is None:
            continue
        try:
            signal.signal(sig, shutdown)
        except (ValueError, OSError):
            pass


# --------------------------------------------------------------------------- 入口


def build_backend(args) -> Backend:
    if args.backend == "fake":
        return FakeBackend()
    if args.backend == "pad":
        return PadBackend()
    venv = args.venv or default_venv()
    return PcUiaBackend(venv=venv,
                        verbose=args.verbose, listen=args.listen, queue_size=args.queue_size,
                        self_name_ttl=args.self_name_ttl)


def parse_args(argv):
    parser = argparse.ArgumentParser(prog="wxauto-bridge", description="微信个人号 sidecar（契约见 contract.md）")
    parser.add_argument("--backend", choices=("fake", "pc-uia", "pad"), default="fake")
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--token", default=os.environ.get("WXBRIDGE_TOKEN") or "")
    parser.add_argument("--media-cache-ttl", type=float, default=300.0)
    parser.add_argument("--venv", default=None, help="wxautox4 所在的 venv 根目录（也可用 WXBRIDGE_VENV；不给就用当前解释器）")
    parser.add_argument("--listen", action="append", default=[], metavar="NAME",
                        help="要监听的会话显示名（可重复；pc-uia 监听模式必需）")
    parser.add_argument("--queue-size", type=int, default=500, help="监听队列保留的消息条数（默认 500）")
    parser.add_argument("--self-name-ttl", type=float, default=60.0,
                        help="群 @ 判据名（本账号显示名）的重读间隔秒数（默认 60）")
    parser.add_argument("--allow-remote", action="store_true", help="允许绑定非 loopback 地址（默认禁止）")
    parser.add_argument("--verbose", action="store_true")
    return parser.parse_args(argv)


def main(argv=None) -> int:
    args = parse_args(argv if argv is not None else sys.argv[1:])
    for stream in (sys.stderr, sys.stdout):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass
    if not args.token:
        sys.stderr.write("wxauto-bridge: 缺少 --token（或环境变量 WXBRIDGE_TOKEN）\n")
        return 2
    if args.host not in LOOPBACK_HOSTS and not args.allow_remote:
        sys.stderr.write("wxauto-bridge: 拒绝绑定 %s —— 默认只允许 loopback（契约 §8）\n" % args.host)
        return 2
    backend = build_backend(args)
    try:
        server = BridgeServer((args.host, args.port), BridgeHandler, App(backend, args.token, args.media_cache_ttl, args.verbose))
    except OSError as error:
        sys.stderr.write("wxauto-bridge: 绑定 %s:%s 失败: %s\n" % (args.host, args.port, error))
        return 1
    install_signal_handlers(server, on_stop=backend.close)
    try:
        backend.prepare()  # 不阻塞的准备（pc-uia 在这里建主线程执行器）
    except BaseException:
        traceback.print_exc()
    # 只打印 token=set，绝不打印 token 本身（契约 §2）。
    sys.stderr.write("wxauto-bridge: listening on http://%s:%s backend=%s token=set version=%s\n"
                     % (server.server_address[0], server.server_address[1], backend.name, package_version()))
    sys.stderr.flush()
    # HTTP 走后台线程；主线程归后端（pc-uia 的微信监听必须注册在主线程）。
    serving = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.2}, name="http", daemon=True)
    serving.start()
    try:
        backend.run_main_loop()
    except KeyboardInterrupt:
        pass
    finally:
        try:
            backend.close()  # 幂等；监听模式必须 StopListening
        except BaseException:
            traceback.print_exc()
        try:
            server.shutdown()
        except BaseException:
            pass
        server.server_close()
        sys.stderr.write("wxauto-bridge: stopped\n")
        sys.stderr.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
