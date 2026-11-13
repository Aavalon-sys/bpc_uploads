#!/usr/bin/env bash
# Runs the Safari build of the extension in WebKit's real web-extension engine
# (the WKWebExtension API that Safari is built on) against local stand-ins for
# a few supported sites, and reports what really happened: which request
# headers were sent, which scripts were blocked, whether content scripts ran.
#
#   safari/engine/run.sh [output-dir]
#
# Needs macOS 15.4 or later with the Xcode command line tools and Node.js.
# The test pages are served by a local proxy (safari/engine/server.mjs) that
# only the test's own web views use, so the real sites are never contacted.
#
# Some of the test hosts are on the system's HSTS preload list, where a
# self-signed certificate cannot be accepted. With BPC_ENGINE_TRUST_CERT=1 (set
# in CI) the test certificate is added to the System keychain for the duration
# of the run, which needs sudo; without it those hosts are left out and
# nothing on the machine is changed. Used by .github/workflows/safari-engine.yml.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="${1:-$ROOT/build/safari/engine}"
EXT="$ROOT/build/safari/extension"
HOSTS=(www.washingtonpost.com www.hola.com www.bpc-control.test)
HSTS_HOSTS=(www.nytimes.com www.ft.com www.wsj.com hbr.org)
CERT_NAME=bpc-engine-test
HTTPS_PORT=18443
PROXY_PORT=18080

cd "$ROOT"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"

echo "== Building the extension"
node safari/build.mjs

echo "== Certificate for the local test sites"
SAN="$(printf 'DNS:%s,' "${HOSTS[@]}" "${HSTS_HOSTS[@]}")"
{
  echo "[req]"
  echo "distinguished_name = dn"
  echo "x509_extensions = v3"
  echo "prompt = no"
  echo "[dn]"
  echo "CN = $CERT_NAME"
  echo "[v3]"
  echo "subjectAltName = ${SAN%,}"
  echo "basicConstraints = CA:FALSE"
  echo "keyUsage = digitalSignature, keyEncipherment"
  echo "extendedKeyUsage = serverAuth"
} > "$OUT/openssl.cnf"
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -keyout "$OUT/key.pem" -out "$OUT/cert.pem" -config "$OUT/openssl.cnf" 2>/dev/null

CERT_TRUSTED=""
untrust_cert() {
  if [ -n "$CERT_TRUSTED" ]; then
    sudo security delete-certificate -c "$CERT_NAME" /Library/Keychains/System.keychain >/dev/null 2>&1 || true
    CERT_TRUSTED=""
  fi
}
if [ "${BPC_ENGINE_TRUST_CERT:-}" = "1" ]; then
  echo "== Trusting the test certificate for this run (HSTS hosts)"
  sudo security authorizationdb write com.apple.trust-settings.admin allow >/dev/null 2>&1 || true
  if sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain "$OUT/cert.pem"; then
    CERT_TRUSTED=1
    HOSTS=("${HOSTS[0]}" "${HSTS_HOSTS[@]}" "${HOSTS[@]:1}")
  else
    echo "   could not trust the certificate; leaving out ${HSTS_HOSTS[*]}"
  fi
fi

echo "== Compiling the WebKit host"
{
  echo '<?xml version="1.0" encoding="UTF-8"?>'
  echo '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
  echo '<plist version="1.0">'
  echo '<dict>'
  echo '  <key>CFBundleIdentifier</key>'
  echo '  <string>io.github.aavalon-sys.bpc-webkit-host</string>'
  echo '  <key>CFBundleName</key>'
  echo '  <string>bpc-webkit-host</string>'
  echo '  <key>NSAppTransportSecurity</key>'
  echo '  <dict>'
  echo '    <key>NSAllowsArbitraryLoads</key>'
  echo '    <true/>'
  echo '  </dict>'
  echo '</dict>'
  echo '</plist>'
} > "$OUT/Info.plist"
xcrun clang -fobjc-arc -fmodules -mmacosx-version-min=15.4 \
  -framework Cocoa -framework Network -framework WebKit \
  -Wl,-sectcreate,__TEXT,__info_plist,"$OUT/Info.plist" \
  safari/engine/host.m -o "$OUT/bpc-webkit-host"

# The Safari version of this machine, for a Safari-like browser identity.
SAFARI_VERSION="${SAFARI_VERSION:-$(defaults read /Applications/Safari.app/Contents/Info CFBundleShortVersionString 2>/dev/null || echo 18.6)}"
echo "   Safari version presented to the extension: $SAFARI_VERSION"

SERVER_PID=""
stop_server() {
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
    SERVER_PID=""
  fi
}
cleanup() {
  stop_server
  untrust_cert
}
trap cleanup EXIT

# Extra environment for the host process (see the staged Safari frameworks below).
HOST_ENV=()

# run_scenario <name> <host arguments...>
run_scenario() {
  local name="$1"
  shift
  echo "== Scenario: $name"
  node safari/engine/server.mjs --cert "$OUT/cert.pem" --key "$OUT/key.pem" --log "$OUT/$name.requests.jsonl" \
    --https-port "$HTTPS_PORT" --proxy-port "$PROXY_PORT" > "$OUT/$name.server.log" 2>&1 &
  SERVER_PID=$!
  local ready=""
  for _ in $(seq 1 50); do
    if curl -sk -o /dev/null -x "http://127.0.0.1:$PROXY_PORT" "https://www.bpc-control.test/ready"; then
      ready=1
      break
    fi
    sleep 0.2
  done
  if [ -z "$ready" ]; then
    echo "error: the local test server did not start" >&2
    cat "$OUT/$name.server.log" >&2 || true
    exit 1
  fi
  # Start from an empty log (the readiness check above is in it).
  : > "$OUT/$name.requests.jsonl"
  local status=0
  env ${HOST_ENV[@]+"${HOST_ENV[@]}"} "$OUT/bpc-webkit-host" --extension "$EXT" --out "$OUT/$name.json" --proxy "127.0.0.1:$PROXY_PORT" "$@" 2> "$OUT/$name.host.log" || status=$?
  echo "   host exit status: $status"
  stop_server
}

URLS=()
for host in "${HOSTS[@]}"; do
  URLS+=(--url "https://$host/test/article.html")
done
FEW=(--url "https://www.washingtonpost.com/test/article.html" --url "https://www.hola.com/test/article.html")

# The user has just enabled the extension and allowed every website.
run_scenario enabled --safari-version "$SAFARI_VERSION" --load-delay 6 --grant all "${URLS[@]}"
# The same with the browser identity of a Safari before 18.4 (older rule syntax).
run_scenario legacy --safari-version 17.6 --load-delay 6 --grant all "${FEW[@]}"
# The extension is loaded while the browser starts (WebKit sends no install event then).
run_scenario launch --safari-version "$SAFARI_VERSION" --load-delay 0 --grant all "${FEW[@]}"
# The background page was unloaded for lack of events and a page load wakes it up.
run_scenario idle --safari-version "$SAFARI_VERSION" --load-delay 6 --grant all --idle 40 "${FEW[@]}"
# No website access was granted.
run_scenario noaccess --safari-version "$SAFARI_VERSION" --load-delay 6 --grant none "${FEW[@]}"
# A Private Browsing window (extensions are off there unless the user allows it).
run_scenario private --safari-version "$SAFARI_VERSION" --load-delay 6 --grant all --private "${FEW[@]}"

# A Safari newer than the system ships its own, newer WebKit ("staged
# frameworks"). When there is one, repeat the two main scenarios with it, so
# that both the system engine and the engine of the installed Safari are tested.
STAGED=""
for dir in /System/Cryptexes/App/System/Library/StagedFrameworks/Safari \
           /System/Volumes/Preboot/Cryptexes/App/System/Library/StagedFrameworks/Safari \
           /Library/Apple/System/Library/StagedFrameworks/Safari; do
  if [ -d "$dir/WebKit.framework" ]; then
    STAGED="$dir"
    break
  fi
done
if [ -n "$STAGED" ] && [ "${BPC_ENGINE_SKIP_STAGED:-}" != "1" ]; then
  echo "== Staged Safari frameworks: $STAGED"
  HOST_ENV=("DYLD_FRAMEWORK_PATH=$STAGED" "DYLD_LIBRARY_PATH=$STAGED" "__XPC_DYLD_FRAMEWORK_PATH=$STAGED" "__XPC_DYLD_LIBRARY_PATH=$STAGED")
  run_scenario staged-enabled --safari-version "$SAFARI_VERSION" --load-delay 6 --grant all "${URLS[@]}"
  run_scenario staged-launch --safari-version "$SAFARI_VERSION" --load-delay 0 --grant all "${FEW[@]}"
  HOST_ENV=()
else
  echo "== No staged Safari frameworks on this machine (Safari uses the system WebKit)"
fi

echo "== Report"
node safari/engine/report.mjs "$OUT"
