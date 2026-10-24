// 附近抱石館地圖
// 資料：data/processed/gyms.json（館）、data/processed/youbike_*.json（YouBike），都由 GitHub Actions 定期更新。
"use strict";

const STATUS_CLASS = { "營業中": "ok", "待確認": "warn", "可能已停業": "warn", "已停業": "bad" };
const TYPE_NAME = { bouldering: "抱石", lead: "上攀", speed: "速度", autobelay: "自動確保" };
const WALK_M_PER_MIN = 75;     // 步行約 4.5 km/h
const BIKE_M_PER_MIN = 200;    // 騎 YouBike 約 12 km/h
const DETOUR = 1.3;            // 直線距離換成實際路程的倍數（估計值）
const YOUBIKE_MAX_KM = 12;     // 超過這個距離就不建議全程騎 YouBike
const MIN_LISTED = 5;          // 範圍內不到這麼多間時，補列範圍外最近的館
// 臺北市 YouBike 即時資料（可借、可還都是 0 時代表資料源沒給數字，不採用）
const LIVE_URL = "https://tcgbusfs.blob.core.windows.net/dotapp/youbike/v2/youbike_immediate.json";

const state = {
  gyms: [], sources: {}, osmExtra: [], checked: "",
  near: null, pattern: null, stations: null, live: undefined,
  me: null, geoError: "", firstFix: true, watchId: null, markers: new Map(), osmLayer: null,
};

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---------- 地圖 ----------
const map = L.map("map", { zoomControl: true }).setView([23.7, 120.95], 7);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);
const meMarker = L.marker([0, 0], { icon: L.divIcon({ className: "", html: '<div class="me-dot"></div>', iconSize: [16, 16] }) });
const meCircle = L.circle([0, 0], { radius: 0, weight: 1, color: "#1c7ed6", fillOpacity: 0.08 });

function distM(a, b) {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const fmtDist = (m) => (m < 1000 ? `${Math.round(m)} 公尺` : `${(m / 1000).toFixed(1)} 公里`);
const fmtMin = (min) => (min < 60 ? `${Math.round(min)} 分` : `${Math.floor(min / 60)} 小時 ${Math.round(min % 60)} 分`);
// 「380」→「$380」，「約 380–420」→「約 $380–420」
const fmtPrice = (p) => String(p ?? "").replace(/(^|[^\d$])(\d)/, "$1$$$2");
const hasBoulder = (g) => (g.types || []).includes("bouldering");
const gmapsSearch = (g) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${g.name} ${g.address || g.city || ""}`)}`;

function gmapsDir(dest, mode, origin) {
  const p = new URLSearchParams({ api: "1", destination: `${dest.lat},${dest.lng}`, travelmode: mode });
  if (origin) p.set("origin", `${origin.lat},${origin.lng}`);
  return `https://www.google.com/maps/dir/?${p}`;
}

async function loadJSON(path) {
  try {
    const r = await fetch(path, { cache: "no-cache" });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

// ---------- 載入 ----------
async function init() {
  const data = await loadJSON("data/processed/gyms.json");
  if (!data) { setStatus("資料載入失敗，請重新整理。", true); return; }
  state.gyms = data.gyms;
  state.sources = data.sources || {};
  state.osmExtra = data.osm_unmatched || [];
  state.checked = data.checked || "";
  $("checked").textContent = state.checked;
  [state.near, state.pattern] = await Promise.all([loadJSON("data/processed/youbike_near.json"), loadJSON("data/processed/youbike_pattern.json")]);

  for (const g of state.gyms) {
    if (g.lat == null) continue;
    const m = L.circleMarker([g.lat, g.lng], markerStyle(g)).bindTooltip(g.name);
    m.on("click", () => openDetail(g.id));
    state.markers.set(g.id, m);
  }
  state.osmLayer = L.layerGroup(state.osmExtra.filter((p) => p.lat != null).map((p) =>
    L.circleMarker([p.lat, p.lng], { radius: 5, color: "#868e96", fillOpacity: 0.6, weight: 1 })
      .bindPopup(`<b>${esc(p.name || "（無名稱）")}</b><br>OpenStreetMap 上的攀岩地點，未人工確認<br><a href="${esc(p.url)}" target="_blank" rel="noopener">OSM</a>`)));

  fillCityOptions();
  loadFilters();
  if (matchMedia("(max-width: 899px)").matches) $("filterBox").open = false;   // 手機上先收起來，清單才看得到
  FILTER_IDS.forEach((id) => $(id).addEventListener("change", () => { saveFilters(); render(); }));
  $("resetFilters").addEventListener("click", () => { setFilters(FILTER_DEFAULTS); saveFilters(); render(); });
  $("locate").addEventListener("click", locate);
  $("handle").addEventListener("click", () => $("panel").classList.toggle("expanded"));
  $("closeDetail").addEventListener("click", closeDetail);
  window.addEventListener("hashchange", () => { const id = location.hash.slice(1); if (id) openDetail(id, false); });

  render();
  locate();
  if (location.hash.length > 1) openDetail(location.hash.slice(1), false);
}

// ---------- 搜尋條件（可以疊加；記在這台裝置的瀏覽器裡，下次打開沿用） ----------
const FILTER_DEFAULTS = { city: "", radius: "10", budget: "0", sort: "dist", limit: "0", boulderOnly: true, showUnverified: true, showOsm: false };
const FILTER_IDS = Object.keys(FILTER_DEFAULTS);
const FILTER_KEY = "climbing-map:filters";
// 縣市選單由北到南排
const CITY_ORDER = ["基隆市", "臺北市", "新北市", "桃園市", "新竹市", "新竹縣", "苗栗縣", "臺中市", "彰化縣", "南投縣", "雲林縣",
  "嘉義市", "嘉義縣", "臺南市", "高雄市", "屏東縣", "宜蘭縣", "花蓮縣", "臺東縣", "澎湖縣", "金門縣", "連江縣"];

function fillCityOptions() {
  const count = {};
  state.gyms.filter((g) => g.status !== "已停業").forEach((g) => { count[g.city] = (count[g.city] || 0) + 1; });
  const cities = Object.keys(count).sort((a, b) => (CITY_ORDER.indexOf(a) + 1 || 99) - (CITY_ORDER.indexOf(b) + 1 || 99));
  $("city").insertAdjacentHTML("beforeend", cities.map((c) => `<option value="${esc(c)}">${esc(c)}（${count[c]}）</option>`).join(""));
}

function getFilters() {
  return Object.fromEntries(FILTER_IDS.map((id) => [id, $(id).type === "checkbox" ? $(id).checked : $(id).value]));
}

function setFilters(f) {
  for (const id of FILTER_IDS) {
    if (!(id in f)) continue;
    if ($(id).type === "checkbox") $(id).checked = Boolean(f[id]);
    else if ([...$(id).options].some((o) => o.value === String(f[id]))) $(id).value = String(f[id]);
  }
}

function loadFilters() {
  try { setFilters(JSON.parse(localStorage.getItem(FILTER_KEY)) || {}); } catch { /* 沒有或讀不到就用預設值 */ }
}

function saveFilters() {
  try { localStorage.setItem(FILTER_KEY, JSON.stringify(getFilters())); } catch { /* 無痕模式等存不了就算了 */ }
}

function markerStyle(g) {
  const color = { ok: "#2b8a3e", warn: "#c77700", bad: "#b02a37" }[STATUS_CLASS[g.status] || "warn"];
  return { radius: hasBoulder(g) ? 9 : 7, color: "#fff", weight: 2, fillColor: color, fillOpacity: 0.95 };
}

function setStatus(msg, isError = false) {
  $("status").textContent = msg;
  $("status").classList.toggle("error", isError);
}

// ---------- 定位 ----------
function locate() {
  if (!navigator.geolocation) { state.geoError = "這個瀏覽器不支援定位"; render(); return; }
  if (!$("detail").hidden) closeDetail();   // 詳細資訊會蓋住地圖
  if (state.me) {
    centerOnMe();   // 已經有位置就先移過去，不等手機回報新位置
  } else {
    setStatus("正在取得你的位置…");
    state.firstFix = true;
  }
  if (state.watchId != null) return;   // 只開一個定位監聽
  state.watchId = navigator.geolocation.watchPosition(onPosition, (err) => {
    if (state.me) return;   // 已經有位置時，偶爾的逾時不用提示
    state.geoError = { 1: "你拒絕了定位權限（可到瀏覽器設定開啟）", 2: "目前無法取得位置", 3: "定位逾時" }[err.code] || err.message;
    render();
  }, { enableHighAccuracy: true, maximumAge: 15000, timeout: 20000 });
}

// 把地圖移到自己的位置，範圍跟清單的距離篩選一致；手機上扣掉下方清單蓋住的高度，藍點才不會被擋住
function centerOnMe() {
  const r = Number($("radius").value) || 10;
  const panel = $("panel");
  const covered = panel.offsetParent && getComputedStyle(panel).position === "absolute" ? panel.offsetHeight : 0;
  const go = () => map.fitBounds(L.latLng(state.me).toBounds(r * 2000), { paddingBottomRight: [0, covered] });
  // 剛點開某間館時地圖還在縮放動畫中，這時移動會被動畫蓋掉，等動畫結束再移
  if (map._animatingZoom) map.once("zoomend", go);
  else { map.stop(); go(); }
}

function onPosition(pos) {
  state.me = { lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy };
  state.geoError = "";
  meMarker.setLatLng(state.me).addTo(map);
  meCircle.setLatLng(state.me).setRadius(state.me.acc).addTo(map);
  if (state.firstFix) {
    state.firstFix = false;
    centerOnMe();
  }
  render();
}

// ---------- 清單 ----------
const minPrice = (g) => (g.price_min ? g.price_min.price : null);

// 縣市、預算、只看有抱石、顯示待確認：這幾個條件不需要定位
function visibleGyms(f) {
  const budget = Number(f.budget);
  return state.gyms.filter((g) =>
    g.status !== "已停業" &&
    (!f.boulderOnly || hasBoulder(g)) &&
    (f.showUnverified || g.status === "營業中") &&
    (!f.city || g.city === f.city) &&
    (!budget || (minPrice(g) != null && minPrice(g) <= budget)));
}

const byName = (a, b) => a.g.name.localeCompare(b.g.name, "zh-Hant");
const byDist = (a, b) => a.d - b.d;
const SORTERS = {
  dist: byDist,
  // 沒有價格的排最後；同價時有定位就近的先
  price: (a, b) => (minPrice(a.g) ?? Infinity) - (minPrice(b.g) ?? Infinity) || (a.d != null ? byDist(a, b) : byName(a, b)),
  city: (a, b) => ((CITY_ORDER.indexOf(a.g.city) + 1 || 99) - (CITY_ORDER.indexOf(b.g.city) + 1 || 99)) || byName(a, b),
};

function render() {
  const f = getFilters();
  const radiusKm = Number(f.radius), limit = Number(f.limit);
  const gyms = visibleGyms(f);
  const withCoord = gyms.filter((g) => g.lat != null);
  let shown = withCoord.map((g) => ({ g, d: state.me ? distM(state.me, g) : null }));
  const sortBy = f.sort === "dist" && !state.me ? "city" : f.sort;   // 還沒定位就先依縣市
  shown.sort(SORTERS[sortBy]);
  let outside = [];   // 範圍內太少時，補列範圍外最近的館（一樣要符合其他條件）
  if (state.me && radiusKm > 0) {
    const inRange = shown.filter((x) => x.d <= radiusKm * 1000);
    const want = Math.min(limit || MIN_LISTED, MIN_LISTED);
    if (inRange.length < want) {
      outside = shown.filter((x) => x.d > radiusKm * 1000).sort(byDist).slice(0, want - inRange.length);
    }
    shown = inRange;
  }
  if (limit) shown = shown.slice(0, limit);
  const changed = FILTER_IDS.filter((id) => String(f[id]) !== String(FILTER_DEFAULTS[id])).length;
  $("resetFilters").hidden = !changed;
  $("filterSummary").textContent = changed ? `篩選與排序（改了 ${changed} 項）` : "篩選與排序";

  const ids = new Set([...shown, ...outside].map((x) => x.g.id));
  state.markers.forEach((m, id) => (ids.has(id) ? m.addTo(map) : m.remove()));
  $("showOsm").checked ? state.osmLayer.addTo(map) : state.osmLayer.remove();

  $("list").innerHTML = (shown.map(({ g, d }) => listItem(g, d)).join("") ||
    `<li class="sub">沒有符合條件的館。</li>`) +
    (outside.length ? `<li class="divider">${radiusKm} 公里外最近的館</li>` + outside.map(({ g, d }) => listItem(g, d)).join("") : "");
  const noCoord = gyms.filter((g) => g.lat == null);
  $("nocoord").hidden = !noCoord.length;
  $("nocoordList").innerHTML = noCoord.map((g) => listItem(g, null)).join("");
  document.querySelectorAll(".list li[data-id]").forEach((li) => li.addEventListener("click", () => openDetail(li.dataset.id)));

  const conds = [f.city, Number(f.budget) ? `${f.budget} 元以下` : "", limit ? `前 ${limit} 間` : "",
    { dist: "", price: "價格低到高", city: "" }[f.sort]].filter(Boolean);
  const condText = conds.length ? `（${conds.join("、")}）` : "";
  if (state.me) {
    const where = radiusKm > 0 ? `${radiusKm} 公里內` : "符合條件";
    const more = outside.length ? `，另列範圍外最近 ${outside.length} 間` : "";
    setStatus(`${where}有 ${shown.length} 間${condText}${more}（定位誤差約 ${Math.round(state.me.acc)} 公尺）`);
  } else if (state.geoError) {
    setStatus(`${state.geoError}，無法依距離排序。共 ${shown.length} 間${condText}`, true);
  } else {
    setStatus(`共 ${shown.length} 間${condText}；開啟定位後可以依距離排序。`);
  }
}

function listItem(g, d) {
  const cls = STATUS_CLASS[g.status] || "warn";
  const first = (g.prices || [])[0];
  const price = g.price_min ? `入場 $${g.price_min.price} 起` : first ? `${first.item} ${fmtPrice(first.price)}` : "";
  const sub = [g.city + (g.district || ""), price, g.status !== "營業中" ? g.status : ""]
    .filter(Boolean).join("・");
  return `<li data-id="${esc(g.id)}"><span class="dot ${cls}"></span><div><div class="name">${esc(g.name)}</div>` +
    `<div class="sub">${esc(sub)}</div></div><span class="dist">${d != null ? fmtDist(d) : g.lat == null ? "位置待補" : ""}</span></li>`;
}

// ---------- 詳細資訊 ----------
function openDetail(id, pushHash = true) {
  const g = state.gyms.find((x) => x.id === id);
  if (!g) return;
  if (pushHash) history.replaceState(null, "", `#${id}`);
  if (g.lat != null) map.setView([g.lat, g.lng], Math.max(map.getZoom(), 15));
  const cls = STATUS_CLASS[g.status] || "warn";
  const types = (g.types || []).map((t) => TYPE_NAME[t] || t).join("、");
  const links = Object.entries(g.links || {}).map(([k, url]) =>
    `<a class="btn small" href="${esc(url)}" target="_blank" rel="noopener">${esc({ website: "官網", facebook: "Facebook", instagram: "Instagram", youtube: "YouTube", price_page: "價目表", booking: "預約" }[k] || k)}</a>`).join("");

  $("detailBody").innerHTML = `
    <h2>${esc(g.name)}</h2>
    <div class="meta"><span class="badge ${cls}">${esc(g.status)}</span> ${esc(types)}${g.name_en ? `・${esc(g.name_en)}` : ""}</div>
    <p>${esc(g.address || `${g.city}${g.district || ""}（地址待補）`)}${g.phone ? `<br>☎ <a href="tel:${esc(g.phone)}">${esc(g.phone)}</a>` : ""}</p>
    ${g.hours ? `<p>🕒 ${esc(g.hours)}</p>` : ""}
    ${g.features ? `<p>${esc(g.features)}</p>` : ""}
    <div class="row">${links}<a class="btn small" href="${gmapsSearch(g)}" target="_blank" rel="noopener">Google 地圖（評論・照片）</a></div>

    <h3>價格</h3>
    ${g.prices && g.prices.length ? `<table>${g.prices.map((p) =>
      `<tr><td>${esc(p.item)}${p.note ? `<div class="note">${esc(p.note)}</div>` : ""}</td><td class="price">${esc(fmtPrice(p.price))}</td></tr>`).join("")}</table>`
      : `<p class="note">還沒找到價格資料，請看官網或 Google 地圖。</p>`}

    <h3>交通建議</h3>
    <div id="transit">${transitHTML(g)}</div>

    ${g.youtube && g.youtube.length ? `<h3>影片・圖片</h3><div class="videos">${g.youtube.map((v) =>
      `<button type="button" data-yt="${esc(v.id)}"><img loading="lazy" alt="" src="https://i.ytimg.com/vi/${esc(v.id)}/hqdefault.jpg">${esc(v.title)}</button>`).join("")}</div>` : ""}

    <h3>留言</h3>
    <div id="comments"></div>

    <h3>資料來源</h3>
    ${sourcesHTML(g)}
  `;
  $("detail").hidden = false;
  $("detailBody").querySelectorAll("[data-yt]").forEach((b) => b.addEventListener("click", () => {
    b.outerHTML = `<iframe class="embed" src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(b.dataset.yt)}?autoplay=1" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen title="YouTube"></iframe>`;
  }));
  mountComments(g);
  enhanceTransit(g);
}

function closeDetail() {
  $("detail").hidden = true;
  history.replaceState(null, "", location.pathname + location.search);
}

function sourcesHTML(g) {
  const FIELD = { address: "地址", phone: "電話", hours: "營業時間", prices: "價格", features: "介紹", name: "館名", status: "營業狀態" };
  const items = Object.entries(g.src || {}).map(([field, ids]) => `<li>${esc(FIELD[field] || field)}：${ids.map((id) => {
    const s = state.sources[id];
    return s ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a>（${esc(s.published)}）` : esc(id);
  }).join("；")}</li>`);
  const coord = { osm: "OpenStreetMap 上的這間館", "nominatim:address": "用門牌定位", "nominatim:road": "只定位到路段，可能有誤差",
    "nominatim:place": "用地標定位", "nominatim:name": "用館名定位，可能有誤差", manual: "手動輸入", none: "找不到" }[g.coord_source] || "—";
  items.push(`<li>地圖位置：${esc(coord)}${g.osm ? `（<a href="${esc(g.osm.url)}" target="_blank" rel="noopener">OSM</a>）` : ""}</li>`);
  const verify = (g.verify || []).length ? `<p class="verify">待確認：${g.verify.map(esc).join("；")}</p>` : "";
  return `<ul class="sources">${items.join("")}</ul>${verify}<p class="note">資料整理於 ${esc(state.checked)}。發現錯誤歡迎在上方留言。</p>`;
}

// ---------- 交通 ----------
function transitHTML(g) {
  if (g.lat == null) return `<p class="note">這間館還沒有座標，<a href="${gmapsSearch(g)}" target="_blank" rel="noopener">用 Google 地圖查路線</a>。</p>`;
  const me = state.me;
  const d = me ? distM(me, g) : null;
  return `
    ${me ? `<p>直線距離 ${fmtDist(d)}</p>` : `<p class="note">開啟定位後可以算出從你的位置出發的建議。</p>`}
    <div class="row">
      <a class="btn small" href="${gmapsDir(g, "transit", me)}" target="_blank" rel="noopener">🚇 大眾運輸</a>
      <a class="btn small" href="${gmapsDir(g, "bicycling", me)}" target="_blank" rel="noopener">🚲 騎車</a>
      <a class="btn small" href="${gmapsDir(g, "walking", me)}" target="_blank" rel="noopener">🚶 步行</a>
    </div>
    <div id="ybPlan"><p class="note">正在計算 YouBike 路線…</p></div>`;
}

async function ensureStations() {
  if (!state.stations) {
    const data = await loadJSON("data/processed/youbike_stations.json");
    state.stations = data ? data.stations.map(([sno, name, lat, lng, total]) => ({ sno, name, lat, lng, total })) : [];
  }
  return state.stations;
}

// 嘗試直接抓臺北市即時車數（瀏覽器可能因跨網域限制失敗，失敗就只用 20 分鐘一次的快照）
async function tryLive() {
  if (state.live !== undefined) return state.live;
  state.live = null;
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 6000);
    const r = await fetch(LIVE_URL, { signal: ctrl.signal });
    const raw = await r.json();
    const counts = new Map();
    for (const s of Array.isArray(raw) ? raw : raw.retVal || []) {
      const rent = Number(s.available_rent_bikes ?? s.sbi);
      const ret = Number(s.available_return_bikes ?? s.bemp);
      if (Number.isFinite(rent) && !(rent === 0 && ret === 0)) counts.set(String(s.sno), { rent, ret, t: s.mday || "" });
    }
    if (counts.size) state.live = counts;
  } catch { /* 跨網域被擋或逾時 */ }
  return state.live;
}

function predict(sno, when) {
  const p = state.pattern && state.pattern[sno];
  if (!p) return null;
  const day = when.getDay();
  const slot = when.getHours() * 2 + Math.floor(when.getMinutes() / 30);
  const v = p[day === 0 || day === 6 ? "we" : "wd"][slot];
  return v ? { rent: v[0], ret: v[1], n: v[2] } : null;
}

function stationCounts(sno, live) {
  if (live && live.has(sno)) return { ...live.get(sno), how: "即時" };
  const s = state.near && state.near.stations[sno];
  if (s && s.rent != null) return { rent: s.rent, ret: s.ret, t: state.near.updated, how: `${state.near.updated} 快照` };
  return null;
}

async function enhanceTransit(g) {
  const box = $("ybPlan");
  if (!box || g.lat == null) return;
  if (!state.me) { box.innerHTML = ybNearGymHTML(g, null); return; }
  const [stations, live] = await Promise.all([ensureStations(), tryLive()]);
  if (!$("ybPlan")) return;
  const total = distM(state.me, g);
  const nearGym = ((state.near && state.near.gyms[g.id]) || []).map(([sno, d]) => ({ sno, d, ...(state.near.stations[sno] || {}) }));
  const nearMe = stations.map((s) => ({ ...s, d: distM(state.me, s) })).sort((a, b) => a.d - b.d).slice(0, 3).filter((s) => s.d <= 1000);

  if (total > YOUBIKE_MAX_KM * 1000) {
    box.innerHTML = `<div class="plan">距離超過 ${YOUBIKE_MAX_KM} 公里，建議搭大眾運輸（上方按鈕），到站後再看館附近的 YouBike。</div>${ybNearGymHTML(g, live)}`;
    return;
  }
  if (!nearMe.length || !nearGym.length) {
    const why = !stations.length ? "YouBike 站點資料還沒產生" : !nearMe.length ? "你附近 1 公里內沒有 YouBike 站" : "這間館附近 1 公里內沒有 YouBike 站";
    box.innerHTML = `<div class="plan">${why}，建議用上方的大眾運輸或步行路線。</div>`;
    return;
  }

  // 起點站：優先選有車的；終點站：優先選有空位的
  const pick = (list, key) => list.find((s) => { const c = stationCounts(s.sno, live); return c && c[key] > 0; }) || list[0];
  const a = pick(nearMe, "rent"), b = pick(nearGym, "ret");
  const walk1 = (a.d * DETOUR) / WALK_M_PER_MIN;
  const ride = (distM(a, b) * DETOUR) / BIKE_M_PER_MIN;
  const walk2 = (b.d * DETOUR) / WALK_M_PER_MIN;
  const now = new Date();
  const tPick = new Date(now.getTime() + walk1 * 60000), tDrop = new Date(tPick.getTime() + ride * 60000);
  const transitMin = (total * 1.4) / 350 + 10;   // 粗估：市區大眾運輸約 21 km/h＋候車 10 分

  box.innerHTML = `
    <div class="plan">
      <div class="total">YouBike 方案：約 ${fmtMin(walk1 + ride + walk2)}</div>
      <ol>
        <li>步行 ${fmtDist(a.d)}（約 ${fmtMin(walk1)}）到 <b>${esc(a.name)}</b> 借車<br>${countsLine(a.sno, live, tPick, "rent")}</li>
        <li>騎 ${fmtDist(distM(a, b) * DETOUR)}（約 ${fmtMin(ride)}）到 <b>${esc(b.name)}</b> 還車<br>${countsLine(b.sno, live, tDrop, "ret")}</li>
        <li>步行 ${fmtDist(b.d)}（約 ${fmtMin(walk2)}）到館</li>
      </ol>
      <div class="row">
        <a class="btn small" href="${gmapsDir(a, "walking", state.me)}" target="_blank" rel="noopener">走到借車站</a>
        <a class="btn small" href="${gmapsDir(b, "bicycling", a)}" target="_blank" rel="noopener">騎車路線</a>
        <a class="btn small" href="${gmapsDir(g, "walking", b)}" target="_blank" rel="noopener">走到館</a>
      </div>
      <p class="note">時間用直線距離 ×${DETOUR} 估算（步行 4.5、騎車 12 公里／小時）；同距離大眾運輸粗估約 ${fmtMin(transitMin)}，實際以 Google 地圖為準。</p>
    </div>
    ${ybNearGymHTML(g, live)}`;
}

function countsLine(sno, live, when, key) {
  const c = stationCounts(sno, live);
  const p = predict(sno, when);
  const label = key === "rent" ? "可借" : "可還";
  const parts = [];
  if (c) parts.push(`現在${label} ${c[key]}（${esc(c.how)}）`);
  if (p) parts.push(`${when.getHours()}:${String(when.getMinutes()).padStart(2, "0")} 歷史平均${label} ${p[key]}（${p.n} 筆）`);
  if (!parts.length) parts.push(`車數資料累積中，<a href="https://www.youbike.com.tw/region/main/stations/" target="_blank" rel="noopener">看 YouBike 官網即時車數</a>`);
  return `<span class="note">${parts.join("；")}</span>`;
}

function ybNearGymHTML(g, live) {
  const list = (state.near && state.near.gyms[g.id]) || [];
  if (!list.length) return "";
  return `<p class="note" style="margin-top:8px">館附近的 YouBike 站：</p><table>${list.map(([sno, d]) => {
    const s = state.near.stations[sno] || {};
    const c = stationCounts(sno, live);
    return `<tr><td>${esc(s.name || sno)}<div class="note">${fmtDist(d)}</div></td><td class="price">${c ? `借 ${c.rent}／還 ${c.ret}` : "—"}</td></tr>`;
  }).join("")}</table>`;
}

// ---------- 留言（giscus，存在 GitHub Discussions） ----------
function mountComments(g) {
  const box = $("comments");
  const cfg = (window.CLIMBING_CONFIG || {}).giscus || {};
  if (!cfg.repoId || !cfg.categoryId) {
    box.innerHTML = `<p class="note">留言區尚未開啟（需要在 repo 開啟 GitHub Discussions 並安裝 giscus，步驟見 README）。<br>
      想看大家的評論可以先看 <a href="${gmapsSearch(g)}" target="_blank" rel="noopener">Google 地圖</a>。</p>`;
    return;
  }
  const s = document.createElement("script");
  s.src = "https://giscus.app/client.js";
  Object.entries({
    "data-repo": cfg.repo, "data-repo-id": cfg.repoId, "data-category": cfg.category, "data-category-id": cfg.categoryId,
    "data-mapping": "specific", "data-term": `抱石館：${g.id}`, "data-strict": "1", "data-reactions-enabled": "1",
    "data-emit-metadata": "0", "data-input-position": "top", "data-lang": "zh-TW", "data-loading": "lazy",
    "data-theme": "preferred_color_scheme", crossorigin: "anonymous",
  }).forEach(([k, v]) => s.setAttribute(k, v));
  s.async = true;
  box.innerHTML = "";
  box.appendChild(s);
}

init();
