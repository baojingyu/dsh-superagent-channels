# -*- coding: utf-8 -*-
"""入站开关的验证：`voice` 与 `images`（假 wx / 假消息，不碰微信）。

面板上的两个开关决定消息被渲染成事件时做什么：语音要不要转写（要驱动客户端界面，每条最多占 8 秒），
图片要不要列进 `media`（关掉就只剩 `[图片]` 占位、一个字节都不下）。这里用假对象把两条分支都钉住，
不需要真机，也不受监听器状态影响。

用法：python verify/options-check.py
"""
import importlib.util
import os

HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.abspath(os.path.join(HERE, "..", "sidecar", "wxauto-bridge", "server.py"))

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


class Message:
    """最小消息替身：`_to_event` 只读这些属性。"""

    def __init__(self, kind, content="", native="m1", sender="阿黎", attr=""):
        self.id, self.type, self.content = native, kind, content
        self.sender, self.attr = sender, attr


class ImageMessage(Message):
    def __init__(self):
        super().__init__("image")

    def download(self):
        return b"\x89PNG\r\n\x1a\n"


class VoiceMessage(Message):
    def __init__(self):
        super().__init__("voice")
        self.calls = 0

    def to_text(self, *args, **kwargs):
        self.calls += 1
        return "语音内容"


class Executor:
    """主线程执行器的替身：直接在当前线程调用。"""

    def call(self, function, timeout=None):
        # The real executor hands the wx object to the callback; this stub has none to hand over.
        return function(None)


class FakeWx:
    def __init__(self):
        self.adds, self.removes = [], []

    def AddListenChat(self, nickname, callback):
        if nickname != "研发-交付群":
            raise RuntimeError("会话不存在")
        self.adds.append(nickname)

    def RemoveListenChat(self, nickname):
        self.removes.append(nickname)

    def GetAllRecentGroups(self):
        return [("研发-交付群", 3)]

    def GetSession(self):
        return [{"name": "研发-交付群"}]


def main():
    module = load()
    backend = module.PcUiaBackend(listen=[], queue_size=10)
    backend._probe = (True, "")

    print("[1] 默认值")
    check("INBOUND_DEFAULTS 是 voice/images 都开",
          module.INBOUND_DEFAULTS == {"voice": True, "images": True}, module.INBOUND_DEFAULTS)

    print("[2] images 开关")
    backend._options = {"voice": True, "images": False}
    off = backend._to_event(ImageMessage(), "")
    check("images=false：media 为空", off["media"] == [], off["media"])
    check("images=false：正文仍是 [图片] 占位", off["text"] == module.PLACEHOLDERS["image"], off["text"])

    backend._options = {"voice": True, "images": True}
    on = backend._to_event(ImageMessage(), "")
    check("images=true：media 有一个图片 id", on["media"] == [{"id": "m1#0", "kind": "image"}], on["media"])

    print("[3] voice 开关")
    backend._executor = Executor()
    backend._options = {"voice": False, "images": True}
    quiet = VoiceMessage()
    text = backend._render_text(quiet, "")
    check("voice=false：不调 to_text（省下最多 8 秒 UI）", quiet.calls == 0, quiet.calls)
    check("voice=false：正文是 [语音消息] 占位", text == module.PLACEHOLDERS["voice"], text)

    backend._options = {"voice": True, "images": True}
    loud = VoiceMessage()
    text = backend._render_text(loud, "")
    check("voice=true：调了一次 to_text", loud.calls == 1, loud.calls)
    check("voice=true：正文是转写结果", text == "语音内容", text)

    print("[4] 开关随 /listen 到达后端")
    second = module.PcUiaBackend(listen=[], queue_size=10)
    second._probe = (True, "")
    wx = FakeWx()
    second._apply_listen(wx, ["研发-交付群"], {"voice": False})
    check("listen 记住了 voice=false", second._options == {"voice": False, "images": True}, second._options)
    second._apply_listen(wx, ["研发-交付群"], {"images": False})
    check("再次 listen 记住 images=false 且保留 voice=false",
          second._options == {"voice": False, "images": False}, second._options)
    second._apply_listen(wx, ["研发-交付群"], {"voice": "yes"})
    check("非法类型被忽略，取值不变", second._options == {"voice": False, "images": False}, second._options)
    check("开关变化没有触发多余的微信调用", wx.adds == ["研发-交付群"] and wx.removes == [], (wx.adds, wx.removes))

    print("[5] 缺省 options 等价于全开")
    third = module.PcUiaBackend(listen=[], queue_size=10)
    third._probe = (True, "")
    third._apply_listen(FakeWx(), ["研发-交付群"], None)
    check("不给 options 时是全开", third._options == module.INBOUND_DEFAULTS, third._options)

    print()
    print("%d passed, %d failed" % (passed, failed))
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
