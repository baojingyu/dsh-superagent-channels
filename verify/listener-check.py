# -*- coding: utf-8 -*-
"""监听的幸存性：哑掉的监听必须被判定出来、重挂一次、并在 `/health` 里说出来（假 wx，不碰微信）。

真机复现过：`/listen` 回 `listening: [老婆]`，而队列在 07:30 之后什么都没收到，`/send` 报「UI 卡住」；把集合清空再
推一次，投递立刻恢复。所以「集合没变就什么都不做」的幂等要以「事件还在来」为前提，否则哑掉的挂载永远不会被修。
用法：python verify/listener-check.py
"""
import importlib.util
import os
import time

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


class FakeWx:
    def __init__(self):
        self.calls = []

    def RemoveListenChat(self, nickname):
        self.calls.append(("remove", nickname))

    def AddListenChat(self, nickname, callback):
        self.calls.append(("add", nickname))

    def StartListening(self):
        self.calls.append(("start", ""))

    def GetAllRecentGroups(self):
        return []

    def GetSession(self):
        return []


def main():
    module = load()

    print("[1] 静默超过阈值：摘掉再挂上，并重启监听")
    backend = module.PcUiaBackend(listen=[], queue_size=10)
    backend._probe = (True, "")
    backend._listen_names = ["研发-交付群", "文件传输助手"]
    backend._listening = True
    backend._last_inbound_at = time.monotonic() - theme(module)
    wx = FakeWx()
    backend._reattach_if_quiet(wx)
    kinds = [kind for kind, _ in wx.calls]
    check("每个会话都先摘后挂", kinds == ["remove", "add", "remove", "add", "start"], wx.calls)
    check("StartListening 被再次调用", ("start", "") in wx.calls, wx.calls)
    check("计数 +1", backend._reattach_count == 1, backend._reattach_count)

    print("[2] 同一次静默窗口内不重复重挂")
    before = len(wx.calls)
    backend._reattach_if_quiet(wx)
    check("没有新的微信调用", len(wx.calls) == before, wx.calls[before:])
    check("计数不变", backend._reattach_count == 1, backend._reattach_count)

    print("[3] 事件还在来：不动")
    fresh = module.PcUiaBackend(listen=[], queue_size=10)
    fresh._probe = (True, "")
    fresh._listen_names = ["研发-交付群"]
    fresh._listening = True
    fresh._last_inbound_at = time.monotonic()
    quiet_wx = FakeWx()
    fresh._reattach_if_quiet(quiet_wx)
    check("最近有事件就不重挂", quiet_wx.calls == [], quiet_wx.calls)

    print("[4] 没在听时不重挂")
    idle = module.PcUiaBackend(listen=[], queue_size=10)
    idle._probe = (True, "")
    idle._listen_names = []
    idle._listening = True
    idle._last_inbound_at = time.monotonic() - theme(module)
    idle_wx = FakeWx()
    idle._reattach_if_quiet(idle_wx)
    check("空监听集合不做任何事", idle_wx.calls == [], idle_wx.calls)

    print("[5] /health 的 detail 说得出来")
    text = backend.detail()
    check("detail 提到最近事件", "最近事件" in text, text)
    check("detail 提到自动重挂次数", "自动重挂 1 次" in text, text)

    print()
    print("%d passed, %d failed" % (passed, failed))
    return 0 if failed == 0 else 1


def theme(module):
    """Past the quiet threshold, with a margin so the test does not race the clock."""
    return module.LISTENER_QUIET_S + 60.0


if __name__ == "__main__":
    raise SystemExit(main())
