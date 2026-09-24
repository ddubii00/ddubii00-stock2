# stock2 퀀트 패치

기준 저장소: `ddubii00/ddubii00-stock2` main (2026-09-24 확인)

## 추가 기능

`종목순위` 오른쪽에 `퀀트` 버튼을 추가합니다.

프리셋: `value_growth_quality_9`

- 가치 40%
  - PER, PBR, PSR, POR: 낮을수록 우수
- 성장 40%
  - 매출성장률, 영업이익성장률, 순이익성장률: 높을수록 우수
- 품질 20%
  - ROE, 영업이익률: 높을수록 우수

ROE 규칙:
- 최근 4분기 순이익(TTM) / 평균 자기자본을 우선 사용
- 자기자본 <= 0 종목은 제외
- ROE <= 0은 제외하지 않고 순위에 반영
- 결측치는 각 지표에서 유니버스 최하위 등수

## 점수 방식

각 지표를 유니버스 내 순위로 변환해 0~100점으로 정규화합니다.
결측치는 해당 지표의 유니버스 최하위 등수(0점)입니다.

- 가치점수 = PER/PBR/PSR/POR 점수 평균
- 성장점수 = 매출/영업이익/순이익 성장 점수 평균
- 품질점수 = ROE/영업이익률 점수 평균
- 종합점수 = 가치 0.40 + 성장 0.40 + 품질 0.20

동률 지표는 평균등수를 사용합니다.

## 데이터 처리

- 기본 종목/시총/기존 재무 데이터: 기존 `market-data.js` 흐름 사용
- 추가 분기 재무 데이터: `yahoo-finance2`의 분기 손익계산서/재무상태표 사용
- 분기 데이터가 충분하면 최근 4분기 TTM과 직전 4분기 TTM으로 성장률 계산
- 분기 데이터가 부족하면 연간 성장률 또는 기존 재무 값으로 대체
- ROE는 TTM 순이익 / 평균 자기자본을 우선 적용하고 불가능한 경우 대체 ROE 사용

## 파일

새 파일:
- `quant-data.js`
- `api/quant.js`
- `quant.js`
- `quant.css`
- `public/quant.js`
- `public/quant.css`

기존 파일 수정 필요:
- `server.js`
- `index.html`
- `public/index.html`

## 가장 쉬운 적용 방법

이 ZIP의 내용을 기존 stock2 저장소 루트에 복사한 뒤:

```bash
bash apply-quant-patch.sh
```

그러면 `server.js`, `index.html`, `public/index.html`만 자동으로 필요한 부분이 수정됩니다.

그 후 변경된 파일과 새 파일을 GitHub에 수동 업로드하면 됩니다.

## Oracle에서 확인

서비스 재시작 후 브라우저에서 `종목순위` 오른쪽의 `퀀트` 버튼을 확인합니다.

API 직접 확인 예:

```bash
curl -s 'http://127.0.0.1:5173/api/quant?market=kospi&universe=top100&limit=20' | python3 -m json.tool | head -80
```

실제 stock2 서비스 포트가 다르면 포트만 바꾸세요.

## 참고

`top500`은 종목별 분기 재무 데이터를 추가로 확인하므로 최초 계산 시간이 길 수 있습니다. 결과는 30분 캐시됩니다.
