# -*- coding: utf-8 -*-
"""pc-uia 真机自测（**只用「文件传输助手」**，不碰任何群、不发 @、不调 msg.at()）。

流程：
  1. 起 sidecar（--backend pc-uia --listen 文件传输助手）；
  2. 轮询 /health，打印 capabilities / detail；
  3. /status 打印 wxid 与显示名；/rooms 打印（单聊不应出现）；
  4. POST /send 往单聊（room=""）发一条自测文本；
  5. GET /messages?room= 读回该条（监听模式是推送式的，不依赖窗口渲染）；
  6. CTRL_BREAK 停止，验证干净退出 + 端口释放。

用法：python verify/live-pc-uia.py [--port 8790]
"""
import json
import os
import re
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
TOKEN = "pc-uia-selftest-token"
CHAT = "文件传输助手"
PORT = 8790
if "--port" in sys.argv:
    PORT = int(sys.argv[sys.argv.index("--port") + 1])
TEXT = "wxbridge-selftest-%d" % int(time.time())

ISO_RE = re.compile(r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")

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


def call(path, payload=None, timeout=30):
    data = None
    headers = {"Authorization": "Bearer " + TOKEN}
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request("http://127.0.0.1:%d%s" % (PORT, path), data=data, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:  # 502/501 也当数据看，便于报告
        return {"httpStatus": error.code, "body": error.read().decode("utf-8", "replace")}


def port_open(port):
    sock = socket.socket()
    sock.settimeout(0.3)
    try:
        return sock.connect_ex(("127.0.0.1", port)) == 0
    finally:
        sock.close()


def main():
    print("[0] 启动 sidecar（pc-uia，监听 %s）" % CHAT)
    argv = [PYTHON, SERVER, "--backend", "pc-uia", "--listen", CHAT,
            "--port", str(PORT), "--token", TOKEN]
    if "--verbose" in sys.argv:
        argv.append("--verbose")
    # stdout 必须继承（不能是 PIPE）：实测 `CREATE_NEW_PROCESS_GROUP` + `stdout=PIPE`
    # 会让子进程原生崩溃（0xC0000005），与本 sidecar 无关。stderr 仍用 PIPE 便于断言。
    proc = subprocess.Popen(
        argv,
        stdout=None, stderr=subprocess.PIPE,
        creationflags=getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0),
    )
    try:
        health = None
        deadline = time.time() + 60
        while time.time() < deadline:
            try:
                health = call("/health", timeout=5)
                break
            except OSError:
                if proc.poll() is not None:
                    break
                time.sleep(0.5)
        if health is None:
            stderr = proc.stderr.read().decode("utf-8", "replace")
            print("  FATAL  /health 没起来 rc=%s\n  --- stderr ---\n%s" % (proc.poll(), stderr[-1500:]))
            return 1
        print("  /health = %s" % json.dumps(health, ensure_ascii=False))
        caps = health.get("capabilities") or {}
        check("capabilities.mentions == 'markup'", caps.get("mentions") == "markup", caps)
        check("capabilities.members == 'observed'", caps.get("members") == "observed", caps)
        check("capabilities.media 是 bool", isinstance(caps.get("media"), bool), caps)
        check("后端可用（attach + 监听）", health.get("available") is True, health.get("detail"))

        print("[1] /status")
        status = call("/status")
        print("  /status = %s" % json.dumps(status, ensure_ascii=False))
        check("status.wxid 非空", bool(status.get("wxid")), status)
        check("status.name 非空", bool(status.get("name")), status)
        check("status.loggedIn", status.get("loggedIn") is True, status)

        print("[2] /rooms（能看到的会话，不是正在听的）")
        rooms_body = call("/rooms")
        check("/rooms 未报错", "httpStatus" not in rooms_body, rooms_body)
        rooms = rooms_body.get("rooms") or []
        print("  /rooms 总数 = %d，前 5 项 = %s" % (len(rooms), json.dumps(rooms[:5], ensure_ascii=False)))
        check("/rooms 非空", len(rooms) > 0, len(rooms))
        check("/rooms 含文件传输助手",
              {"id": "wxname_bc07334612ab41a0", "name": CHAT} in rooms, rooms[:5])
        check("/rooms id 全是 wxname_", all(str(r.get("id", "")).startswith("wxname_") for r in rooms), rooms[:3])

        # 只读性：/rooms 是活快照（会话列表本身随新消息变动），所以断言「目标会话始终在」
        # 而不是逐字相等；「不发 AddListenChat」由 markup-check 的 FakeWx 计数证明。
        again_rooms = call("/rooms").get("rooms") or []
        check("再次 /rooms 仍含文件传输助手",
              {"id": "wxname_bc07334612ab41a0", "name": CHAT} in again_rooms, len(again_rooms))
        health_after_rooms = call("/health")
        check("/rooms 不影响 /health detail",
              health_after_rooms.get("detail") == health.get("detail"),
              (health.get("detail"), health_after_rooms.get("detail")))

        print("[2.5] 判据名与 /listen 后的刷新")
        check("/health detail 报出判据名",
              "群 @ 判据：@" in (health.get("detail") or ""), health.get("detail"))
        check("/health detail 的名字与 /status 一致",
              status.get("name", "") in (health.get("detail") or ""), (status.get("name"), health.get("detail")))
        listened = call("/listen", {"rooms": [CHAT]}, timeout=60)
        check("/listen 仍 200", listened.get("httpStatus") is None, listened)
        after = call("/health")
        check("/listen 后 detail 仍带判据名",
              "群 @ 判据：@" in (after.get("detail") or ""), after.get("detail"))
        check("/listen 后判据名未变",
              status.get("name", "") in (after.get("detail") or ""), (status.get("name"), after.get("detail")))
        rooms_after_listen = call("/rooms").get("rooms") or []
        check("/listen 后 /rooms 仍含文件传输助手（与监听集合无关）",
              {"id": "wxname_bc07334612ab41a0", "name": CHAT} in rooms_after_listen, len(rooms_after_listen))

        print("[3] POST /send（单聊 room=\"\"，只发文本，不带 at）")
        sent = call("/send", {"room": "", "wxid": CHAT, "text": TEXT, "quoteId": ""})
        print("  /send = %s" % json.dumps(sent, ensure_ascii=False))
        check("发送返回 msgId", bool(sent.get("msgId")), sent)

        print("[4] GET /messages?room= （推送式监听，不依赖窗口渲染）")
        found = None
        deadline = time.time() + 40
        while time.time() < deadline and found is None:
            page = call("/messages?room=&limit=100")
            for event in page.get("events") or []:
                if TEXT in (event.get("text") or ""):
                    found = event
                    break
            if found is None:
                time.sleep(0.5)
        if found:
            print("  event = %s" % json.dumps(found, ensure_ascii=False))
        check("读到自测消息（room=\"\"）", found is not None, TEXT)
        if found:
            check("room 为空串（单聊）", found.get("room") == "", found.get("room"))
            check("own == true", found.get("own") is True, found.get("own"))
            check("sender.id 是 wxname_", str(found.get("sender", {}).get("id", "")).startswith("wxname_"), found.get("sender"))
            check("sender.name 是显示名", found.get("sender", {}).get("name") == status.get("name"), found.get("sender"))
            check("ats 为空（自测文本没有 @）", found.get("ats") == [], found.get("ats"))
            at = str(found.get("at") or "")
            check("at 是 ISO8601 Z", bool(ISO_RE.match(at)), at)
            now = time.time()
            parsed = time.mktime(time.strptime(at, "%Y-%m-%dT%H:%M:%SZ")) - time.timezone if ISO_RE.match(at) else 0
            marker_like = ISO_RE.match(at) and at[17:19] == "00"
            print("  事件 at = %s | 当前 UTC = %s | 秒位为 00（marker）= %s"
                  % (at, time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), marker_like))
            check("at 要么来自 TimeMessage（秒为 00），要么接近当前时间",
                  bool(marker_like or (ISO_RE.match(at) and abs(parsed - now) <= 120)), at)

        print("[5] /members（observed）")
        members = call("/members?room=").get("members") or []
        print("  /members?room= = %s" % json.dumps(members, ensure_ascii=False))
        check("observed 里有本账号", any(m.get("id") == found.get("sender", {}).get("id") for m in members) if found else True, members)

        print("[6] CTRL_BREAK 停止（StopListening + 干净退出）")
        try:
            os.kill(proc.pid, signal.CTRL_BREAK_EVENT)
        except OSError as error:
            check("可投递 CTRL_BREAK", False, error)
        try:
            proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            proc.kill()
            check("15s 内退出", False, "still running")
        check("退出码为 0", proc.returncode == 0, proc.returncode)
        time.sleep(0.3)
        check("端口 %d 已释放" % PORT, not port_open(PORT))
        stderr = proc.stderr.read().decode("utf-8", "replace")
        proc.stderr.close()
        check("打印 stopped", "stopped" in stderr, stderr[-300:])
        check("未打印 token 值", TOKEN not in stderr)
        print("  --- sidecar stderr ---")
        print("\n".join("  " + line for line in stderr.strip().splitlines()[-20:]))
    finally:
        if proc.poll() is None:
            proc.kill()
    print("\n%d passed, %d failed" % (passed, failed))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
