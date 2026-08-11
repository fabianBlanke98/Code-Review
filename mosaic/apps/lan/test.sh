#!/usr/bin/env bash
set -euo pipefail
# End-to-end checks for the LAN server. Boots it on a spare port, drives the
# whole flow with curl, tears everything down. No browser needed.
#
#   ./apps/lan/test.sh
BASE="http://127.0.0.1:8788"
export MOSAIC_DATA=$(mktemp -d)
# Plain http for the API checks so curl needs no certificate handling; the
# https path gets its own check at the end.
MOSAIC_HTTP=1 PORT=8788 node apps/lan/server.mjs >/tmp/lan.log 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null || true; rm -rf "$MOSAIC_DATA"' EXIT
for i in $(seq 1 40); do curl -sf "$BASE/" >/dev/null 2>&1 && break; sleep 0.25; done

ok(){ printf '  ok   %s\n' "$1"; }
bad(){ printf '  FAIL %s\n' "$1"; exit 1; }

curl -sf "$BASE/" | grep -q "Eén film, samen" && ok "page served" || bad "page"

# The camera must live inside the app. A regression here is invisible in the
# API but is the whole difference between "it stops by itself" and "my own
# camera app opened and kept rolling".
PAGE=$(curl -sf "$BASE/")
echo "$PAGE" | grep -q 'id="shutter"' && ok "viewfinder has an in-app shutter" || bad "no shutter"
echo "$PAGE" | grep -q 'id="preview"' && ok "viewfinder shows a live preview" || bad "no preview"
echo "$PAGE" | grep -q 'id="denied"' && ok "blocked camera is explained, not silently handed off" || bad "no denial panel"
echo "$PAGE" | grep -q 'getTracks().forEach' && ok "camera tracks are released after a take" || bad "camera never released"

CODE=$(curl -sf -X POST "$BASE/api/groups" -H 'content-type: application/json' \
  -d '{"title":"Kreta 2026","clipSeconds":2}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).code')
[ ${#CODE} -eq 6 ] && ok "group created ($CODE)" || bad "group create"

curl -sf "$BASE/api/groups/$CODE" | grep -q '"clipSeconds":2' && ok "clip length stored" || bad "clipSeconds"

head -c 5000 /dev/urandom > /tmp/fake.mp4
add(){ curl -sf -X POST "$BASE/api/groups/$CODE/clips?author=$1&durationMs=2000" \
         -H 'content-type: video/mp4' --data-binary @/tmp/fake.mp4 \
       | node -pe 'JSON.parse(require("fs").readFileSync(0)).id'; }

A1=$(add Fabian); A2=$(add Sanne); A3=$(add Fabian)
ORDER=$(curl -sf "$BASE/api/groups/$CODE" | node -pe '
  JSON.parse(require("fs").readFileSync(0)).clips.map(c=>c.author).join(",")')
[ "$ORDER" = "Fabian,Sanne,Fabian" ] && ok "append order preserved: $ORDER" || bad "order was $ORDER"

SEQ=$(curl -sf "$BASE/api/groups/$CODE" | node -pe '
  JSON.parse(require("fs").readFileSync(0)).clips.map(c=>c.sequence).join(",")')
[ "$SEQ" = "1,2,3" ] && ok "server assigns sequence: $SEQ" || bad "sequence was $SEQ"

curl -sf "$BASE/api/groups/$CODE/clips/$A2/media?r=1" -o /tmp/back.mp4
cmp -s /tmp/fake.mp4 /tmp/back.mp4 && ok "media round-trips byte-for-byte" || bad "media mismatch"

CODE_RESP=$(curl -s -o /dev/null -w '%{http_code}' -X POST \
  "$BASE/api/groups/$CODE/clips/$A2/replace?author=Fabian" \
  -H 'content-type: video/mp4' --data-binary @/tmp/fake.mp4)
[ "$CODE_RESP" = "403" ] && ok "cannot replace someone else's clip (403)" || bad "replace authz $CODE_RESP"

head -c 7000 /dev/urandom > /tmp/fake2.mp4
REV=$(curl -sf -X POST "$BASE/api/groups/$CODE/clips/$A2/replace?author=Sanne" \
  -H 'content-type: video/mp4' --data-binary @/tmp/fake2.mp4 \
  | node -pe 'JSON.parse(require("fs").readFileSync(0)).revision')
[ "$REV" = "2" ] && ok "author can replace, revision -> 2" || bad "revision $REV"

ORDER2=$(curl -sf "$BASE/api/groups/$CODE" | node -pe '
  JSON.parse(require("fs").readFileSync(0)).clips.map(c=>c.author).join(",")')
[ "$ORDER2" = "Fabian,Sanne,Fabian" ] && ok "replacement kept its slot" || bad "slot moved: $ORDER2"

curl -sf "$BASE/api/groups/$CODE/clips/$A2/media?r=2" -o /tmp/back2.mp4
cmp -s /tmp/fake2.mp4 /tmp/back2.mp4 && ok "replacement serves the new take" || bad "stale media"

DEL=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE \
  "$BASE/api/groups/$CODE/clips/$A1?author=Sanne")
[ "$DEL" = "403" ] && ok "cannot delete someone else's clip (403)" || bad "delete authz $DEL"

curl -sf -X DELETE "$BASE/api/groups/$CODE/clips/$A1?author=Fabian" >/dev/null
LEFT=$(curl -sf "$BASE/api/groups/$CODE" | node -pe '
  JSON.parse(require("fs").readFileSync(0)).clips.length')
[ "$LEFT" = "2" ] && ok "author can delete their own clip" || bad "left $LEFT"

FILM=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/groups/$CODE/film")
[ "$FILM" = "501" ] && ok "no ffmpeg here -> honest 501, not a crash" || bad "film status $FILM"

MISS=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/groups/ZZZZZZ")
[ "$MISS" = "404" ] && ok "unknown group -> 404" || bad "missing group $MISS"

timeout 3 curl -sN "$BASE/api/groups/$CODE/events" > /tmp/sse.txt 2>/dev/null || true
grep -q '"code"' /tmp/sse.txt && ok "SSE stream sends the group on connect" || bad "sse"

# A second viewer must see a new clip arrive without asking for it.
( timeout 4 curl -sN "$BASE/api/groups/$CODE/events" > /tmp/sse2.txt 2>/dev/null || true ) &
SSEPID=$!
sleep 1
add Joris >/dev/null
wait $SSEPID
[ "$(grep -c '^data: ' /tmp/sse2.txt)" -ge 2 ] && ok "live push reaches a second viewer" || bad "no live push"

# --- https: without it a phone will not let the page use its camera, and the
# recording cannot stop by itself.
if command -v openssl >/dev/null 2>&1; then
  MOSAIC_DATA=$(mktemp -d) PORT=8790 node apps/lan/server.mjs >/tmp/lan-tls.log 2>&1 &
  TLS=$!
  for i in $(seq 1 40); do curl -skf "https://127.0.0.1:8790/" >/dev/null 2>&1 && break; sleep 0.25; done
  curl -skf "https://127.0.0.1:8790/" | grep -q "Eén film, samen" \
    && ok "https serves the page (camera allowed, recording self-stops)" || bad "https"
  grep -q "certificaat" /tmp/lan-tls.log && ok "startup explains the certificate warning" || bad "tls notice"
  kill $TLS 2>/dev/null || true
else
  printf '  skip openssl absent — https path not exercised\n'
fi

echo "  --- all LAN server checks passed ---"
