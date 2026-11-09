#!/usr/bin/env bash
# Shared transport: ignore curlrc, verify TLS and bound every request. Do not
# retry mutations: a timed-out POST may already have committed on the server.
smoke_curl_args=(--disable --silent --show-error --connect-timeout 10 --max-time 30)
if [ -n "${SMOKE_CA_CERT:-}" ]; then
  smoke_curl_args+=(--cacert "$SMOKE_CA_CERT")
fi

smoke_http() {
  curl "${smoke_curl_args[@]}" "$@"
}

smoke_json() {
  node -e 'const args=process.argv.slice(1), data={}; for(let i=0;i<args.length;i+=2) data[args[i]]=args[i+1]; process.stdout.write(JSON.stringify(data));' "$@"
}
