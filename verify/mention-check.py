# -*- coding: utf-8 -*-
"""出站 @ 的验证：只对群、只用观测到的显示名（假 wx，不碰微信）。

`SendMsg(at=[...])` 收显示名，而面板/Node 手里只有 `wxname_…` id。这里钉住三件事：
群内 id 能解析成 sidecar 自己观测到的名字；解析不出来就不提；单聊一律不提。
用法：python verify/mention-check.py
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


class Executor:
    def call(self, function, timeout=None):
        return function(None)


class FakeWx:
    """记录每一次 SendMsg 的关键字参数。"""

    def __init__(self):
        self.calls = []

    def SendMsg(self, text, who=None, **kwargs):
        self.calls.append({"text": text, "who": who, "kwargs": kwargs})
        return {"status": "成功"}


def build(module):
    backend = module.PcUiaBackend(listen=[], queue_size=10)
    backend._probe = (True, "")
    backend._executor = Executor()
    wx = FakeWx()
    backend._wx = wx
    backend._room_names = {"wxname_group": "研发-交付群", "wxname_friend": "阿黎"}
    # What the listener observed: the group knows one of its senders by id.
    backend._observed = {"wxname_group": {"wxname_person": "阿黎"}}
    backend._executor.call = lambda function, timeout=None: function(wx)
    return backend, wx


def main():
    module = load()

    print("[1] 群内 @：id → 观测到的显示名")
    backend, wx = build(module)
    backend.send("wxname_group", "", "收到", "", ["wxname_person"])
    check("SendMsg 只调了一次", len(wx.calls) == 1, wx.calls)
    check("at 是显示名而不是 id", wx.calls[0]["kwargs"].get("at") == ["阿黎"], wx.calls[0]["kwargs"])
    check("who 是群名", wx.calls[0]["who"] == "研发-交付群", wx.calls[0]["who"])

    print("[2] 显示名直接给也能用")
    backend, wx = build(module)
    backend.send("wxname_group", "", "收到", "", ["王博"])
    check("at 原样传给客户端", wx.calls[0]["kwargs"].get("at") == ["王博"], wx.calls[0]["kwargs"])

    print("[3] 解析不出来的 id 不会被塞进客户端")
    backend, wx = build(module)
    backend.send("wxname_group", "", "收到", "", ["wxname_unknown"])
    check("没有 at 关键字", "at" not in wx.calls[0]["kwargs"], wx.calls[0]["kwargs"])

    print("[4] 单聊一律不 @")
    backend, wx = build(module)
    backend.send("", "wxname_friend", "收到", "", ["wxname_person"])
    check("单聊没有 at", "at" not in wx.calls[0]["kwargs"], wx.calls[0]["kwargs"])

    print("[5] 不给 at 时行为不变")
    backend, wx = build(module)
    backend.send("wxname_group", "", "收到")
    check("没有 at 关键字", "at" not in wx.calls[0]["kwargs"], wx.calls[0]["kwargs"])
    check("文本照发", wx.calls[0]["text"] == "收到", wx.calls[0]["text"])

    print("[6] 重复项去重、空项忽略")
    backend, wx = build(module)
    backend.send("wxname_group", "", "收到", "", ["阿黎", "阿黎", "", "王博"])
    check("at 去重且无空串", wx.calls[0]["kwargs"].get("at") == ["阿黎", "王博"], wx.calls[0]["kwargs"])

    print()
    print("%d passed, %d failed" % (passed, failed))
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
