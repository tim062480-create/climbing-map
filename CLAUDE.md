# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# 附近抱石館地圖（climbing-map）

手機定位找附近的室內抱石館，顯示價格、營業時間、影片、留言，並提供大眾運輸與 YouBike 交通建議。用 GitHub Pages 發布，GitHub Actions 自動更新資料。使用者用繁體中文溝通，文件、註解、commit 訊息都用繁體中文。

## 資料夾規則
- data/raw/：原始資料，寫入後不再修改。
  - `sources.csv` 只存「代號、媒體、日期時間、標題、網址」，**不得儲存文章全文**。
  - `osm/` 是 Overpass 原始回應，`youbike_log/` 是車數記錄，都由程式寫入。
- data/manual/：`gyms_seed.json` 是人工整理的館資料，唯一可以手動編輯的資料檔。
  - 每個欄位用 `src` 對應 `sources.csv` 的代號。
  - `verify` 列出待確認事項。
  - `osm_keywords` 是比對 OSM 名稱用的關鍵字組，每組的字要全部出現在 OSM 名稱裡。
- data/processed/：由 src/ 的程式產生，不手動編輯。
- src/：所有 Python 程式都放這裡。**不要只在對話中執行一次性程式碼**，任何處理步驟都要存成 src/ 下的 .py 檔，確保可以重跑。只用 Python 內建套件（urllib、csv、json），沒有 requirements.txt、測試框架或 linter，要確認能跑就直接執行。
- output/：每次分析或匯出另存新版本資料夾 output/v1/、output/v2/…，**舊版不覆蓋、不刪除**。使用者決定採用的版本才複製到 output/final/，未經使用者同意不得改動 final。
- docs/：AI 自動產生的報告（`enrich_report.md`）和使用者親手寫的文件。`資料來源紀錄.md` 是資料來源與驗證的總紀錄，補資料時要在「操作紀錄」加一段並註明日期。不得改寫使用者親手寫的文件。
- logs/：過程紀錄，由紀錄系統自動寫入。
- 根目錄的 `index.html` 和 `web/` 是網頁。GitHub Pages 從根目錄發布，網頁用相對路徑讀 `data/processed/`。

## 資料流
1. `src/enrich.py`：
   - 讀 seed 和 sources.csv，先用 Overpass 比對 OSM 的館名，對不到再用 Nominatim 查地址（門牌 → 地址括號裡的地標 → 路段 → 地標 → 館名）。
   - 只有縣市或行政區的地址不拿來定位。
   - 輸出 `data/processed/gyms.json` 和 `docs/enrich_report.md`。座標可信度看 `coord_source`。
   - `price_min`：成人一次入場的最低價（含星光、離峰時段；排除租借、課程、學生票、計時、起價），網頁的價格排序和預算篩選用。
   - 連不到 OSM 時沿用上一次的座標。
2. `src/youbike_near.py`：
   - 用全台 YouBike 站點（`apis.youbike.com.tw`，非正式 API）和臺北市開放資料，記錄每館 1 公里內最近 4 站的車數。
   - 算出 `youbike_pattern.json`：站號 → 平日 `wd`／假日 `we` → `slot = 小時*2 + 分//30` → `[平均可借, 平均可還, 樣本數]`。
   - 「可借、可還都是 0」視為沒有資料（例如颱風暫停營運時；2026-10-23 起北部整批回傳 0），不記錄、不算平均。
3. `src/export_table.py`：把 gyms.json 匯出成 `output/vN/gyms.csv` 和 `summary.md`，N 自動遞增。
4. 網頁（`index.html`、`web/app.js`）：
   - 沒有建置步驟，Leaflet 和 OSM 底圖從 unpkg 載入。
   - 搜尋條件（縣市、範圍、預算、排序、顯示間數、只看有抱石、顯示待確認）可以疊加，存在瀏覽器的 localStorage。範圍內不到 5 間時補列範圍外最近的館。
   - 交通時間用直線距離乘繞路係數估算，路線本身交給 Google 地圖網址（`/maps/dir/?api=1&travelmode=...`）。
   - 留言用 giscus：`web/config.js` 的 `repoId`、`categoryId` 空著時不顯示。

`.github/workflows/update-data.yml`：YouBike 每 20 分鐘、補座標每週一次或改了 seed、來源、程式之後自動跑，結果 commit 回 repo。schedule 只在 main 上執行。排程會一直 commit，所以本機 push 前要先 pull。

雲端開發環境常連不到 OSM、YouBike、Google，需要外部資料的步驟交給 Actions 跑。

## 原則（使用者確認過的）
- 只收室內館，以抱石為主。
- 不爬 Google 地圖（違反使用條款），只附搜尋連結讓人手動對照。要顯示 Google 評論、照片需要 Places API 金鑰，使用者還沒申請。
- 不能確認的資料寫進 `verify`，不要猜。
- 機密資訊（API 金鑰等）放 .env，不寫進程式碼、不 commit。
