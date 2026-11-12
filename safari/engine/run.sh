#!/usr/bin/env bash
# Runs the Safari build of the extension in WebKit's real web-extension engine
# (the WKWebExtension API that Safari is built on) against local stand-ins for
# a few supported sites, and reports what really happened: which request
# headers were sent, which scripts were blocked, whether content scripts ran.
#
#   safari/engine/run.sh [output-dir]
#
# Needs macOS 15.4 or later with the Xcode command line tools, Node.js, and
# sudo (it adds test host names to /etc/hosts and serves them on ports 80/443).
# Meant for CI (.github/workflows/safari-engine.yml); think twice before
# running it on your own Mac, since the /etc/hosts entries hide the real sites
# until you remove them again (the script prints the command).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="${1:-$ROOT/build/safari/engine}"
EXT="$ROOT/build/safari/extension"
HOSTS=(www.washingtonpost.com www.nytimes.com www.ft.com www.wsj.com www.hola.com www.bpc-control.test)
MARK="# bpc-engine-test"

cd "$ROOT"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"

echo "== Building the extension"
node safari/build.mjs

echo "== Certificate for the local test sites"
SAN="$(printf 'DNS:%s,' "${HOSTS[@]}")"
cat > "$OUT/openssl.cnf" <<EOF
[req]
distinguished_name = dn
x509_extensions = v3
prompt = no
[dn]
CN = bpc-engine-test
[v3]
subjectAltName = ${SAN%,}
basicConstraints = CA:FALSE
EOF
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -keyout "$OUT/key.pem" -out "$OUT/cert.pem" -config "$OUT/openssl.cnf" 2>/dev/null

echo "== Mapping the test host names to this machine"
for host in "${HOSTS[@]}"; do
  if ! grep -q "[[:space:]]$host[[:space:]]" /etc/hosts; then
    echo "127.0.0.1 $host $MARK" | sudo tee -a /etc/hosts >/dev/null
  fi
done
sudo dscacheutil -flushcache 2>/dev/null || true
sudo killall -HUP mDNSResponder 2>/dev/null || true
echo "   (undo with: sudo sed -i '' '/$MARK/d' /etc/hosts)"

echo "== Compiling the WebKit host"
cat > "$OUT/Info.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>io.github.aavalon-sys.bpc-webkit-host</string>
  <key>CFBundleName</key>
  <string>bpc-webkit-host</string>
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsArbitraryLoads</key>
    <true/>
  </dict>
</dict>
</plist>
EOF
xcrun clang -fobjc-arc -fmodules -mmacosx-version-min=15.4 \
  -framework Cocoa -framework WebKit \
  -Wl,-sectcreate,__TEXT,__info_plist,"$OUT/Info.plist" \
  safari/engine/host.m -o "$OUT/bpc-webkit-host"

SERVER_PID=""
stop_server() {
  if [ -n "$SERVER_PID" ]; then
    sudo kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
    SERVER_PID=""
  fi
}
trap stop_server EXIT

# run_scenario <name> <host arguments...>
run_scenario() {
  local name="$1"
  shift
  echo "== Scenario: $name"
  sudo node safari/engine/server.mjs --cert "$OUT/cert.pem" --key "$OUT/key.pem" --log "$OUT/$name.requests.jsonl" > "$OUT/$name.server.log" 2>&1 &
  SERVER_PID=$!
  local ready=""
  for _ in $(seq 1 50); do
    if curl -sk -o /dev/null "https://www.bpc-control.test/ready"; then
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
  sudo sh -c ": > '$OUT/$name.requests.jsonl'"
  local status=0
  "$OUT/bpc-webkit-host" --extension "$EXT" --out "$OUT/$name.json" "$@" 2> "$OUT/$name.host.log" || status=$?
  echo "   host exit status: $status"
  stop_server
}

URLS=()
for host in "${HOSTS[@]}"; do
  URLS+=(--url "https://$host/test/article.html")
done

# The user has just enabled the extension and allowed every website.
run_scenario enabled --load-delay 6 --grant all "${URLS[@]}"
# The extension is loaded while the browser starts (WebKit sends no install event then).
run_scenario launch --load-delay 0 --grant all --url "https://www.washingtonpost.com/test/article.html" --url "https://www.hola.com/test/article.html"
# No website access was granted.
run_scenario noaccess --load-delay 6 --grant none --url "https://www.washingtonpost.com/test/article.html" --url "https://www.hola.com/test/article.html"

echo "== Report"
node safari/engine/report.mjs "$OUT"
