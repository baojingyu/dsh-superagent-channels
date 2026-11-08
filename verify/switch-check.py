# -*- coding: utf-8 -*-
"""换号/重新登录：窗口没了就必须整体重建（假 wx，不碰微信）。

真机现象：换了微信号之后 `/status` 还是旧账号、`/rooms` 0.02 秒返回旧的 108 条——进程从头到尾抓着启动时那个窗口对象，
`GetMyInfo()` 也一直从旧客户端里读，按账号缓存的东西永远不会失效。
用法：python verify/switch-check.py
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


def seeded(module):
    backend = module.PcUiaBackend(listen=[], queue_size=10)
    backend._probe = (True, "")
    backend._self_wxid = "wxid_old"
    backend._self_name = "旧账号"
    backend._room_names = {"wxname_old": "旧群"}
    backend._observed = {"wxname_old": {"wxname_p": "某人"}}
    backend._chat_kind = {"wxname_old": "group"}
    backend._rooms_cache = [{"id": "wxname_old", "name": "旧群"}]
    backend._rooms_cache_at = 1.0
    backend._recent_groups_cache = ["旧群"]
    backend._recent_groups_at = 1.0
    backend._listen_names = ["旧群"]
    backend._listening = True
    with backend._queue_lock:
        backend._queue.append((1, {"room": "wxname_old"}))
    backend._last_maintain_at = 0.0
    return backend


def main():
    module = load()

    print("[1] 窗口还在：不动，只做监听维护")
    backend = seeded(module)
    backend._window_alive = lambda wx: True
    marker = object()
    out = backend._maintain(marker)
    check("返回同一个客户端", out is marker, out)
    check("没有重建", getattr(backend, "_account_switch_count", 0) == 0, backend._account_switch_count)
    check("缓存仍在", backend._room_names == {"wxname_old": "旧群"}, backend._room_names)

    print("[2] 窗口没了（换号）：清空按账号缓存并重建")
    backend = seeded(module)
    backend._window_alive = lambda wx: False
    fresh = object()
    backend._setup_wx = lambda: fresh
    out = backend._maintain(object())
    check("返回新客户端", out is fresh, out)
    check("房间名清空", backend._room_names == {}, backend._room_names)
    check("观测清空", backend._observed == {}, backend._observed)
    check("会话缓存清空", backend._rooms_cache == [] and backend._recent_groups_cache == [], backend._rooms_cache)
    check("监听集合清空", backend._listen_names == [] and backend._listening is False, backend._listen_names)
    check("身份清空，等重建后重读", backend._self_wxid == "" and backend._self_name == "", (backend._self_wxid, backend._self_name))
    check("队列清空（旧账号的事件不留给新账号）", len(backend._queue) == 0, len(backend._queue))
    check("计数 +1", backend._account_switch_count == 1, backend._account_switch_count)
    text = backend.detail()
    check("detail 说得出来", "客户端窗口更换" in text and "重建连接 1 次" in text, text)

    print("[3] 同一窗口内限频：两次调用只检查一次")
    backend = seeded(module)
    calls = []
    backend._window_alive = lambda wx: calls.append(1) or True
    import time as _time
    backend._last_maintain_at = _time.monotonic()
    backend._maintain(object())
    backend._maintain(object())
    check("tick 内的第二次不重复检查", len(calls) == 0, calls)

    print()
    print("%d passed, %d failed" % (passed, failed))
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
