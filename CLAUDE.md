# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# 岩館地圖go（climbing-map）

手機定位找附近的室內抱石館，顯示價格、營業時間、影片、留言，並提供大眾運輸與 YouBike 交通建議。用 GitHub Pages 發布，GitHub Actions 自動更新資料。使用者用繁體中文溝通，文件、註解、commit 訊息都用繁體中文。

## 資料夾規則
- data/raw/：原始資料，寫入後不再修改。
  - `sources.csv` 只存「代號、媒體、日期時間、標題、網址」，**不得儲存文章全文**。
  - `osm/` 是 Overpass 原始回應，都由程式寫入。`youbike_log/` 是舊的車數記錄（2026-10-26 起不再寫入，YouBike 改存在 `youbike-data` 分支）。
- data/manual/：`gyms_seed.json` 是人工整理的館資料，唯一可以手動編輯的資料檔。
  - 每個欄位用 `src` 對應 `sources.csv` 的代號。
  - `verify` 列出待確認事項。
  - `osm_keywords` 是比對 OSM 名稱用的關鍵字組，每組的字要全部出現在 OSM 名稱裡。
  - `news` 是近期動態（`src/fetch_news.py`）用的：`names` 館的專有名稱（新聞標題要出現其中一個）、`branch` 連鎖品牌的分店字、`climb` 名稱太一般時標題還要有攀岩字。新增館時要一起填。
- data/processed/：由 src/ 的程式產生，不手動編輯。
- src/：所有 Python 程式都放這裡。**不要只在對話中執行一次性程式碼**，任何處理步驟都要存成 src/ 下的 .py 檔，確保可以重跑。只用 Python 內建套件（urllib、csv、json），沒有 requirements.txt、測試框架或 linter，要確認能跑就直接執行。
- output/：每次分析或匯出另存新版本資料夾 output/v1/、output/v2/…，**舊版不覆蓋、不刪除**。使用者決定採用的版本才複製到 output/final/，未經使用者同意不得改動 final。
- docs/：AI 自動產生的報告（`enrich_report.md`）和使用者親手寫的文件。`資料來源紀錄.md` 是資料來源與驗證的總紀錄，補資料時要在「操作紀錄」加一段並註明日期。不得改寫使用者親手寫的文件。
- logs/：過程紀錄，由紀錄系統自動寫入。
- relay/：放在 Cloudflare 上跑的中繼程式（JavaScript，不是 Python），目前只有 TDX 大眾運輸路線。
- 根目錄的 `index.html` 和 `web/` 是網頁。GitHub Pages 從根目錄發布，網頁用相對路徑讀 `data/processed/`。

## 資料流
1. `src/enrich.py`：
   - 讀 seed 和 sources.csv，先用 Overpass 比對 OSM 的館名，對不到再用 Nominatim 查地址（門牌 → 地址括號裡的地標 → 路段 → 地標 → 館名）。
   - 只有縣市或行政區的地址不拿來定位。
   - 輸出 `data/processed/gyms.json` 和 `docs/enrich_report.md`。座標可信度看 `coord_source`。
   - `src/hours_prices.py`（enrich.py 會呼叫，也可以單獨跑來更新 gyms.json）：把文字營業時間轉成 `open_hours`（週一…週日每天的 [開, 關] 分鐘、國定假日），票價加 `kind`（entry／hourly／other）和 `when`（平日／假日／星期幾、幾點到幾點、閉館前幾小時）。網頁用這些算「現在有沒有開」「現在入場多少錢」，國定假日、補班日讀 `cdn.jsdelivr.net/gh/ruyut/TaiwanCalendar`。seed 的 `status`「營業中」是「還在營運」，網頁顯示成「仍在營運」，不是現在有開。
   - `price_min`：成人入場的最低價（含星光、離峰時段和計時 1 小時，`per_hour` 標示計時；排除租借、課程、學生票、起價），`price_day` 不含計時。網頁的價格排序和預算篩選用。
   - 連不到 OSM 時沿用上一次的座標。
2. `src/youbike_history.py`（2026-10-26 取代 `youbike_near.py`）：
   - 每 20 分鐘（`.github/workflows/youbike.yml`）抓全台 YouBike 站點（`apis.youbike.com.tw`，非正式 API，有區碼 `area_code`）和臺北市開放資料，依區切檔。
   - 結果存在 **`youbike-data` 分支**，每次 force push 成只有一個版本（不進 main、repo 不會長大）；網頁從 `raw.githubusercontent.com/.../youbike-data/` 讀：`index.json`（各區名稱、範圍）、`areas/區碼.json`（每站 [站名, 緯度, 經度, 總車位, 可借, 可還]）、`pattern/區碼.json`（每站 `wd`／`we` × 48 個半小時 `[平均可借, 平均可還, 樣本數]`，0 表示沒資料）。
   - 歷史平均是累加平均，樣本數上限 20（之後新資料權重固定），**不存原始記錄**（全台一年約 11 GB）。`data/raw/youbike_log/` 是 10/24–10/26 舊做法留下的每館附近車數，第一次跑時用來填平均。
   - 「可借、可還都是 0」視為沒有資料（例如颱風暫停營運時；2026-10-23 起北部整批回傳 0），不更新平均。
   - 網頁選站：借車站看現在車數；還車站看「騎到時那個半小時」的歷史平均可還（樣本 2 筆以上），選最近一個平均有 3 個空位以上的；館附近站列出到館時平均可還、2 小時後回程平均可借。
3. `src/find_new_gyms.py`：每半年（1 月、7 月，`.github/workflows/new-gyms.yml`）重新抓 OSM 後，列出地圖還沒收錄、上次檢查之後新出現的攀岩地點，使用者關注的宜蘭、永和排最前面。輸出 `docs/new_gyms_report.md`、`data/processed/new_gyms_seen.json`，並開 issue 通知。只是候選，人工確認後才加進 seed。
4. `src/fetch_news.py`：每月 1、16 日（`.github/workflows/news.yml`）抓每間館的近期動態：Google 新聞 RSS（標題要有館的關鍵字＋攀岩相關字）、館的 YouTube 頻道 RSS、官網有宣告的 RSS。輸出 `data/raw/news/日期.json` 和 `data/processed/news.json`（180 天內最多 8 則，只存日期、來源、標題、網址）。Facebook、Instagram 抓不到，網頁只附連結。
5. `src/export_table.py`：把 gyms.json 匯出成 `output/vN/gyms.csv` 和 `summary.md`，N 自動遞增。
6. 網頁（`index.html`、`web/app.js`）：
   - 沒有建置步驟，Leaflet 和 OSM 底圖從 unpkg 載入。
   - 改了 `web/` 的 JS 或 CSS，要一起改 `index.html` 裡的 `?v=日期` 版本號，不然手機可能拿到新 HTML 配舊 JS（GitHub Pages 會快取 10 分鐘）。
   - 上方一個搜尋框輸入所有條件（`parseQuery`）：地點（縣市、行政區）、館名、預算（「300 以下」）、排序（「最便宜」「最近」）、間數（「5 間」）、範圍（「3 公里」「不限距離」）、「上攀」「營業中」「全日」（價格不算計時），空白隔開可以疊加，解析結果顯示成可以按 ✕ 拿掉的標籤。點搜尋框會展開下拉選單（`renderSuggest`）列出可選條件，打字時改列符合的地區和館名；關鍵字的正規表示式統一放在 `Q_RE`，解析和選單共用。搜尋字串存在網址 `?q=` 和 localStorage。
   - 沒指定地點、館名、範圍時，有定位就只列 10 公里內；範圍內不到 5 間時補列範圍外最近的館。
   - 交通分頁（YouBike／步行／開車／大眾運輸）：前三種用 FOSSGIS 的 OSRM（`routing.openstreetmap.de`，免金鑰、可跨網域，只在打開館的詳細資訊時呼叫）算實際路線、時間和中文轉彎步驟，畫在地圖上；連不到時退回直線距離 ×1.3 估算。大眾運輸用交通部 TDX 旅運規劃（`/api/maas/routing`），經過 `relay/tdx-worker.js`（Cloudflare Worker，金鑰存在 Cloudflare 加密變數，不進 repo）；`web/config.js` 的 `transitRelay` 空著時只粗估時間，路線交給 Google 地圖網址（`/maps/dir/?api=1&travelmode=...`）。設定步驟見 `docs/TDX大眾運輸設定步驟.md`。改了 Worker 要手動貼到 Cloudflare 重新部署。
   - 最愛：`web/config.js` 的 `firebase` 空著時，最愛存在瀏覽器 localStorage（`climbing-map:fav`）。填好後用 Firebase 做 Google 登入（`setupAuth`，SDK 從 gstatic 動態 import），最愛存在 Firestore `users/{uid}` 的 `favorites`；沒登入可以照常使用，按 ☆ 或「最愛」時跳出登入框（`showLogin`）。第一次登入會把這台裝置的 localStorage 最愛併進帳號。Firebase 設定是公開值，安全靠 Firestore 規則，設定步驟見 `docs/Google登入設定步驟.md`。使用的 Firebase 專案是 `climbing-map-25afd`（另一個 `climbing-map-4041c` 是多建的，沒用到）。`measurementId` 有填時載入 Google Analytics 算匿名瀏覽人數，並記錄事件 `open_gym`（`gym_id`、`gym_name`）和 `search`（`search_term`，停止打字 2 秒才記）；只在 https 上，本機不算，網頁下方有註明。搜尋「最愛」只列最愛。
   - 館的詳細資訊有「近期動態」；15 天內有新動態的館，清單上顯示 🆕 和標題。
   - 留言用 giscus：`web/config.js` 的 `repoId`、`categoryId` 空著時不顯示。

`.github/workflows/update-data.yml`：補座標每週一次或改了 seed、來源、程式之後自動跑，結果 commit 回 repo。YouBike 在 `youbike.yml`（每 20 分鐘，只寫 `youbike-data` 分支，不 commit 到 main）。schedule 只在 main 上執行。排程會 commit，所以本機 push 前要先 pull。

雲端開發環境常連不到 OSM、YouBike、Google，需要外部資料的步驟交給 Actions 跑。

## 原則（使用者確認過的）
- 只收室內館，以抱石為主。只有戶外岩場的不收；網頁也不顯示 OSM 上未確認的攀岩地點（多是戶外岩場、樹抱石，2026-10-29 拿掉）。
- 不爬 Google 地圖（違反使用條款），只附搜尋連結讓人手動對照。要顯示 Google 評論、照片需要 Places API 金鑰，使用者還沒申請。
- 營業中的判斷（2026-10-30）：Google 地圖上要有營業時間，且最新評論在 3 個月內；評論超過 3 個月的館從 seed 刪掉（已停業的留著當紀錄，網站不顯示）。只看該館自己的區塊，不要抓到「其他人也搜尋了」。
- 不能確認的資料寫進 `verify`，不要猜。
- 機密資訊（API 金鑰等）放 .env，不寫進程式碼、不 commit。
