#!/usr/bin/env bash
# Creates the Google Play upload key and android/keystore.properties.
# Run once, on your own computer:  bash scripts/make-upload-key.sh
# Needs keytool (comes with any JDK 17+, or Android Studio's bundled JBR).
set -euo pipefail
cd "$(dirname "$0")/.."

KEY_DIR="${KEY_DIR:-$HOME/cadview-keys}"
KEYSTORE="$KEY_DIR/cadview-upload.jks"
ALIAS="cadview-upload"
PROPS="android/keystore.properties"

if [ -f "$KEYSTORE" ]; then
  echo "A key already exists at $KEYSTORE. Not overwriting it."
  exit 1
fi
command -v keytool >/dev/null || { echo "keytool not found. Install a JDK 17+ or use Android Studio's (…/jbr/bin/keytool)."; exit 1; }

mkdir -p "$KEY_DIR"
read -rsp "Choose a keystore password (min 6 characters): " PASS; echo
read -rsp "Repeat it: " PASS2; echo
[ "$PASS" = "$PASS2" ] || { echo "Passwords don't match."; exit 1; }
[ ${#PASS} -ge 6 ] || { echo "Too short."; exit 1; }
read -rp "Your name or company (shown in the certificate): " CN

keytool -genkeypair -v \
  -keystore "$KEYSTORE" -alias "$ALIAS" \
  -keyalg RSA -keysize 4096 -validity 10000 \
  -storepass "$PASS" -keypass "$PASS" \
  -dname "CN=${CN:-CADView}"

cat > "$PROPS" <<EOF
storeFile=$KEYSTORE
storePassword=$PASS
keyAlias=$ALIAS
keyPassword=$PASS
EOF
chmod 600 "$PROPS" "$KEYSTORE"

echo
echo "Done."
echo "  Key:        $KEYSTORE"
echo "  Settings:   $PROPS (git-ignored, never commit it)"
echo
echo "Back up the .jks file and the password somewhere safe (a password manager plus an offline copy)."
echo "Google keeps the real app signing key (Play App Signing); this is only your upload key."
echo "If you lose it, the Play Console can reset it, but that takes a support request and a few days."
