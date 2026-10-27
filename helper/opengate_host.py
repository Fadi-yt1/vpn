#!/usr/bin/env python3
"""Tervyn VPN helper.

Chrome starts this script through "native messaging" when the extension needs
it. It starts/stops Xray-core with the config the extension sends, and tests
server speed. No third-party Python packages needed.
"""
import json
import os
import socket
import struct
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor

IS_WIN = os.name == "nt"
HOME = os.path.join(os.path.expanduser("~"), ".opengate-vpn")
XRAY = os.path.join(HOME, "xray", "xray.exe" if IS_WIN else "xray")
CONFIG = os.path.join(HOME, "config.json")
PID_FILE = os.path.join(HOME, "xray.pid")
LOG_FILE = os.path.join(HOME, "xray.log")

os.makedirs(HOME, exist_ok=True)


# ---------- native messaging framing ----------
def read_message():
    raw = sys.stdin.buffer.read(4)
    if len(raw) < 4:
        return None
    (size,) = struct.unpack("<I", raw)
    return json.loads(sys.stdin.buffer.read(size).decode("utf-8"))


def send_message(obj):
    data = json.dumps(obj).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(data)) + data)
    sys.stdout.buffer.flush()


# ---------- process helpers ----------
def xray_version():
    try:
        out = subprocess.run([XRAY, "version"], capture_output=True, text=True, timeout=10, **no_window())
        return out.stdout.splitlines()[0].strip() if out.stdout else ""
    except Exception:
        return ""


def no_window():
    return {"creationflags": 0x08000000} if IS_WIN else {}  # CREATE_NO_WINDOW


def is_xray(pid):
    """True if pid is alive and is an xray process (guards against reused pids)."""
    try:
        if IS_WIN:
            out = subprocess.run(["tasklist", "/FI", f"PID eq {pid}", "/FO", "CSV", "/NH"],
                                 capture_output=True, text=True, timeout=10, **no_window()).stdout
            return "xray" in out.lower()
        os.kill(pid, 0)
        if os.path.exists(f"/proc/{pid}/cmdline"):
            with open(f"/proc/{pid}/cmdline", "rb") as f:
                return b"xray" in f.read()
        out = subprocess.run(["ps", "-p", str(pid), "-o", "comm="], capture_output=True, text=True).stdout
        return "xray" in out
    except Exception:
        return False


def read_pid():
    try:
        with open(PID_FILE) as f:
            return int(f.read().strip())
    except Exception:
        return None


def kill(pid):
    try:
        if IS_WIN:
            subprocess.run(["taskkill", "/PID", str(pid), "/F"], capture_output=True, **no_window())
        else:
            os.kill(pid, 15)
            for _ in range(20):
                if not is_xray(pid):
                    break
                time.sleep(0.1)
            else:
                os.kill(pid, 9)
    except Exception:
        pass


def spawn(args, log_path):
    """Start a process that keeps running after this helper exits."""
    log = open(log_path, "ab")
    kwargs = {"stdin": subprocess.DEVNULL, "stdout": log, "stderr": subprocess.STDOUT, "cwd": os.path.dirname(XRAY)}
    if IS_WIN:
        DETACHED, NEW_GROUP, BREAKAWAY = 0x00000008, 0x00000200, 0x01000000
        try:
            return subprocess.Popen(args, creationflags=DETACHED | NEW_GROUP | BREAKAWAY, **kwargs)
        except OSError:
            return subprocess.Popen(args, creationflags=DETACHED | NEW_GROUP, **kwargs)
    return subprocess.Popen(args, start_new_session=True, **kwargs)


def port_open(port, timeout=0.3):
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=timeout):
            return True
    except OSError:
        return False


def test_config(path):
    r = subprocess.run([XRAY, "run", "-test", "-c", path], capture_output=True, text=True, timeout=30, **no_window())
    out = (r.stdout + r.stderr).strip()
    return r.returncode == 0, out[-800:]


# ---------- commands ----------
def cmd_status(_msg):
    if not os.path.exists(XRAY):
        return {"ok": False, "error": f"Xray not found at {XRAY}. Run the installer again."}
    pid = read_pid()
    return {"ok": True, "version": xray_version(), "running": bool(pid and is_xray(pid)), "home": HOME}


def cmd_stop(_msg):
    pid = read_pid()
    if pid and is_xray(pid):
        kill(pid)
    try:
        os.remove(PID_FILE)
    except OSError:
        pass
    return {"ok": True}


def cmd_start(msg):
    if not os.path.exists(XRAY):
        return {"ok": False, "error": "Xray is not installed. Run the installer again."}
    config = msg["config"]
    tmp = CONFIG + ".new"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(config, f, indent=2)
    ok, out = test_config(tmp)
    if not ok:
        return {"ok": False, "error": "Xray rejected the config: " + out}
    os.replace(tmp, CONFIG)

    cmd_stop({})
    ports = [i["port"] for i in config.get("inbounds", [])]
    for _ in range(30):  # wait for the old process to release its ports
        if not any(port_open(p) for p in ports):
            break
        time.sleep(0.1)
    else:
        return {"ok": False, "error": f"Port {ports[0]} is already used by another program. Change it in Settings."}

    with open(LOG_FILE, "wb"):
        pass  # fresh log each start
    proc = spawn([XRAY, "run", "-c", CONFIG], LOG_FILE)
    with open(PID_FILE, "w") as f:
        f.write(str(proc.pid))
    for _ in range(50):
        if proc.poll() is not None:
            with open(LOG_FILE, "rb") as f:
                return {"ok": False, "error": "Xray stopped: " + f.read()[-800:].decode("utf-8", "replace")}
        if all(port_open(p) for p in ports):
            return {"ok": True, "pid": proc.pid}
        time.sleep(0.1)
    return {"ok": True, "pid": proc.pid, "note": "started, ports not confirmed yet"}


def tcp_ping(host, port, timeout):
    try:
        info = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)[0]
        start = time.perf_counter()
        with socket.socket(info[0], socket.SOCK_STREAM) as s:
            s.settimeout(timeout)
            s.connect(info[4])
        return round((time.perf_counter() - start) * 1000)
    except Exception:
        return None


def cmd_tcpping(msg):
    items, timeout = msg["items"], float(msg.get("timeout", 3))
    with ThreadPoolExecutor(64) as ex:
        res = ex.map(lambda i: (i["key"], tcp_ping(i["host"], i["port"], timeout)), items)
        return {"ok": True, "results": dict(res)}


def socks_http_get(port, url, timeout):
    """GET an http:// URL through a local SOCKS5 port. Returns delay in ms or None."""
    host = url.split("://", 1)[1].split("/", 1)[0]
    path = "/" + url.split("://", 1)[1].split("/", 1)[1] if "/" in url.split("://", 1)[1] else "/"
    start = time.perf_counter()
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=timeout) as s:
            s.settimeout(timeout)
            s.sendall(b"\x05\x01\x00")
            if s.recv(2) != b"\x05\x00":
                return None
            hb = host.encode()
            s.sendall(b"\x05\x01\x00\x03" + bytes([len(hb)]) + hb + struct.pack(">H", 80))
            rep = s.recv(10)
            if len(rep) < 2 or rep[1] != 0:
                return None
            s.sendall(f"GET {path} HTTP/1.1\r\nHost: {host}\r\nUser-Agent: Tervyn\r\nConnection: close\r\n\r\n".encode())
            first = s.recv(64)
            if not first.startswith(b"HTTP/1."):
                return None
            code = first.split(b" ")[1]
            if code[:1] not in (b"2", b"3"):
                return None
        return round((time.perf_counter() - start) * 1000)
    except Exception:
        return None


def realtest_batch(items, timeout, url, base_port):
    """Runs one temporary xray with a SOCKS inbound per server and measures each."""
    inbounds, outbounds, rules = [], [], []
    for n, it in enumerate(items):
        ob = dict(it["outbound"])
        ob["tag"] = f"o{n}"
        outbounds.append(ob)
        inbounds.append({"tag": f"i{n}", "listen": "127.0.0.1", "port": base_port + n, "protocol": "socks", "settings": {"udp": False}})
        rules.append({"type": "field", "inboundTag": [f"i{n}"], "outboundTag": f"o{n}"})
    cfg = {"log": {"loglevel": "none"}, "inbounds": inbounds, "outbounds": outbounds, "routing": {"rules": rules}}

    fd, path = tempfile.mkstemp(prefix="opengate-test-", suffix=".json")
    with os.fdopen(fd, "w") as f:
        json.dump(cfg, f)
    try:
        ok, _ = test_config(path)
        if not ok:
            if len(items) == 1:
                return {items[0]["key"]: None}
            # One bad server breaks the whole config: split and retry.
            half = len(items) // 2
            res = realtest_batch(items[:half], timeout, url, base_port)
            res.update(realtest_batch(items[half:], timeout, url, base_port))
            return res
        proc = subprocess.Popen([XRAY, "run", "-c", path], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL, **no_window())
        try:
            for _ in range(60):
                if port_open(base_port + len(items) - 1, 0.1):
                    break
                time.sleep(0.1)
            with ThreadPoolExecutor(48) as ex:
                delays = list(ex.map(lambda n: socks_http_get(base_port + n, url, timeout), range(len(items))))
            return {it["key"]: d for it, d in zip(items, delays)}
        finally:
            proc.kill()
            proc.wait(5)
    finally:
        os.remove(path)


def cmd_realtest(msg):
    if not os.path.exists(XRAY):
        return {"ok": False, "error": "Xray is not installed."}
    items = msg["items"][:1000]
    timeout = float(msg.get("timeout", 6))
    url = msg.get("url", "http://www.gstatic.com/generate_204")
    results = {}
    for i in range(0, len(items), 300):  # keep the number of test ports reasonable
        results.update(realtest_batch(items[i:i + 300], timeout, url, 42000))
    return {"ok": True, "results": results}


COMMANDS = {"status": cmd_status, "start": cmd_start, "stop": cmd_stop, "tcpping": cmd_tcpping, "realtest": cmd_realtest}


def main():
    if IS_WIN:
        import msvcrt
        msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
        msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)
    msg = read_message()
    if msg is None:
        return
    try:
        fn = COMMANDS.get(msg.get("cmd"))
        reply = fn(msg) if fn else {"ok": False, "error": "unknown command"}
    except Exception as e:  # never leave Chrome without an answer
        reply = {"ok": False, "error": f"{type(e).__name__}: {e}"}
    send_message(reply)


if __name__ == "__main__":
    main()
