#!/usr/bin/env python3
"""Hark remote client: drive the user's Chrome through the Hark Bridge (stdlib only).

Examples:
  python3 hark_remote.py --host 100.64.0.5 --token-file ~/.hark_token status
  python3 hark_remote.py --host 100.64.0.5 --token-file tok --socks5 localhost:1055 read
  python3 hark_remote.py ... screenshot out.png
  python3 hark_remote.py ... click 12
  python3 hark_remote.py ... type 7 "hello world" --enter
  python3 hark_remote.py ... navigate https://example.com
  python3 hark_remote.py ... tabs
  python3 hark_remote.py ... run "Find the cheapest flight to Goa next Friday"

Environment: HARK_BRIDGE_HOST, HARK_BRIDGE_TOKEN, HARK_BRIDGE_PORT, HARK_SOCKS5 can replace the flags.
"""
import argparse
import http.client
import ipaddress
import json
import os
import socket
import struct
import sys
import urllib.parse

DEFAULT_PORT = 17346


# --------------------------------------------------------------------------------------------------------------
# Minimal SOCKS5 CONNECT (RFC 1928), no auth: enough for `tailscaled --socks5-server=localhost:1055`.


def socks5_connect(proxy_host, proxy_port, dest_host, dest_port, timeout):
    sock = socket.create_connection((proxy_host, proxy_port), timeout=timeout)
    try:
        sock.sendall(b"\x05\x01\x00")  # version 5, one method: no authentication
        reply = _recv_exact(sock, 2)
        if reply[0] != 5 or reply[1] != 0:
            raise ConnectionError("SOCKS5 proxy refused no-auth method")
        try:
            ip = ipaddress.ip_address(dest_host)
            if ip.version == 4:
                addr = b"\x01" + ip.packed
            else:
                addr = b"\x04" + ip.packed
        except ValueError:
            name = dest_host.encode("idna")
            if len(name) > 255:
                raise ValueError("host name too long")
            addr = b"\x03" + bytes([len(name)]) + name
        sock.sendall(b"\x05\x01\x00" + addr + struct.pack(">H", dest_port))
        head = _recv_exact(sock, 4)
        if head[0] != 5:
            raise ConnectionError("bad SOCKS5 reply")
        if head[1] != 0:
            errors = {
                1: "general failure",
                2: "not allowed by ruleset",
                3: "network unreachable",
                4: "host unreachable",
                5: "connection refused",
                6: "TTL expired",
                7: "command not supported",
                8: "address type not supported",
            }
            raise ConnectionError("SOCKS5 connect failed: %s" % errors.get(head[1], head[1]))
        atyp = head[3]
        if atyp == 1:
            _recv_exact(sock, 4)
        elif atyp == 4:
            _recv_exact(sock, 16)
        elif atyp == 3:
            _recv_exact(sock, _recv_exact(sock, 1)[0])
        _recv_exact(sock, 2)
        return sock
    except Exception:
        sock.close()
        raise


def _recv_exact(sock, n):
    data = b""
    while len(data) < n:
        chunk = sock.recv(n - len(data))
        if not chunk:
            raise ConnectionError("connection closed by proxy")
        data += chunk
    return data


class SocksHTTPConnection(http.client.HTTPConnection):
    def __init__(self, host, port, proxy, timeout):
        super().__init__(host, port, timeout=timeout)
        self._proxy = proxy

    def connect(self):
        self.sock = socks5_connect(self._proxy[0], self._proxy[1], self.host, self.port, self.timeout)


# --------------------------------------------------------------------------------------------------------------


class BridgeError(Exception):
    def __init__(self, status, body):
        self.status = status
        self.body = body
        msg = body.get("error") if isinstance(body, dict) else str(body)
        code = body.get("code") if isinstance(body, dict) else None
        super().__init__("HTTP %s%s: %s" % (status, " " + code if code else "", msg))


class HarkRemote:
    def __init__(self, host, token, port=DEFAULT_PORT, socks5=None, timeout=60):
        self.host = host
        self.port = port
        self.token = token
        self.socks5 = socks5
        self.timeout = timeout

    def _conn(self, timeout):
        if self.socks5:
            return SocksHTTPConnection(self.host, self.port, self.socks5, timeout)
        return http.client.HTTPConnection(self.host, self.port, timeout=timeout)

    def request(self, method, path, body=None, query=None, timeout=None, raw=False):
        if query:
            path += "?" + urllib.parse.urlencode({k: v for k, v in query.items() if v is not None})
        conn = self._conn(timeout or self.timeout)
        headers = {"Authorization": "Bearer " + self.token, "Accept": "application/json"}
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
        try:
            conn.request(method, path, body=data, headers=headers)
            res = conn.getresponse()
            payload = res.read()
            ctype = res.getheader("Content-Type", "")
        finally:
            conn.close()
        if raw and res.status == 200 and ctype.startswith("image/"):
            return payload
        try:
            parsed = json.loads(payload.decode() or "{}")
        except ValueError:
            parsed = {"error": payload.decode(errors="replace")[:500]}
        if res.status != 200:
            raise BridgeError(res.status, parsed)
        return parsed

    # Convenience wrappers
    def status(self):
        return self.request("GET", "/status")

    def tabs(self):
        return self.request("GET", "/tabs")

    def tab(self, action, url=None, tab_id=None):
        return self.request("POST", "/tab", {"action": action, "url": url, "tabId": tab_id})

    def navigate(self, url=None, action=None):
        return self.request("POST", "/navigate", {"url": url} if url else {"action": action})

    def read(self, max_chars=None, lite=None):
        q = {"maxChars": max_chars}
        if lite is not None:
            q["lite"] = "true" if lite else "false"
        return self.request("GET", "/read", query=q)

    def screenshot_png(self, labels=False):
        return self.request("GET", "/screenshot", query={"format": "png", "labels": "true" if labels else None}, raw=True)

    def click(self, index=None, selector=None, x=None, y=None):
        body = {k: v for k, v in {"index": index, "selector": selector, "x": x, "y": y}.items() if v is not None}
        return self.request("POST", "/click", body)

    def type(self, index, text, enter=False):
        return self.request("POST", "/type", {"index": index, "text": text, "enter": enter})

    def scroll(self, direction="down", pages=1, to=None):
        body = {"to": to} if to else {"direction": direction, "pages": pages}
        return self.request("POST", "/scroll", body)

    def key(self, keys):
        return self.request("POST", "/key", {"keys": keys})

    def run_task(self, prompt, timeout_sec=600):
        return self.request("POST", "/run_task", {"prompt": prompt, "timeoutSec": timeout_sec}, timeout=timeout_sec + 60)

    def stop(self):
        return self.request("POST", "/stop", {})


def parse_hostport(value, default_port):
    if not value:
        return None
    host, _, port = value.rpartition(":")
    if not host:
        return value, default_port
    return host.strip("[]"), int(port)


def print_read(data):
    d = data.get("data", {})
    print("Title: %s\nURL:   %s\n" % (d.get("title"), d.get("url")))
    print("Interactive elements:")
    for el in d.get("elements", []):
        print("  " + el.get("line", ""))
    print("\nText:\n" + (d.get("text") or ""))


def main(argv=None):
    p = argparse.ArgumentParser(description="Drive Chrome through the Hark Bridge.")
    p.add_argument("--host", default=os.environ.get("HARK_BRIDGE_HOST"), help="Bridge host (the laptop's Tailscale IP)")
    p.add_argument("--port", type=int, default=int(os.environ.get("HARK_BRIDGE_PORT", DEFAULT_PORT)))
    p.add_argument("--token", default=os.environ.get("HARK_BRIDGE_TOKEN"), help="Agent token (prefer --token-file)")
    p.add_argument("--token-file", help="File holding the agent token")
    p.add_argument("--socks5", default=os.environ.get("HARK_SOCKS5"), help="SOCKS5 proxy host:port, e.g. localhost:1055")
    p.add_argument("--timeout", type=int, default=60)
    p.add_argument("--json", action="store_true", help="Print raw JSON")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("status")
    sub.add_parser("tabs")
    s = sub.add_parser("screenshot")
    s.add_argument("out", nargs="?", default="screenshot.png")
    s.add_argument("--labels", action="store_true")
    r = sub.add_parser("read")
    r.add_argument("--max-chars", type=int)
    r.add_argument("--lite", action="store_true")
    c = sub.add_parser("click")
    c.add_argument("index", nargs="?", type=int)
    c.add_argument("--selector")
    c.add_argument("--x", type=float)
    c.add_argument("--y", type=float)
    t = sub.add_parser("type")
    t.add_argument("index", type=int)
    t.add_argument("text")
    t.add_argument("--enter", action="store_true")
    n = sub.add_parser("navigate")
    n.add_argument("url", help="URL, or back / forward / reload")
    tb = sub.add_parser("tab")
    tb.add_argument("action", choices=["open", "switch", "close"])
    tb.add_argument("target", nargs="?", help="URL for open, tab id for switch/close")
    sc = sub.add_parser("scroll")
    sc.add_argument("direction", nargs="?", default="down", choices=["up", "down", "top", "bottom"])
    sc.add_argument("--pages", type=float, default=1)
    k = sub.add_parser("key")
    k.add_argument("keys")
    rn = sub.add_parser("run")
    rn.add_argument("prompt")
    rn.add_argument("--timeout-sec", type=int, default=600)
    sub.add_parser("stop")
    a = p.parse_args(argv)

    token = a.token
    if a.token_file:
        with open(os.path.expanduser(a.token_file)) as f:
            token = f.read().strip()
    if not a.host or not token:
        p.error("--host and --token/--token-file are required (or HARK_BRIDGE_HOST / HARK_BRIDGE_TOKEN)")
    proxy = parse_hostport(a.socks5, 1080)
    client = HarkRemote(a.host, token, a.port, proxy, a.timeout)

    try:
        if a.cmd == "status":
            out = client.status()
        elif a.cmd == "tabs":
            out = client.tabs()
        elif a.cmd == "screenshot":
            png = client.screenshot_png(labels=a.labels)
            with open(a.out, "wb") as f:
                f.write(png)
            print("Saved %s (%d bytes)" % (a.out, len(png)))
            return 0
        elif a.cmd == "read":
            out = client.read(a.max_chars, True if a.lite else None)
            if not a.json:
                print_read(out)
                return 0
        elif a.cmd == "click":
            out = client.click(a.index, a.selector, a.x, a.y)
        elif a.cmd == "type":
            out = client.type(a.index, a.text, a.enter)
        elif a.cmd == "navigate":
            out = client.navigate(action=a.url) if a.url in ("back", "forward", "reload") else client.navigate(a.url)
        elif a.cmd == "tab":
            if a.action == "open":
                out = client.tab("open", url=a.target)
            else:
                out = client.tab(a.action, tab_id=int(a.target))
        elif a.cmd == "scroll":
            out = client.scroll(to=a.direction) if a.direction in ("top", "bottom") else client.scroll(a.direction, a.pages)
        elif a.cmd == "key":
            out = client.key(a.keys)
        elif a.cmd == "run":
            out = client.run_task(a.prompt, a.timeout_sec)
        elif a.cmd == "stop":
            out = client.stop()
        else:
            p.error("unknown command")
    except BridgeError as e:
        print("Error: %s" % e, file=sys.stderr)
        if a.json:
            print(json.dumps(e.body, indent=2))
        return 1
    except (OSError, ConnectionError) as e:
        print("Cannot reach the bridge at %s:%s%s: %s" % (a.host, a.port, " via SOCKS5 " + a.socks5 if a.socks5 else "", e), file=sys.stderr)
        return 2
    print(json.dumps(out, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
