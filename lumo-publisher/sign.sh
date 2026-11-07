#!/usr/bin/env bash
# Sign Windows executables on Linux / macOS with your lumo publisher (Authenticode SHA-256 + RFC 3161 timestamp).
# Needs osslsigncode (free: apt install osslsigncode / brew install osslsigncode).
#
#   LUMO_SIGN_PASSWORD=... ./sign.sh dist/lumo-materials.exe dist/lumo-materials-setup.exe
#
# Options (environment):
#   LUMO_PUBLISHER_DIR   folder with publisher.json (default: ./publisher next to this script)
#   LUMO_SIGN_PASSWORD   password of the signing .pfx (asked if unset)
#   LUMO_SIGN_NAME       description stored in the signature (default: publisher name)
#   LUMO_SIGN_URL        URL stored in the signature (optional)
#   LUMO_NO_TIMESTAMP=1  sign without timestamp (signature then ends when the certificate expires)
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
pubdir="${LUMO_PUBLISHER_DIR:-$here/publisher}"
json="$pubdir/publisher.json"

command -v osslsigncode >/dev/null || { echo "osslsigncode is not installed (apt install osslsigncode / brew install osslsigncode)" >&2; exit 1; }
[ -f "$json" ] || { echo "No $json. Run make_publisher.py or New-LumoPublisher.ps1 first." >&2; exit 1; }
[ "$#" -gt 0 ] || { echo "usage: $0 FILE.exe [FILE.dll ...]" >&2; exit 1; }

jget() { python3 -c 'import json,sys; d=json.load(open(sys.argv[1]));
for k in sys.argv[2].split("."): d=d[k]
print(d)' "$json" "$1"; }

pfx="$pubdir/$(jget files.codesign_pfx)"
rootcer="$pubdir/$(jget files.root_cer)"
name="${LUMO_SIGN_NAME:-$(jget publisher)}"
[ -f "$pfx" ] || { echo "Signing certificate missing: $pfx" >&2; exit 1; }

if [ -z "${LUMO_SIGN_PASSWORD:-}" ]; then
  read -r -s -p "Password for $(basename "$pfx"): " LUMO_SIGN_PASSWORD; echo
fi

work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
chmod 700 "$work"
printf '%s' "$LUMO_SIGN_PASSWORD" > "$work/pass"; chmod 600 "$work/pass"
openssl x509 -inform DER -in "$rootcer" -out "$work/root.pem"

servers=(http://timestamp.digicert.com http://timestamp.sectigo.com http://timestamp.globalsign.com/tsa/r6advanced1)
failed=0
for f in "$@"; do
  if [ ! -f "$f" ]; then echo "FAILED  $f (not found)" >&2; failed=$((failed+1)); continue; fi
  out="$work/signed.bin"; ok=0
  base=(osslsigncode sign -pkcs12 "$pfx" -readpass "$work/pass" -h sha256 -n "$name" -in "$f" -out "$out")
  [ -n "${LUMO_SIGN_URL:-}" ] && base+=(-i "$LUMO_SIGN_URL")
  if [ "${LUMO_NO_TIMESTAMP:-0}" = "1" ]; then
    rm -f "$out"; "${base[@]}" >/dev/null && ok=1
  else
    for ts in "${servers[@]}"; do
      rm -f "$out"
      if "${base[@]}" -ts "$ts" >/dev/null 2>"$work/err"; then ok=1; break; fi
      echo "  timestamp server $ts failed, trying the next one ..." >&2
    done
  fi
  if [ "$ok" != 1 ]; then echo "FAILED  $f"; cat "$work/err" 2>/dev/null >&2 || true; failed=$((failed+1)); continue; fi
  if osslsigncode verify -CAfile "$work/root.pem" -in "$out" >"$work/verify" 2>&1; then
    mv -f "$out" "$f"; echo "OK      $f"
  else
    echo "FAILED  $f (verification)"; sed 's/^/        /' "$work/verify" >&2; failed=$((failed+1))
  fi
done
[ "$failed" -eq 0 ] || { echo "$failed file(s) failed." >&2; exit 1; }
