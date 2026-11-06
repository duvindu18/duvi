"""Entry point for the packaged app (ArchVizSEO.exe).

Starts the local web server on a free port, opens the browser, and keeps running
until the console window is closed (or Ctrl+C).
"""

from __future__ import annotations

import sys
import threading
import time
import webbrowser

from . import web
from .paths import APP_NAME, data_dir, reports_dir

PREFERRED_PORTS = (8765, 8766, 8767, 0)


def _bind():
    for port in PREFERRED_PORTS:
        try:
            return web.serve("127.0.0.1", port)
        except OSError:
            continue
    raise RuntimeError("Could not open a local port.")


def main() -> None:
    no_browser = "--no-browser" in sys.argv
    httpd = _bind()
    url = f"http://127.0.0.1:{httpd.server_address[1]}/"
    threading.Thread(target=httpd.serve_forever, daemon=True).start()

    print(APP_NAME)
    print("=" * len(APP_NAME))
    print(f"Running at:     {url}")
    print(f"Reports folder: {reports_dir()}")
    print(f"Settings:       {data_dir()}")
    print("\nKeep this window open while you use the app. Close it to quit.\n", flush=True)
    if not no_browser:
        threading.Timer(0.6, webbrowser.open, args=(url,)).start()
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        httpd.shutdown()


if __name__ == "__main__":
    main()
