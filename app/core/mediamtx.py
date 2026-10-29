"""Built-in receiver for phone cameras (Blackmagic Camera, Larix, OBS, ...).

Veil starts a private MediaMTX server. Phones *publish* to it over Wi-Fi
(RTMP on 1935 or SRT on 8890), and Veil *reads* the same stream back over
RTSP on the loopback interface. MediaMTX re-packages without re-encoding, so
it adds only milliseconds of latency.

Ports bound to all interfaces: 1935 (RTMP) and 8890/udp (SRT), for the phone.
Loopback only: 8554 (RTSP, read by Veil) and 9997 (status API).
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import socket
import subprocess
import sys
import time
import urllib.request
from dataclasses import dataclass
from pathlib import Path

from app.utils.paths import PROJECT_ROOT, cache_dir, log_dir

log = logging.getLogger(__name__)

RTMP_PORT = 1935
SRT_PORT = 8890
RTSP_PORT = 8554
API_PORT = 9997
STREAM_PATH = "live/phone"

CONFIG = f"""\
logLevel: warn
logDestinations: [stdout]
readTimeout: 10s
writeTimeout: 10s
api: yes
apiAddress: 127.0.0.1:{API_PORT}
metrics: no
pprof: no
playback: no
rtsp: yes
protocols: [tcp]
rtspAddress: 127.0.0.1:{RTSP_PORT}
rtmp: yes
rtmpAddress: :{RTMP_PORT}
srt: yes
srtAddress: :{SRT_PORT}
hls: no
webrtc: no
paths:
  all_others:
"""


@dataclass
class StreamStatus:
    ready: bool
    tracks: list[str]
    source: str  # e.g. "rtmpConn", "srtConn"
    readers: int


def find_executable() -> Path | None:
    exe = "mediamtx.exe" if sys.platform == "win32" else "mediamtx"
    candidates = [
        os.environ.get("VEIL_MEDIAMTX", ""),
        str(PROJECT_ROOT.parent / "runtimes" / "mediamtx" / exe),  # installed layout
        str(PROJECT_ROOT / "runtimes" / "mediamtx" / exe),  # running from source
        shutil.which("mediamtx") or "",
    ]
    for c in candidates:
        if c and Path(c).is_file():
            return Path(c)
    return None


def local_ipv4_addresses() -> list[str]:
    """LAN addresses a phone can reach, primary (default-route) address first."""
    ips: list[str] = []
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("192.0.2.1", 9))  # no packet is sent; selects the outgoing interface
            ips.append(s.getsockname()[0])
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ips.append(info[4][0])
    except OSError:
        pass
    seen: list[str] = []
    for ip in ips:
        if ip not in seen and not ip.startswith(("127.", "169.254.", "0.")):
            seen.append(ip)
    return seen


def publish_urls(ip: str) -> dict[str, str]:
    server, key = STREAM_PATH.split("/", 1)
    return {
        "rtmp_server": f"rtmp://{ip}:{RTMP_PORT}/{server}",
        "rtmp_key": key,
        "rtmp_full": f"rtmp://{ip}:{RTMP_PORT}/{STREAM_PATH}",
        "srt": f"srt://{ip}:{SRT_PORT}?streamid=publish:{STREAM_PATH}",
    }


def read_url() -> str:
    return f"rtsp://127.0.0.1:{RTSP_PORT}/{STREAM_PATH}"


def _port_free(port: int, udp: bool = False) -> bool:
    kind = socket.SOCK_DGRAM if udp else socket.SOCK_STREAM
    with socket.socket(socket.AF_INET, kind) as s:
        try:
            s.bind(("0.0.0.0", port))
            return True
        except OSError:
            return False


class MediaMTXServer:
    def __init__(self) -> None:
        self._proc: subprocess.Popen | None = None
        self._log_file = None
        self.exe = find_executable()

    @property
    def available(self) -> bool:
        return self.exe is not None

    @property
    def running(self) -> bool:
        return self._proc is not None and self._proc.poll() is None

    def start(self, timeout: float = 6.0) -> None:
        if self.running:
            return
        if self.exe is None:
            raise FileNotFoundError(
                "MediaMTX is not installed. Re-run VeilSetup.exe and select "
                "'Phone & Blackmagic Camera receiver', or set VEIL_MEDIAMTX to mediamtx.exe."
            )
        if self._api_alive():
            log.info("A MediaMTX instance is already running; reusing it.")
            return
        busy = [p for p, udp in ((RTMP_PORT, False), (RTSP_PORT, False), (SRT_PORT, True)) if not _port_free(p, udp)]
        if busy:
            raise OSError(f"Port(s) {', '.join(map(str, busy))} are in use by another program (OBS? another server?).")
        cfg_path = cache_dir() / "mediamtx.yml"
        cfg_path.write_text(CONFIG, encoding="utf-8")
        self._log_file = (log_dir() / "mediamtx.log").open("a", encoding="utf-8")
        flags = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0  # type: ignore[attr-defined]
        self._proc = subprocess.Popen(
            [str(self.exe), str(cfg_path)], stdout=self._log_file, stderr=subprocess.STDOUT,
            cwd=str(self.exe.parent), creationflags=flags,
        )
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            if self._proc.poll() is not None:
                raise RuntimeError(f"MediaMTX exited (code {self._proc.returncode}); see {log_dir() / 'mediamtx.log'}.")
            if self._api_alive():
                log.info("MediaMTX started (RTMP %d, SRT %d, RTSP %d)", RTMP_PORT, SRT_PORT, RTSP_PORT)
                return
            time.sleep(0.15)
        self.stop()
        raise TimeoutError("MediaMTX did not start in time.")

    def stop(self) -> None:
        proc, self._proc = self._proc, None
        if proc is not None and proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                proc.kill()
        if self._log_file is not None:
            self._log_file.close()
            self._log_file = None

    # Loopback API: never route through a system/corporate proxy.
    _opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def _api(self, path: str, timeout: float = 0.5) -> dict | None:
        try:
            with self._opener.open(f"http://127.0.0.1:{API_PORT}{path}", timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except Exception:
            return None

    def _api_alive(self) -> bool:
        return self._api("/v3/paths/list") is not None

    def status(self) -> StreamStatus | None:
        """State of the phone stream, or None if nothing is publishing."""
        data = self._api("/v3/paths/list")
        if not data:
            return None
        for item in data.get("items", []):
            if item.get("name") == STREAM_PATH:
                source = item.get("source") or {}
                return StreamStatus(
                    ready=bool(item.get("ready")),
                    tracks=list(item.get("tracks") or []),
                    source=str(source.get("type", "")),
                    readers=len(item.get("readers") or []),
                )
        return None


# ---------------------------------------------------------------------------
# Blackmagic Camera: "Live Stream > Platform > Import Stream Settings"
# ---------------------------------------------------------------------------
# Blackmagic Camera has no free-text server field; custom servers are added by
# importing a streaming XML file (the same format ATEM Software Control
# exports). Veil generates one for this PC and can serve it over the LAN so
# the phone downloads it by scanning a QR code.
SHARE_PORT = 8899
XML_NAME = "Veil.xml"

_PROFILES = (
    # name, resolution, fps, video bitrate (b/s)
    ("1080p30 (recommended)", "1080p", 30, 8_000_000),
    ("1080p60", "1080p", 60, 12_000_000),
    ("720p30 (weak Wi-Fi)", "720p", 30, 4_000_000),
    ("2160p30", "2160p", 30, 25_000_000),
)


def blackmagic_xml(ip: str) -> str:
    from xml.sax.saxutils import escape

    server, key = STREAM_PATH.split("/", 1)
    profiles = "\n".join(
        f"""            <profile>
                <name>{escape(name)}</name>
                <config resolution="{res}" fps="{fps}">
                    <bitrate>{rate}</bitrate>
                    <audio-bitrate>128000</audio-bitrate>
                    <keyframe-interval>1</keyframe-interval>
                </config>
            </profile>"""
        for name, res, fps, rate in _PROFILES
    )
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<streaming>
    <service>
        <name>Veil</name>
        <servers>
            <server>
                <name>Veil PC ({escape(ip)})</name>
                <url>rtmp://{escape(ip)}:{RTMP_PORT}/{server}</url>
            </server>
        </servers>
        <key>{key}</key>
        <profiles>
{profiles}
        </profiles>
    </service>
</streaming>
"""


def share_url(ip: str) -> str:
    return f"http://{ip}:{SHARE_PORT}/{XML_NAME}"


class SettingsShareServer:
    """Tiny LAN web server that only serves the generated settings file.

    Lets the phone download it by scanning a QR code; it stops when the
    connection dialog closes. Nothing else is exposed.
    """

    def __init__(self) -> None:
        self._httpd = None
        self._thread = None
        self.xml = b""

    def start(self, ip: str) -> bool:
        import http.server
        import threading

        self.xml = blackmagic_xml(ip).encode("utf-8")
        if self._httpd is not None:
            return True
        owner = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802
                if self.path.split("?")[0] != f"/{XML_NAME}":
                    self.send_error(404)
                    return
                self.send_response(200)
                self.send_header("Content-Type", "application/xml")
                self.send_header("Content-Disposition", f'attachment; filename="{XML_NAME}"')
                self.send_header("Content-Length", str(len(owner.xml)))
                self.end_headers()
                self.wfile.write(owner.xml)

            def log_message(self, *_a):  # keep the console quiet
                pass

        try:
            self._httpd = http.server.ThreadingHTTPServer(("0.0.0.0", SHARE_PORT), Handler)
        except OSError as exc:
            log.warning("Settings share server unavailable: %s", exc)
            return False
        self._thread = threading.Thread(target=self._httpd.serve_forever, name="XmlShare", daemon=True)
        self._thread.start()
        return True

    def stop(self) -> None:
        if self._httpd is not None:
            self._httpd.shutdown()
            self._httpd.server_close()
            self._httpd = None
