#!/usr/bin/env bash
# Packages the unsigned iOS build from `build-app.sh ... ios` as an .ipa.
#
#   safari/xcode/make-ipa.sh [derived-data-dir] [output.ipa]
#
# The .ipa is NOT signed: iOS only installs signed apps, so sign it while
# installing (Sideloadly or AltStore with your Apple ID, or your own
# certificate). Keep the app extension when the tool asks: it is the Safari
# extension itself.
set -euo pipefail

DERIVED="${1:-build/safari/dd}"
OUT="${2:-build/safari/Bypass-Paywalls-Clean-unsigned.ipa}"

APP="$(find "$DERIVED/Build/Products/Release-iphoneos" -maxdepth 1 -name '*.app' | head -1)"
if [ -z "$APP" ]; then
  echo "error: no iOS app in $DERIVED/Build/Products/Release-iphoneos, run 'safari/xcode/build-app.sh <project> ios' first" >&2
  exit 1
fi
APPEX="$(find "$APP/PlugIns" -maxdepth 1 -name '*.appex' | head -1)"
if [ -z "$APPEX" ]; then
  echo "error: $APP contains no app extension" >&2
  exit 1
fi
# iOS bundles are flat: the extension's files sit at the root of the .appex.
for f in manifest.json safari-compat.js background.js; do
  if [ ! -f "$APPEX/$f" ]; then
    echo "error: $f is missing from $APPEX" >&2
    exit 1
  fi
done
POINT="$(plutil -extract NSExtension.NSExtensionPointIdentifier raw "$APPEX/Info.plist")"
if [ "$POINT" != "com.apple.Safari.web-extension" ]; then
  echo "error: unexpected extension point $POINT" >&2
  exit 1
fi

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/Payload"
cp -R "$APP" "$STAGE/Payload/"
mkdir -p "$(dirname "$OUT")"
OUT_ABS="$(cd "$(dirname "$OUT")" && pwd)/$(basename "$OUT")"
rm -f "$OUT_ABS"
(cd "$STAGE" && zip -qry "$OUT_ABS" Payload)

echo "IPA: $OUT"
echo "  app:       $(basename "$APP") $(plutil -extract CFBundleShortVersionString raw "$APP/Info.plist") build $(plutil -extract CFBundleVersion raw "$APP/Info.plist") ($(plutil -extract CFBundleIdentifier raw "$APP/Info.plist"))"
echo "  extension: $(basename "$APPEX") ($(plutil -extract CFBundleIdentifier raw "$APPEX/Info.plist"))"
echo "  minimum iOS: $(plutil -extract MinimumOSVersion raw "$APP/Info.plist")"
echo "  size: $(du -h "$OUT_ABS" | cut -f1)"
