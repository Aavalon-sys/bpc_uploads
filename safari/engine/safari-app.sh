#!/usr/bin/env bash
# Runs the Safari build of the extension in the real Safari app, driven by
# safaridriver, against the local stand-in sites of the engine test.
#
#   safari/engine/safari-app.sh [output-dir]
#
# Needs macOS with Safari 18.4 or later, Node.js and sudo. It changes the
# machine for the duration of the run and puts it back afterwards:
#   - the test certificate is added to the System keychain (Safari has no way
#     to accept a self-signed certificate in a WebDriver session),
#   - every network service gets a proxy auto-configuration that sends only
#     the stand-in host names to the local proxy (Safari uses the system's
#     proxy settings; it cannot be given one of its own),
#   - Safari's remote automation is switched on (safaridriver --enable),
#   - Safari is quit and restarted, and its question about website access is
#     answered with "Always Allow" through the accessibility interface.
# Meant for a CI machine, not for the Mac you work on; see
# .github/workflows/safari-engine.yml.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="${1:-$ROOT/build/safari/app-test}"
EXT="$ROOT/build/safari/extension"
HOSTS=(www.washingtonpost.com www.nytimes.com www.ft.com www.wsj.com hbr.org www.hola.com www.bpc-control.test)
CERT_NAME=bpc-safari-app-test
HTTPS_PORT=18443
PROXY_PORT=18080

cd "$ROOT"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"

echo "== Building the extension"
node safari/build.mjs

echo "== Certificate for the local test sites"
SAN="$(printf 'DNS:%s,' "${HOSTS[@]}")"
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

SERVER_PID=""
CERT_TRUSTED=""
SERVICES=()
cleanup() {
  for service in ${SERVICES[@]+"${SERVICES[@]}"}; do
    sudo networksetup -setautoproxystate "$service" off >/dev/null 2>&1 || true
  done
  if [ -n "$CERT_TRUSTED" ]; then
    sudo security delete-certificate -c "$CERT_NAME" /Library/Keychains/System.keychain >/dev/null 2>&1 || true
  fi
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

echo "== Trusting the test certificate for this run"
sudo security authorizationdb write com.apple.trust-settings.admin allow >/dev/null 2>&1 || true
sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain "$OUT/cert.pem"
CERT_TRUSTED=1

echo "== Local stand-in sites"
node safari/engine/server.mjs --cert "$OUT/cert.pem" --key "$OUT/key.pem" --log "$OUT/safari-app.requests.jsonl" \
  --https-port "$HTTPS_PORT" --proxy-port "$PROXY_PORT" > "$OUT/safari-app.server.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 50); do
  if curl -s -o /dev/null --noproxy '*' "http://127.0.0.1:$PROXY_PORT/proxy.pac"; then break; fi
  sleep 0.2
done
curl -s --noproxy '*' "http://127.0.0.1:$PROXY_PORT/proxy.pac"

echo "== Sending the stand-in host names to the local proxy"
while IFS= read -r service; do
  case "$service" in
    "An asterisk"*|"*"*|"") continue ;;
  esac
  if sudo networksetup -setautoproxyurl "$service" "http://127.0.0.1:$PROXY_PORT/proxy.pac"; then
    SERVICES+=("$service")
    echo "   $service"
  fi
done < <(networksetup -listallnetworkservices)
# The system reads the configuration asynchronously.
sleep 3
: > "$OUT/safari-app.requests.jsonl"

echo "== Safari"
defaults read /Applications/Safari.app/Contents/Info CFBundleShortVersionString || true
sudo safaridriver --enable || true

URLS=()
for host in "${HOSTS[@]}"; do
  URLS+=(--url "https://$host/test/article.html")
done

# A second round after a pause: Safari unloads the extension's background page
# after 30 seconds without events, and the next page has to wake it up.
AGAIN=(--idle 40 --again "https://www.washingtonpost.com/test/article.html?visit=2" --again "https://www.hola.com/test/article.html?visit=2")

status=0
node safari/engine/safari-app.mjs --extension "$EXT" --out "$OUT/safari-app.json" "${URLS[@]}" "${AGAIN[@]}" 2>&1 | tee "$OUT/safari-app.host.log" || status=$?
echo "   exit status: $status"

echo "== Report"
node safari/engine/report.mjs "$OUT" --app
