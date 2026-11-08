# -*- coding: utf-8 -*-
"""出站文件：端点收字节、写临时文件、调 `SendFiles`（假 wx，不碰微信）。

库侧本来就有 `Chat.SendFiles(filepath, who=None, exact=False)`，所以这一层要证明的是我们这边的护栏：
文件名不能逃出临时目录、超限被拒、以及真的把**那个路径**交给了客户端。
用法：python verify/file-check.py
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
    def __init__(self):
        self.messages, self.files = [], []

    def SendMsg(self, text, who=None, **kwargs):
        self.messages.append((text, who, kwargs))

    def SendFiles(self, filepath=None, who=None, exact=False):
        self.files.append(filepath)
        return {"status": "成功"}


def main():
    module = load()

    print("[1] 文件名不能逃出临时目录")
    check("路径分隔符被去掉", module.safe_filename("../../etc/passwd") == "passwd", module.safe_filename("../../etc/passwd"))
    check("Windows 路径只留 basename", module.safe_filename("C:\\Windows\\win.ini") == "win.ini")
    check("空格被替换", module.safe_filename("a b.png") == "a_b.png")
    check("空名有兜底", module.safe_filename("") == "file")
    check("长度受限", len(module.safe_filename("x" * 500 + ".png")) <= 120)

    print("[2] 上限")
    check("上限是 20 MiB", module.MAX_OUTBOUND_FILE_BYTES == 20 * 1024 * 1024, module.MAX_OUTBOUND_FILE_BYTES)

    print("[3] 只发文件：SendFiles 收到我们写的那个路径")
    backend = module.PcUiaBackend(listen=[], queue_size=10)
    backend._probe = (True, "")
    wx = FakeWx()
    backend._executor = Executor()
    backend._executor.call = lambda function, timeout=None: function(wx)
    backend._room_names = {"wxname_friend": "阿黎"}
    import tempfile

    directory = tempfile.mkdtemp(prefix="file-check-")
    path = os.path.join(directory, "chart.png")
    with open(path, "wb") as handle:
        handle.write(b"\x89PNG\r\n\x1a\n")
    backend.send("wxname_friend", "", "", "", None, (path, "chart.png"))
    check("SendFiles 调用了一次", len(wx.files) == 1, wx.files)
    check("交出的是同一个路径", wx.files and wx.files[0] == path, wx.files)
    check("没有多余的 SendMsg", wx.messages == [], wx.messages)

    print("[4] 文字 + 文件：先文字后文件")
    wx2 = FakeWx()
    backend._executor.call = lambda function, timeout=None: function(wx2)
    backend.send("wxname_friend", "", "图在下面", "", None, (path, "chart.png"))
    check("先发文字", wx2.messages and wx2.messages[0][0] == "图在下面", wx2.messages)
    check("再发文件", wx2.files == [path], wx2.files)

    import shutil

    shutil.rmtree(directory, ignore_errors=True)

    print()
    print("%d passed, %d failed" % (passed, failed))
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
