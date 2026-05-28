(() => {
  const RELATIVE_PERIODS = [
    { key: "day", label: "당일", offset: 1 },
    { key: "d3", label: "3일", offset: 3 },
    { key: "d5", label: "5일", offset: 5 },
    { key: "d10", label: "10일", offset: 10 },
    { key: "m1", label: "1개월", offset: 21 },
    { key: "m3", label: "3개월", offset: 63 },
    { key: "m6", label: "6개월", offset: 126 },
    { key: "y1", label: "1년", offset: 252 },
  ];

  const INDEX_SYMBOLS = {
    kospi: { code: "^KS11", label: "KOSPI", chartMarket: "nasdaq100", fallbacks: [{ code: "KOSPI" }] },
    kosdaq: { code: "^KQ11", label: "KOSDAQ", chartMarket: "nasdaq100", fallbacks: [{ code: "KOSDAQ" }] },
    nasdaq100: { code: "^NDX", label: "NASDAQ 100", chartMarket: "nasdaq100" },
    dow: { code: "^DJI", label: "Dow", chartMarket: "nasdaq100" },
  };

  const WARNING_THRESHOLD = -5;
  const CHART_LOOKBACK_DAYS = 320;
  const RELATIVE_CONCURRENCY = 6;
  const cache = new Map();

  function withSignClass(value) {
    if (value > 0) return "up";
    if (value < 0) return "down";
    return "flat";
  }

  function ensureMetricLabel() {
    const metricArticle = els.avgRate?.closest("article");
    const label = metricArticle?.querySelector("span");
    if (label) {
      const indexLabel = INDEX_SYMBOLS[state.market]?.label || "지수";
      label.textContent = `${indexLabel} 변화율`;
    }
  }

  function ensureRelativeHeaders() {
    const headerRow = document.querySelector(".table-wrap thead tr");
    const anchor = document.querySelector("#extraHeader");
    if (!headerRow || !anchor || headerRow.querySelector("[data-relative-header]")) {
      return;
    }

    const fragment = document.createDocumentFragment();
    RELATIVE_PERIODS.forEach((period) => {
      const th = document.createElement("th");
      th.className = "numeric relative-header";
      th.dataset.relativeHeader = period.key;
      th.textContent = `지수대비 ${period.label}`;
      fragment.appendChild(th);
    });
    headerRow.insertBefore(fragment, anchor);
  }

  function returnFromOffset(rows, offset) {
    if (!Array.isArray(rows) || rows.length <= offset) {
      return null;
    }
    const latest = rows[rows.length - 1]?.close;
    const base = rows[rows.length - 1 - offset]?.close;
    if (!Number.isFinite(latest) || !Number.isFinite(base) || base === 0) {
      return null;
    }
    return ((latest - base) / base) * 100;
  }

  function computePeriodReturns(rows, dayFallback = null) {
    return Object.fromEntries(
      RELATIVE_PERIODS.map((period) => {
        const value = period.key === "day" && Number.isFinite(dayFallback)
          ? dayFallback
          : returnFromOffset(rows, period.offset);
        return [period.key, Number.isFinite(value) ? value : null];
      }),
    );
  }

  async function mapWithLimit(items, limit, mapper) {
    const results = new Array(items.length);
    let nextIndex = 0;

    async function worker() {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await mapper(items[index], index);
      }
    }

    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
  }

  async function fetchOhlcv(code, days = CHART_LOOKBACK_DAYS, marketOverride = state.market) {
    const params = new URLSearchParams({
      market: marketOverride,
      code,
      days: String(days),
      timeframe: "day",
    });
    const response = await fetch(`/api/ohlcv?${params.toString()}`);
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.detail || payload.error || `${code} 차트 데이터 요청 실패`);
    }
    return payload.items || [];
  }

  function relativePerformance(stockReturns, indexReturns) {
    return Object.fromEntries(
      RELATIVE_PERIODS.map((period) => {
        const stockReturn = stockReturns[period.key];
        const indexReturn = indexReturns[period.key];
        const relativeReturn = Number.isFinite(stockReturn) && Number.isFinite(indexReturn)
          ? stockReturn - indexReturn
          : null;
        return [
          period.key,
          {
            stockReturn: Number.isFinite(stockReturn) ? stockReturn : null,
            indexReturn: Number.isFinite(indexReturn) ? indexReturn : null,
            relativeReturn,
            warning: Number.isFinite(relativeReturn) && relativeReturn < WARNING_THRESHOLD,
          },
        ];
      }),
    );
  }

  function cacheKeyFor(items) {
    return [
      state.market,
      INDEX_SYMBOLS[state.market]?.code || "",
      items.map((item) => `${item.code}:${item.changeRate ?? ""}`).join("|"),
    ].join("::");
  }

  async function enrichRelativeData(items) {
    const cacheKey = cacheKeyFor(items);
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.loadedAt < 1000 * 60 * 5) {
      return cached.value;
    }

    const index = INDEX_SYMBOLS[state.market] || INDEX_SYMBOLS.kospi;
    let indexRows = [];
    const indexCandidates = [index, ...(index.fallbacks || [])];
    for (const candidate of indexCandidates) {
      try {
        indexRows = await fetchOhlcv(
          candidate.code,
          CHART_LOOKBACK_DAYS,
          candidate.chartMarket || index.chartMarket || state.market,
        );
        if (indexRows.length) break;
      } catch (error) {
        console.warn(`Index OHLCV fetch failed for ${candidate.code}`, error);
      }
    }
    const indexReturns = computePeriodReturns(indexRows);

    const enrichedItems = await mapWithLimit(items, RELATIVE_CONCURRENCY, async (stock) => {
      try {
        const rows = await fetchOhlcv(stock.code);
        const stockReturns = computePeriodReturns(rows, stock.changeRate);
        return {
          ...stock,
          relativePerformance: relativePerformance(stockReturns, indexReturns),
        };
      } catch (error) {
        console.warn(`Relative performance fetch failed for ${stock.code}`, error);
        const stockReturns = computePeriodReturns([], stock.changeRate);
        return {
          ...stock,
          relativePerformance: relativePerformance(stockReturns, indexReturns),
        };
      }
    });

    const value = {
      indexPerformance: {
        ...index,
        periods: indexReturns,
        warningThreshold: WARNING_THRESHOLD,
      },
      items: enrichedItems,
    };
    cache.set(cacheKey, { loadedAt: Date.now(), value });
    return value;
  }

  function firstIndexReturn(periodKey = "day") {
    if (state.indexPerformance?.periods) {
      const value = state.indexPerformance.periods[periodKey];
      if (Number.isFinite(value)) return value;
    }

    for (const item of state.items || []) {
      const value = item.relativePerformance?.[periodKey]?.indexReturn;
      if (Number.isFinite(value)) return value;
    }
    return null;
  }

  const baseUpdateChrome = updateChrome;
  updateChrome = function updateChromeWithRelativeHeaders() {
    baseUpdateChrome();
    ensureMetricLabel();
    ensureRelativeHeaders();
  };

  updateMetrics = function updateMetricsWithIndexRate(visibleItems) {
    const up = state.items.filter((item) => rateClass(item) === "up").length;
    const down = state.items.filter((item) => rateClass(item) === "down").length;
    const indexDayRate = firstIndexReturn("day");

    els.upCount.textContent = numberFormatter.format(up);
    els.downCount.textContent = numberFormatter.format(down);
    els.avgRate.textContent = formatRate(indexDayRate);
    els.avgRate.className = withSignClass(indexDayRate);
    els.visibleCount.textContent = `${numberFormatter.format(visibleItems.length)}개`;

    if (state.meta.extraType === "marketCap") {
      const marketCapTotal = state.items.reduce(
        (sum, item) => sum + (Number.isFinite(item.marketCap) ? item.marketCap : 0),
        0,
      );
      els.totalMarketCap.textContent = marketCapToJo(marketCapTotal);
    } else if (state.meta.extraType === "marketCapUsd") {
      const marketCapTotal = state.items.reduce(
        (sum, item) => sum + (Number.isFinite(item.marketCap) ? item.marketCap : 0),
        0,
      );
      els.totalMarketCap.textContent = formatUsdMarketCap(marketCapTotal);
    } else {
      els.totalMarketCap.textContent = averageVolumeText(state.items);
    }
  };

  function relativeCell(stock, periodKey) {
    const data = stock.relativePerformance?.[periodKey];
    const value = data?.relativeReturn;
    const valueClass = withSignClass(value);
    const warning = data?.warning ? `<span class="warning-tag">경고</span>` : "";
    return `
      <td class="numeric relative-cell">
        <span class="relative-rate ${valueClass}">${formatRate(value)}</span>
        ${warning}
      </td>`;
  }

  function relativeCells(stock) {
    return RELATIVE_PERIODS.map((period) => relativeCell(stock, period.key)).join("");
  }

  renderRows = function renderRowsWithRelativePerformance(items) {
    els.rows.innerHTML = items
      .map((stock) => {
        const movement = rateClass(stock);
        return `
          <tr>
            <td class="rank">${formatNumber(stock.rank)}</td>
            <td>
              <div class="stock-name">
                <a href="#" data-code="${escapeHtml(stock.code)}" data-name="${escapeHtml(stock.name)}" class="stock-link">
                  ${escapeHtml(stock.name)}
                </a>
                <span class="code">${escapeHtml(stock.code)}</span>
              </div>
            </td>
            <td class="numeric">${formatPrice(stock)}</td>
            <td class="numeric">
              <span class="rate-pill ${movement}">${formatRate(stock.changeRate, stock.changeRateText)}</span>
            </td>
            <td class="numeric ${movement}">${escapeHtml(formatChange(stock))}</td>
            ${relativeCells(stock)}
            ${extraCell(stock)}
            <td class="numeric muted-value">${eokToJo(stock.sales)}</td>
            <td class="numeric muted-value">${eokToJo(stock.operatingProfit)}</td>
            <td class="numeric">${formatPlainNumber(stock.per)}</td>
            <td class="numeric">${Number.isFinite(stock.roe) ? `${formatPlainNumber(stock.roe)}%` : "-"}</td>
            <td class="numeric muted-value">${formatUnavailableMetric(stock.pbr)}</td>
            <td class="numeric">${formatNumber(stock.volume)}</td>
          </tr>`;
      })
      .join("");
  };

  loadStocks = async function loadStocksWithRelativeData(forceRefresh = false) {
    const serial = ++requestSerial;
    state.loading = true;
    state.error = "";
    state.indexPerformance = null;
    els.refreshButton.disabled = true;
    render();

    try {
      const params = new URLSearchParams({ market: state.market });
      if (forceRefresh) {
        params.set("refresh", "1");
      }

      const response = await fetch(`/api/market?${params.toString()}`);
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.detail || payload.error || "데이터 요청 실패");
      }

      if (serial !== requestSerial) {
        return;
      }

      const relative = await enrichRelativeData(payload.items || []);
      if (serial !== requestSerial) {
        return;
      }

      state.items = relative.items;
      state.indexPerformance = relative.indexPerformance;
      state.meta = {
        currency: payload.currency,
        extraLabel: payload.extraLabel,
        extraType: payload.extraType,
        eyebrow: payload.eyebrow,
        metricLabel: payload.metricLabel,
        rankLabel: payload.rankLabel,
        title: payload.title,
        timezone: payload.timezone,
      };
      state.sourceName = payload.sourceName;
      state.sourceUrl = payload.sourceUrl;
      state.retrievedAt = payload.retrievedAt;
    } catch (error) {
      if (serial === requestSerial) {
        state.error = `데이터를 가져오지 못했습니다. ${error.message}`;
        state.items = [];
      }
    } finally {
      if (serial === requestSerial) {
        state.loading = false;
        els.refreshButton.disabled = false;
        render();
      }
    }
  };

  if (typeof requestSerial === "number") {
    requestSerial += 1;
  }
  loadStocks();
})();
