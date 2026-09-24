const YahooFinance = require("yahoo-finance2").default;
const { getKoreanScreenerPayload } = require("./market-data");

const PRESET_ID = "value_growth_quality_9";
const CACHE_TTL_MS = 1000 * 60 * 30;
const FUNDAMENTAL_CONCURRENCY = 4;

const yahooFinance = new YahooFinance({ suppressNotices: ["yahooSurvey"] });
const quantCache = new Map();

const metricDefs = [
  { key: "per", axis: "value", direction: "asc" },
  { key: "pbr", axis: "value", direction: "asc" },
  { key: "psr", axis: "value", direction: "asc" },
  { key: "por", axis: "value", direction: "asc" },
  { key: "salesGrowth", axis: "growth", direction: "desc" },
  { key: "opGrowth", axis: "growth", direction: "desc" },
  { key: "netGrowth", axis: "growth", direction: "desc" },
  { key: "roe", axis: "quality", direction: "desc" },
  { key: "operatingMargin", axis: "quality", direction: "desc" },
];

function finiteOrNull(value) {
  if (Number.isFinite(value)) return Number(value);
  if (value && Number.isFinite(value.raw)) return Number(value.raw);
  return null;
}

function firstFinite(...values) {
  for (const value of values) {
    const parsed = finiteOrNull(value);
    if (parsed != null) return parsed;
  }
  return null;
}

function mapWithLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  }

  return Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  ).then(() => results);
}

function asTimestamp(value) {
  if (value instanceof Date) return value.getTime();
  if (Number.isFinite(value)) return Number(value) * (Number(value) < 1e12 ? 1000 : 1);
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function statementRows(moduleValue, keys) {
  if (!moduleValue) return [];
  if (Array.isArray(moduleValue)) return [...moduleValue];

  for (const key of keys) {
    if (Array.isArray(moduleValue[key])) {
      return [...moduleValue[key]];
    }
  }

  return [];
}

function sortNewest(rows) {
  return [...rows].sort((a, b) => asTimestamp(b?.endDate) - asTimestamp(a?.endDate));
}

function statementValue(row, candidates) {
  if (!row) return null;
  for (const key of candidates) {
    const value = finiteOrNull(row[key]);
    if (value != null) return value;
  }
  return null;
}

function sumRecent(rows, count, candidates, offset = 0) {
  const window = rows.slice(offset, offset + count);
  if (window.length < count) return null;
  const values = window.map((row) => statementValue(row, candidates));
  if (values.some((value) => value == null)) return null;
  return values.reduce((sum, value) => sum + value, 0);
}

function growthRate(current, previous) {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) {
    return null;
  }
  return ((current - previous) / Math.abs(previous)) * 100;
}

function annualGrowth(rows, candidates) {
  if (rows.length < 2) return null;
  const current = statementValue(rows[0], candidates);
  const previous = statementValue(rows[1], candidates);
  return growthRate(current, previous);
}

function ttmGrowth(quarterRows, annualRows, candidates) {
  const current = sumRecent(quarterRows, 4, candidates, 0);
  const previous = sumRecent(quarterRows, 4, candidates, 4);
  const quarterlyGrowth = growthRate(current, previous);
  return quarterlyGrowth != null ? quarterlyGrowth : annualGrowth(annualRows, candidates);
}

function ratio(numerator, denominator) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    return null;
  }
  return numerator / denominator;
}

function koreanYahooSymbol(item, marketId) {
  return `${item.code}.${marketId === "kosdaq" ? "KQ" : "KS"}`;
}

async function fetchQuantFundamentals(item, marketId) {
  const symbol = koreanYahooSymbol(item, marketId);

  let summary = {};
  try {
    summary = await yahooFinance.quoteSummary(symbol, {
      modules: [
        "price",
        "summaryDetail",
        "defaultKeyStatistics",
        "financialData",
        "incomeStatementHistoryQuarterly",
        "balanceSheetHistoryQuarterly",
        "incomeStatementHistory",
        "balanceSheetHistory",
      ],
    });
  } catch (error) {
    console.warn(`Quant fundamentals unavailable for ${symbol}: ${error.message}`);
  }

  const price = summary.price || {};
  const detail = summary.summaryDetail || {};
  const statistics = summary.defaultKeyStatistics || {};
  const financial = summary.financialData || {};

  const quarterlyIncome = sortNewest(
    statementRows(summary.incomeStatementHistoryQuarterly, ["incomeStatementHistory"]),
  );
  const quarterlyBalance = sortNewest(
    statementRows(summary.balanceSheetHistoryQuarterly, ["balanceSheetStatements"]),
  );
  const annualIncome = sortNewest(
    statementRows(summary.incomeStatementHistory, ["incomeStatementHistory"]),
  );
  const annualBalance = sortNewest(
    statementRows(summary.balanceSheetHistory, ["balanceSheetStatements"]),
  );

  const revenueKeys = ["totalRevenue", "operatingRevenue"];
  const operatingIncomeKeys = ["operatingIncome", "operatingIncomeLoss"];
  const netIncomeKeys = [
    "netIncome",
    "netIncomeCommonStockholders",
    "netIncomeFromContinuingOps",
  ];
  const equityKeys = [
    "stockholdersEquity",
    "totalStockholderEquity",
    "totalEquityGrossMinorityInterest",
  ];

  const ttmRevenue = sumRecent(quarterlyIncome, 4, revenueKeys);
  const ttmOperatingIncome = sumRecent(quarterlyIncome, 4, operatingIncomeKeys);
  const ttmNetIncome = sumRecent(quarterlyIncome, 4, netIncomeKeys);

  const annualRevenue = statementValue(annualIncome[0], revenueKeys);
  const annualOperatingIncome = statementValue(annualIncome[0], operatingIncomeKeys);

  const latestEquity = firstFinite(
    statementValue(quarterlyBalance[0], equityKeys),
    statementValue(annualBalance[0], equityKeys),
    Number.isFinite(item.equity) ? item.equity * 100000000 : null,
  );

  const openingEquity = firstFinite(
    statementValue(quarterlyBalance[4], equityKeys),
    statementValue(quarterlyBalance[quarterlyBalance.length - 1], equityKeys),
    statementValue(annualBalance[1], equityKeys),
  );

  const averageEquity =
    Number.isFinite(latestEquity) && Number.isFinite(openingEquity)
      ? (latestEquity + openingEquity) / 2
      : null;

  const roeTtm =
    Number.isFinite(ttmNetIncome) && Number.isFinite(averageEquity) && averageEquity !== 0
      ? (ttmNetIncome / averageEquity) * 100
      : null;

  const fallbackRoe = firstFinite(
    Number.isFinite(financial.returnOnEquity) ? financial.returnOnEquity * 100 : null,
    item.roe,
  );

  const marketCapWon = firstFinite(
    price.marketCap,
    detail.marketCap,
    Number.isFinite(item.marketCap) ? item.marketCap * 100000000 : null,
  );

  const salesWon = firstFinite(
    ttmRevenue,
    financial.totalRevenue,
    annualRevenue,
    Number.isFinite(item.sales) ? item.sales * 100000000 : null,
  );

  const operatingProfitWon = firstFinite(
    ttmOperatingIncome,
    annualOperatingIncome,
    Number.isFinite(item.operatingProfit) ? item.operatingProfit * 100000000 : null,
  );

  const operatingMargin = firstFinite(
    Number.isFinite(ttmOperatingIncome) && Number.isFinite(ttmRevenue) && ttmRevenue !== 0
      ? (ttmOperatingIncome / ttmRevenue) * 100
      : null,
    Number.isFinite(financial.operatingMargins) ? financial.operatingMargins * 100 : null,
    Number.isFinite(item.operatingProfit) && Number.isFinite(item.sales) && item.sales !== 0
      ? (item.operatingProfit / item.sales) * 100
      : null,
  );

  const salesGrowth = firstFinite(
    ttmGrowth(quarterlyIncome, annualIncome, revenueKeys),
    Number.isFinite(financial.revenueGrowth) ? financial.revenueGrowth * 100 : null,
  );

  const opGrowth = ttmGrowth(quarterlyIncome, annualIncome, operatingIncomeKeys);

  const netGrowth = firstFinite(
    ttmGrowth(quarterlyIncome, annualIncome, netIncomeKeys),
    Number.isFinite(financial.earningsGrowth) ? financial.earningsGrowth * 100 : null,
  );

  const per = firstFinite(detail.trailingPE, statistics.trailingPE, item.per);
  const pbr = firstFinite(statistics.priceToBook, item.pbr);

  return {
    ...item,
    market: marketId,
    yahooSymbol: symbol,
    per,
    pbr,
    psr: ratio(marketCapWon, salesWon),
    por: ratio(marketCapWon, operatingProfitWon),
    salesGrowth,
    opGrowth,
    netGrowth,
    roe: firstFinite(roeTtm, fallbackRoe),
    operatingMargin,
    latestEquity,
    averageEquity,
    ttmNetIncome,
    roeMethod: roeTtm != null ? "TTM 순이익 / 평균 자기자본" : fallbackRoe != null ? "대체 ROE" : "결측",
  };
}

function rankMetric(items, metric, direction) {
  const n = items.length;
  const finite = items
    .filter((item) => Number.isFinite(item[metric]))
    .sort((a, b) => {
      const delta = a[metric] - b[metric];
      return direction === "asc" ? delta : -delta;
    });

  const ranks = new Map();
  let index = 0;
  while (index < finite.length) {
    let end = index + 1;
    while (end < finite.length && finite[end][metric] === finite[index][metric]) {
      end += 1;
    }
    const averageRank = ((index + 1) + end) / 2;
    for (let i = index; i < end; i += 1) {
      ranks.set(finite[i].code, averageRank);
    }
    index = end;
  }

  return items.map((item) => {
    const rank = ranks.get(item.code) ?? n;
    const score = n <= 1 ? 100 : ((n - rank) / (n - 1)) * 100;
    return {
      ...item,
      [`${metric}Rank`]: rank,
      [`${metric}Score`]: Math.max(0, Math.min(100, score)),
    };
  });
}

function averageScores(item, metrics) {
  if (!metrics.length) return 0;
  return metrics.reduce((sum, metric) => sum + (item[`${metric}Score`] || 0), 0) / metrics.length;
}

function scoreUniverse(items) {
  let scored = items;
  for (const def of metricDefs) {
    scored = rankMetric(scored, def.key, def.direction);
  }

  const valueMetrics = metricDefs.filter((def) => def.axis === "value").map((def) => def.key);
  const growthMetrics = metricDefs.filter((def) => def.axis === "growth").map((def) => def.key);
  const qualityMetrics = metricDefs.filter((def) => def.axis === "quality").map((def) => def.key);

  return scored
    .map((item) => {
      const valueScore = averageScores(item, valueMetrics);
      const growthScore = averageScores(item, growthMetrics);
      const qualityScore = averageScores(item, qualityMetrics);
      const quantScore = valueScore * 0.4 + growthScore * 0.4 + qualityScore * 0.2;
      return {
        ...item,
        valueScore,
        growthScore,
        qualityScore,
        quantScore,
      };
    })
    .sort(
      (a, b) =>
        b.quantScore - a.quantScore ||
        b.growthScore - a.growthScore ||
        b.qualityScore - a.qualityScore ||
        b.valueScore - a.valueScore ||
        (b.marketCap || 0) - (a.marketCap || 0),
    )
    .map((item, index) => ({ ...item, quantRank: index + 1 }));
}

async function getKoreanQuantPayload(
  marketId,
  universe = "top100",
  displayLimit = 100,
  forceRefresh = false,
) {
  const market = marketId === "kosdaq" ? "kosdaq" : "kospi";
  const normalizedUniverse = universe === "top500" ? "top500" : "top100";
  const universeSize = normalizedUniverse === "top500" ? 500 : 100;
  const limit = Math.max(10, Math.min(universeSize, Number(displayLimit) || 100));
  const cacheKey = `${market}:${normalizedUniverse}`;
  const cached = quantCache.get(cacheKey);

  if (!forceRefresh && cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    return {
      ...cached.payload,
      items: cached.payload.allItems.slice(0, limit),
      count: Math.min(limit, cached.payload.allItems.length),
    };
  }

  const screener = await getKoreanScreenerPayload(
    market,
    [{ metric: "marketCap", direction: "desc" }],
    normalizedUniverse === "top500" ? "all" : "top100",
    universeSize,
    forceRefresh,
  );

  const enriched = await mapWithLimit(
    screener.items,
    FUNDAMENTAL_CONCURRENCY,
    (item) => fetchQuantFundamentals(item, market),
  );

  const excludedEquity = enriched.filter(
    (item) => Number.isFinite(item.latestEquity) && item.latestEquity <= 0,
  );

  const eligible = enriched.filter(
    (item) => !Number.isFinite(item.latestEquity) || item.latestEquity > 0,
  );

  const allItems = scoreUniverse(eligible);

  const payload = {
    id: "quant",
    preset: PRESET_ID,
    market,
    universe: normalizedUniverse,
    universeSize: screener.items.length,
    eligibleCount: allItems.length,
    excludedEquityCount: excludedEquity.length,
    retrievedAt: new Date().toISOString(),
    sourceName: "Naver Finance + Yahoo Finance",
    rules: {
      valueWeight: 0.4,
      growthWeight: 0.4,
      qualityWeight: 0.2,
      valueMetrics: ["per", "pbr", "psr", "por"],
      growthMetrics: ["salesGrowth", "opGrowth", "netGrowth"],
      qualityMetrics: ["roe", "operatingMargin"],
      missingRule: "결측치는 각 지표의 유니버스 최하위 등수",
      equityRule: "자기자본 <= 0 종목 제외",
      roeRule: "최근 4분기 순이익(TTM) / 평균 자기자본 우선, ROE <= 0은 제외하지 않음",
    },
    allItems,
  };

  quantCache.set(cacheKey, { cachedAt: Date.now(), payload });

  return {
    ...payload,
    items: allItems.slice(0, limit),
    count: Math.min(limit, allItems.length),
  };
}

module.exports = {
  getKoreanQuantPayload,
};
