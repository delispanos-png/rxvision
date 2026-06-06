#!/usr/bin/env bash
# Full-stack smoke test: drives the live stack through Caddy (self-signed TLS) and
# asserts every module endpoint + web route responds 200. One-command regression check.
#
#   bash scripts/smoke-test.sh            # against local Caddy (default)
#   APP_HOST=app.rxvision.gr bash scripts/smoke-test.sh
set -u

APP_HOST="${APP_HOST:-app.rxvision.gr}"
ADMIN_HOST="${ADMIN_HOST:-adminpanel.rxvision.gr}"
TARGET_IP="${TARGET_IP:-127.0.0.1}"
EMAIL="${EMAIL:-owner@example.com}"
PASSWORD="${PASSWORD:-ChangeMe-Demo-2026!}"
PADMIN_EMAIL="${PADMIN_EMAIL:-admin@example.com}"
PADMIN_PASS="${PADMIN_PASS:-ChangeMe-Admin-2026!}"

RES="--resolve ${APP_HOST}:443:${TARGET_IP} --resolve ${ADMIN_HOST}:443:${TARGET_IP}"
BASE="https://${APP_HOST}"
PASS=0; FAIL=0

FROM=$(python3 -c 'from datetime import datetime,timedelta,timezone;print((datetime.now(timezone.utc)-timedelta(days=80)).strftime("%Y-%m-%dT%H:%M:%SZ"))')
TO=$(python3 -c 'from datetime import datetime,timezone;print(datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))')
PERIOD=$(date +%Y-%m)
DR="date_from=${FROM}&date_to=${TO}"

say() { printf "%-46s %s\n" "$1" "$2"; }

# ── login ──────────────────────────────────────────────
TOK=$(curl -sk $RES "${BASE}/api/v1/auth/login" -H "Content-Type: application/json" \
  -d "{\"email\":\"${EMAIL}\",\"password\":\"${PASSWORD}\"}" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin).get("access_token",""))' 2>/dev/null)
if [ -z "$TOK" ]; then echo "FATAL: login failed"; exit 2; fi
echo "✓ login ok"
AUTH="-H Authorization:Bearer\ ${TOK}"

check() { # name  url
  local name="$1" url="$2"
  local code
  code=$(curl -sk $RES -o /dev/null -w '%{http_code}' -H "Authorization: Bearer ${TOK}" "$url")
  if [ "$code" = "200" ]; then PASS=$((PASS+1)); say "$name" "✓ 200";
  else FAIL=$((FAIL+1)); say "$name" "✗ $code"; fi
}
checkweb() { # name  host  path
  local name="$1" host="$2" path="$3" code
  code=$(curl -sk $RES -o /dev/null -w '%{http_code}' "https://${host}${path}")
  if [ "$code" = "200" ]; then PASS=$((PASS+1)); say "$name" "✓ 200";
  else FAIL=$((FAIL+1)); say "$name" "✗ $code"; fi
}

echo "── API endpoints ──────────────────────────────"
check "auth/me"                "${BASE}/api/v1/auth/me"
check "dashboard/summary"      "${BASE}/api/v1/dashboard/summary?${DR}"
check "dashboard/timeseries"   "${BASE}/api/v1/dashboard/timeseries?metric=value&grain=day&${DR}"
check "dashboard/top"          "${BASE}/api/v1/dashboard/top?dim=doctors&${DR}"
check "dashboard/heatmap"      "${BASE}/api/v1/dashboard/heatmap?metric=executions&${DR}"
check "prescriptions"          "${BASE}/api/v1/prescriptions?${DR}&page=1&page_size=5"
check "prescriptions/aggregate" "${BASE}/api/v1/prescriptions/aggregate?group_by=fund&${DR}"
check "doctors"                "${BASE}/api/v1/doctors?${DR}"
check "patients/aggregate"     "${BASE}/api/v1/patients/aggregate?by=age_group&${DR}"
check "patients/list"          "${BASE}/api/v1/patients/list?sort=value&${DR}"
check "icd10/aggregate"        "${BASE}/api/v1/icd10/aggregate?metric=count&${DR}"
check "icd10/hierarchy"        "${BASE}/api/v1/icd10/hierarchy?level=3&metric=value&${DR}"
check "profitability/summary"  "${BASE}/api/v1/profitability/summary?period=${PERIOD}"
check "profitability/low-margin" "${BASE}/api/v1/profitability/low-margin?threshold_pct=10"
check "profitability/aging"    "${BASE}/api/v1/profitability/aging"
check "prescriptions/unexecuted" "${BASE}/api/v1/prescriptions/unexecuted?${DR}"
check "future/upcoming"        "${BASE}/api/v1/future/upcoming?days=30"
check "future/upcoming+history" "${BASE}/api/v1/future/upcoming?days=30&min_history=2"
check "orders/suggestions"     "${BASE}/api/v1/orders/suggestions"
check "closing/control"        "${BASE}/api/v1/closing/${PERIOD}/control"
check "pharmacyone/sales"      "${BASE}/api/v1/pharmacyone/sales?${DR}"
check "pharmacyone/by-seller"  "${BASE}/api/v1/pharmacyone/by-seller?${DR}"
check "pharmacyone/by-user"    "${BASE}/api/v1/pharmacyone/by-user?${DR}"
check "pharmacyone/unexecuted" "${BASE}/api/v1/pharmacyone/unexecuted?${DR}"
check "subscription"           "${BASE}/api/v1/subscription"

echo "── Platform admin (CloudOn back-office) ───────"
# platform admin uses a SEPARATE identity (padmin token), never a tenant owner
PTOK=$(curl -sk $RES "${BASE}/api/v1/platform/auth/login" -H "Content-Type: application/json" \
  -d "{\"email\":\"${PADMIN_EMAIL}\",\"password\":\"${PADMIN_PASS}\"}" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin).get("access_token",""))' 2>/dev/null)
if [ -n "$PTOK" ]; then PASS=$((PASS+1)); say "platform/auth/login" "✓ ok"; else FAIL=$((FAIL+1)); say "platform/auth/login" "✗ no token"; fi
# admin endpoints require the platform token
pcode=$(curl -sk $RES -o /dev/null -w '%{http_code}' -H "Authorization: Bearer ${PTOK}" "${BASE}/api/v1/admin/tenants")
if [ "$pcode" = 200 ]; then PASS=$((PASS+1)); say "admin/tenants (padmin)" "✓ 200"; else FAIL=$((FAIL+1)); say "admin/tenants (padmin)" "✗ $pcode"; fi
pcode=$(curl -sk $RES -o /dev/null -w '%{http_code}' -H "Authorization: Bearer ${PTOK}" "${BASE}/api/v1/admin/sync-health")
if [ "$pcode" = 200 ]; then PASS=$((PASS+1)); say "admin/sync-health (padmin)" "✓ 200"; else FAIL=$((FAIL+1)); say "admin/sync-health (padmin)" "✗ $pcode"; fi
pcode=$(curl -sk $RES -o /dev/null -w '%{http_code}' -H "Authorization: Bearer ${PTOK}" "${BASE}/api/v1/admin/subscriptions")
if [ "$pcode" = 200 ]; then PASS=$((PASS+1)); say "admin/subscriptions (padmin)" "✓ 200"; else FAIL=$((FAIL+1)); say "admin/subscriptions (padmin)" "✗ $pcode"; fi
pcode=$(curl -sk $RES -o /dev/null -w '%{http_code}' -H "Authorization: Bearer ${PTOK}" "${BASE}/api/v1/admin/packages")
if [ "$pcode" = 200 ]; then PASS=$((PASS+1)); say "admin/packages (padmin)" "✓ 200"; else FAIL=$((FAIL+1)); say "admin/packages (padmin)" "✗ $pcode"; fi
pcode=$(curl -sk $RES -o /dev/null -w '%{http_code}' -H "Authorization: Bearer ${PTOK}" "${BASE}/api/v1/admin/idika")
if [ "$pcode" = 200 ]; then PASS=$((PASS+1)); say "admin/idika (padmin)" "✓ 200"; else FAIL=$((FAIL+1)); say "admin/idika (padmin)" "✗ $pcode"; fi
pcode=$(curl -sk $RES -o /dev/null -w '%{http_code}' -H "Authorization: Bearer ${PTOK}" "${BASE}/api/v1/admin/noeton")
if [ "$pcode" = 200 ]; then PASS=$((PASS+1)); say "admin/noeton (padmin)" "✓ 200"; else FAIL=$((FAIL+1)); say "admin/noeton (padmin)" "✗ $pcode"; fi

echo "── Noeton integration (inbound) ───────────────"
hcode=$(curl -sk $RES -o /dev/null -w '%{http_code}' "${BASE}/health")
if [ "$hcode" = 200 ]; then PASS=$((PASS+1)); say "Noeton /health" "✓ 200"; else FAIL=$((FAIL+1)); say "Noeton /health" "✗ $hcode"; fi
# REST push without X-API-Key must be rejected (401)
ncode=$(curl -sk $RES -o /dev/null -w '%{http_code}' -X POST "${BASE}/api/noeton/tenant/deactivate" -H "Content-Type: application/json" -d '{"tenant_code":"X"}')
if [ "$ncode" = 401 ]; then PASS=$((PASS+1)); say "Noeton push blocks no-key" "✓ 401"; else FAIL=$((FAIL+1)); say "Noeton push blocks no-key" "✗ $ncode"; fi
# webhook with bad signature must be rejected (401)
wcode=$(curl -sk $RES -o /dev/null -w '%{http_code}' -X POST "${BASE}/api/noeton/webhooks" -H "Content-Type: application/json" -H "X-Noeton-Signature: sha256=bad" -H "X-Timestamp: 0" -d '{"event_type":"ping"}')
if [ "$wcode" = 401 ]; then PASS=$((PASS+1)); say "Noeton webhook bad sig" "✓ 401"; else FAIL=$((FAIL+1)); say "Noeton webhook bad sig" "✗ $wcode"; fi
pcode=$(curl -sk $RES -o /dev/null -w '%{http_code}' -H "Authorization: Bearer ${PTOK}" "${BASE}/api/v1/admin/staff")
if [ "$pcode" = 200 ]; then PASS=$((PASS+1)); say "admin/staff (padmin)" "✓ 200"; else FAIL=$((FAIL+1)); say "admin/staff (padmin)" "✗ $pcode"; fi
pcode=$(curl -sk $RES -o /dev/null -w '%{http_code}' -H "Authorization: Bearer ${PTOK}" "${BASE}/api/v1/admin/billing")
if [ "$pcode" = 200 ]; then PASS=$((PASS+1)); say "admin/billing (padmin)" "✓ 200"; else FAIL=$((FAIL+1)); say "admin/billing (padmin)" "✗ $pcode"; fi
pcode=$(curl -sk $RES -o /dev/null -w '%{http_code}' -H "Authorization: Bearer ${PTOK}" "${BASE}/api/v1/admin/smtp")
if [ "$pcode" = 200 ]; then PASS=$((PASS+1)); say "admin/smtp (padmin)" "✓ 200"; else FAIL=$((FAIL+1)); say "admin/smtp (padmin)" "✗ $pcode"; fi
pcode=$(curl -sk $RES -o /dev/null -w '%{http_code}' -H "Authorization: Bearer ${PTOK}" "${BASE}/api/v1/admin/newsletter")
if [ "$pcode" = 200 ]; then PASS=$((PASS+1)); say "admin/newsletter (padmin)" "✓ 200"; else FAIL=$((FAIL+1)); say "admin/newsletter (padmin)" "✗ $pcode"; fi
pcode=$(curl -sk $RES -o /dev/null -w '%{http_code}' -H "Authorization: Bearer ${PTOK}" "${BASE}/api/v1/admin/health")
if [ "$pcode" = 200 ]; then PASS=$((PASS+1)); say "admin/health (padmin)" "✓ 200"; else FAIL=$((FAIL+1)); say "admin/health (padmin)" "✗ $pcode"; fi
pcode=$(curl -sk $RES -o /dev/null -w '%{http_code}' -H "Authorization: Bearer ${PTOK}" "${BASE}/api/v1/admin/posts?type=news")
if [ "$pcode" = 200 ]; then PASS=$((PASS+1)); say "admin/posts (padmin)" "✓ 200"; else FAIL=$((FAIL+1)); say "admin/posts (padmin)" "✗ $pcode"; fi
pcode=$(curl -sk $RES -o /dev/null -w '%{http_code}' -H "Authorization: Bearer ${PTOK}" "${BASE}/api/v1/admin/maintenance")
if [ "$pcode" = 200 ]; then PASS=$((PASS+1)); say "admin/maintenance (padmin)" "✓ 200"; else FAIL=$((FAIL+1)); say "admin/maintenance (padmin)" "✗ $pcode"; fi
pcode=$(curl -sk $RES -o /dev/null -w '%{http_code}' "${BASE}/api/v1/platform/status")
if [ "$pcode" = 200 ]; then PASS=$((PASS+1)); say "platform/status (public)" "✓ 200"; else FAIL=$((FAIL+1)); say "platform/status (public)" "✗ $pcode"; fi
# SECURITY: a tenant owner token must be REJECTED from the back-office
tcode=$(curl -sk $RES -o /dev/null -w '%{http_code}' -H "Authorization: Bearer ${TOK}" "${BASE}/api/v1/admin/tenants")
if [ "$tcode" = 403 ]; then PASS=$((PASS+1)); say "admin blocks tenant token" "✓ 403"; else FAIL=$((FAIL+1)); say "admin blocks tenant token" "✗ $tcode (leak!)"; fi

echo "── Ingestion (ΗΔΙΚΑ / GR) ─────────────────────"
# 1st sync: processes synthetic ΗΔΙΚΑ records (fetched>=1, idempotent re inserts)
S1=$(curl -sk $RES -X POST "${BASE}/api/v1/ingestion/hdika/sync" -H "Authorization: Bearer ${TOK}")
FET=$(echo "$S1" | python3 -c 'import sys,json;print(json.load(sys.stdin)["stats"]["fetched"])' 2>/dev/null || echo 0)
ST=$(echo "$S1"  | python3 -c 'import sys,json;print(json.load(sys.stdin)["status"])' 2>/dev/null || echo err)
if [ "${FET:-0}" -ge 1 ] && { [ "$ST" = success ] || [ "$ST" = partial ]; }; then
  PASS=$((PASS+1)); say "hdika sync #1 (fetched=$FET)" "✓ ${ST}"; else FAIL=$((FAIL+1)); say "hdika sync #1" "✗ ($ST fetched=$FET)"; fi
# 2nd sync: same records → all duplicates (proves dedup/idempotency)
S2=$(curl -sk $RES -X POST "${BASE}/api/v1/ingestion/hdika/sync" -H "Authorization: Bearer ${TOK}")
DUP=$(echo "$S2" | python3 -c 'import sys,json;d=json.load(sys.stdin)["stats"];print(d["duplicates"])' 2>/dev/null || echo 0)
INS2=$(echo "$S2" | python3 -c 'import sys,json;print(json.load(sys.stdin)["stats"]["inserted"])' 2>/dev/null || echo 99)
if [ "${DUP:-0}" -ge 1 ] && [ "${INS2:-9}" -eq 0 ]; then
  PASS=$((PASS+1)); say "hdika sync #2 dedup (dup=$DUP)" "✓ idempotent"; else FAIL=$((FAIL+1)); say "hdika sync #2 dedup" "✗ (dup=$DUP ins=$INS2)"; fi
# country rule: GR tenant cannot upload ΓΕΣΥ → 409
CODE=$(printf '<gesy_executions/>' | curl -sk $RES -o /dev/null -w '%{http_code}' \
  -X POST "${BASE}/api/v1/ingestion/gesy/upload" -H "Authorization: Bearer ${TOK}" -F 'file=@-;filename=x.xml')
if [ "$CODE" = "409" ]; then PASS=$((PASS+1)); say "gesy upload blocked for GR" "✓ 409";
else FAIL=$((FAIL+1)); say "gesy upload blocked for GR" "✗ $CODE"; fi
# jobs visible
check "ingestion/jobs"         "${BASE}/api/v1/ingestion/jobs"

echo "── Web routes ─────────────────────────────────"
checkweb "web /login"          "${APP_HOST}"   "/login"
checkweb "web / (redirect)"    "${APP_HOST}"   "/"
checkweb "web /dashboard"      "${APP_HOST}"   "/dashboard"
checkweb "adminpanel /"        "${ADMIN_HOST}" "/"

echo "───────────────────────────────────────────────"
echo "PASS=${PASS}  FAIL=${FAIL}"
[ "$FAIL" -eq 0 ] && { echo "✓ ALL GREEN"; exit 0; } || { echo "✗ FAILURES"; exit 1; }
