# -*- coding: utf-8 -*-
"""win_diag.py — Windows 会话与微信窗口诊断。

用途
----
在跑 ``probe_wxauto.py`` 之前先回答三个问题：

1. 当前 Python 进程在哪个 Windows 会话？
2. 微信客户端在哪个会话，主窗口是否可见？
3. 客户端是哪一代（3.9.x 还是 4.x），因此该装 ``wxauto`` 还是 ``wxauto4``/``wxautox4``？

为什么不合并进探针
------------------
UIAutomation 只能枚举**本会话**的顶层窗口。从 SSH、Windows 服务、断开的 RDP
会话里跑，一律看不到窗口，表现为 ``WindowDiscoveryError`` / ``no WeChat window``。
把会话诊断单独做成一个不依赖 wxauto 的脚本，是为了让「跑不出报告」这件事
有一个能自己说话的答案：报告为空时先跑它。

用法
----
    python win_diag.py
    python win_diag.py --json          # 只输出 JSON，便于管道
    python win_diag.py --out diag.json # 同时写文件

输出
----
一个 JSON 对象，关键字段：

``session``       本进程会话 ID
``clients[]``     每个微信顶层窗口：hwnd / session / class / title / visible
``generation``    ``4.x`` / ``3.9.x`` / ``unknown``
``packageAdvice`` 建议安装哪个包
``conclusion``    一句话结论；成功时固定为
                  ``a WeChat window is visible in this session``

退出码
------
0  找到本会话内可见的微信窗口
2  找到窗口但不可见，或窗口在别的会话
3  没找到任何微信窗口
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any

# 微信 4.x 的主窗口类名是 Qt 的通用类名，3.9.x 是 MMCore 的。
CLASS_4X = "Qt51514QWindowIcon"
CLASS_39 = "mmui::MainWindow"
# 4.x 的进程名是 Weixin.exe，3.9.x 是 WeChat.exe。
PROC_4X = "Weixin.exe"
PROC_39 = "WeChat.exe"
TITLES = ("微信", "Weixin", "WeChat")


def process_session(pid: int) -> int | None:
    """返回某个进程所在的 Windows 会话 ID，取不到时返回 None。

    只读 ``ProcessIdToSessionId``，不需要打开进程句柄，因此在受限账户下也能用。
    """
    try:
        import ctypes

        session = ctypes.c_ulong(0)
        if ctypes.windll.kernel32.ProcessIdToSessionId(pid, ctypes.byref(session)):
            return int(session.value)
    except Exception:
        pass
    return None


def window_session(hwnd: int) -> int | None:
    """返回某个窗口所属的会话 ID（``GetWindowThreadProcessId`` + ``ProcessIdToSessionId``）。"""
    try:
        import ctypes

        pid = ctypes.c_ulong(0)
        ctypes.windll.user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        return process_session(int(pid.value))
    except Exception:
        return None


def enumerate_windows() -> list[dict[str, Any]]:
    """枚举所有微信相关顶层窗口。

    同时用 ``EnumWindows``（只看得到本会话）和 ``EnumChildWindows`` 之外的手段不够，
    所以这里额外记下 ``IsWindowVisible``：客户端最小化到托盘时 ``IsWindowVisible == 0``，
    wxautox4 会报「未找到已登录的客户端主窗口」。
    """
    found: list[dict[str, Any]] = []
    try:
        import win32gui
    except ImportError:
        return found

    def callback(hwnd: int, _extra: Any) -> bool:
        try:
            title = win32gui.GetWindowText(hwnd)
            cls = win32gui.GetClassName(hwnd)
        except Exception:
            return True
        if title not in TITLES and cls not in (CLASS_4X, CLASS_39):
            return True
        found.append({
            "hwnd": hex(hwnd),
            "session": window_session(hwnd),
            "class": cls,
            "title": title,
            "visible": bool(win32gui.IsWindowVisible(hwnd)),
        })
        return True

    try:
        win32gui.EnumWindows(callback, None)
    except Exception:
        pass
    return found


def client_processes() -> list[dict[str, Any]]:
    """列出微信客户端进程及其会话，用于解释「窗口不在本会话」的情况。"""
    rows: list[dict[str, Any]] = []
    try:
        import win32process

        for pid in win32process.EnumProcesses() if hasattr(win32process, "EnumProcesses") else []:
            rows.append({"pid": pid})
    except Exception:
        pass
    # psutil 不一定装了；标准库路线走 tasklist 太重，这里直接用 ctypes 读进程名。
    rows = []
    try:
        import ctypes
        import ctypes.wintypes as wt

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.CreateToolhelp32Snapshot.restype = ctypes.c_void_p
        TH32CS_SNAPPROCESS = 0x00000002

        class PROCESSENTRY32(ctypes.Structure):
            _fields_ = [
                ("dwSize", wt.DWORD),
                ("cntUsage", wt.DWORD),
                ("th32ProcessID", wt.DWORD),
                ("th32DefaultHeapID", ctypes.POINTER(ctypes.c_ulong)),
                ("th32ModuleID", wt.DWORD),
                ("cntThreads", wt.DWORD),
                ("th32ParentProcessID", wt.DWORD),
                ("pcPriClassBase", ctypes.c_long),
                ("dwFlags", wt.DWORD),
                ("szExeFile", ctypes.c_char * 260),
            ]

        snapshot = kernel32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
        if snapshot and snapshot != ctypes.c_void_p(-1).value:
            entry = PROCESSENTRY32()
            entry.dwSize = ctypes.sizeof(PROCESSENTRY32)
            ok = kernel32.Process32First(snapshot, ctypes.byref(entry))
            while ok:
                name = entry.szExeFile.decode("mbcs", "ignore")
                if name in (PROC_4X, PROC_39):
                    pid = int(entry.th32ProcessID)
                    rows.append({"name": name, "pid": pid, "session": process_session(pid)})
                ok = kernel32.Process32Next(snapshot, ctypes.byref(entry))
            kernel32.CloseHandle(ctypes.c_void_p(snapshot))
    except Exception:
        pass
    return rows


def decide(clients: list[dict[str, Any]], processes: list[dict[str, Any]]) -> tuple[str, str, str]:
    """据窗口与进程推断客户端代际、建议的包、以及一句结论。"""
    classes = {row["class"] for row in clients}
    names = {row["name"] for row in processes}
    if CLASS_4X in classes or PROC_4X in names:
        generation = "4.x"
        advice = "wxautox4 (paid, Python 3.9-3.13) or wxauto4 (free, client <= 4.1.8.107)"
    elif CLASS_39 in classes or PROC_39 in names:
        generation = "3.9.x"
        advice = "wxauto"
    else:
        generation = "unknown"
        advice = "install nothing until a WeChat client window is found"

    session = process_session(os.getpid())
    visible_here = [row for row in clients if row["visible"] and row["session"] == session]
    if visible_here:
        return generation, advice, "a WeChat window is visible in this session"
    if clients:
        elsewhere = sorted({row["session"] for row in clients if row["session"] is not None})
        if any(row["visible"] for row in clients):
            return generation, advice, (
                f"a WeChat window exists but not in session {session} (found in {elsewhere}); "
                "run the probe from that interactive desktop session"
            )
        return generation, advice, (
            "a WeChat window exists but is hidden (minimized to the tray); "
            "restore the window before running the probe"
        )
    return generation, advice, "no WeChat window was found; is the client running and signed in?"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Diagnose the Windows session and the WeChat client window.")
    parser.add_argument("--json", action="store_true", help="print only JSON")
    parser.add_argument("--out", default="", help="also write the report to this path")
    args = parser.parse_args(argv)

    session = process_session(os.getpid())
    clients = enumerate_windows()
    processes = client_processes()
    generation, advice, conclusion = decide(clients, processes)

    report = {
        "platform": sys.platform,
        "python": sys.version.split()[0],
        "session": session,
        "isAdmin": _is_admin(),
        "clients": clients,
        "processes": processes,
        "generation": generation,
        "packageAdvice": advice,
        "conclusion": conclusion,
    }

    text = json.dumps(report, ensure_ascii=False, indent=2)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as handle:
            handle.write(text + "\n")
    if args.json:
        print(text)
    else:
        print(f"session      : {session}")
        print(f"isAdmin      : {report['isAdmin']}")
        print(f"generation   : {generation}")
        print(f"package      : {advice}")
        for row in clients:
            print(f"window       : {row['hwnd']} session={row['session']} class={row['class']} "
                  f"title={row['title']!r} visible={row['visible']}")
        for row in processes:
            print(f"process      : {row['name']} pid={row['pid']} session={row['session']}")
        print(f"conclusion   : {conclusion}")

    if conclusion.startswith("a WeChat window is visible in this session"):
        return 0
    return 2 if clients else 3


def _is_admin() -> bool:
    """是否以管理员身份运行；决定能否读另一个进程的内存、能否显示其窗口。"""
    try:
        import ctypes

        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    except Exception:
        return False


if __name__ == "__main__":
    raise SystemExit(main())
