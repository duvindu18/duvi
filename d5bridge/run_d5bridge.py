"""Launcher used by PyInstaller and for running from source: python run_d5bridge.py"""
from d5bridge.main import main

if __name__ == "__main__":
    raise SystemExit(main())
