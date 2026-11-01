#!/usr/bin/env bash
# Wraps the Safari extension folder in an Xcode project (macOS + iOS app)
# using Apple's converter from Xcode.
#
#   safari/xcode/convert.sh [extension-dir] [project-dir]
#
# Defaults: build/safari/extension -> build/safari/xcode
# APP_NAME and BUNDLE_ID can be overridden through the environment.
set -euo pipefail

EXT_DIR="${1:-build/safari/extension}"
OUT_DIR="${2:-build/safari/xcode}"
APP_NAME="${APP_NAME:-Bypass Paywalls Clean}"
BUNDLE_ID="${BUNDLE_ID:-io.github.aavalon-sys.bypass-paywalls-clean}"

if [ ! -f "$EXT_DIR/manifest.json" ]; then
  echo "error: $EXT_DIR/manifest.json not found, run 'node safari/build.mjs' first" >&2
  exit 1
fi

TOOL=""
for candidate in safari-web-extension-converter safari-web-extension-packager; do
  if xcrun --find "$candidate" >/dev/null 2>&1; then
    TOOL="$candidate"
    break
  fi
done
if [ -z "$TOOL" ]; then
  echo "error: Xcode's safari-web-extension-converter was not found (install Xcode and run xcode-select)" >&2
  exit 1
fi

# Only pass the optional flags this Xcode version knows about.
HELP="$(xcrun "$TOOL" --help 2>&1 || true)"
ARGS=(--project-location "$OUT_DIR" --app-name "$APP_NAME" --bundle-identifier "$BUNDLE_ID")
for flag in --swift --copy-resources --no-open --no-prompt --force; do
  if grep -q -- "$flag" <<<"$HELP"; then ARGS+=("$flag"); fi
done

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"
echo "+ xcrun $TOOL $EXT_DIR ${ARGS[*]}"
xcrun "$TOOL" "$EXT_DIR" "${ARGS[@]}" </dev/null

PROJECT="$(find "$OUT_DIR" -maxdepth 3 -name '*.xcodeproj' | head -1)"
if [ -z "$PROJECT" ]; then
  echo "error: no Xcode project was generated in $OUT_DIR" >&2
  exit 1
fi
echo "Xcode project: $PROJECT"
