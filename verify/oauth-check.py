#!/usr/bin/env python3
"""Sign in to Yunxiao and write the token file this plugin reads.

Runs the same OAuth 2.0 flow as the panel's "Sign in with Yunxiao" action, from a terminal:
authorization-server metadata discovery, dynamic client registration, authorization code with PKCE
(S256), a loopback callback on 127.0.0.1, and the token exchange. Writes <token-file> (mode 0600)
and <token-file>.oauth.json beside it. Prints progress only - never a token value.

Usage:
    python verify/oauth-check.py --token-file /path/to/yunxiao-token [--site https://openapi-rdc.aliyuncs.com]

Then run the read-only contract check:
    LIVE=1 YUNXIAO_ORG=... YUNXIAO_PROJECT=... YUNXIAO_TOKEN_FILE=/path/to/yunxiao-token \
        npx vitest run tests/live/projex-contract.live.spec.ts
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import secrets
import sys
import threading
import time
import urllib.parse
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer

CALLBACK_PATH = "/callback"
DEFAULT_SITE = "https://openapi-rdc.aliyuncs.com"


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def http_json(url: str, payload: dict | None = None, form: dict | None = None, timeout: int = 20) -> dict:
    headers = {"accept": "application/json"}
    data = None
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["content-type"] = "application/json"
    elif form is not None:
        data = urllib.parse.urlencode(form).encode("utf-8")
        headers["content-type"] = "application/x-www-form-urlencoded"
    request = urllib.request.Request(url, data=data, headers=headers, method="POST" if data is not None else "GET")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as error:
        body = error.read().decode("utf-8", "replace")
        raise SystemExit(f"{url} answered HTTP {error.code}: {body[:300]}") from None


def discover(site: str) -> dict:
    base = site.rstrip("/")
    try:
        meta = http_json(f"{base}/.well-known/oauth-authorization-server")
        if meta.get("authorization_endpoint") and meta.get("token_endpoint"):
            return meta
    except SystemExit:
        pass
    return {"authorization_endpoint": f"{base}/v1/oauth2/authorize", "token_endpoint": f"{base}/v1/oauth2/token",
            "registration_endpoint": f"{base}/v1/oauth2/register"}


def register(endpoint: str, redirect_uri: str, client_name: str) -> str:
    body = {"client_name": client_name, "redirect_uris": [redirect_uri],
            "grant_types": ["authorization_code", "refresh_token"], "response_types": ["code"],
            "token_endpoint_auth_method": "none"}
    answer = http_json(endpoint, payload=body)
    client_id = answer.get("client_id")
    if not client_id:
        raise SystemExit("Yunxiao did not return a client_id")
    return str(client_id)


class Callback(BaseHTTPRequestHandler):
    code: str | None = None
    state: str | None = None

    def do_GET(self) -> None:  # noqa: N802 - http.server's name
        url = urllib.parse.urlparse(self.path)
        if url.path != CALLBACK_PATH:
            self.send_response(404)
            self.end_headers()
            return
        query = urllib.parse.parse_qs(url.query)
        Callback.code = (query.get("code") or [None])[0]
        Callback.state = (query.get("state") or [None])[0]
        ok = bool(Callback.code)
        self.send_response(200)
        self.send_header("content-type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write(("<p>授权完成，可以关闭此页面。</p>" if ok else "<p>授权未完成，请回到终端查看原因。</p>").encode("utf-8"))

    def log_message(self, *_args) -> None:  # keep the console clean
        return


def main() -> int:
    parser = argparse.ArgumentParser(description="Sign in to Yunxiao and write the token file")
    parser.add_argument("--token-file", required=True, help="file the plugin reads the token from")
    parser.add_argument("--site", default=DEFAULT_SITE, help=f"API site (default {DEFAULT_SITE})")
    parser.add_argument("--client-name", default="dsh-superagent-multi-channel")
    parser.add_argument("--timeout", type=int, default=300)
    args = parser.parse_args()

    endpoints = discover(args.site)
    server = HTTPServer(("127.0.0.1", 0), Callback)
    port = server.server_address[1]
    redirect_uri = f"http://127.0.0.1:{port}{CALLBACK_PATH}"
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    print(f"[1/4] site {args.site}")
    client_id = register(endpoints.get("registration_endpoint") or f"{args.site.rstrip('/')}/v1/oauth2/register",
                         redirect_uri, args.client_name)
    print(f"[2/4] client registered ({client_id[:6]}…)")

    verifier = b64url(secrets.token_bytes(32))
    challenge = b64url(hashlib.sha256(verifier.encode("ascii")).digest())
    state = b64url(secrets.token_bytes(16))
    url = (endpoints["authorization_endpoint"] + "?" + urllib.parse.urlencode({
        "response_type": "code", "client_id": client_id, "redirect_uri": redirect_uri,
        "code_challenge": challenge, "code_challenge_method": "S256", "state": state}))
    print("[3/4] 在浏览器完成云效登录与授权；若没有自动打开，请访问：")
    print("      " + url)
    try:
        webbrowser.open(url)
    except Exception:
        pass

    deadline = time.time() + args.timeout
    while time.time() < deadline and Callback.code is None:
        time.sleep(0.2)
    server.shutdown()
    if not Callback.code:
        print("没有收到授权回调（超时或被拒绝）", file=sys.stderr)
        return 2
    if Callback.state != state:
        print("回调的 state 不匹配，已拒绝", file=sys.stderr)
        return 2

    tokens = http_json(endpoints["token_endpoint"], form={
        "grant_type": "authorization_code", "code": Callback.code, "redirect_uri": redirect_uri,
        "client_id": client_id, "code_verifier": verifier})
    access = tokens.get("access_token")
    if not access:
        raise SystemExit("Yunxiao returned no access_token")

    token_file = os.path.abspath(os.path.expanduser(args.token_file))
    os.makedirs(os.path.dirname(token_file) or ".", exist_ok=True)
    with open(token_file, "w", encoding="utf-8") as handle:
        handle.write(access + "\n")
    os.chmod(token_file, 0o600)
    stored = {"site": args.site.rstrip("/"), "clientId": client_id, "tokenEndpoint": endpoints["token_endpoint"]}
    if tokens.get("refresh_token"):
        stored["refreshToken"] = tokens["refresh_token"]
    if tokens.get("expires_in"):
        stored["expiresAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + int(tokens["expires_in"])))
    stored_file = token_file + ".oauth.json"
    with open(stored_file, "w", encoding="utf-8") as handle:
        json.dump(stored, handle, ensure_ascii=False, indent=2)
    os.chmod(stored_file, 0o600)
    print(f"[4/4] 令牌写入 {token_file}（访问令牌 24 小时，刷新令牌 90 天，已存续期信息）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
