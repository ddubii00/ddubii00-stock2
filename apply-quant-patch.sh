#!/usr/bin/env bash
set -e

python3 <<'PY'
from pathlib import Path
import re

root = Path('.')
server = root / 'server.js'

if not server.exists():
    raise SystemExit('ERROR: server.js가 없습니다. 저장소 루트에서 실행하세요.')

s = server.read_text(encoding='utf-8')

require_line = 'const { getKoreanQuantPayload } = require("./quant-data");'
if require_line not in s:
    anchor = '} = require("./market-data");'
    if anchor not in s:
        raise SystemExit('ERROR: server.js의 market-data require 위치를 찾지 못했습니다.')
    s = s.replace(anchor, anchor + '\n' + require_line, 1)

route_marker = '  if (url.pathname === "/api/ohlcv") {'
if 'if (url.pathname === "/api/quant") {' not in s:
    if route_marker not in s:
        raise SystemExit('ERROR: server.js의 /api/ohlcv 위치를 찾지 못했습니다.')
    route = '''  if (url.pathname === "/api/quant") {
    try {
      const marketId = (url.searchParams.get("market") || "kospi").toLowerCase();
      const universe = url.searchParams.get("universe") || "top100";
      const limit = Number(url.searchParams.get("limit") || 100);
      const forceRefresh = url.searchParams.get("refresh") === "1";
      const payload = await getKoreanQuantPayload(
        marketId,
        universe,
        limit,
        forceRefresh,
      );
      sendJson(res, 200, payload);
    } catch (error) {
      sendJson(res, 502, {
        error: "퀀트 데이터를 가져오지 못했습니다.",
        detail: error.message,
      });
    }
    return;
  }

'''
    s = s.replace(route_marker, route + route_marker, 1)

server.write_text(s, encoding='utf-8')

for rel in ['index.html', 'public/index.html']:
    path = root / rel
    if not path.exists():
        continue
    html = path.read_text(encoding='utf-8')

    if './quant.css' not in html:
        pattern = re.compile(r'(?P<line>\s*<link rel="stylesheet" href="\./styles\.css(?:\?v=[^"]*)?"\s*/>)')
        m = pattern.search(html)
        if not m:
            raise SystemExit(f'ERROR: {rel}의 styles.css 링크를 찾지 못했습니다.')
        insert = m.group('line') + '\n    <link rel="stylesheet" href="./quant.css?v=20260924q1" />'
        html = html[:m.start()] + insert + html[m.end():]

    if './quant.js' not in html:
        pattern = re.compile(r'(?P<line>\s*<script src="\./app\.js(?:\?v=[^"]*)?" defer></script>)')
        m = pattern.search(html)
        if not m:
            raise SystemExit(f'ERROR: {rel}의 app.js 스크립트를 찾지 못했습니다.')
        insert = m.group('line') + '\n    <script src="./quant.js?v=20260924q1" defer></script>'
        html = html[:m.start()] + insert + html[m.end():]

    path.write_text(html, encoding='utf-8')

print('OK: stock2 퀀트 패치 적용 완료')
PY

node --check server.js
node --check quant-data.js
node --check api/quant.js
node --check quant.js
node --check public/quant.js

echo 'OK: JavaScript 문법 검사 완료'
