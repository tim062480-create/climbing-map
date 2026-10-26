// 岩館地圖go
// 資料：data/processed/gyms.json（館）、data/processed/youbike_*.json（YouBike），都由 GitHub Actions 定期更新。
"use strict";

// 直接在電腦上點開 index.html（file://）時：瀏覽器不讓網頁讀旁邊的資料檔，OSM 底圖也會擋（沒有網站來源），
// 整頁會像壞掉一樣。改成顯示一段說明和網站網址，後面的程式都不跑。
const SITE_URL = "https://tim062480-create.github.io/climbing-map/";
if (location.protocol === "file:") {
  document.body.innerHTML = `<main style="max-width:560px;margin:15vh auto;padding:0 20px;font:16px/1.7 system-ui,'Microsoft JhengHei',sans-serif">
    <h1 style="font-size:22px">這是網站的原始碼，請用網址打開</h1>
    <p>直接點開 <code>index.html</code> 時，瀏覽器不讓網頁讀取館的資料，地圖也載入不了，所以畫面會像壞掉一樣。</p>
    <p><a href="${SITE_URL}" style="font-size:20px">👉 打開岩館地圖go</a></p>
    <p style="color:#5f6b78;font-size:14px">資料夾裡的「打開岩館地圖go」也可以直接打開網站。</p></main>`;
  throw new Error("請用網址打開網站，不要直接開 index.html");
}

// seed 的 status 是「這間館還有沒有在營運」，不是「現在有沒有開」，畫面上改叫「仍在營運」以免誤會
const STATUS_LABEL = { "營業中": "仍在營運" };
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
  live: undefined,
  me: null, geoError: "", listed: [], detailId: null, typing: false, firstFix: true, watchId: null, markers: new Map(), osmLayer: null,
  favs: new Set(), news: {}, newsUpdated: "",
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
  state.favs = loadFavs();
  // 國定假日行事曆在背景讀；今天剛好是國定假日或補班日時，清單和打開的館重畫一次
  loadHolidays().then(() => {
    const t = new Date(), h = holidays.get(ymd(t));
    if (h && h.off !== (t.getDay() === 0 || t.getDay() === 6)) { render(); if (state.detailId) openDetail(state.detailId, false); }
  });
  $("checked").textContent = state.checked;
  const news = await loadJSON("data/processed/news.json");   // YouBike 等打開館的交通時才讀（見 ybNear）
  state.news = (news && news.gyms) || {};
  state.newsUpdated = (news && news.updated) || "";

  for (const g of state.gyms) {
    if (g.lat == null) continue;
    const m = L.circleMarker([g.lat, g.lng], markerStyle(g)).bindTooltip(g.name);
    m.on("click", () => openDetail(g.id));
    state.markers.set(g.id, m);
  }
  state.osmLayer = L.layerGroup(state.osmExtra.filter((p) => p.lat != null).map((p) =>
    L.circleMarker([p.lat, p.lng], { radius: 5, color: "#868e96", fillOpacity: 0.6, weight: 1 })
      .bindPopup(`<b>${esc(p.name || "（無名稱）")}</b><br>OpenStreetMap 上的攀岩地點，未人工確認<br><a href="${esc(p.url)}" target="_blank" rel="noopener">OSM</a>`)));

  buildPlaceIndex();
  $("q").value = new URLSearchParams(location.search).get("q") ?? loadQuery();
  let timer;
  $("q").addEventListener("input", () => { state.typing = true; renderSuggest(); clearTimeout(timer); timer = setTimeout(onQueryChange, 200); });
  $("q").addEventListener("focus", openSuggest);
  $("q").addEventListener("click", openSuggest);
  $("q").addEventListener("keydown", (e) => { if (e.key === "Escape") { closeSuggest(); $("q").blur(); } });
  $("suggest").addEventListener("mousedown", (e) => e.preventDefault());   // 點選項時不要讓搜尋框失去焦點
  $("suggest").addEventListener("click", onSuggestClick);
  document.addEventListener("pointerdown", (e) => { if (!$("searchForm").contains(e.target)) closeSuggest(); });
  $("searchForm").addEventListener("submit", (e) => { e.preventDefault(); onQueryChange(); closeSuggest(); $("q").blur(); revealResults(); });
  $("chips").addEventListener("click", onChipClick);
  $("locate").addEventListener("click", locate);
  map.on("moveend", drawYbStations);
  $("favsTop").addEventListener("click", onFavsTop);
  $("authBtn").addEventListener("click", () => (auth.user ? logout() : login()));
  $("loginGo").addEventListener("click", login);
  $("loginCancel").addEventListener("click", hideLogin);
  setupAuth();
  setupPanel();
  $("closeDetail").addEventListener("click", closeDetail);
  window.addEventListener("hashchange", () => { const id = location.hash.slice(1); if (id) openDetail(id, false); });

  render();
  if (searchesPlace(parseQuery($("q").value))) fitToGyms(state.listed);
  locate();
  if (location.hash.length > 1) openDetail(location.hash.slice(1), false);
}

const searchesPlace = (c) => c.cities.length || c.districts.length || c.names.length || c.fav;

// ---------- 最愛 ----------
// 有設定 Google 登入（config.js 的 firebase）時：最愛存在登入的帳號裡，沒登入的人按「加入最愛」會請他登入。
// 沒設定登入時：最愛存在這台裝置的瀏覽器裡。
const FAV_KEY = "climbing-map:fav";
function loadFavs() {
  try {
    const saved = localStorage.getItem(FAV_KEY);
    if (saved != null) return new Set(JSON.parse(saved));
  } catch { /* 無痕模式或資料壞掉就當作沒有 */ }
  return new Set();
}

function toggleFav(id) {
  if (auth.enabled && !auth.user) { showLogin("登入 Google 帳號才能存最愛"); return; }
  state.favs.has(id) ? state.favs.delete(id) : state.favs.add(id);
  if (auth.user) saveCloudFavs();
  else try { localStorage.setItem(FAV_KEY, JSON.stringify([...state.favs])); } catch { /* 存不了就只在這次有效 */ }
  refreshFavs();
}

// 最愛變了（加入、取消、登入、登出）：地圖外圈、清單、按鈕都重畫
function refreshFavs() {
  for (const g of state.gyms) { const m = state.markers.get(g.id); if (m) m.setStyle(markerStyle(g)); }
  render();
  if (state.detailId) renderFavBtn(state.detailId);
}

// ---------- 登入（Firebase：Google 帳號登入，最愛存在 Firestore 的 users/{uid}） ----------
// 安全規則見 docs/Google登入設定步驟.md：每個人只能讀寫自己的那一份。
const FB_VER = "10.12.2";
const auth = { enabled: false, user: null, fb: null };

async function setupAuth() {
  const cfg = (window.CLIMBING_CONFIG || {}).firebase || {};
  if (!cfg.apiKey || !cfg.projectId) return;   // 沒設定：不顯示登入，最愛存在這台裝置
  try {
    const base = `https://www.gstatic.com/firebasejs/${FB_VER}`;
    const [{ initializeApp }, A, F] = await Promise.all([
      import(`${base}/firebase-app.js`), import(`${base}/firebase-auth.js`), import(`${base}/firebase-firestore.js`)]);
    const app = initializeApp(cfg);
    auth.fb = { A, F, auth: A.getAuth(app), db: F.getFirestore(app) };
  } catch (e) {
    console.warn("Firebase 載入失敗，最愛先存在這台裝置", e);
    return;
  }
  auth.enabled = true;
  renderAuthBtn();
  const { A } = auth.fb;
  A.getRedirectResult(auth.fb.auth).catch(() => { /* 不是從登入頁回來 */ });
  A.onAuthStateChanged(auth.fb.auth, onAuth);
}

// 登入狀態變了：登入就讀帳號的最愛（第一次登入把這台裝置的併進去），登出就清空
async function onAuth(u) {
  const { F, db } = auth.fb;
  auth.user = u;
  if (u) {
    const ref = F.doc(db, "users", u.uid);
    try {
      const snap = await F.getDoc(ref);
      let favs = snap.exists() ? snap.data().favorites || [] : [];
      // 第一次登入：把這台裝置以前存的最愛併進帳號
      const local = [...loadFavs()];
      if (!snap.exists() && local.length) {
        favs = [...new Set([...favs, ...local])];
        await F.setDoc(ref, { favorites: favs, updatedAt: F.serverTimestamp() });
      }
      state.favs = new Set(favs);
    } catch (e) {
      console.warn("讀取帳號的最愛失敗", e);
      setStatus("讀取帳號的最愛失敗，請重新整理。", true);
    }
    hideLogin();
  } else {
    state.favs = new Set();   // 沒登入：沒有最愛
  }
  renderAuthBtn();
  refreshFavs();
}

async function saveCloudFavs() {
  const { F, db } = auth.fb;
  try {
    await F.setDoc(F.doc(db, "users", auth.user.uid), { favorites: [...state.favs], updatedAt: F.serverTimestamp() });
  } catch (e) {
    console.warn("最愛存到帳號失敗", e);
    setStatus("最愛沒有存到帳號，請檢查網路後再試一次。", true);
  }
}

async function login() {
  const { A } = auth.fb;
  const provider = new A.GoogleAuthProvider();
  try {
    await A.signInWithPopup(auth.fb.auth, provider);
  } catch (e) {
    // 跳出視窗被擋（有些手機瀏覽器）就改成整頁跳轉到 Google 登入
    if (/popup-blocked|operation-not-supported/.test(e.code || "")) await A.signInWithRedirect(auth.fb.auth, provider);
    else if (!/popup-closed|cancelled-popup/.test(e.code || "")) alert(`登入失敗：${e.message}`);
  }
}

function logout() {
  if (confirm(`要登出 ${auth.user.email || ""} 嗎？登出後最愛不會顯示，再登入就回來。`)) auth.fb.A.signOut(auth.fb.auth);
}

// 右上角：沒登入是「登入」按鈕，登入後是頭像（點了可以登出）
function renderAuthBtn() {
  const b = $("authBtn");
  b.hidden = !auth.enabled;
  if (!auth.enabled) return;
  const u = auth.user;
  b.innerHTML = u
    ? (u.photoURL ? `<img src="${esc(u.photoURL)}" alt="" referrerpolicy="no-referrer">` : "👤")
    : `<span class="g">G</span><span class="label"> 登入</span>`;
  b.title = u ? `${u.displayName || u.email}（點一下登出）` : "用 Google 帳號登入，最愛存在帳號裡";
  b.setAttribute("aria-label", u ? "帳號，點一下登出" : "用 Google 登入");
}

function showLogin(reason) {
  $("loginReason").textContent = reason;
  $("loginBox").hidden = false;
}
function hideLogin() { $("loginBox").hidden = true; }

// ---------- 下方清單面板（手機）：收起 collapsed／一半 normal／拉高 expanded ----------
// 一開始收起來讓地圖大一點；點拉把或往上滑展開，往下滑或點地圖收起；搜尋、按 ⭐ 時自動展開
const PANEL_STEPS = ["collapsed", "normal", "expanded"];
const isPhone = () => matchMedia("(max-width: 899px)").matches;

function setPanel(mode) {
  const p = $("panel");
  p.classList.toggle("collapsed", mode === "collapsed");
  p.classList.toggle("expanded", mode === "expanded");
  if (mode === "collapsed") p.scrollTop = 0;
  $("handleHint").textContent = mode === "collapsed" ? "▲ 看清單" : "▼ 收起";
}

const panelMode = () => PANEL_STEPS.find((m) => $("panel").classList.contains(m)) || "normal";

function setupPanel() {
  const h = $("handle");
  if (isPhone()) setPanel("collapsed");
  else setPanel("normal");
  // 點拉把：收起 ↔ 一半
  h.addEventListener("click", () => setPanel(panelMode() === "collapsed" ? "normal" : "collapsed"));
  h.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); h.click(); } });
  // 在拉把或狀態列上滑動：往上一階、往下一階
  let y0 = null;
  const zones = [h, $("status")];
  zones.forEach((z) => {
    z.addEventListener("touchstart", (e) => { y0 = e.touches[0].clientY; }, { passive: true });
    z.addEventListener("touchend", (e) => {
      if (y0 == null) return;
      const dy = e.changedTouches[0].clientY - y0;
      y0 = null;
      if (Math.abs(dy) < 30) return;
      const i = PANEL_STEPS.indexOf(panelMode());
      setPanel(PANEL_STEPS[Math.max(0, Math.min(2, i + (dy < 0 ? 1 : -1)))]);
    });
  });
  // 收起時點狀態列也能展開
  $("status").addEventListener("click", () => { if (panelMode() === "collapsed") setPanel("normal"); });
  // 點地圖空白處：收起清單，地圖看得比較清楚
  map.on("click", () => { if (isPhone() && $("detail").hidden) setPanel("collapsed"); });
}

// 使用者主動搜尋時，清單收著就打開到一半，結果才看得到
function revealResults() {
  if (isPhone() && panelMode() === "collapsed") setPanel("normal");
}

// 上方的 ⭐ 按鈕：點一下只看最愛（搜尋框換成「最愛」），再點一下回到原本的搜尋
function onFavsTop() {
  if (auth.enabled && !auth.user) { showLogin("登入 Google 帳號就能看、存你的最愛"); return; }
  const on = parseQuery($("q").value).fav;
  if (on) {
    $("q").value = state.qBeforeFav ?? normalizeQuery($("q").value).replace(Q_RE.fav, " ").replace(/\s+/g, " ").trim();
    state.qBeforeFav = null;
  } else {
    state.qBeforeFav = $("q").value;
    $("q").value = "最愛";
    if (!$("detail").hidden) closeDetail();
    setPanel("expanded");   // 手機上把清單拉高，最愛一眼看得到
  }
  onQueryChange();
}

function renderFavsTop(c) {
  const b = $("favsTop");
  b.setAttribute("aria-pressed", String(Boolean(c.fav)));
  $("favCount").textContent = state.favs.size ? String(state.favs.size) : "";
}

function renderFavBtn(id) {
  const b = $("favBtn");
  if (!b) return;
  const on = state.favs.has(id);
  b.setAttribute("aria-pressed", on);
  b.textContent = on ? "★ 已加入最愛" : "☆ 加入最愛";
}

// ---------- 搜尋框 ----------
// 一個框打所有條件，例如「台中 300 以下 最便宜」「最近 5 間」「內湖」「原岩」「上攀 3 公里」。
// 搜尋字串記在網址 ?q=（可以分享）和這台裝置的瀏覽器裡（下次打開沿用）。
const QUERY_KEY = "climbing-map:q";
const DEFAULT_RADIUS_KM = 10;   // 沒指定地點、館名、範圍時，有定位就先看附近這麼遠
const CITY_ORDER = ["基隆市", "臺北市", "新北市", "桃園市", "新竹市", "新竹縣", "苗栗縣", "臺中市", "彰化縣", "南投縣", "雲林縣",
  "嘉義市", "嘉義縣", "臺南市", "高雄市", "屏東縣", "宜蘭縣", "花蓮縣", "臺東縣", "澎湖縣", "金門縣", "連江縣"];
const SUGGESTIONS = ["最愛", "最近 5 間", "最便宜", "300 以下", "台北", "台中", "高雄"];
const STOPWORDS = /抱石館|攀岩館|攀岩場|抱石|攀岩|岩館|我想|想要|幫我|找|的|在|有|和|跟|與|及|或|以及/g;
// 搜尋框認得的關鍵字（解析和下拉選單共用）
const Q_RE = {
  fav: /我的最愛|最愛|收藏/g,
  budget: /(?:預算|低於|不超過|[<≤])\s*(\d{2,4})\s*(?:元|塊)?|(\d{2,4})\s*(?:元|塊)?\s*(?:以下|以內|內|有找)/g,
  km: /(\d+(?:\.\d+)?)\s*(?:公里|km|k)(?:以內|內)?/gi,
  anywhere: /全臺|全國|不限距離|不限範圍|不限/g,
  limit: /前\s*(\d+|[一二兩三四五六七八九十]{1,2})\s*(?:間|家|個)?|(\d+|[一二兩三四五六七八九十]{1,2})\s*(?:間|家|個)/g,
  cheap: /最?便宜|價格|低價|划算|省錢/g,
  near: /最近|附近|離我|距離/g,
  lead: /上攀|先鋒|綁繩|top\s*rope|lead/gi,
  open: /現在有開|現在營業|營業中|有開/g,
  day: /全日|整天|不限時|包日/g,
  osm: /osm/gi,
};
const CN_NUM = { 一: 1, 二: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
const toNum = (s) => (/^\d+$/.test(s) ? Number(s) : s.length === 2 && s[0] === "十" ? 10 + CN_NUM[s[1]] : s.length === 2 && s[1] === "十" ? CN_NUM[s[0]] * 10 : CN_NUM[s] || 0);

let PLACES = [];   // [{ key: 比對用的字, city?, district? }]，長的先比
function buildPlaceIndex() {
  const add = (key, v) => { if (key.length >= 2) PLACES.push({ key, ...v }); };
  CITY_ORDER.forEach((c) => { add(c, { city: c }); add(c.slice(0, 2), { city: c }); });
  for (const g of state.gyms) {
    if (!g.district) continue;
    add(g.district, { district: g.district });
    add(g.district.replace(/[區市鄉鎮]$/, ""), { district: g.district });
  }
  const seen = new Set();
  PLACES = PLACES.filter((p) => { const k = p.key + (p.city || p.district); return !seen.has(k) && seen.add(k); })
    .sort((a, b) => b.key.length - a.key.length);
}

const normalizeQuery = (q) => q
  .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))   // 全形英數轉半形
  .replace(/台/g, "臺").replace(/　/g, " ").trim();

// 把搜尋字串拆成條件；chips 是畫面上顯示的標籤，每個都記得自己來自哪段文字（raw），按 ✕ 就把那段拿掉
function parseQuery(q) {
  let s = normalizeQuery(q);
  const c = { cities: [], districts: [], names: [], budget: 0, radius: null, limit: 0, sort: null, lead: false, openNow: false, osm: false, fav: false, chips: [] };
  const take = (re, fn) => { s = s.replace(re, (...m) => { fn(...m); return " "; }); };

  take(Q_RE.fav, (raw) => { c.fav = true; c.chips.push({ raw, label: "⭐ 只看最愛" }); });
  take(Q_RE.budget, (raw, a, b) => { c.budget = Number(a || b); c.chips.push({ raw, label: `$${c.budget} 以下` }); });
  take(Q_RE.km, (raw, n) => { c.radius = Number(n); c.chips.push({ raw, label: `${n} 公里內` }); });
  take(Q_RE.anywhere, (raw) => { c.radius = 0; c.chips.push({ raw, label: "不限距離" }); });
  take(Q_RE.limit, (raw, a, b) => { c.limit = toNum(a || b); if (c.limit) c.chips.push({ raw, label: `前 ${c.limit} 間` }); });
  take(Q_RE.cheap, (raw) => { c.sort = "price"; c.chips.push({ raw, label: "價格低到高" }); });
  take(Q_RE.near, (raw) => { c.sort = "dist"; c.chips.push({ raw, label: "距離近到遠" }); });
  take(Q_RE.lead, (raw) => { c.lead = true; c.chips.push({ raw, label: "含只有上攀的館" }); });
  take(Q_RE.open, (raw) => { c.openNow = true; c.chips.push({ raw, label: "現在有開" }); });
  take(Q_RE.day, (raw) => { c.dayOnly = true; c.chips.push({ raw, label: "價格不算計時" }); });
  take(Q_RE.osm, (raw) => { c.osm = true; c.chips.push({ raw, label: "顯示 OSM 上其他攀岩地點" }); });
  // 地名先比（可以黏在一起打，例如「臺中西屯」，長的地名先比），再刪「的、和」這類贅字，不然「永和」會被拆掉
  for (const p of PLACES) {
    if (!s.includes(p.key)) continue;
    s = s.replace(p.key, " ");
    if (p.city) { const all = PLACES.filter((x) => x.key === p.key && x.city).map((x) => x.city); c.cities.push(...all); c.chips.push({ raw: p.key, label: `📍 ${all.join("、")}` }); }
    else { c.districts.push(p.district); c.chips.push({ raw: p.key, label: `📍 ${p.district}` }); }
  }
  s = s.replace(STOPWORDS, " ");

  for (const word of s.split(/[\s,，、;；/]+/).filter(Boolean)) {
    const t = word.toLowerCase();
    if (state.gyms.some((g) => gymText(g).includes(t))) { c.names.push(t); c.chips.push({ raw: word, label: `館名含「${word}」` }); }
    else c.chips.push({ raw: word, label: `看不懂「${word}」`, unknown: true });
  }
  c.cities = [...new Set(c.cities)];
  // 沒指定地點、館名、最愛或範圍時，有定位就先看附近
  c.radiusAuto = c.radius == null && !searchesPlace(c);
  if (c.radius == null) c.radius = c.radiusAuto ? DEFAULT_RADIUS_KM : 0;
  return c;
}

const gymText = (g) => [g.name, g.name_en, g.brand, g.address].join(" ").replace(/台/g, "臺").toLowerCase();

function loadQuery() {
  try { return localStorage.getItem(QUERY_KEY) || ""; } catch { return ""; }
}

function onQueryChange() {
  const q = $("q").value.trim();
  try { localStorage.setItem(QUERY_KEY, q); } catch { /* 無痕模式等存不了就算了 */ }
  const url = new URL(location.href);
  q ? url.searchParams.set("q", q) : url.searchParams.delete("q");
  history.replaceState(null, "", url);
  render();
  if (searchesPlace(parseQuery(q))) fitToGyms(state.listed);   // 搜了地點或館名，地圖移到搜尋結果
}

function fitToGyms(gyms) {
  if (!gyms.length) return;
  const panel = $("panel");
  const covered = getComputedStyle(panel).position === "absolute" ? panel.offsetHeight : 0;
  map.stop();
  map.fitBounds(L.latLngBounds(gyms.map((g) => [g.lat, g.lng])), { paddingTopLeft: [30, 30], paddingBottomRight: [30, covered + 30], maxZoom: 15 });
}

function onChipClick(e) {
  const chip = e.target.closest("[data-raw], [data-add]");
  if (!chip) return;
  if (chip.dataset.add) $("q").value = `${$("q").value} ${chip.dataset.add}`.trim();
  else $("q").value = normalizeQuery($("q").value).replace(chip.dataset.raw, " ").replace(/\s+/g, " ").trim();
  onQueryChange();
  revealResults();
}

// ---------- 搜尋框下拉選單 ----------
// 點搜尋框：列出可以選的條件（再點一次取消，同一組只能選一個）；打字時：列出符合的地區、館名
const toRe = (s) => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
function suggestGroups() {
  const count = {};
  state.gyms.filter((g) => g.status !== "已停業").forEach((g) => { count[g.city] = (count[g.city] || 0) + 1; });
  const cities = Object.keys(count).sort((a, b) => (CITY_ORDER.indexOf(a) + 1 || 99) - (CITY_ORDER.indexOf(b) + 1 || 99));
  return [
    { title: "排序", one: [Q_RE.cheap, Q_RE.near], items: [
      { label: "最便宜", on: (c) => c.sort === "price" }, { label: "最近", on: (c) => c.sort === "dist" }] },
    { title: "預算（一次入場）", one: [Q_RE.budget], items: [200, 250, 300, 350, 400].map((n) => ({ label: `${n} 以下`, on: (c) => c.budget === n })) },
    { title: "顯示幾間", one: [Q_RE.limit], items: [3, 5, 10].map((n) => ({ label: `前 ${n} 間`, on: (c) => c.limit === n })) },
    { title: "距離（開定位後）", one: [Q_RE.km, Q_RE.anywhere], items: [
      ...[3, 5, 10, 30].map((n) => ({ label: `${n} 公里`, on: (c) => !c.radiusAuto && c.radius === n })),
      { label: "不限距離", on: (c, q) => toRe("不限").test(q) }] },
    { title: "其他", items: [
      { label: "最愛", re: Q_RE.fav, count: state.favs.size, on: (c) => c.fav },
      { label: "現在有開", re: Q_RE.open, on: (c) => c.openNow },
      { label: "上攀", re: Q_RE.lead, on: (c) => c.lead },
      { label: "全日", re: Q_RE.day, on: (c) => c.dayOnly }] },
    // 短名稱（台北）重複時（新竹市、新竹縣）用全名
    { title: "地區", items: cities.map((city) => {
      const short = cities.filter((x) => x.slice(0, 2) === city.slice(0, 2)).length > 1 ? city : city.slice(0, 2);
      return { label: short.replace("臺", "台"), count: count[city], re: new RegExp(short === city ? city : `${short}(?:${city.slice(2)})?`, "g"),
        on: (c) => c.cities.includes(city) };
    }) },
  ];
}

function openSuggest() { if ($("suggest").hidden) state.typing = false; $("suggest").hidden = false; renderSuggest(); }
function closeSuggest() { $("suggest").hidden = true; }

function renderSuggest() {
  const box = $("suggest");
  if (box.hidden) return;
  const raw = $("q").value;
  const q = normalizeQuery(raw), c = parseQuery(raw);
  // 正在打的那個字（剛從選單選完、或結尾是空白時就不算）
  const partial = !state.typing || /\s$/.test(raw) ? "" : normalizeQuery(raw.split(/\s+/).pop() || "");
  const groups = suggestGroups();
  let html = "";

  // 打字中：先列符合的地區、館名（點館名直接打開那間）
  if (partial) {
    const seen = new Set(), places = [];
    for (const p of PLACES) {
      const target = p.city || p.district;
      if (!p.key.includes(partial) || seen.has(target)) continue;
      seen.add(target);
      const city = p.city || (state.gyms.find((g) => g.district === p.district) || {}).city;
      places.push({ key: p.key, label: p.city ? p.city : `${p.district}（${city}）` });
    }
    const t = partial.toLowerCase();
    const gyms = state.gyms.filter((g) => g.status !== "已停業" && gymText(g).includes(t)).slice(0, 6);
    html += places.slice(0, 5).map((p) => `<button type="button" class="hit" data-replace="${esc(p.key)}">📍 ${esc(p.label)}</button>`).join("");
    html += gyms.map((g) => `<button type="button" class="hit" data-gym="${esc(g.id)}">🧗 ${esc(g.name)}<small>${esc(g.city + (g.district || ""))}</small></button>`).join("");
  }
  // 打字中只列名稱符合或已選的條件；什麼都沒對到就全部列出來
  const keywordHit = groups.some((gr) => gr.items.some((it) => normalizeQuery(it.label).includes(partial)));
  const showAll = !partial || (!html && !keywordHit);
  html += groups.map((gr, gi) => {
    const items = gr.items.map((it, ii) => ({ it, ii })).filter(({ it }) => showAll || it.on(c, q) || normalizeQuery(it.label).includes(partial));
    if (!items.length) return "";
    return `<h4>${esc(gr.title)}</h4><div class="opts">${items.map(({ it, ii }) =>
      `<button type="button" class="opt" data-g="${gi}" data-i="${ii}" aria-pressed="${Boolean(it.on(c, q))}">${esc(it.label)}${it.count ? ` <small>${it.count}</small>` : ""}</button>`).join("")}</div>`;
  }).join("");
  const n = c.chips.filter((x) => !x.unknown).length;
  html += `<div class="done"><span>${n ? `已選 ${n} 個條件` : "可以選很多個，會疊加"}</span><span>
    ${n ? `<button type="button" class="opt" data-clear>清除全部</button> ` : ""}<button type="button" class="opt" data-close aria-pressed="true">完成</button></span></div>`;
  box.innerHTML = html;
}

function onSuggestClick(e) {
  const b = e.target.closest("button");
  if (!b) return;
  const input = $("q");
  state.typing = false;
  if (b.dataset.close != null) { closeSuggest(); input.blur(); return; }
  if (b.dataset.clear != null) { input.value = ""; onQueryChange(); renderSuggest(); return; }
  if (b.dataset.gym) { input.value = input.value.replace(/\S*$/, "").trim(); onQueryChange(); closeSuggest(); input.blur(); openDetail(b.dataset.gym); return; }
  if (b.dataset.replace) {
    input.value = `${input.value.replace(/\S*$/, "")}${b.dataset.replace} `;
  } else {
    const gr = suggestGroups()[b.dataset.g], it = gr.items[b.dataset.i];
    let q = normalizeQuery(input.value);
    const c = parseQuery(q);
    const strip = (res) => { for (const re of res) q = q.replace(re, " "); };
    if (it.on(c, q)) strip(gr.one || [it.re]);                        // 已選 → 取消
    else { if (gr.one) strip(gr.one); q = `${q} ${it.label}`; }        // 同一組只留一個
    input.value = q.replace(/\s+/g, " ").trim();
    if (matchMedia("(max-width: 599px)").matches) input.blur();       // 手機收起鍵盤，選單才看得到
  }
  onQueryChange();
  renderSuggest();
  revealResults();
}

function renderChips(c) {
  const chips = c.chips.map((x) => `<span class="chip${x.unknown ? " unknown" : ""}">${esc(x.label)}` +
    `<button type="button" data-raw="${esc(x.raw)}" aria-label="拿掉這個條件">✕</button></span>`);
  if (state.me && c.radiusAuto) {
    chips.push(`<span class="chip">附近 ${DEFAULT_RADIUS_KM} 公里<button type="button" data-add="不限距離" aria-label="不限距離">✕</button></span>`);
  }
  if (!c.chips.length) {
    chips.push(...SUGGESTIONS.map((s) => `<button type="button" class="chip suggest" data-add="${esc(s)}">${esc(s)}</button>`));
  }
  $("chips").innerHTML = chips.join("");
}

function markerStyle(g) {
  const color = { ok: "#2b8a3e", warn: "#c77700", bad: "#b02a37" }[STATUS_CLASS[g.status] || "warn"];
  const fav = state.favs.has(g.id);   // 最愛的館外圈改成金色
  return { radius: hasBoulder(g) ? 9 : 7, color: fav ? "#f59f00" : "#fff", weight: fav ? 3 : 2, fillColor: color, fillOpacity: 0.95 };
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
  const r = parseQuery($("q").value).radius || DEFAULT_RADIUS_KM;
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
    // 正在看某間館的詳細資訊：補算交通路線，地圖不跳走
    const open = state.detailId && state.gyms.find((x) => x.id === state.detailId);
    if (open) { $("transit").innerHTML = transitHTML(open); enhanceTransit(open); }
    else if (!searchesPlace(parseQuery($("q").value))) centerOnMe();   // 正在看搜尋的地點時不要跳走
  }
  render();
}

// ---------- 清單 ----------
// 價格用 price_min（含計時，以 1 小時算）；搜尋「全日」時改用 price_day（只看一次入場的票）
const priceOf = (g) => (state.dayOnly ? g.price_day : g.price_min) || null;
const minPrice = (g) => (priceOf(g) ? priceOf(g).price : null);

// 地點、館名、預算、類型、狀態：這幾個條件不需要定位
function visibleGyms(c) {
  return state.gyms.filter((g) =>
    g.status !== "已停業" &&
    (!c.fav || state.favs.has(g.id)) &&
    (c.lead || c.fav || hasBoulder(g)) &&   // 最愛的館就算只有上攀也列出來
    (!c.openNow || (g.status === "營業中" && (openState(g) || {}).open)) &&
    (!c.cities.length || c.cities.includes(g.city)) &&
    (!c.districts.length || c.districts.includes(g.district)) &&
    c.names.every((t) => gymText(g).includes(t)) &&
    (!c.budget || (minPrice(g) != null && minPrice(g) <= c.budget)));
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
  const c = parseQuery($("q").value);
  state.dayOnly = Boolean(c.dayOnly);
  const radiusKm = c.radius, limit = c.limit;
  const gyms = visibleGyms(c);
  const withCoord = gyms.filter((g) => g.lat != null);
  let shown = withCoord.map((g) => ({ g, d: state.me ? distM(state.me, g) : null }));
  const sortBy = c.sort === "price" ? "price" : state.me ? "dist" : "city";   // 預設有定位依距離，沒定位依縣市
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
  state.listed = shown.map((x) => x.g);
  renderChips(c);
  renderFavsTop(c);

  const ids = new Set([...shown, ...outside].map((x) => x.g.id));
  state.markers.forEach((m, id) => (ids.has(id) ? m.addTo(map) : m.remove()));
  c.osm ? state.osmLayer.addTo(map) : state.osmLayer.remove();

  $("list").innerHTML = (shown.map(({ g, d }) => listItem(g, d)).join("") ||
    (c.fav && !state.favs.size ? `<li class="sub">${auth.enabled && !auth.user ? "登入 Google 帳號後，按館的「☆ 加入最愛」就會出現在這裡。" : "還沒有最愛。打開館的詳細資訊，按「☆ 加入最愛」就會出現在這裡。"}</li>` : `<li class="sub">沒有符合條件的館。</li>`)) +
    (outside.length ? `<li class="divider">${radiusKm} 公里外最近的館</li>` + outside.map(({ g, d }) => listItem(g, d)).join("") : "");
  const noCoord = gyms.filter((g) => g.lat == null);
  $("nocoord").hidden = !noCoord.length;
  $("nocoordList").innerHTML = noCoord.map((g) => listItem(g, null)).join("");
  document.querySelectorAll(".list li[data-id]").forEach((li) => li.addEventListener("click", () => openDetail(li.dataset.id)));

  if (state.me) {
    const where = radiusKm > 0 ? `${radiusKm} 公里內有` : "找到";
    const more = outside.length ? `，另列範圍外最近 ${outside.length} 間` : "";
    setStatus(`${where} ${shown.length} 間${more}（定位誤差約 ${Math.round(state.me.acc)} 公尺）`);
  } else if (state.geoError) {
    setStatus(`${state.geoError}，無法依距離排序。找到 ${shown.length} 間`, true);
  } else {
    setStatus(`找到 ${shown.length} 間；開啟定位後可以依距離排序。`);
  }
}

function listItem(g, d) {
  const cls = STATUS_CLASS[g.status] || "warn";
  const first = (g.prices || [])[0];
  const p = priceOf(g);
  const price = p ? `入場 $${p.price}${p.per_hour ? "／小時" : ""} 起` : first ? `${first.item} ${fmtPrice(first.price)}` : "";
  const os = g.status === "營業中" ? openState(g) : null;
  const sub = [g.city + (g.district || ""), price, g.status !== "營業中" ? g.status : os ? (os.open ? "營業中" : "已打烊") : ""]
    .filter(Boolean).join("・");
  const n = freshNews(g);
  return `<li data-id="${esc(g.id)}"><span class="dot ${cls}"></span><div><div class="name">${state.favs.has(g.id) ? "⭐ " : ""}${esc(g.name)}</div>` +
    `<div class="sub">${esc(sub)}</div>${n ? `<div class="sub fresh">🆕 ${esc(n.date.slice(5).replace("-", "/"))} ${esc(n.title)}</div>` : ""}</div><span class="dist">${d != null ? fmtDist(d) : g.lat == null ? "位置待補" : ""}</span></li>`;
}

// ---------- 近期動態（data/processed/news.json，每半個月更新） ----------
const FRESH_DAYS = 15;
// 最近 FRESH_DAYS 天內的最新一則，清單上顯示「🆕」
function freshNews(g) {
  const n = (state.news[g.id] || [])[0];
  return n && n.date >= new Date(Date.now() - FRESH_DAYS * 864e5).toISOString().slice(0, 10) ? n : null;
}

function newsHTML(g) {
  const items = state.news[g.id] || [];
  const ICON = { news: "📰", youtube: "▶️", website: "🌐" };
  const social = ["facebook", "instagram"].filter((k) => (g.links || {})[k]).map((k) =>
    `<a class="btn small" href="${esc(g.links[k])}" target="_blank" rel="noopener">${k === "facebook" ? "Facebook" : "Instagram"} 最新貼文</a>`).join("");
  return (items.length ? `<ul class="news">${items.map((n) =>
    `<li>${ICON[n.kind] || "📰"} <a href="${esc(n.url)}" target="_blank" rel="noopener">${esc(n.title)}</a><div class="note">${esc(n.date)}・${esc(n.source)}</div></li>`).join("")}</ul>`
    : `<p class="note">最近半年沒有找到這間館的新聞、影片或官網公告。</p>`) +
    (social ? `<div class="row">${social}</div>` : "") +
    `<p class="note">每半個月自動更新${state.newsUpdated ? `（上次 ${esc(state.newsUpdated)}）` : ""}。只抓館方的官網和 YouTube（例如原岩新訊、官網上的活動與課程）；Facebook、Instagram 的貼文沒辦法自動抓，請點連結看。</p>`;
}

// ---------- 現在有沒有開、現在入場多少錢 ----------
// open_hours、prices[].when 由 src/hours_prices.py 產生；國定假日、補班日用 ruyut/TaiwanCalendar（政府行事曆整理）
const holidays = new Map();   // "20261010" → { off: 是否放假, desc: "國慶日" }
const WEEK = ["日", "一", "二", "三", "四", "五", "六"];
const ymd = (d) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
const minOfDay = (d) => d.getHours() * 60 + d.getMinutes();
const hm = (m) => `${Math.floor(m / 60) % 24}:${String(m % 60).padStart(2, "0")}`;

async function loadHolidays() {
  const y = new Date().getFullYear();
  const years = new Date().getMonth() === 11 ? [y, y + 1] : [y];   // 12 月時順便讀明年
  const lists = await Promise.all(years.map((yy) => loadJSON(`https://cdn.jsdelivr.net/gh/ruyut/TaiwanCalendar/data/${yy}.json`)));
  for (const d of lists.flat().filter(Boolean)) holidays.set(d.date, { off: d.isHoliday, desc: d.description || "" });
}

// 這天是不是假日（週末或國定假日；補班的週六算平日）；行事曆沒讀到就只看週末
function isOffDay(d) {
  const h = holidays.get(ymd(d));
  return h ? h.off : d.getDay() === 0 || d.getDay() === 6;
}

const dayLabel = (d) => {
  const h = holidays.get(ymd(d));
  const tag = h && h.off && h.desc ? h.desc : h && !h.off && (d.getDay() === 0 || d.getDay() === 6) ? "補班" : isOffDay(d) ? "假日" : "平日";
  return `${d.getMonth() + 1}/${d.getDate()} 週${WEEK[d.getDay()]}・${tag}`;
};

// 某天的營業時段 [[開, 關], …]；[] 公休；null／undefined 不知道
function dayHours(g, d) {
  const oh = g.open_hours;
  if (!oh) return undefined;
  const i = (d.getDay() + 6) % 7;   // 0 = 週一
  if (isOffDay(d) && i < 5) return oh.holiday;   // 平日遇到國定假日
  if (!isOffDay(d) && i >= 5) return oh.week[4]; // 補班的週末照週五
  return oh.week[i];
}

// → { open: true, until } ／ { open: false, next: Date 或 null } ／ null（營業時間不明）
function openState(g, t = new Date()) {
  const today = dayHours(g, t);
  if (today == null) return null;
  const m = minOfDay(t);
  const now = today.find(([a, b]) => a <= m && m < b);
  if (now) return { open: true, until: now[1] };
  for (let i = 0; i < 8; i++) {
    const d = new Date(t.getFullYear(), t.getMonth(), t.getDate() + i);
    const iv = i === 0 ? today : dayHours(g, d);
    if (iv == null) return { open: false, next: null };
    const first = iv.find(([a]) => i > 0 || a > m);
    if (first) return { open: false, next: new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, first[0]) };
  }
  return { open: false, next: null };
}

function nextLabel(next, from = new Date()) {
  const days = Math.round((new Date(next.getFullYear(), next.getMonth(), next.getDate()) - new Date(from.getFullYear(), from.getMonth(), from.getDate())) / 864e5);
  return `${days === 0 ? "今天" : days === 1 ? "明天" : `週${WEEK[next.getDay()]}`} ${hm(minOfDay(next))}`;
}

function openNowHTML(g) {
  const s = openState(g);
  if (!s) return "";
  if (s.open) return `<p class="open-now on">● 現在營業中・到 ${hm(s.until)}</p>`;
  return `<p class="open-now off">● 現在沒有營業${s.next ? `・${nextLabel(s.next)} 開` : ""}</p>`;
}

// 這個票在時間 t 能不能用
function priceFits(g, p, t) {
  if (p.kind === "other" || p.when == null) return false;
  if (!p.when.length) return true;
  const iv = dayHours(g, t) || [];
  const m = minOfDay(t), close = iv.length ? iv[iv.length - 1][1] : 1440;
  const off = isOffDay(t), wday = (t.getDay() + 6) % 7;
  return p.when.some((c) => {
    if (c.days === "wd" && off) return false;
    if (c.days === "we" && !off) return false;
    if (Array.isArray(c.days) && !c.days.includes(wday)) return false;
    const from = c.before_close != null ? close - c.before_close : c.from ?? -1;
    return from <= m && m < (c.to ?? 1e9);
  });
}

// 價格區開頭：現在（沒營業就看下次開門）能買哪些票，最便宜的放前面；回傳 { html, fits: 符合的票 }
function priceNow(g) {
  const s = openState(g);
  const t = s && !s.open && s.next ? s.next : new Date();
  const fits = (g.prices || []).filter((p) => priceFits(g, p, t));
  if (!fits.length || (s && !s.open && !s.next)) return { html: "", fits: [] };
  const num = (p) => Number((String(p.price).match(/\d+/) || [Infinity])[0]);
  const sorted = [...fits].sort((a, b) => num(a) - num(b));
  const when = s && !s.open ? `下次開門（${dayLabel(t)} ${hm(minOfDay(t))}）` : `現在（${dayLabel(t)} ${hm(minOfDay(t))}）`;
  return {
    fits,
    html: `<div class="price-now">${when}入場：${sorted.map((p, i) =>
      `${i ? "、" : ""}<b>${esc(fmtPrice(p.price))}</b> ${esc(p.item)}`).join("")}</div>`,
  };
}

// 票價的說明：「星光」沒寫幾點開始時，補一句是什麼意思
function priceNote(p) {
  const extra = /星光/.test(p.item) && p.when == null && !/打烊|閉館/.test(p.note || "")
    ? "星光票是晚上快打烊時入場的優惠票，這裡沒寫幾點開始，請先問館方" : "";
  return [p.note, extra].filter(Boolean).join("；");
}

// ---------- 詳細資訊 ----------
function openDetail(id, pushHash = true) {
  const g = state.gyms.find((x) => x.id === id);
  if (!g) return;
  state.detailId = id;
  if (pushHash) history.replaceState(null, "", `#${id}`);
  if (g.lat != null) map.setView([g.lat, g.lng], Math.max(map.getZoom(), 15));
  const cls = STATUS_CLASS[g.status] || "warn";
  const types = (g.types || []).map((t) => TYPE_NAME[t] || t).join("、");
  const pn = priceNow(g);
  const links = Object.entries(g.links || {}).map(([k, url]) =>
    `<a class="btn small" href="${esc(url)}" target="_blank" rel="noopener">${esc({ website: "官網", facebook: "Facebook", instagram: "Instagram", youtube: "YouTube", price_page: "價目表", booking: "預約" }[k] || k)}</a>`).join("");

  $("detailBody").innerHTML = `
    <h2>${esc(g.name)}</h2>
    ${openNowHTML(g)}
    <div class="meta"><span class="badge ${cls}">${esc(STATUS_LABEL[g.status] || g.status)}</span> ${esc(types)}${g.name_en ? `・${esc(g.name_en)}` : ""}</div>
    <button type="button" class="btn small fav" id="favBtn"></button>
    <p>${esc(g.address || `${g.city}${g.district || ""}（地址待補）`)}${g.phone ? `<br>☎ <a href="tel:${esc(g.phone)}">${esc(g.phone)}</a>` : ""}</p>
    ${g.hours ? `<p>🕒 ${esc(g.hours)}</p>` : ""}
    ${g.features ? `<p>${esc(g.features)}</p>` : ""}
    <div class="row">${links}<a class="btn small" href="${gmapsSearch(g)}" target="_blank" rel="noopener">Google 地圖（評論・照片）</a></div>

    <h3>近期動態</h3>
    ${newsHTML(g)}

    <h3>價格</h3>
    ${pn.html}
    ${g.prices && g.prices.length ? `<table>${g.prices.map((p) =>
      `<tr${pn.fits.includes(p) ? ' class="now"' : ""}><td>${esc(p.item)}${priceNote(p) ? `<div class="note">${esc(priceNote(p))}</div>` : ""}</td><td class="price">${esc(fmtPrice(p.price))}</td></tr>`).join("")}</table>`
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
  renderFavBtn(id);
  $("favBtn").addEventListener("click", () => toggleFav(id));
  $("detailBody").querySelectorAll("[data-yt]").forEach((b) => b.addEventListener("click", () => {
    b.outerHTML = `<iframe class="embed" src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(b.dataset.yt)}?autoplay=1" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen title="YouTube"></iframe>`;
  }));
  mountComments(g);
  enhanceTransit(g);
}

function closeDetail() {
  $("detail").hidden = true;
  state.detailId = null;   // 地圖上的路線留著，按「在地圖上看路線」就是要看它
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
// 步行、單車、開車的實際路線用 FOSSGIS 架的 OSRM（OpenStreetMap 資料，免金鑰，請勿大量呼叫）。
// 大眾運輸沒有免費免金鑰的路線服務（要 TDX 帳號＋中繼），只做粗估，路線交給 Google 地圖。
const ROUTER = "https://routing.openstreetmap.de";
const YB_DOCK_MIN = 2;   // 借車、還車各約 1 分鐘
const MODES = [
  { id: "youbike", icon: "🚲", name: "YouBike" },
  { id: "walk", icon: "🚶", name: "步行" },
  { id: "car", icon: "🚗", name: "開車" },
  { id: "transit", icon: "🚇", name: "大眾運輸" },
];
const LEG_STYLE = {
  foot: { color: "#1c7ed6", weight: 5, dashArray: "2 9", lineCap: "round" },
  bike: { color: "#2b8a3e", weight: 6 },
  car: { color: "#d9480f", weight: 6 },
};
const routeLayer = L.layerGroup().addTo(map);
const routeCache = new Map();

// profile：foot／bike／car；pts：[{lat,lng}, …]。失敗回傳 null
async function osrmRoute(profile, pts) {
  const key = profile + pts.map((p) => `${p.lng.toFixed(5)},${p.lat.toFixed(5)}`).join(";");
  if (routeCache.has(key)) return routeCache.get(key);
  let out = null;
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 12000);
    const url = `${ROUTER}/routed-${profile}/route/v1/driving/${pts.map((p) => `${p.lng},${p.lat}`).join(";")}?overview=full&geometries=geojson&steps=true`;
    const r = await (await fetch(url, { signal: ctrl.signal })).json();
    const rt = r.code === "Ok" && r.routes[0];
    if (rt) out = { profile, distance: rt.distance, minutes: rt.duration / 60,
      coords: rt.geometry.coordinates.map(([lng, lat]) => [lat, lng]), steps: rt.legs.flatMap((l) => l.steps) };
  } catch { /* 逾時或連不到 */ }
  routeCache.set(key, out);
  return out;
}

// 連不到路線服務時，用直線距離估
const straightLeg = (profile, a, b) => {
  const d = distM(a, b) * DETOUR;
  return { profile, distance: d, minutes: d / (profile === "foot" ? WALK_M_PER_MIN : profile === "bike" ? BIKE_M_PER_MIN : 500),
    coords: [[a.lat, a.lng], [b.lat, b.lng]], steps: [], estimated: true };
};

const BEARING = ["北", "東北", "東", "東南", "南", "西南", "西", "西北"];
const TURN = { left: "左轉", right: "右轉", "slight left": "靠左", "slight right": "靠右", "sharp left": "向左急轉",
  "sharp right": "向右急轉", straight: "直走", uturn: "迴轉" };

// OSRM 的轉彎步驟 → 中文；太短又沒路名的小段合併掉
function stepTexts(steps) {
  const out = [];
  for (const s of steps) {
    const m = s.maneuver || {}, name = s.name || "";
    if (m.type === "arrive") { out.push({ text: "抵達", d: 0 }); continue; }
    let text;
    if (m.type === "depart") text = `往${BEARING[Math.round((m.bearing_after || 0) / 45) % 8]}出發`;
    else if (m.type === "roundabout" || m.type === "rotary") text = "進入圓環";
    else if (m.type === "new name" || m.type === "continue") text = "繼續直走";
    else text = TURN[m.modifier] || "繼續";
    const last = out[out.length - 1];
    if (last && s.distance < 25 && !name) { last.d += s.distance; continue; }
    if (last && name && last.name === name && (m.type === "new name" || m.type === "continue")) { last.d += s.distance; continue; }
    out.push({ text: name ? `${text}，走${name}` : text, name, d: s.distance });
  }
  return out;
}

const clock = (min) => { const t = new Date(Date.now() + min * 60000); return `${t.getHours()}:${String(t.getMinutes()).padStart(2, "0")}`; };

function transitHTML(g) {
  if (g.lat == null) return `<p class="note">這間館還沒有座標，<a href="${gmapsSearch(g)}" target="_blank" rel="noopener">用 Google 地圖查路線</a>。</p>`;
  if (!state.me) {
    return `<p class="note">開啟定位後，會算出從你的位置過去的 YouBike、步行、開車路線和時間。</p>
      <div class="row"><button type="button" class="btn small" id="transitLocate">📍 開啟定位</button>
      <a class="btn small" href="${gmapsDir(g, "transit")}" target="_blank" rel="noopener">用 Google 地圖查路線</a></div>`;
  }
  return `<div class="modes" role="tablist">${MODES.map((m) =>
    `<button type="button" role="tab" data-mode="${m.id}"><span>${m.icon} ${m.name}</span><b>…</b></button>`).join("")}</div>
    <div id="modeBody"><p class="note">正在算路線…</p></div>`;
}

// ---------- YouBike（全台站點、即時車數、同時段歷史平均） ----------
// 由 src/youbike_history.py 每 20 分鐘產生，存在 youbike-data 分支，依區切檔；只讀用得到的那幾區
const YB_DATA_DEFAULT = "https://raw.githubusercontent.com/tim062480-create/climbing-map/youbike-data/";
const ybUrl = (path) => ((window.CLIMBING_CONFIG || {}).youbikeData || YB_DATA_DEFAULT) + path;   // 本機測試可以在 config 指到別的位置
const YB_FEW = 4;   // 歷史平均樣本少於這個數時標示「資料還少」
const yb = { index: undefined, areas: new Map() };

async function ybIndex() {
  if (yb.index === undefined) yb.index = (await loadJSON(ybUrl("index.json"))) || null;
  return yb.index;
}

// 讀一區的站點、即時車數和歷史平均（同一區只讀一次）
function ybArea(code) {
  if (!yb.areas.has(code)) {
    yb.areas.set(code, Promise.all([loadJSON(ybUrl(`areas/${code}.json`)), loadJSON(ybUrl(`pattern/${code}.json`))]).then(([a, p]) => {
      const area = { updated: (a && a.updated) || "", pattern: (p && p.stations) || {} };
      area.stations = Object.entries((a && a.stations) || {}).map(([sno, [name, lat, lng, total, rent, ret]]) =>
        ({ sno, name, lat, lng, total, rent, ret, area }));
      return area;
    }));
  }
  return yb.areas.get(code);
}

// 這個位置附近 maxM 公尺內最近的 n 站（範圍稍微放大，靠近縣市交界也找得到）；資料讀不到回傳 null
async function ybNear(p, maxM, n) {
  const idx = await ybIndex();
  if (!idx) return null;
  const pad = 0.02;
  const codes = Object.entries(idx.areas).filter(([, a]) =>
    p.lat >= a.bbox[0] - pad && p.lat <= a.bbox[2] + pad && p.lng >= a.bbox[1] - pad && p.lng <= a.bbox[3] + pad).map(([c]) => c);
  const areas = await Promise.all(codes.map(ybArea));
  return areas.flatMap((a) => a.stations).map((s) => ({ ...s, d: distM(p, s) }))
    .filter((s) => s.d <= maxM).sort((a, b) => a.d - b.d).slice(0, n);
}

// 地圖放大到街道（16 級以上）時，畫面內的 YouBike 站畫成小標籤，數字是現在可借幾台；點了看可借、可還和歷史平均
const YB_MAP_ZOOM = 16;
const YB_MAP_MAX = 150;   // 畫面內最多畫幾站（離中心近的先畫）
map.createPane("yb").style.zIndex = 350;   // 在館的圓點（400）下面，不會擋住館
const ybLayer = L.layerGroup();
let ybDrawSeq = 0;   // 地圖連續移動時，只畫最後一次

async function drawYbStations() {
  const seq = ++ybDrawSeq;
  if (map.getZoom() < YB_MAP_ZOOM) { ybLayer.remove(); return; }
  const idx = await ybIndex();
  if (!idx || seq !== ybDrawSeq) return;
  const b = map.getBounds(), c = map.getCenter();
  const codes = Object.entries(idx.areas).filter(([, a]) =>
    a.bbox[0] <= b.getNorth() && a.bbox[2] >= b.getSouth() && a.bbox[1] <= b.getEast() && a.bbox[3] >= b.getWest()).map(([k]) => k);
  const areas = await Promise.all(codes.map(ybArea));
  if (seq !== ybDrawSeq) return;
  const live = state.live || null;
  const list = areas.flatMap((a) => a.stations).filter((s) => b.contains([s.lat, s.lng]))
    .sort((x, y) => distM(c, x) - distM(c, y)).slice(0, YB_MAP_MAX);
  ybLayer.clearLayers();
  for (const s of list) {
    const now = stationCounts(s, live);
    const cls = !now ? "none" : now.rent === 0 ? "empty" : now.rent <= 2 ? "low" : "ok";
    L.marker([s.lat, s.lng], { pane: "yb", keyboard: false,
      icon: L.divIcon({ className: "", html: `<div class="yb-tag ${cls}">${now ? now.rent : "–"}</div>`, iconSize: [26, 18] }) })
      .bindPopup(() => ybPopup(s, live)).addTo(ybLayer);
  }
  ybLayer.addTo(map);
}

function ybPopup(s, live) {
  const now = stationCounts(s, live);
  const later = new Date(Date.now() + 3600000);
  const p0 = predict(s, new Date()), p1 = predict(s, later);
  return `<b>🚲 ${esc(s.name)}</b><br>${now ? `現在可借 ${now.rent}、可還 ${now.ret}（${esc(now.how)}）` : "沒有車數資料"}` +
    (p0 ? `<br>這個時段${avgText(p0, "可借", "rent")}` : "") +
    (p1 ? `<br>${hhmm(later)} ${avgText(p1, "可借", "rent")}` : "") +
    `<br><a href="${gmapsDir(s, "walking", state.me)}" target="_blank" rel="noopener">走過去（Google 地圖）</a>`;
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

// 站 s 在 when 那個半小時的歷史平均 → { rent, ret, n }；那格還沒資料回傳 null
function predict(s, when) {
  const p = s.area && s.area.pattern[s.sno];
  if (!p) return null;
  const day = when.getDay();
  const v = p[day === 0 || day === 6 ? "we" : "wd"][when.getHours() * 2 + Math.floor(when.getMinutes() / 30)];
  return v ? { rent: Math.round(v[0]), ret: Math.round(v[1]), n: v[2] } : null;
}

// 現在的車數：瀏覽器直接抓得到臺北市即時資料就用它，不然用 20 分鐘一次的全台快照
function stationCounts(s, live) {
  if (live && live.has(s.sno)) return { ...live.get(s.sno), how: "即時" };
  if (s.rent != null) return { rent: s.rent, ret: s.ret, how: `${s.area.updated.slice(11)} 更新` };
  return null;
}

// 打開館的詳細資訊時算四種方式的路線，填進分頁；預設選最合適的那個
async function enhanceTransit(g) {
  const tl = $("transitLocate");
  if (tl) tl.addEventListener("click", locate);
  routeLayer.clearLayers();
  if (!state.me || g.lat == null || !document.querySelector("#transit .modes")) return;
  const me = { ...state.me };
  const live = await tryLive();
  const plans = { transit: transitPlan(g, me) };
  const [walk, car, yb] = await Promise.all([
    osrmRoute("foot", [me, g]).then((r) => r || straightLeg("foot", me, g)),
    osrmRoute("car", [me, g]).then((r) => r || straightLeg("car", me, g)),
    youbikePlan(g, me, live),
  ]);
  if (state.detailId !== g.id) return;   // 算完時使用者已經換看別間
  plans.walk = { legs: [walk], minutes: walk.minutes, distance: walk.distance };
  plans.car = { legs: [car], minutes: car.minutes * 1.3, distance: car.distance };   // OSRM 不含塞車、找車位，多抓三成
  plans.youbike = yb;

  const tabs = document.querySelectorAll("#transit [data-mode]");
  tabs.forEach((btn) => {
    const p = plans[btn.dataset.mode];
    btn.querySelector("b").textContent = p.minutes ? `${p.approx ? "約 " : ""}${fmtMin(p.minutes)}` : "—";
    btn.addEventListener("click", () => showMode(g, plans, btn.dataset.mode));
  });
  // 預設：2 公里內步行，YouBike 可以就 YouBike，不然大眾運輸
  const dist = walk.distance;
  showMode(g, plans, dist <= 2000 ? "walk" : yb.minutes ? "youbike" : "transit");
}

function transitPlan(g, me) {
  const d = distM(me, g);
  return { approx: true, minutes: (d * 1.4) / 350 + 10, distance: d * 1.4 };   // 粗估：市區大眾運輸約 21 km/h＋候車 10 分
}

async function youbikePlan(g, me, live) {
  const [nearMe, nearGym] = await Promise.all([ybNear(me, 1000, 3), ybNear(g, 1000, 4)]);
  if (!nearGym) return { reason: "YouBike 資料暫時讀不到。", nearGym: [] };
  if (distM(me, g) > YOUBIKE_MAX_KM * 1000) return { reason: `距離超過 ${YOUBIKE_MAX_KM} 公里，騎 YouBike 太遠，建議搭大眾運輸。`, nearGym, live };
  if (!nearMe.length || !nearGym.length) {
    return { reason: !nearMe.length ? "你附近 1 公里內沒有 YouBike 站。" : "這間館附近 1 公里內沒有 YouBike 站。", nearGym, live };
  }
  // 借車站（你附近、現在就要借）：看現在的車數，選最近一個有車的
  const a = nearMe.find((s) => { const c = stationCounts(s, live); return c && c.rent > 0; }) || nearMe[0];
  // 還車站（館附近、騎到時才還）：先粗估騎到的時間，看那個半小時的歷史平均可還，選最近一個平均有 3 個以上空位的
  const tDrop = new Date(Date.now() + ((a.d * DETOUR) / WALK_M_PER_MIN + (distM(a, g) * DETOUR) / BIKE_M_PER_MIN + 1) * 60000);
  const expectRet = (s) => {
    const p = predict(s, tDrop);
    if (p && p.n >= 2) return { v: p.ret, by: `${hhmm(tDrop)} 歷史平均可還 ${p.ret}` };
    const c = stationCounts(s, live);
    return c ? { v: c.ret, by: `現在可還 ${c.ret}（歷史資料還少）` } : { v: null, by: "沒有車數資料" };
  };
  const scored = nearGym.map((s) => ({ s, e: expectRet(s) }));
  const best = scored.find((x) => x.e.v >= 3) || scored.filter((x) => x.e.v != null).sort((x, y) => y.e.v - x.e.v)[0] || scored[0];
  const b = { ...best.s, why: best.s.sno === nearGym[0].sno ? "" : `沒選最近的 ${nearGym[0].name}：${scored[0].e.by}；這站 ${best.e.by}` };
  const legs = await Promise.all([
    osrmRoute("foot", [me, a]).then((r) => r || straightLeg("foot", me, a)),
    osrmRoute("bike", [a, b]).then((r) => r || straightLeg("bike", a, b)),
    osrmRoute("foot", [b, g]).then((r) => r || straightLeg("foot", b, g)),
  ]);
  const minutes = legs.reduce((s, l) => s + l.minutes, 0) + YB_DOCK_MIN;
  return { legs, minutes, distance: legs.reduce((s, l) => s + l.distance, 0), a, b, live, nearGym };
}

function showMode(g, plans, mode) {
  document.querySelectorAll("#transit [data-mode]").forEach((b) => b.setAttribute("aria-selected", b.dataset.mode === mode));
  const p = plans[mode], body = $("modeBody");
  routeLayer.clearLayers();
  if (mode === "transit") {
    const relay = (window.CLIMBING_CONFIG || {}).transitRelay;
    body.innerHTML = `<div id="tdxBox">${relay ? `<p class="note">正在查公車、捷運路線…</p>` : `<div class="plan">
      <div class="total">約 ${fmtMin(p.minutes)}<span class="note">（粗估，約 ${clock(p.minutes)} 到）</span></div>
      <p>公車、捷運要轉哪幾班，請用 Google 地圖查：</p>
      <a class="btn primary" href="${gmapsDir(g, "transit", state.me)}" target="_blank" rel="noopener">🚇 用 Google 地圖看大眾運輸路線</a>
      <p class="note">時間是用距離粗估：市區約每小時 21 公里，加候車 10 分鐘。</p>
    </div>`}</div>${ybNearGymHTML(plans.youbike, new Date(Date.now() + p.minutes * 60000))}`;
    if (relay) showTransitRoutes(g, p, relay);
    return;
  }
  if (!p.minutes) { body.innerHTML = `<div class="plan">${esc(p.reason)}</div>${ybNearGymHTML(plans.youbike, new Date(Date.now() + plans.transit.minutes * 60000))}`; return; }

  const estimated = p.legs.some((l) => l.estimated);
  const head = `<div class="total">${fmtMin(p.minutes)}<span class="note">・${fmtDist(p.distance)}・約 ${clock(p.minutes)} 到</span></div>`;
  let legsHTML;
  if (mode === "youbike") {
    const [w1, bike, w2] = p.legs;
    const tPick = new Date(Date.now() + w1.minutes * 60000), tDrop = new Date(tPick.getTime() + (bike.minutes + 1) * 60000);
    const near = (leg) => leg.distance < 40;   // 站就在旁邊，不用另外寫步行
    legsHTML = `<ol class="legs">
      <li>${near(w1) ? `<b>${esc(p.a.name)}</b> 就在你旁邊，借車` : `<b>🚶 步行 ${fmtMin(w1.minutes)}</b>（${fmtDist(w1.distance)}）到 <b>${esc(p.a.name)}</b> 借車`}<br>${countsLine(p.a, p.live, tPick, "rent")}${near(w1) ? "" : stepsHTML(w1)}</li>
      <li><b>🚲 騎車 ${fmtMin(bike.minutes)}</b>（${fmtDist(bike.distance)}）到 <b>${esc(p.b.name)}</b> 還車<br>${countsLine(p.b, p.live, tDrop, "ret")}${p.b.why ? `<br><span class="note">${esc(p.b.why)}</span>` : ""}${stepsHTML(bike)}</li>
      <li>${near(w2) ? "還車站就在館旁邊" : `<b>🚶 步行 ${fmtMin(w2.minutes)}</b>（${fmtDist(w2.distance)}）到館${stepsHTML(w2)}`}</li>
    </ol>
    <div class="row"><a class="btn small" href="${gmapsDir(p.a, "walking", state.me)}" target="_blank" rel="noopener">Google：走到借車站</a>
      <a class="btn small" href="${gmapsDir(p.b, "bicycling", p.a)}" target="_blank" rel="noopener">Google：騎到還車站</a>
      <a class="btn small" href="${gmapsDir(g, "walking", p.b)}" target="_blank" rel="noopener">Google：走到館</a></div>`;
  } else {
    const gm = { walk: "walking", car: "driving" }[mode];
    legsHTML = `${stepsHTML(p.legs[0], true)}
      <div class="row"><a class="btn small" href="${gmapsDir(g, gm, state.me)}" target="_blank" rel="noopener">用 Google 地圖導航</a></div>
      ${mode === "car" ? `<p class="note">開車時間多抓三成，路線服務沒有算塞車和找車位。</p>` : ""}`;
  }
  body.innerHTML = `<div class="plan">${head}
    <button type="button" class="btn small" id="showRoute">🗺 在地圖上看路線</button>
    ${legsHTML}
    <p class="note">${estimated ? "路線服務暫時連不到，以直線距離估算。" : "路線：OpenStreetMap（FOSSGIS OSRM），實際以現場為準。"}</p>
  </div>${mode === "youbike" ? ybNearGymHTML(p, new Date(Date.now() + p.minutes * 60000)) : ""}`;

  // 地圖上畫路線：步行虛線、騎車綠線、開車橘線，借還車站標出來
  for (const l of p.legs) L.polyline(l.coords, LEG_STYLE[l.profile]).addTo(routeLayer);
  if (mode === "youbike") {
    [[p.a, "借"], [p.b, "還"]].forEach(([s, t]) => L.marker([s.lat, s.lng], {
      icon: L.divIcon({ className: "", html: `<div class="yb-pin">${t}</div>`, iconSize: [24, 24] }) }).bindTooltip(s.name).addTo(routeLayer));
  }
  $("showRoute").addEventListener("click", () => {
    closeDetail();
    const panel = $("panel");
    const covered = getComputedStyle(panel).position === "absolute" ? panel.offsetHeight : 0;
    map.stop();
    map.fitBounds(L.latLngBounds(p.legs.flatMap((l) => l.coords)), { paddingTopLeft: [30, 30], paddingBottomRight: [30, covered + 30] });
  });
}

// ---------- 大眾運輸（TDX 旅運規劃，經過 relay/tdx-worker.js） ----------
const TRANSIT_ICON = { bus: "🚌", intercityBus: "🚌", subway: "🚇", metro: "🚇", lightRail: "🚊", train: "🚆", regionalTrain: "🚆",
  highSpeedTrain: "🚄", ferry: "⛴", aerial: "🚡", bicycle: "🚲", bikeShare: "🚲", pedestrian: "🚶", walk: "🚶" };
const localISO = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 19);
const hhmm = (t) => { const d = new Date(t); return Number.isNaN(d.getTime()) ? "" : `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`; };

// TDX 的回傳格式只看過文件描述（類似 HERE 的 routes → sections），欄位名稱都多試幾種，讀不懂就退回粗估
function parseTdxRoutes(j) {
  const routes = j?.data?.routes || j?.routes || j?.data || [];
  return (Array.isArray(routes) ? routes : []).map((r) => {
    const sections = (r.sections || r.legs || []).map((s) => {
      const t = s.transport || {};
      const mode = s.type === "pedestrian" ? "pedestrian" : t.mode || s.mode || s.type || "";
      const dur = s.travelSummary?.duration ?? s.travel_summary?.duration ?? s.summary?.duration ?? s.duration;
      return {
        mode, line: t.shortName || t.name || t.longName || s.route_name || "", headsign: t.headsign || "",
        from: s.departure?.place?.name || s.departure?.name || "", to: s.arrival?.place?.name || s.arrival?.name || "",
        dep: s.departure?.time, arr: s.arrival?.time, minutes: dur != null ? dur / 60 : null,
        length: s.travelSummary?.length ?? s.travel_summary?.length ?? s.length ?? null,
      };
    });
    const first = sections[0], last = sections[sections.length - 1];
    let minutes = r.travel_time != null ? r.travel_time / 60 : null;
    if (minutes == null && first?.dep && last?.arr) minutes = (new Date(last.arr) - new Date(first.dep)) / 60000;
    if (minutes == null) minutes = sections.reduce((s, x) => s + (x.minutes || 0), 0) || null;
    return { minutes, price: r.total_price ?? r.price ?? null, dep: first?.dep, arr: last?.arr, sections };
  }).filter((r) => r.minutes && r.sections.length);
}

async function showTransitRoutes(g, estimate, relay) {
  const box = $("tdxBox");
  const fallback = (why) => {
    if (!$("tdxBox")) return;
    $("tdxBox").innerHTML = `<div class="plan"><div class="total">約 ${fmtMin(estimate.minutes)}<span class="note">（粗估）</span></div>
      <p class="note">${esc(why)}</p>
      <a class="btn primary" href="${gmapsDir(g, "transit", state.me)}" target="_blank" rel="noopener">🚇 用 Google 地圖看大眾運輸路線</a></div>`;
  };
  let routes = [];
  try {
    const u = new URL("/route", relay);
    u.search = new URLSearchParams({ from: `${state.me.lat},${state.me.lng}`, to: `${g.lat},${g.lng}`, depart: localISO(new Date()) });
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 15000);
    const j = await (await fetch(u, { signal: ctrl.signal })).json();
    if (j.error) return fallback(`公車捷運路線查詢失敗（${j.error}），先用粗估。`);
    routes = parseTdxRoutes(j);
  } catch { return fallback("公車捷運路線服務暫時連不到，先用粗估。"); }
  if (!box.isConnected) return;
  if (!routes.length) return fallback("查不到這段的公車捷運路線（可能太近、太遠或沒有班次），先用粗估。");

  box.innerHTML = routes.map((r, i) => {
    const chips = r.sections.map((s) => `${TRANSIT_ICON[s.mode] || "🚍"}${s.mode === "pedestrian" ? (s.minutes ? ` ${Math.round(s.minutes)}` : "") : ` ${esc(s.line)}`}`).join(" › ");
    const detail = r.sections.map((s) => s.mode === "pedestrian"
      ? `<li>🚶 步行${s.minutes ? ` ${fmtMin(s.minutes)}` : ""}${s.length ? `（${fmtDist(s.length)}）` : ""}${s.to ? ` 到 ${esc(s.to)}` : ""}</li>`
      : `<li>${TRANSIT_ICON[s.mode] || "🚍"} <b>${esc(s.line)}</b>${s.headsign ? `（往${esc(s.headsign)}）` : ""}<br>
          ${hhmm(s.dep)} ${esc(s.from)} 上車 → ${hhmm(s.arr)} ${esc(s.to)} 下車${s.minutes ? `<span class="note">　${fmtMin(s.minutes)}</span>` : ""}</li>`).join("");
    return `<div class="plan">
      <div class="total">${fmtMin(r.minutes)}<span class="note">${r.dep ? `・${hhmm(r.dep)} 出發` : ""}${r.arr ? `・${hhmm(r.arr)} 到` : ""}${r.price != null ? `・$${r.price}` : ""}</span></div>
      <div class="transit-chips">${chips}</div>
      <details class="steps"${i === 0 ? " open" : ""}><summary>怎麼搭</summary><ol>${detail}</ol></details>
    </div>`;
  }).join("") + `<div class="row"><a class="btn small" href="${gmapsDir(g, "transit", state.me)}" target="_blank" rel="noopener">用 Google 地圖對照</a></div>
    <p class="note">路線：交通部 TDX 旅運規劃，班次以現場為準。</p>`;
  const best = routes[0].minutes;
  const tab = document.querySelector('#transit [data-mode="transit"] b');
  if (tab) tab.textContent = fmtMin(best);
}

// 轉彎步驟收在「詳細路線」裡，像 Google 地圖那樣點開才看
function stepsHTML(leg, open = false) {
  const list = stepTexts(leg.steps || []);
  if (list.length < 2) return "";
  return `<details class="steps"${open ? " open" : ""}><summary>詳細路線（${list.length} 步）</summary><ol>${
    list.map((s) => `<li>${esc(s.text)}${s.d >= 10 ? `<span class="note">　${fmtDist(s.d)}</span>` : ""}</li>`).join("")}</ol></details>`;
}

// 歷史平均的說明：樣本少時提醒「資料還少」
const avgText = (p, label, key) => `平均${label} ${p[key]}${p.n < YB_FEW ? "（資料還少）" : ""}`;

function countsLine(s, live, when, key) {
  const c = stationCounts(s, live);
  const p = predict(s, when);
  const label = key === "rent" ? "可借" : "可還";
  const parts = [];
  if (c) parts.push(`現在${label} ${c[key]}（${esc(c.how)}）`);
  if (p) parts.push(`${hhmm(when)} 到站時${avgText(p, label, key)}`);
  if (!parts.length) parts.push(`車數資料累積中，<a href="https://www.youbike.com.tw/region/main/stations/" target="_blank" rel="noopener">看 YouBike 官網即時車數</a>`);
  return `<span class="note">${parts.join("；")}</span>`;
}

// 館附近的站：現在的車數、到館時的平均空位（還車）、大約 2 小時後回程時的平均車數（借車）
function ybNearGymHTML(plan, arrive) {
  const list = (plan && plan.nearGym) || [];
  if (!list.length) return "";
  const back = new Date(arrive.getTime() + 2 * 3600000);
  const cell = (p, label, key) => (p ? avgText(p, label, key) : "—");
  return `<p class="note" style="margin-top:8px">館附近的 YouBike 站（歷史平均是過去同一個半小時、平日／假日分開算）：</p>
    <table class="yb"><tr><th>站</th><th>現在</th><th>${hhmm(arrive)} 到館</th><th>${hhmm(back)} 回程</th></tr>${list.map((s) => {
    const c = stationCounts(s, plan.live);
    return `<tr><td>${esc(s.name)}<div class="note">${fmtDist(s.d)}</div></td><td>${c ? `借 ${c.rent}／還 ${c.ret}` : "—"}</td>
      <td>${cell(predict(s, arrive), "可還", "ret")}</td><td>${cell(predict(s, back), "可借", "rent")}</td></tr>`;
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
