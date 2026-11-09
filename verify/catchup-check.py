# -*- coding: utf-8 -*-
"""重挂后的补读：监听断开期间到达的消息必须被读回来，已投递的不能重复入队（假 wx，不碰微信）。

真机现场（2026-11-09 07:18）：消息在微信里、桥里却什么痕迹都没有——监听是**推送**的，断开期间的消息对队列不存在。
所以每次重挂之后读一遍被监听会话的最近几条，把没见过的补进队列；引擎按消息 id 去重，重复投递无害，漏掉才有害。

用法：python verify/catchup-check.py
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


class FakeMsg:
    """A client message: `id` is what the native-id helper prefers."""

    def __init__(self, ident, sender, content, kind="friend"):
        self.id = ident
        self.sender = sender
        self.content = content
        self.type = kind
        self.attr = ""
        self.time = ""


class FakeWx:
    def __init__(self, history):
        self.history = history
        self.calls = []

    def ChatWith(self, name):
        self.calls.append(("chat", name))
        return self

    def GetAllMessage(self):
        self.calls.append(("all", ""))
        return list(self.history)


def backend(module, names, history):
    instance = module.PcUiaBackend(listen=[], queue_size=10)
    instance._probe = (True, "")
    instance._listen_names = list(names)
    instance._listening = True
    # A direct chat: its events carry no room, which is the case the 07:18 report was about.
    if names:
        instance._chat_kind[module.wxname(names[0])] = "friend"
    return instance, FakeWx(history)


def queued(instance, room=""):
    events, _, _ = instance.messages(room, "0", 50)
    return [event["nativeId"] for event in events]


def main():
    module = load()

    print("[1] 重挂之后把断档期间的消息补进队列")
    history = [FakeMsg("m1", "张三", "断档时发的第一条"), FakeMsg("m2", "张三", "断档时发的第二条")]
    instance, wx = backend(module, ["研发-交付群"], history)
    instance._catchup_due = True
    instance._catchup(wx)
    check("每条被监听会话只打开一次", [kind for kind, _ in wx.calls] == ["chat", "all"], wx.calls)
    check("两条都进了队列", queued(instance) == ["m1", "m2"], queued(instance))
    check("计数为 2", instance._catchup_total == 2, instance._catchup_total)

    print("[2] 已经投递过的消息不再入队")
    replay, replay_wx = backend(module, ["研发-交付群"], history)
    for message in history:  # 监听回调已经送过这两条
        replay._enqueue_event(message, "")
    replay._catchup_due = True
    replay._catchup(replay_wx)
    check("队列里还是只有两条", queued(replay) == ["m1", "m2"], queued(replay))
    check("没有新增补读", replay._catchup_total == 0, replay._catchup_total)

    print("[3] 一分钟内不重复补读")
    again, again_wx = backend(module, ["研发-交付群"], history)
    again._catchup_due = True
    again._catchup(again_wx)
    before = len(again_wx.calls)
    again._catchup_due = True
    again._catchup(again_wx)
    check("没有新的客户端调用", len(again_wx.calls) == before, again_wx.calls[before:])

    print("[4] 没有在听的会话时什么都不做，并保留待补读标记")
    idle, idle_wx = backend(module, [], [])
    idle._listen_names = []
    idle._catchup_due = True
    idle._catchup(idle_wx)
    check("不碰客户端", idle_wx.calls == [], idle_wx.calls)
    check("标记还在，等 /listen 推来集合", idle._catchup_due is True, idle._catchup_due)

    print("[5] 重挂会要求补读")
    silence, _ = backend(module, ["研发-交付群"], history)
    silence._last_inbound_at = time.monotonic() - (module.LISTENER_QUIET_S + 60.0)
    silence._last_reattach_at = 0.0
    silence._catchup_due = False
    silence._reattach_if_quiet(FakeWx([]))
    check("重挂后标记被置起", silence._catchup_due is True, silence._catchup_due)

    print("[6] /health 说得出来补了多少")
    text = instance.detail()
    check("detail 提到补读条数", "重挂后补读 2 条" in text, text)

    print()
    print("%d passed, %d failed" % (passed, failed))
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
