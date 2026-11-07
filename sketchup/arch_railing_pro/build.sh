#!/usr/bin/env bash
# Packages src/ into release/ArchRailingPro_v<version>.rbz (an .rbz is a zip).
set -euo pipefail
cd "$(dirname "$0")"
VERSION=$(ruby -ne 'puts $1 if /VERSION\s*=\s*.([0-9.]+)/' src/arch_railing_pro.rb)
OUT="release/ArchRailingPro_v${VERSION}.rbz"
mkdir -p release
rm -f "$OUT"
(cd src && zip -r -X -q "../$OUT" arch_railing_pro.rb arch_railing_pro -x '*.DS_Store')
echo "Built $OUT"
unzip -l "$OUT" | tail -1
