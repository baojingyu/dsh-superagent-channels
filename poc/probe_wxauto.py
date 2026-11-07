# -*- coding: utf-8 -*-
"""probe_wxauto.py — 微信 PC 客户端能力探针，产出 ``probe-report.json``。

为什么需要它
------------
``docs/extensions/ADR-005-weixin-backend.md`` 把「群 ``@`` 能否结构化判定」（Q1）
定为 L0 后端的准入门槛。本项目有一条硬规则：**群 ``@`` 绝不按文本反解**。
因此必须先拿到运行时证据，再决定后端走 L0（pc-uia）还是 L2（pad）。

探针只读，不发消息、不加好友、不改群设置。唯一的副作用风险是 ``FriendMessage.at``：
它在 wxautox4 里是**拍一拍动作**（返回 ``WxResponse``），不是取字段的方法，
所以本探针**从不调用**它，只记录它的类型。

用法
----
    python probe_wxauto.py --selftest              # 不碰微信，只验证报告链路
    python probe_wxauto.py                         # 用会话列表里的第一个群
    python probe_wxauto.py --group "研发-交付群" --media --wait 120
    python probe_wxauto.py --all-groups --max-groups 5

报告
----
``probe-report.json``，关键字段：

``package``          实际加载的包（wxauto4 / wxautox4 / wxauto）
``checks[]``         逐项检查：``name`` / ``ok`` / ``detail``
``q1SampleMessage``  样本消息的全字段 dump 与 ``atListCandidates``
``q1Verdict``        ``structured`` / ``absent``，以及建议后端
``q2GroupMembers``   群成员表能力
``media``            （``--media``）图片下载与 OCR 能力

退出码
------
0  报告已写出（无论 Q1 结论如何 —— 有证据就是成功）
1  连报告都写不出来（这种情况只可能是磁盘问题）
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import traceback
from typing import Any

REPORT_NAME = "probe-report.json"
# 包名按优先级排列：4.x 客户端用 wxauto4 / wxautox4，3.9.x 用 wxauto。
PACKAGE_ORDER = ("wxauto4", "wxautox4", "wxauto")
# 微信 4.x 在群 @ 后面插入 U+2005（四分宽空格）作为分隔符。这是**文本**特征，
# 用户可复制粘贴伪造，所以只作证据记录，绝不用作判定依据（ADR-005 §2.3 硬规则 4）。
MENTION_SEPARATOR = "\u2005"
# 不可能是 @ 列表的字段：``attr`` 是消息来源（system/self/friend）。
NOT_A_MENTION_FIELD = frozenset({"attr", "sender_remark", "type", "id", "hash", "hash_text", "direction"})


def _jsonable(value: Any, depth: int = 0) -> Any:
    """把任意运行时值转成可 JSON 序列化的形式，保留类型信息，深度受限。"""
    if depth > 4:
        return "<max depth>"
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, (list, tuple, set)):
        return [_jsonable(item, depth + 1) for item in value]
    if isinstance(value, dict):
        return {str(key): _jsonable(item, depth + 1) for key, item in value.items()}
    if callable(value):
        return "<callable %s>" % type(value).__name__
    return "<%s> %s" % (type(value).__name__, repr(value)[:200])


def _looks_like_list(value: Any) -> bool:
    """一个值是否「真像 @ 列表」：字符串列表，或含字符串列表的 dict。

    ADR-005 §7 记录过一个坑：旧逻辑把 ``attr``（消息来源）当成了 @ 列表，
    直接把 Q1 判成「有证据」。这里要求值本身真的是列表，且元素是字符串。
    """
    if isinstance(value, (list, tuple, set)) and value:
        return all(isinstance(item, str) for item in value)
    if isinstance(value, dict):
        return any(_looks_like_list(item) for item in value.values())
    return False


def _attributes(obj: Any) -> dict[str, Any]:
    """把一个消息对象的全部可读属性 dump 成 dict，供证据留存与候选判定。"""
    row: dict[str, Any] = {"__class__": type(obj).__name__}
    bag = getattr(obj, "__dict__", None)
    if isinstance(bag, dict):
        for key, value in bag.items():
            if key in ("parent", "control", "root"):
                row[key] = "<%s>" % type(value).__name__
                continue
            row[key] = _jsonable(value)
    for name in ("type", "attr", "id", "sender", "sender_remark", "content", "info",
                 "chat_info", "at", "ats", "at_list", "atList", "mentions", "time"):
        if name in row:
            continue
        try:
            value = getattr(obj, name)
        except BaseException:
            continue
        row[name] = _jsonable(value)
    return row


def _mention_candidates(row: dict[str, Any]) -> dict[str, Any]:
    """从一条消息的属性 dump 里挑出可能承载结构化 @ 的字段。

    返回 ``{field: sample}``；``attr`` 一类字段被排除，``at`` 可调用时也排除
    （它是拍一拍动作，见模块 docstring）。
    """
    found: dict[str, Any] = {}
    for key, value in row.items():
        if key in NOT_A_MENTION_FIELD or key == "__class__":
            continue
        if isinstance(value, str) and value.startswith("<callable"):
            continue
        if _looks_like_list(value):
            found[key] = value
    return found


def _uia_facts(control: Any) -> dict[str, Any]:
    """记录消息控件的 UIA 结构：子节点数、支持的 pattern。

    微信 4.x 的消息气泡是 ``mmui::ChatTextItemView``，扁平叶子、无 pattern；
    这条事实就是「L0 拿不到结构化 @」的直接原因，必须写进报告。
    """
    facts: dict[str, Any] = {}
    try:
        facts["class"] = getattr(control, "ClassName", None)
        facts["automationId"] = getattr(control, "AutomationId", None)
        facts["name"] = getattr(control, "Name", None)
    except BaseException:
        pass
    try:
        facts["childCount"] = len(control.GetChildren())
    except BaseException:
        facts["childCount"] = None
    patterns = {}
    for name in ("TextPattern", "ValuePattern", "LegacyIAccessiblePattern", "SelectionPattern"):
        try:
            patterns[name] = getattr(control, name, None) is not None
        except BaseException:
            patterns[name] = None
    facts["patterns"] = patterns
    return facts


def load_package() -> tuple[Any, str, str]:
    """按优先级加载一个可用的 wxauto 系包，返回 (WeChat 类, 包名, 备注)。

    ``wxautox4`` 是商业库，构造客户端时会检查授权；授权由部署方自行提供。没有有效授权时
    构造会失败，探针把原因写进报告而不是崩掉——这条路径本身不含任何规避手段。
    """
    note = ""
    errors = []
    for package in PACKAGE_ORDER:
        try:
            module = __import__(package + ".wx", fromlist=["wx"])
            return module.WeChat, package, note
        except BaseException as error:
            errors.append("%s: %r" % (package, error))
    raise RuntimeError("no usable wxauto package; tried " + "; ".join(errors))


def read_chat(client: Any, chat: str, away: str, tries: int, gap: float) -> list[Any]:
    """读一个会话当前渲染出来的消息。

    ``GetAllMessage()`` 只覆盖**当前窗口已渲染**的消息，而 ``ChatWith`` 在目标
    已是当前会话时不会重绘，于是返回空列表。所以先切到 ``away`` 再切回来，
    然后轮询；这也是 sidecar 轮询时必须复用的读取策略。
    """
    for _ in range(max(1, tries)):
        try:
            if away and away != chat:
                client.ChatWith(away)
                time.sleep(0.4)
            client.ChatWith(chat)
        except BaseException:
            pass
        time.sleep(gap)
        try:
            messages = client.GetAllMessage() or []
        except BaseException:
            messages = []
        if messages:
            return messages
    return []


def probe_mentions(client: Any, messages: list[Any]) -> dict[str, Any]:
    """Q1：在真实消息里找结构化 @ 列表，并把证据原样留存。"""
    result: dict[str, Any] = {
        "messageCount": len(messages),
        "atListCandidates": {},
        "sampleMessage": None,
        "uia": None,
        "textSeparator": None,
    }
    # 样本优先级：别人发来的带 @ 的消息 > 带 @ 的任意消息 > 别人发来的消息 > 第一条。
    # 必须先排除自消息：自己发的消息本来就不会带 at 列表，拿它当样本会把 Q1 误判成「没有」。
    def pick(predicate) -> Any:
        for message in messages:
            if predicate(message):
                return message
        return None

    def mentions_text(message: Any) -> bool:
        content = getattr(message, "content", None)
        return isinstance(content, str) and "@" in content

    sample = (pick(lambda m: getattr(m, "attr", None) == "friend" and mentions_text(m))
              or pick(mentions_text)
              or pick(lambda m: getattr(m, "attr", None) == "friend")
              or (messages[0] if messages else None))
    if sample is None:
        return result

    row = _attributes(sample)
    result["sampleMessage"] = row
    result["atListCandidates"] = _mention_candidates(row)
    try:
        result["uia"] = _uia_facts(sample.control)
    except BaseException:
        result["uia"] = None

    content = row.get("content")
    if isinstance(content, str) and MENTION_SEPARATOR in content:
        head = content.split(MENTION_SEPARATOR, 1)[0]
        result["textSeparator"] = {
            "separator": "U+2005",
            "prefix": head,
            "textDerived": True,
            "usable": False,
            "why": "a user can type or paste U+2005, so this is text, not the client's own mention markup",
        }
    return result


def probe_members(client: Any) -> dict[str, Any]:
    """Q2：群成员表能力。契约的 ``/members`` 端点靠它，拿不到就只能如实报空。"""
    result: dict[str, Any] = {"apis": {}, "memberCount": None, "members": []}
    for name in ("GetGroupMembers", "GetMembers", "GetGroupMemberList", "GetGroupMembersList"):
        result["apis"][name] = hasattr(client, name)
    try:
        info = client.ChatInfo()
        result["chatInfo"] = _jsonable(info)
        if isinstance(info, dict):
            result["memberCount"] = info.get("group_member_count")
    except BaseException as error:
        result["chatInfo"] = "<failed: %r>" % (error,)
    # wxautox4 的私有 API 面里也找一遍，避免漏掉没暴露到公开类上的实现。
    api = getattr(client, "_api", None)
    if api is not None:
        result["privateApis"] = sorted(
            name for name in dir(api)
            if "member" in name.lower() or "contact" in name.lower()
        )
    return result


def probe_media(client: Any, messages: list[Any]) -> dict[str, Any]:
    """Q4：图片消息的下载与 OCR 能力（只有 Plus 构建才带 ``download()``）。"""
    result: dict[str, Any] = {"imageCount": 0, "hasDownload": False, "hasOcr": False}
    images = [message for message in messages if getattr(message, "type", None) == "image"]
    result["imageCount"] = len(images)
    if not images:
        result["detail"] = "no image message was rendered in this chat"
        return result
    sample = images[0]
    result["hasDownload"] = callable(getattr(sample, "download", None))
    result["hasOcr"] = callable(getattr(sample, "ocr", None))
    result["detail"] = ("image messages need the Plus build" if not result["hasDownload"]
                        else "download() is available")
    return result


def build_report(args: argparse.Namespace) -> dict[str, Any]:
    """跑完一次探针，返回整份报告。"""
    report: dict[str, Any] = {
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "host": sys.platform,
        "python": sys.version.split()[0],
        "selftest": bool(args.selftest),
        "checks": [],
        "q1Verdict": None,
    }

    def check(name: str, ok: bool, detail: str = "") -> None:
        report["checks"].append({"name": name, "ok": bool(ok), "detail": detail})

    if args.selftest:
        # 不碰微信：只证明「报告一定能写出来」这条链路。
        check("report pipeline", True, "selftest: no client was touched")
        report["q1Verdict"] = {"verdict": "not-probed", "recommendedBackend": "unknown"}
        return report

    try:
        client_class, package, note = load_package()
    except BaseException as error:
        check("import a wxauto package", False, repr(error))
        report["q1Verdict"] = {"verdict": "not-probed", "recommendedBackend": "unknown"}
        return report
    report["package"] = package
    report["packageNote"] = note
    check("import a wxauto package", True, "%s%s" % (package, ("; " + note) if note else ""))

    try:
        client = client_class(version="微信")
    except BaseException as error:
        check("attach the WeChat client", False, repr(error))
        report["q1Verdict"] = {"verdict": "not-probed", "recommendedBackend": "unknown"}
        return report
    check("attach the WeChat client", True, "attached")

    try:
        report["identity"] = _jsonable(client.GetMyInfo())
    except BaseException as error:
        report["identity"] = "<failed: %r>" % (error,)

    # 选群：命令行指定优先，否则用最近群列表的第一个。
    groups: list[Any] = []
    try:
        groups = client.GetAllRecentGroups() or []
    except BaseException as error:
        report["recentGroupsError"] = repr(error)
    report["groupCount"] = len(groups)
    names = [row[0] if isinstance(row, (list, tuple)) and row else str(row) for row in groups]

    targets = [args.group] if args.group else (names[: max(1, args.max_groups)] if args.all_groups else names[:1])
    if not targets:
        check("find a group to probe", False, "no recent group was listed")
        report["q1Verdict"] = {"verdict": "not-probed", "recommendedBackend": "unknown"}
        return report
    check("find a group to probe", True, ", ".join(str(t) for t in targets))

    chats = []
    for target in targets:
        entry: dict[str, Any] = {"group": target}
        messages = read_chat(client, str(target), args.away, args.tries, args.gap)
        entry["rendered"] = len(messages)
        entry["q1"] = probe_mentions(client, messages)
        entry["q2"] = probe_members(client)
        if args.media:
            entry["media"] = probe_media(client, messages)
        chats.append(entry)
    report["chats"] = chats

    # Q1 结论：任一会话里出现真正的字符串列表候选，就算拿到结构化 @。
    candidates: dict[str, Any] = {}
    for entry in chats:
        candidates.update(entry["q1"].get("atListCandidates") or {})
    report["q1SampleMessage"] = next(
        (entry["q1"]["sampleMessage"] for entry in chats if entry["q1"].get("sampleMessage")), None)
    report["atListCandidates"] = candidates

    uia = next((entry["q1"].get("uia") for entry in chats if entry["q1"].get("uia")), None)
    structured = bool(candidates)
    if structured:
        check("Q1 structured mentions", True, "fields: " + ", ".join(sorted(candidates)))
        verdict = {
            "verdict": "structured",
            "fields": sorted(candidates),
            "recommendedBackend": "pc-uia",
            "next": "map the real field name into the sidecar's `ats`, then the Node side needs no change",
        }
    else:
        check("Q1 structured mentions", False,
              "no string-list field on the message object; the bubble is a flat UIA leaf")
        verdict = {
            "verdict": "absent",
            "recommendedBackend": "pad",
            "why": "the message control exposes no structured mention list",
            "evidence": {
                "uia": uia,
                "messageFields": sorted((report["q1SampleMessage"] or {}).keys()),
            },
            "next": ("do not reverse @ from text (hard rule); switch the sidecar backend to L2 (pad), "
                     "or add an L1 database reader that reads the protocol's own mention list"),
        }
    report["q1Verdict"] = verdict

    members = next((entry["q2"] for entry in chats if entry["q2"]), {})
    check("Q2 group members", bool(members.get("memberCount")),
          "group_member_count=%s, member list API=%s" % (
              members.get("memberCount"),
              [name for name, present in (members.get("apis") or {}).items() if present] or "none"))

    if args.media:
        media = next((entry.get("media") for entry in chats if entry.get("media")), {})
        check("Q4 image download", bool(media.get("hasDownload")), str(media.get("detail", "")))

    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Probe the WeChat PC client for the weixin backend contract.")
    parser.add_argument("--group", default="", help="group display name to probe")
    parser.add_argument("--all-groups", action="store_true", help="probe the most recent groups, not just one")
    parser.add_argument("--max-groups", type=int, default=3, help="how many groups --all-groups probes")
    parser.add_argument("--media", action="store_true", help="also probe image download and OCR")
    parser.add_argument("--wait", type=int, default=0, help="sleep this many seconds before reading messages")
    parser.add_argument("--tries", type=int, default=8, help="how many times to re-render and re-read")
    parser.add_argument("--gap", type=float, default=1.0, help="seconds between a re-render and a read")
    parser.add_argument("--away", default="文件传输助手", help="a chat to switch to first, forcing a re-render")
    parser.add_argument("--selftest", action="store_true", help="do not touch WeChat; only prove the report is written")
    parser.add_argument("--out", default="", help="report path; defaults to ./probe-report.json")
    args = parser.parse_args(argv)

    out = os.path.abspath(args.out or os.path.join(os.path.dirname(os.path.abspath(__file__)), REPORT_NAME))
    report: dict[str, Any]
    try:
        if args.wait:
            time.sleep(args.wait)
        report = build_report(args)
    except BaseException as error:
        # 探针的价值在于「一定出报告」：异常也写进去，而不是什么都不留。
        report = {
            "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "error": repr(error),
            "traceback": traceback.format_exc(),
            "checks": [{"name": "probe", "ok": False, "detail": repr(error)}],
            "q1Verdict": {"verdict": "not-probed", "recommendedBackend": "unknown"},
        }
    finally:
        try:
            with open(out, "w", encoding="utf-8") as handle:
                json.dump(report, handle, ensure_ascii=False, indent=2)
                handle.write("\n")
            print("[probe] report written: %s" % out)
        except BaseException as error:
            print("[probe] could not write %s: %r" % (out, error), file=sys.stderr)
            return 1

    for entry in report.get("checks", []):
        print("[probe] %-26s %s  %s" % (entry["name"], "OK  " if entry["ok"] else "FAIL", entry.get("detail", "")))
    verdict = report.get("q1Verdict") or {}
    print("[probe] Q1 verdict: %s (recommended backend: %s)" % (
        verdict.get("verdict"), verdict.get("recommendedBackend")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
