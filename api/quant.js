const { getKoreanQuantPayload } = require("../quant-data");

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(payload));
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  try {
    const requestUrl = new URL(req.url, `https://${req.headers.host || "localhost"}`);
    const market = (req.query?.market || requestUrl.searchParams.get("market") || "kospi").toLowerCase();
    const universe = req.query?.universe || requestUrl.searchParams.get("universe") || "top100";
    const limit = Number(req.query?.limit || requestUrl.searchParams.get("limit") || 100);
    const forceRefresh =
      req.query?.refresh === "1" || requestUrl.searchParams.get("refresh") === "1";

    const payload = await getKoreanQuantPayload(
      market,
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
};
