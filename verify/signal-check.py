# -*- coding: utf-8 -*-
"""停机与边界自测（不进契约测试主流程）。

1. 真实进程 + Windows 控制台事件（CTRL_BREAK → SIGBREAK、CTRL_C → SIGINT）：
   必须优雅退出、打印 stopped、端口释放。
2. 零字节规则：后端返回 b"" 时 /media 必须 404，绝不 200。
3. 127.0.0.1 默认绑定与非回环拒绝。

用法：python verify/signal-check.py
"""
import json
import os
import signal
import socket
import subprocess
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.abspath(os.path.join(HERE, "..", "sidecar", "wxauto-bridge", "server.py"))
TOKEN = "signal-check-token"
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


def port_open(port):
    sock = socket.socket()
    sock.settimeout(0.3)
    try:
        return sock.connect_ex(("127.0.0.1", port)) == 0
    finally:
        sock.close()


def free_port():
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


def health(port):
    request = urllib.request.Request("http://127.0.0.1:%d/health" % port, headers={"Authorization": "Bearer " + TOKEN})
    with urllib.request.urlopen(request, timeout=2) as response:
        return json.loads(response.read())


def spawn(port):
    proc = subprocess.Popen(
        [sys.executable, SERVER, "--backend", "fake", "--port", str(port), "--token", TOKEN],
        stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
        creationflags=getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0),
    )
    deadline = time.time() + 10
    while time.time() < deadline:
        try:
            if health(port)["ok"]:
                return proc
        except OSError:
            time.sleep(0.1)
    proc.kill()
    raise RuntimeError("sidecar never became healthy on port %d" % port)


def signal_round(label, event):
    port = free_port()
    proc = spawn(port)
    check("%s: 服务在跑" % label, health(port)["ok"] is True)
    started = time.time()
    try:
        os.kill(proc.pid, event)
    except OSError as error:
        proc.kill()
        check("%s: 控制台事件可投递" % label, False, error)
        return
    try:
        proc.wait(timeout=8)
    except subprocess.TimeoutExpired:
        proc.kill()
        check("%s: 5s 内退出" % label, False, "still running")
        return
    stderr = proc.stderr.read().decode("utf-8", "replace")
    proc.stderr.close()
    closed = not port_open(port)
    check("%s: 退出码为 0" % label, proc.returncode == 0, proc.returncode)
    check("%s: 打印 stopped" % label, "stopped" in stderr, stderr.strip())
    check("%s: 端口 %d 已释放" % (label, port), closed)
    check("%s: 耗时 < 5s" % label, time.time() - started < 5, "%.2fs" % (time.time() - started))
    check("%s: 未打印 token 值" % label, TOKEN not in stderr)


def sigint_in_process():
    """Windows 上 CTRL_C 对新进程组默认禁用，所以 SIGINT 走进程内 raise_signal 验证同一条处理链。"""
    import importlib.util
    import threading

    spec = importlib.util.spec_from_file_location("wxbridge_server", SERVER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    app = module.App(module.FakeBackend(), TOKEN, 60.0)
    server = module.BridgeServer(("127.0.0.1", 0), module.BridgeHandler, app)
    port = server.server_address[1]
    module.install_signal_handlers(server)
    worker = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.1}, daemon=True)
    worker.start()
    deadline = time.time() + 5
    while time.time() < deadline:
        try:
            if health(port)["ok"]:
                break
        except OSError:
            time.sleep(0.05)
    check("SIGINT: 服务在跑", health(port)["ok"] is True)
    started = time.time()
    signal.raise_signal(signal.SIGINT)  # 主线程同步触发处理函数
    worker.join(5)
    check("SIGINT: serve_forever 返回", not worker.is_alive(), "still serving")
    server.server_close()
    check("SIGINT: 耗时 < 5s", time.time() - started < 5, "%.2fs" % (time.time() - started))
    check("SIGINT: 端口 %d 已释放" % port, not port_open(port))


def read_only_ats():
    """`ats` 的只读铁律与 capabilities 三态（标记判定的完整用例在 verify/markup-check.py）。"""
    import importlib.util

    spec = importlib.util.spec_from_file_location("wxbridge_server", SERVER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    called = []

    class BoobyTrapped:
        """真机形状：at 是 bound method，执行即「拍一拍」。"""

        id = "89cbfdfc0e13c4aa9c6c212859be8436"
        content = "@<昵称>\U0001F9AB\u2005把 timeout 改成 3s"
        attr = "friend"
        sender = "阿黎"
        type = "text"
        chat_info = {"chat_type": "group", "chat_name": "研发-交付群", "group_member_count": 3}

        def at(self):
            called.append("pat")  # 真实后果：给群里每个人拍一拍
            return {"status": "成功"}

    hits = module.marked_mentions(BoobyTrapped(), "<昵称>\U0001F9AB", "<wxid>")
    check("marked_mentions 命中客户端标记", hits == ["<wxid>"], hits)
    check("marked_mentions 绝不调用 at()", called == [], called)

    check("fake capabilities 三态", module.FakeBackend().capabilities()
          == {"mentions": "structured", "members": "full", "media": True})
    check("pad capabilities 全 none", module.PadBackend().capabilities()
          == {"mentions": "none", "members": "none", "media": False})
    pc = module.PcUiaBackend(venv="")
    caps = pc.capabilities()
    check("pc-uia mentions=markup", caps["mentions"] == "markup", caps)
    check("pc-uia members=observed", caps["members"] == "observed", caps)
    check("pc-uia media 为 bool", isinstance(caps["media"], bool), caps)


def capabilities_over_http():
    """`/health.capabilities` 必须出现在真实进程的响应里。"""
    port = free_port()
    proc = spawn(port)
    try:
        body = health(port)
        check("/health 带 capabilities", isinstance(body.get("capabilities"), dict), body)
        check("fake capabilities 三态", body.get("capabilities")
              == {"mentions": "structured", "members": "full", "media": True}, body)
        check("既有字段未被破坏", body.get("sidecar") == "1" and body.get("backend") == "fake" and body.get("ok") is True, body)
    finally:
        proc.kill()
        proc.wait(timeout=10)


def zero_byte_rule():
    """后端返回 b"" 时 App.media 必须抛 MediaGone（→ 404），绝不 200。"""
    import importlib.util

    spec = importlib.util.spec_from_file_location("wxbridge_server", SERVER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    class EmptyMedia(module.FakeBackend):
        def media(self, media_id):
            return b"", "image/png"

    app = module.App(EmptyMedia(), TOKEN, 60.0)
    try:
        app.media("m4#0")
        check("零字节载荷 → MediaGone", False, "returned a payload")
    except module.MediaGone:
        check("零字节载荷 → MediaGone（404）", True)

    app2 = module.App(module.FakeBackend(), TOKEN, 60.0)
    payload, mime = app2.media("m4#0")
    check("正常载荷 69 字节 + image/png", len(payload) == 69 and mime == "image/png", (len(payload), mime))
    again, _ = app2.media("m4#0")
    check("二次读取命中缓存（同一对象）", again is payload)


def bind_rules():
    port = free_port()
    proc = subprocess.run(
        [sys.executable, SERVER, "--backend", "fake", "--port", str(port), "--token", TOKEN, "--host", "0.0.0.0"],
        capture_output=True, timeout=30,
    )
    stderr = proc.stderr.decode("utf-8", "replace")
    check("默认拒绝绑定 0.0.0.0", proc.returncode == 2, (proc.returncode, stderr.strip()))
    check("拒绝时说明原因", "loopback" in stderr, stderr.strip())
    check("拒绝后端口未占用", not port_open(port))


if __name__ == "__main__":
    print("[1] CTRL_BREAK → SIGBREAK（真实进程）")
    signal_round("SIGBREAK", signal.CTRL_BREAK_EVENT)
    print("[2] SIGINT（进程内，同一处理链）")
    sigint_in_process()
    print("[3] 零字节规则")
    zero_byte_rule()
    print("[4] 绑定规则")
    bind_rules()
    print("[5] structured_ats 只读性与 capabilities")
    read_only_ats()
    print("[6] /health.capabilities（真实进程）")
    capabilities_over_http()
    print("\n%d passed, %d failed" % (passed, failed))
    sys.exit(1 if failed else 0)
