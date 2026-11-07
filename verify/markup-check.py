# -*- coding: utf-8 -*-
"""群 `@` 标记判定 + 监听队列语义的单元级验证（**完全不碰微信**）。

1. `marked_mentions()` 五条用例：U+2005 标记命中、普通空格不命中、句末 mention 命中、
   `@所有人␅` 命中、正文提到不命中；外加「绝不调用 msg.at()」的回归守卫。
2. `PcUiaBackend` 的监听队列：直接喂 `_on_message()`（不 attach），验证 room 归一
   （friend → ""）、`wxname_` 身份、游标单调递增与「没有新的就 events:[] 且 next 不变」、
   `members` 的 observed 语义、`send` 的 room 两种写法。

用法：python verify/markup-check.py
"""
import importlib.util
import os
import re
import sys

ISO_RE = re.compile(r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")

HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.abspath(os.path.join(HERE, "..", "sidecar", "wxauto-bridge", "server.py"))
SELF_NAME = "<昵称>"                     # 本账号显示名（样本用占位符，不写真实昵称）
SELF_ID = "<wxid>"                       # GetMyInfo()["id"]，注意不是 wxid_ 形状
SEP = "\u2005"                          # 客户端 @ 之后的四分宽空格

passed = 0
failed = 0


def check(name, ok, detail=""):
    global passed, failed
    if ok:
        passed += 1
        print("  PASS  %s" % name)
    else:
        failed += 1
        print("  FAIL  %s%s" % (name, (" — " + str(detail)) if detail else ""))


def load():
    spec = importlib.util.spec_from_file_location("wxbridge_server", SERVER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Msg:
    """最小消息替身：只提供 marked_mentions / _to_event 需要的字段。"""

    def __init__(self, content, sender="阿黎", attr="friend", type="text", mid=None):
        self.content = content
        self.sender = sender
        self.attr = attr
        self.type = type
        self.id = mid


class Chat:
    def __init__(self, chat_type, who):
        self.chat_type = chat_type
        self.who = who


def markup_cases(module):
    print("[1] marked_mentions 五条用例")
    cases = [
        ("@" + SELF_NAME + SEP + "一会儿带两个豆浆回来，我们吃过了", True, "U+2005 标记（客户端插入）"),
        ("@" + SELF_NAME + " 一会儿带两个豆浆回来", False, "普通空格 U+0020（人工手打）"),
        ("帮我看看 @" + SELF_NAME, True, "句末 mention（无尾随分隔符）"),
        ("@所有人" + SEP + "开会了", True, "@所有人 标记"),
        ("他刚才说了 @" + SELF_NAME + " 这句话", False, "正文提到，不是 @"),
    ]
    for text, want, label in cases:
        got = module.marked_mentions(Msg(text), SELF_NAME, SELF_ID)
        check(label, (got == [SELF_ID]) if want else (got == []), got)

    check("非 str content → []", module.marked_mentions(Msg(None), SELF_NAME, SELF_ID) == [])
    check("空 content → []", module.marked_mentions(Msg(""), SELF_NAME, SELF_ID) == [])
    check("缺 self_wxid → []", module.marked_mentions(Msg("@" + SELF_NAME + SEP + "x"), SELF_NAME, "") == [])
    check("别人被 @ 不算本账号", module.marked_mentions(Msg("@<成员>" + SEP + "妈"), SELF_NAME, SELF_ID) == [])

    called = []

    class BoobyTrapped(Msg):
        def at(self):
            called.append("pat")  # 真实后果：拍一拍
            return {"status": "成功"}

    module.marked_mentions(BoobyTrapped("@" + SELF_NAME + SEP + "hi"), SELF_NAME, SELF_ID)
    check("绝不调用 msg.at()（拍一拍）", called == [], called)


def queue_cases(module):
    print("[2] 监听队列语义（不 attach，直接喂回调）")
    backend = module.PcUiaBackend(listen=["文件传输助手", "<群名>"], queue_size=10)
    backend._probe = (True, "")          # 跳过 probe，绝不 attach 真机
    backend._self_wxid, backend._self_name = SELF_ID, SELF_NAME

    check("capabilities 三态", backend.capabilities()["mentions"] == "markup"
          and backend.capabilities()["members"] == "observed"
          and isinstance(backend.capabilities()["media"], bool), backend.capabilities())

    backend._on_message(Msg("自测一", sender=SELF_NAME, attr="self", mid="n1"), Chat("friend", "文件传输助手"))
    backend._on_message(Msg("@" + SELF_NAME + SEP + "改一下超时", mid="n2"), Chat("group", "<群名>"))
    backend._on_message(Msg("收到", mid="n3"), Chat("group", "<群名>"))

    friend_events, friend_next = backend.messages("", "", 50)
    check("friend 会话 room 为空串", all(e["room"] == "" for e in friend_events) and len(friend_events) == 1, friend_events)
    check("friend 事件 own=true", friend_events[0]["own"] is True, friend_events[0])
    check("游标是字符串整数", friend_next == "1", friend_next)

    group_id = module.wxname("<群名>")
    group_events, group_next = backend.messages(group_id, "", 50)
    check("群会话 id 是 wxname_ 前缀", group_id.startswith("wxname_"), group_id)
    check("群事件两条", [e["nativeId"] for e in group_events] == ["n2", "n3"], group_events)
    check("群 @ 命中本账号", group_events[0]["ats"] == [SELF_ID], group_events[0]["ats"])
    check("群游标 3", group_next == "3", group_next)

    replay, replay_next = backend.messages(group_id, group_next, 50)
    check("传回 next 只拿新的（空）", replay == [] and replay_next == "3", (replay, replay_next))

    by_name, _ = backend.messages("<群名>", "", 50)
    check("/messages 也接受显示名", [e["nativeId"] for e in by_name] == ["n2", "n3"], by_name)

    sender_id = module.wxname("阿黎")
    check("sender.id 是 wxname_", group_events[0]["sender"]["id"] == sender_id, group_events[0]["sender"])
    check("sender.name 保留显示名", group_events[0]["sender"]["name"] == "阿黎", group_events[0]["sender"])

    members = backend.members(group_id)
    check("members 为 observed（本会话发过言的人）",
          [m["id"] for m in members] == [sender_id], members)
    check("未知会话 members 为 []", backend.members("wxname_deadbeef") == [])

    class FakeExec:
        """替身执行器：直接在当前线程执行提交的函数。"""

        def __init__(self, wx):
            self.wx = wx

        def call(self, fn, timeout=None):
            return fn(self.wx)

    class FakeWxRooms:
        """可见会话：两个群 + 一个单聊；监听集合是另一回事。"""

        def __init__(self):
            self.adds = []

        def GetAllRecentGroups(self):
            return [("群B", 5), ("群A", 3)]

        def GetSession(self):
            return [{"name": "群A"}, {"name": "文件传输助手"}]

        def AddListenChat(self, nickname, callback=None):
            self.adds.append(nickname)

    wx_rooms = FakeWxRooms()
    backend._executor = FakeExec(wx_rooms)
    rooms = backend.rooms()
    check("/rooms 是可见会话全集（与监听集合无关）",
          {r["name"] for r in rooms} == {"群A", "群B", "文件传输助手"}, rooms)
    check("/rooms 按显示名排序", [r["name"] for r in rooms] == sorted(r["name"] for r in rooms), rooms)
    check("/rooms id 全是 wxname_", all(r["id"].startswith("wxname_") for r in rooms), rooms)
    check("/rooms 含单聊（面板下拉需要）", any(r["name"] == "文件传输助手" for r in rooms), rooms)
    backend.rooms()
    check("/rooms 只读：一次 AddListenChat 都没发", wx_rooms.adds == [], wx_rooms.adds)

    # 有界队列：超过 queue_size 后丢最旧的
    for i in range(30):
        backend._on_message(Msg("灌入%d" % i, mid="p%d" % i), Chat("friend", "文件传输助手"))
    tail, _ = backend.messages("", "", 500)
    check("队列有界（<= queue_size）", len(tail) <= 10, len(tail))
    check("保留的是最新消息", tail[-1]["nativeId"] == "p29", tail[-1])


def send_room_cases(module):
    print("[3] /send 的 room 解析（不真的发消息）")
    backend = module.PcUiaBackend(listen=["<群名>"], queue_size=10)
    backend._probe = (True, "")
    sent = []

    class FakeWorker:
        """替身 worker：记录 call() 提交的调用并在本线程执行。"""

        def __init__(self):
            self.wx = type("FakeWx", (), {"SendMsg": lambda _self, text, **kw: sent.append((text, kw))})()

        def call(self, fn, timeout=None):
            return fn(self.wx)

    backend._executor = FakeWorker()
    group_id = module.wxname("<群名>")
    backend.send(group_id, "", "hello")
    check("wxname_ id 解析回显示名", sent[-1] == ("hello", {"who": "<群名>"}), sent[-1])
    backend.send("<群名>", "", "hello2")
    check("显示名直接可用", sent[-1] == ("hello2", {"who": "<群名>"}), sent[-1])
    backend.send("", "wxid_alice", "hello3")
    check("单聊按 wxid 发", sent[-1] == ("hello3", {"who": "wxid_alice"}), sent[-1])
    check("绝不带 at= 参数", all("at" not in kwargs for _, kwargs in sent), sent)
    try:
        backend.send("", "", "x")
        check("无目标 → SendGone", False, "no raise")
    except module.SendGone:
        check("无目标 → SendGone（409）", True)


def identity_cases(module):
    print("[4] 判据名 TTL 刷新（不碰微信）")

    class FakeWx:
        def __init__(self, name):
            self.name = name
            self.boom = False
            self.calls = 0

        def GetMyInfo(self):
            self.calls += 1
            if self.boom:
                raise RuntimeError("boom")
            return {"display_name": self.name, "id": "<wxid>"}

    class FakeExec:
        def __init__(self, wx):
            self.wx = wx

        def call(self, fn, timeout=None):
            return fn(self.wx)

    backend = module.PcUiaBackend(listen=[], queue_size=10)
    backend._probe = (True, "")
    wx = FakeWx("A")
    backend._executor = FakeExec(wx)
    backend._self_name_ttl = 0.0  # 每次都过期，逼出刷新

    check("首次读到判据名", backend._self_display_name() == "A", backend._self_name)

    wx.name = "B"
    check("改名后判据跟着刷新", backend._self_display_name() == "B", backend._self_name)
    check("刷新后 @B 命中",
          module.marked_mentions(Msg("@" + backend._self_name + SEP + "hi"),
                                 backend._self_name, backend._self_wxid) == [backend._self_wxid])
    check("刷新后 @A 不命中",
          module.marked_mentions(Msg("@A" + SEP + "hi"), backend._self_name, backend._self_wxid) == [])
    check("detail 报出判据名", backend.detail().startswith("群 @ 判据：@B"), backend.detail())

    wx.boom = True
    backend._self_name_at = 0.0
    kept = backend._self_display_name()
    check("GetMyInfo 抛异常时保留旧名", kept == "B", kept)
    check("失败有 note 记录", "GetMyInfo 失败" in backend._self_name_note, backend._self_name_note)
    check("失败后 @旧名仍命中",
          module.marked_mentions(Msg("@B" + SEP + "hi"),
                                 backend._self_name, backend._self_wxid) == [backend._self_wxid])
    check("失败后 detail 带 note", "GetMyInfo 失败" in backend.detail(), backend.detail())


def inbound_cases(module):
    print("[5] 入站消息加厚：时间标记 / 语音转写 / 引用 / 占位")

    class FakeExec:
        def call(self, fn, timeout=None):
            return fn(object())

    class TimeMsg:
        def __init__(self, stamp):
            self.type = "time"
            self.content = "15:15"
            self.time = stamp
            self.sender = "system"
            self.attr = "system"
            self.id = "t1"

    backend = module.PcUiaBackend(listen=[], queue_size=50)
    backend._probe = (True, "")
    backend._self_name, backend._self_wxid = SELF_NAME, SELF_ID
    backend._executor = FakeExec()
    group = Chat("group", "<群名>")
    room = module.wxname("<群名>")

    backend._on_message(Msg("第一条", mid="a1"), group)
    first, cursor = backend.messages(room, "", 10)
    check("无 marker 时 at 是服务端时间（ISO Z）", bool(ISO_RE.match(first[0]["at"])), first[0]["at"])

    backend._on_message(TimeMsg("2026-11-07 15:15:00"), group)
    backend._on_message(Msg("marker 之后", mid="a2"), group)
    backend._on_message(Msg("再一条", mid="a3"), group)
    later, _ = backend.messages(room, cursor, 10)
    check("marker 之后的事件都用 marker 时间",
          all(e["at"] == backend._time_markers[room] for e in later), later)
    check("marker 时间与无 marker 的首条不同", later[0]["at"] != first[0]["at"], (first[0]["at"], later[0]["at"]))
    check("marker 保留完整日期且是 ISO Z", bool(ISO_RE.match(later[0]["at"])), later[0]["at"])
    check("时间分隔符本身不进事件流", all(e["nativeId"] != "t1" for e in later), later)

    class VoiceOk:
        type, content, sender, attr, id = "voice", "[语音]", "乙", "friend", "v1"

        def to_text(self):
            return "转写好的文字"

    class VoiceDict:
        type, content, sender, attr, id = "voice", "[语音]", "乙", "friend", "v2"

        def to_text(self):
            return {"status": "成功", "data": "字典里的转写"}

    class VoiceBoom:
        type, content, sender, attr, id = "voice", "[语音]", "乙", "friend", "v3"

        def to_text(self):
            raise RuntimeError("nope")

    check("语音转写成功 → text 是转写", backend._render_text(VoiceOk(), "") == "转写好的文字")
    check("语音返回 dict 也认", backend._render_text(VoiceDict(), "") == "字典里的转写")
    boom = backend._render_text(VoiceBoom(), "")
    check("语音转写失败 → 保留原 content + 标注", boom == "[语音]（语音转写失败）", boom)
    check("语音转写失败不产生空串", boom.strip() != "")

    class QuoteOk:
        type, content, sender, attr, id = "quote", "回复正文", "丙", "friend", "q1"
        quote = {"content": "被引原文"}

    class QuoteNone:
        type, content, sender, attr, id = "quote", "回复正文", "丙", "friend", "q2"

    rendered = backend._render_text(QuoteOk(), "")
    check("引用拼成「引用」格式", rendered == "「引用」被引原文\n回复正文", rendered)
    check("取不到被引文本时不伪造", backend._render_text(QuoteNone(), "") == "回复正文",
          backend._render_text(QuoteNone(), ""))

    expected = {"file": "[文件消息]", "video": "[视频消息]", "link": "[链接消息]",
                "location": "[位置消息]", "emotion": "[表情消息]", "merge": "[合并转发消息]",
                "other": "[其他消息]", "image": "[图片]", "weird": "[消息]"}
    for kind, want in expected.items():
        msg = type("M", (), {"type": kind, "content": "", "sender": "丙", "attr": "friend", "id": "x"})()
        got = backend._render_text(msg, "")
        check("空 content 的 %s → %s" % (kind, want), got == want, got)
        check("%s 的 text 非空" % kind, got.strip() != "", got)


if __name__ == "__main__":
    module = load()
    markup_cases(module)
    queue_cases(module)
    send_room_cases(module)
    identity_cases(module)
    inbound_cases(module)
    print("\n%d passed, %d failed" % (passed, failed))
    sys.exit(1 if failed else 0)
