# -*- coding: utf-8 -*-
"""`POST /listen` 的验证：单元（不碰微信）+ fake/pad HTTP + pc-uia 真机。

真机部分**只用「文件传输助手」**：不碰任何群、不调 msg.at()、不 SendMsg(at=[...])。
用法：python verify/listen-check.py [--port 8793]
"""
import importlib.util
import json
import os
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.abspath(os.path.join(HERE, "..", "sidecar", "wxauto-bridge", "server.py"))
PYTHON = os.environ.get('WXBRIDGE_PYTHON') or sys.executable  # 用装了 wxautox4 的解释器启动 sidecar
TOKEN = "listen-check-token"
CHAT = "文件传输助手"

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


def free_port():
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


def port_open(port):
    sock = socket.socket()
    sock.settimeout(0.3)
    try:
        return sock.connect_ex(("127.0.0.1", port)) == 0
    finally:
        sock.close()


def call(port, path, payload=None, token=TOKEN, method=None, timeout=30):
    headers = {} if token is None else {"Authorization": "Bearer " + token}
    data = None
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request("http://127.0.0.1:%d%s" % (port, path), data=data,
                                     headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        raw = error.read().decode("utf-8", "replace")
        try:
            return error.code, json.loads(raw)
        except ValueError:
            return error.code, {"raw": raw}


def spawn(backend, port, extra=()):
    argv = [PYTHON, SERVER, "--backend", backend, "--port", str(port), "--token", TOKEN] + list(extra)
    # stdout 必须继承：CREATE_NEW_PROCESS_GROUP + PIPE 会让子进程原生崩溃（与本 sidecar 无关）。
    return subprocess.Popen(argv, stdout=None, stderr=subprocess.PIPE,
                            creationflags=getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0))


def wait_health(port, cap=60):
    deadline = time.time() + cap
    while time.time() < deadline:
        try:
            status, _ = call(port, "/health", timeout=5)
            if status == 200:
                return True
        except OSError:
            pass
        time.sleep(0.5)
    return False


def unit_cases(module):
    print("[1] 单元：_apply_listen 的增删与幂等（假 wx，不碰微信）")

    class FakeWx:
        def __init__(self):
            self.adds, self.removes = [], []

        def AddListenChat(self, nickname, callback):
            if nickname not in ("文件传输助手", "研发-交付群"):
                raise RuntimeError("会话不存在")
            self.adds.append(nickname)

        def RemoveListenChat(self, nickname):
            self.removes.append(nickname)

        def GetAllRecentGroups(self):
            return [("文件传输助手", 0), ("研发-交付群", 3)]

        def GetSession(self):
            return [{"name": "研发-交付群"}]

        def ChatInfo(self, who=None, *args):
            return {"chat_name": who, "chat_type": "group"}

    backend = module.PcUiaBackend(listen=[], queue_size=10)
    backend._probe = (True, "")
    wx = FakeWx()

    first = backend._apply_listen(wx, ["研发-交付群"])
    check("首次新增进 added", first["added"] == ["研发-交付群"], first)
    check("首次 listening 含它", [r["name"] for r in first["listening"]] == ["研发-交付群"], first)
    check("首次只发了一次 AddListenChat", wx.adds == ["研发-交付群"], wx.adds)

    again = backend._apply_listen(wx, ["研发-交付群"])
    check("幂等：added 为空", again["added"] == [], again)
    check("幂等：removed 为空", again["removed"] == [], again)
    check("幂等：一个微信调用都不发", wx.adds == ["研发-交付群"] and wx.removes == [], (wx.adds, wx.removes))

    by_id = module.wxname("研发-交付群")
    via_id = backend._apply_listen(wx, [by_id])
    check("wxname_ id 解析回显示名且无需变更", via_id["added"] == [] and via_id["failed"] == [], via_id)
    check("按 id 重发也不触发调用", wx.adds == ["研发-交付群"] and wx.removes == [], (wx.adds, wx.removes))

    unknown = backend._apply_listen(wx, ["不存在的群"])
    check("未知名字进 failed", len(unknown["failed"]) == 1, unknown)
    check("未知名字仍整体成功（有 listening 字段）", isinstance(unknown.get("listening"), list), unknown)
    check("未知名字导致它被移出监听", unknown["removed"] == ["研发-交付群"], unknown)

    backend._apply_listen(wx, ["研发-交付群"])
    bad_id = backend._apply_listen(wx, ["wxname_deadbeefdeadbeef"])
    check("解析不了的 id 进 failed", len(bad_id["failed"]) == 1, bad_id)
    check("失败条目带 room/detail", set(bad_id["failed"][0]) == {"room", "detail"}, bad_id["failed"])

    backend._apply_listen(wx, ["研发-交付群", "文件传输助手"])
    cleared = backend._apply_listen(wx, [])
    check("空数组停掉全部", sorted(cleared["removed"]) == sorted(["研发-交付群", "文件传输助手"]), cleared)
    check("空数组后 listening 为空", cleared["listening"] == [], cleared)


def fake_cases():
    print("[2] fake 后端（HTTP）")
    port = free_port()
    proc = spawn("fake", port)
    try:
        if not wait_health(port):
            check("fake /health 起来", False)
            return
        status, body = call(port, "/listen", {"rooms": ["chatroom_fake_dev"]})
        check("已知房间 → 200", status == 200, body)
        check("listening 含它", [r["id"] for r in body.get("listening", [])] == ["chatroom_fake_dev"], body)
        check("added 为空（已固定）", body.get("added") == [], body)
        check("failed 为空", body.get("failed") == [], body)

        status, body = call(port, "/listen", {"rooms": ["研发-交付群"]})
        check("显示名也认得", status == 200 and body["listening"][0]["id"] == "chatroom_fake_dev", body)

        status, body = call(port, "/listen", {"rooms": ["不存在的群"]})
        check("未知名字 → 仍 200", status == 200, status)
        check("未知名字进 failed", len(body.get("failed") or []) == 1, body)

        status, body = call(port, "/listen", {"rooms": []})
        check("空数组 → 200", status == 200 and body.get("listening") == [], body)

        status, body = call(port, "/rooms")
        check("数据集未被 /listen 改动", body.get("rooms") == [{"id": "chatroom_fake_dev", "name": "研发-交付群"}], body)

        status, _ = call(port, "/listen", method="GET")
        check("GET /listen → 405", status == 405, status)
        status, body = call(port, "/listen", {"rooms": ["x"]}, token=None)
        check("无 token → 401", status == 401 and body.get("error") == "unauthorized", (status, body))
        status, _ = call(port, "/listen", {"rooms": "chatroom_fake_dev"})
        check("rooms 不是数组 → 400", status == 400, status)
        status, _ = call(port, "/listen", {"rooms": ["ok", 1]})
        check("rooms 含非字符串 → 400", status == 400, status)
        status, _ = call(port, "/listen", {"nope": []})
        check("缺 rooms → 400", status == 400, status)
        status, _ = call(port, "/listen", None, method="POST")
        check("空 body → 400", status == 400, status)
    finally:
        proc.kill()
        proc.wait(timeout=10)
        proc.stderr.close()


def pad_cases():
    print("[3] pad 桩（HTTP）")
    port = free_port()
    proc = spawn("pad", port)
    try:
        if not wait_health(port):
            check("pad /health 起来", False)
            return
        status, body = call(port, "/listen", {"rooms": ["x"]})
        check("pad /listen → 501", status == 501, (status, body))
    finally:
        proc.kill()
        proc.wait(timeout=10)
        proc.stderr.close()


def live_cases(port):
    print("[4] pc-uia 真机（只用「文件传输助手」）")
    proc = spawn("pc-uia", port)
    try:
        if not wait_health(port):
            check("pc-uia /health 起来", False, proc.stderr.read().decode("utf-8", "replace")[-800:])
            return
        status, body = call(port, "/status")
        check("真机已登录", body.get("loggedIn") is True, body)

        status, body = call(port, "/listen", {"rooms": [CHAT]}, timeout=60)
        check("新增监听 → 200", status == 200, body)
        check("added 含它", body.get("added") == [CHAT], body)
        check("listening 含它", [r["name"] for r in body.get("listening", [])] == [CHAT], body)
        room_id = (body.get("listening") or [{}])[0].get("id", "")
        check("id 是 wxname_", room_id.startswith("wxname_"), room_id)

        status, again = call(port, "/listen", {"rooms": [CHAT]}, timeout=60)
        check("幂等：added 为空", again.get("added") == [], again)
        check("幂等：removed 为空", again.get("removed") == [], again)
        check("幂等：listening 不变", [r["id"] for r in again.get("listening", [])] == [room_id], again)

        status, by_id = call(port, "/listen", {"rooms": [room_id]}, timeout=60)
        check("按 id 重发同样幂等", by_id.get("added") == [] and by_id.get("removed") == [], by_id)

        status, cleared = call(port, "/listen", {"rooms": []}, timeout=60)
        check("空数组 → removed 含它", cleared.get("removed") == [CHAT], cleared)
        check("空数组后 listening 为空", cleared.get("listening") == [], cleared)
    finally:
        try:
            os.kill(proc.pid, signal.CTRL_BREAK_EVENT)
            proc.wait(timeout=15)
        except BaseException:
            proc.kill()
        stderr = proc.stderr.read().decode("utf-8", "replace")
        proc.stderr.close()
        check("真机 sidecar 干净退出", proc.returncode == 0, proc.returncode)
        time.sleep(0.3)
        check("端口 %d 已释放" % port, not port_open(port))


if __name__ == "__main__":
    module = load()
    unit_cases(module)
    fake_cases()
    pad_cases()
    port = int(sys.argv[sys.argv.index("--port") + 1]) if "--port" in sys.argv else 8793
    live_cases(port)
    print("\n%d passed, %d failed" % (passed, failed))
    sys.exit(1 if failed else 0)
