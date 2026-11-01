"""Authenticode-sign one file in place (called by makensis via !finalize).

Windows only trusts a signature from a certificate issued by a public code
signing CA, so the certificate itself has to be obtained by the publisher.
Configure ONE of these before running build_installer.py:

  Azure Trusted Signing (cheapest, no hardware token; Windows build machine):
    VEIL_SIGN_AZURE_DLIB      path to Azure.CodeSigning.Dlib.dll
    VEIL_SIGN_AZURE_METADATA  path to metadata.json (endpoint, account, profile)

  A code signing certificate as a .pfx file (OV certificate from a CA):
    VEIL_SIGN_PFX             path to the .pfx
    VEIL_SIGN_PASSWORD        its password

  A certificate in the Windows certificate store / on a USB token:
    VEIL_SIGN_THUMBPRINT      SHA-1 thumbprint of the certificate

Optional: VEIL_SIGN_TIMESTAMP (RFC 3161 URL, default DigiCert; "none" skips it,
for test certificates only - without a timestamp signatures expire with the certificate).
signtool.exe (Windows SDK) is used on Windows, osslsigncode elsewhere (pfx only).
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

TIMESTAMP = os.environ.get("VEIL_SIGN_TIMESTAMP", "http://timestamp.digicert.com")
DESCRIPTION = "Veil"
URL = "https://github.com/duvindu18/duvi"


def configured() -> bool:
    return any(os.environ.get(k) for k in ("VEIL_SIGN_PFX", "VEIL_SIGN_THUMBPRINT", "VEIL_SIGN_AZURE_DLIB"))


def _signtool() -> str | None:
    found = shutil.which("signtool")
    if found:
        return found
    kits = Path(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")) / "Windows Kits" / "10" / "bin"
    candidates = sorted(kits.glob("*/x64/signtool.exe"), reverse=True) if kits.is_dir() else []
    return str(candidates[0]) if candidates else None


def sign(path: Path) -> None:
    env = os.environ
    signtool = _signtool() if sys.platform == "win32" else None
    if signtool:
        cmd = [signtool, "sign", "/fd", "SHA256", "/d", DESCRIPTION, "/du", URL]
        if TIMESTAMP != "none":
            cmd += ["/tr", TIMESTAMP, "/td", "SHA256"]
        if env.get("VEIL_SIGN_AZURE_DLIB"):
            cmd += ["/dlib", env["VEIL_SIGN_AZURE_DLIB"], "/dmdf", env["VEIL_SIGN_AZURE_METADATA"]]
        elif env.get("VEIL_SIGN_PFX"):
            cmd += ["/f", env["VEIL_SIGN_PFX"], "/p", env.get("VEIL_SIGN_PASSWORD", "")]
        else:
            cmd += ["/sha1", env["VEIL_SIGN_THUMBPRINT"]]
        subprocess.run(cmd + [str(path)], check=True)
        return
    if not env.get("VEIL_SIGN_PFX"):
        sys.exit("sign.py: outside Windows only VEIL_SIGN_PFX (with osslsigncode) is supported")
    tool = shutil.which("osslsigncode") or sys.exit("sign.py: osslsigncode not found (apt install osslsigncode)")
    signed = path.with_suffix(path.suffix + ".signed")
    subprocess.run(
        [tool, "sign", "-pkcs12", env["VEIL_SIGN_PFX"], "-pass", env.get("VEIL_SIGN_PASSWORD", ""),
         "-n", DESCRIPTION, "-i", URL, "-h", "sha256",
         *([] if TIMESTAMP == "none" else ["-ts", TIMESTAMP]), "-in", str(path), "-out", str(signed)],
        check=True,
    )
    os.replace(signed, path)


if __name__ == "__main__":
    sign(Path(sys.argv[1]))
