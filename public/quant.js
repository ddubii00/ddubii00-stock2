(() => {
  const basePath = new URL(".", window.location.href).pathname.replace(/\/$/, "");
  const apiUrl = (endpoint) => `${basePath}${endpoint}`;
  const number = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 2 });

  const screenerTab = document.querySelector('[data-market="screener"]');
  const nav = screenerTab?.parentElement;
  const statusBand = document.querySelector(".status-band");
  const screenerControls = document.querySelector("#screenerControls");
  const metrics = document.querySelector(".metrics");
  const searchControls = document.querySelector(".stock-search-controls");
  const tableWrap = document.querySelector(".table-wrap");
  const pageTitle = document.querySelector("#pageTitle");
  const eyebrow = document.querySelector("#eyebrow");

  if (!nav || !screenerTab) return;

  const quantButton = document.createElement("button");
  quantButton.type = "button";
  quantButton.id = "quantTabButton";
  quantButton.className = "quant-tab-button";
  quantButton.textContent = "퀀트";
  screenerTab.insertAdjacentElement("afterend", quantButton);

  const panel = document.createElement("section");
  panel.id = "quantPanel";
  panel.className = "quant-panel";
  panel.innerHTML = `
    <div class="quant-preset-card">
      <div>
        <strong>value_growth_quality_9</strong>
        <span>가치 40% · 성장 40% · 품질 20%</span>
      </div>
      <div class="quant-rule-line">가치: PER · PBR · PSR · POR (낮을수록 우수)</div>
      <div class="quant-rule-line">성장: 매출 · 영업이익 · 순이익 성장률 (높을수록 우수)</div>
      <div class="quant-rule-line">품질: ROE · 영업이익률 (높을수록 우수)</div>
      <div class="quant-rule-line">ROE: TTM 순이익 / 평균 자기자본 우선 · 자기자본 ≤ 0 제외 · 음수 ROE는 순위 반영</div>
      <div class="quant-rule-line">결측치는 해당 지표의 유니버스 최하위 등수</div>
    </div>

    <div class="quant-controls">
      <label>시장
        <select id="quantMarket">
          <option value="kospi">KOSPI</option>
          <option value="kosdaq">KOSDAQ</option>
        </select>
      </label>
      <label>유니버스
        <select id="quantUniverse">
          <option value="top100">시총 100</option>
          <option value="top500">시총 500</option>
        </select>
      </label>
      <label>표시
        <select id="quantLimit">
          <option value="50">50개</option>
          <option value="100" selected>100개</option>
          <option value="200">200개</option>
          <option value="500">500개</option>
        </select>
      </label>
      <button type="button" id="quantApplyButton">계산</button>
      <button type="button" id="quantRefreshButton">새로 계산</button>
    </div>

    <div class="quant-status" id="quantStatus">퀀트 탭을 열면 계산을 시작합니다.</div>

    <div class="quant-table-wrap">
      <table class="quant-table">
        <thead>
          <tr>
            <th>퀀트순위</th>
            <th>종목</th>
            <th class="numeric">종합점수</th>
            <th class="numeric">가치</th>
            <th class="numeric">성장</th>
            <th class="numeric">품질</th>
            <th class="numeric">PER</th>
            <th class="numeric">PBR</th>
            <th class="numeric">PSR</th>
            <th class="numeric">POR</th>
            <th class="numeric">매출성장</th>
            <th class="numeric">영업익성장</th>
            <th class="numeric">순익성장</th>
            <th class="numeric">ROE</th>
            <th class="numeric">영업이익률</th>
            <th class="numeric">시총(조)</th>
          </tr>
        </thead>
        <tbody id="quantRows"></tbody>
      </table>
    </div>
  `;

  statusBand?.insertAdjacentElement("beforebegin", panel);

  const els = {
    market: panel.querySelector("#quantMarket"),
    universe: panel.querySelector("#quantUniverse"),
    limit: panel.querySelector("#quantLimit"),
    apply: panel.querySelector("#quantApplyButton"),
    refresh: panel.querySelector("#quantRefreshButton"),
    status: panel.querySelector("#quantStatus"),
    rows: panel.querySelector("#quantRows"),
  };

  let active = false;
  let loadedKey = "";

  function fmt(value, digits = 2) {
    if (!Number.isFinite(value)) return "-";
    return Number(value).toLocaleString("ko-KR", {
      maximumFractionDigits: digits,
      minimumFractionDigits: digits,
    });
  }

  function pct(value) {
    if (!Number.isFinite(value)) return "-";
    const sign = value > 0 ? "+" : "";
    return `${sign}${fmt(value, 2)}%`;
  }

  function marketCapJo(value) {
    if (!Number.isFinite(value)) return "-";
    return fmt(value / 10000, 2);
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function setNormalVisibility(show) {
    [statusBand, screenerControls, metrics, searchControls, tableWrap].forEach((element) => {
      element?.classList.toggle("quant-hidden", !show);
    });
  }

  function setQuantMode(next) {
    active = next;
    panel.classList.toggle("is-visible", next);
    quantButton.classList.toggle("is-active", next);
    setNormalVisibility(!next);

    if (next) {
      document.querySelectorAll(".market-tab").forEach((button) => button.classList.remove("is-active"));
      if (pageTitle) pageTitle.textContent = "value_growth_quality_9 퀀트 순위";
      if (eyebrow) eyebrow.textContent = "Value · Growth · Quality";
    }
  }

  function renderRows(items) {
    els.rows.innerHTML = items
      .map((item) => `
        <tr>
          <td class="rank">${item.quantRank ?? "-"}</td>
          <td>
            <button type="button" class="quant-stock-link" data-code="${escapeHtml(item.code)}" data-name="${escapeHtml(item.name)}" data-market="${escapeHtml(item.market)}">
              ${escapeHtml(item.name)}
            </button>
            <span class="code">${escapeHtml(item.code)}</span>
          </td>
          <td class="numeric quant-score-main">${fmt(item.quantScore)}</td>
          <td class="numeric">${fmt(item.valueScore)}</td>
          <td class="numeric">${fmt(item.growthScore)}</td>
          <td class="numeric">${fmt(item.qualityScore)}</td>
          <td class="numeric">${fmt(item.per)}</td>
          <td class="numeric">${fmt(item.pbr)}</td>
          <td class="numeric">${fmt(item.psr)}</td>
          <td class="numeric">${fmt(item.por)}</td>
          <td class="numeric">${pct(item.salesGrowth)}</td>
          <td class="numeric">${pct(item.opGrowth)}</td>
          <td class="numeric">${pct(item.netGrowth)}</td>
          <td class="numeric" title="${escapeHtml(item.roeMethod || "")}">${pct(item.roe)}</td>
          <td class="numeric">${pct(item.operatingMargin)}</td>
          <td class="numeric">${marketCapJo(item.marketCap)}</td>
        </tr>
      `)
      .join("");

    els.rows.querySelectorAll(".quant-stock-link").forEach((button) => {
      button.addEventListener("click", async () => {
        if (typeof openChartByCode !== "function") return;
        try {
          await openChartByCode(
            button.dataset.code || "",
            button.dataset.name || "",
            button.dataset.market || "kospi",
          );
        } catch (error) {
          els.status.textContent = `차트 로드 실패: ${error.message}`;
        }
      });
    });
  }

  async function loadQuant(forceRefresh = false) {
    const market = els.market.value;
    const universe = els.universe.value;
    const maxLimit = universe === "top500" ? 500 : 100;
    const limit = Math.min(maxLimit, Number(els.limit.value || 100));
    els.limit.value = String(limit);

    const key = `${market}:${universe}:${limit}`;
    if (!forceRefresh && loadedKey === key && els.rows.children.length) return;

    els.apply.disabled = true;
    els.refresh.disabled = true;
    els.status.textContent =
      universe === "top500"
        ? "시총 500 종목의 9개 팩터를 계산 중입니다. 첫 계산은 시간이 걸릴 수 있습니다."
        : "시총 100 종목의 9개 팩터를 계산 중입니다.";

    const params = new URLSearchParams({
      market,
      universe,
      limit: String(limit),
    });
    if (forceRefresh) params.set("refresh", "1");

    try {
      const response = await fetch(apiUrl(`/api/quant?${params.toString()}`));
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.detail || payload.error || "퀀트 데이터 요청 실패");
      }

      loadedKey = key;
      renderRows(payload.items || []);
      const time = payload.retrievedAt ? new Date(payload.retrievedAt).toLocaleString("ko-KR") : "-";
      els.status.textContent =
        `${payload.preset} · 유니버스 ${number.format(payload.universeSize || 0)}개 · ` +
        `평가 ${number.format(payload.eligibleCount || 0)}개 · 자기자본≤0 제외 ${number.format(payload.excludedEquityCount || 0)}개 · ${time}`;
    } catch (error) {
      els.rows.innerHTML = "";
      els.status.textContent = `퀀트 계산 실패: ${error.message}`;
    } finally {
      els.apply.disabled = false;
      els.refresh.disabled = false;
    }
  }

  quantButton.addEventListener("click", () => {
    setQuantMode(true);
    loadQuant(false);
  });

  document.querySelectorAll(".market-tab").forEach((button) => {
    button.addEventListener("click", () => {
      if (!active) return;
      setQuantMode(false);
    });
  });

  els.apply.addEventListener("click", () => loadQuant(false));
  els.refresh.addEventListener("click", () => loadQuant(true));
  els.universe.addEventListener("change", () => {
    const max = els.universe.value === "top500" ? 500 : 100;
    if (Number(els.limit.value) > max) els.limit.value = String(max);
  });
})();
