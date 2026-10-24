// TDX 大眾運輸路線規劃的中繼（Cloudflare Worker）
// ------------------------------------------------
// 為什麼要中繼：TDX 要用 Client Id／Client Secret 換 access token 才能呼叫，金鑰不能放在網頁裡（任何人都看得到）。
// 這支程式放在 Cloudflare，金鑰存在 Cloudflare 的加密變數（TDX_CLIENT_ID、TDX_CLIENT_SECRET），不進 repo。
//
// 網頁呼叫：GET https://<你的 worker>.workers.dev/route?from=緯度,經度&to=緯度,經度&depart=2026-10-24T19:30:00
// 回傳：TDX 旅運規劃 API 的原始 JSON（網頁端解析）
//
// 部署步驟見 docs/TDX大眾運輸設定步驟.md。

const TOKEN_URL = "https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token";
const ROUTING_URL = "https://tdx.transportdata.tw/api/maas/routing";
// 只讓自己的網站和本機預覽呼叫，避免別人拿去用掉額度
const ALLOWED_ORIGINS = ["https://tim062480-create.github.io", "http://localhost:8765"];
const CACHE_SECONDS = 300;   // 同一段路 5 分鐘內重複查，直接用快取

let token = null, tokenExpires = 0;   // 同一個 Worker 執行個體內重複使用 token

async function getToken(env) {
  if (token && Date.now() < tokenExpires - 60_000) return token;
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: env.TDX_CLIENT_ID, client_secret: env.TDX_CLIENT_SECRET }),
  });
  if (!r.ok) throw new Error(`TDX token ${r.status}`);
  const j = await r.json();
  token = j.access_token;
  tokenExpires = Date.now() + (j.expires_in || 3600) * 1000;
  return token;
}

// 出發時間一律用台灣時間的字串「2026-10-24T19:30:00」，分鐘取到 5 分鐘（快取比較容易命中）。
// 不用 Date 解析網頁傳來的時間，避免執行環境時區不同而差 8 小時
function departTime(s) {
  let ymdhm = /^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(s || "") ? s.slice(0, 16) : null;
  if (!ymdhm) ymdhm = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 16);   // 沒給就用現在的台灣時間
  const min = Math.floor(Number(ymdhm.slice(14, 16)) / 5) * 5;
  return `${ymdhm.slice(0, 14)}${String(min).padStart(2, "0")}:00`;
}

const latlng = (s) => /^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(s || "") ? s.split(",").map((x) => Number(x).toFixed(5)).join(",") : null;

function cors(origin) {
  return {
    "access-control-allow-origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    "access-control-allow-methods": "GET",
    vary: "origin",
  };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get("origin") || "";
    const json = (body, status = 200) => new Response(JSON.stringify(body), {
      status, headers: { "content-type": "application/json; charset=utf-8", ...cors(origin) } });

    if (request.method === "OPTIONS") return new Response(null, { headers: cors(origin) });
    if (url.pathname !== "/route") return json({ error: "只有 /route" }, 404);
    if (!ALLOWED_ORIGINS.includes(origin)) return json({ error: "來源網站不在允許清單" }, 403);

    const from = latlng(url.searchParams.get("from")), to = latlng(url.searchParams.get("to"));
    if (!from || !to) return json({ error: "from、to 要是「緯度,經度」" }, 400);
    const depart = departTime(url.searchParams.get("depart"));

    const q = new URLSearchParams({
      origin: from, destination: to,
      gc: "1.0",                  // 依總時間排序
      top: "3",                   // 最多 3 個方案
      transit: "3,4,5,6,7,8,9",   // 公車、客運、捷運、台鐵、高鐵、輕軌、渡輪等全部運具
      transfer_time: "0,60",
      depart,
      first_mile_mode: "0", first_mile_time: "15",   // 起點、終點步行最多 15 分鐘
      last_mile_mode: "0", last_mile_time: "15",
    });
    const cacheKey = new Request(`${ROUTING_URL}?${q}`);
    const cache = caches.default;
    const hit = await cache.match(cacheKey);
    if (hit) return json(await hit.json());

    try {
      const r = await fetch(`${ROUTING_URL}?${q}`, { headers: { authorization: `Bearer ${await getToken(env)}` } });
      const body = await r.json().catch(() => ({ error: `TDX 回傳 ${r.status}` }));
      if (r.ok) ctx.waitUntil(cache.put(cacheKey, new Response(JSON.stringify(body), { headers: { "cache-control": `max-age=${CACHE_SECONDS}` } })));
      return json(body, r.ok ? 200 : 502);
    } catch (e) {
      return json({ error: String(e.message || e) }, 502);
    }
  },
};
