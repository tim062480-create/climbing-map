# 附近抱石館地圖

## 👉 網站：https://tim062480-create.github.io/climbing-map/

在電腦上雙擊資料夾裡的 **「打開攀岩地圖網站」** 也會打開。手機建議把網址加到主畫面。

> **不要直接點 `index.html`**：它是網站的原始碼，要放在網路上（或本機伺服器）才讀得到資料。
> 直接用瀏覽器打開會顯示「資料載入失敗」；用記事本等程式打開會看到程式碼，有些程式還會變成亂碼。

用手機定位，自動列出附近的室內抱石館；點開可以看現在有沒有開、現在入場多少錢、價格、影片、近期動態和交通建議（YouBike、步行、開車、大眾運輸）。

## 你會用到的檔案

| 想做什麼 | 看這裡 |
|---|---|
| 打開網站 | 雙擊 `打開攀岩地圖網站`，或上面的網址 |
| 改館的資料（價格、營業時間、地址…） | `data/manual/gyms_seed.json`（唯一要手動改的資料檔） |
| 資料怎麼來的、哪些還沒確認 | [docs/資料來源紀錄.md](docs/資料來源紀錄.md) |
| 大眾運輸路線怎麼開通 | [docs/TDX大眾運輸設定步驟.md](docs/TDX大眾運輸設定步驟.md) |

其他資料夾都是程式和程式自動產生的檔案，平常不用動。

## 資料夾

```
climbing-map/
├─ 打開攀岩地圖網站.url     雙擊打開網站
├─ index.html              網站原始碼的入口（GitHub Pages 從這裡開始，不要直接點開）
├─ web/                    網頁程式：app.js、style.css、config.js（留言區、大眾運輸中繼的設定）
├─ data/
│  ├─ manual/              人工整理的館資料 gyms_seed.json（唯一要手動改的資料檔）
│  ├─ raw/                 原始資料：sources.csv（媒體、日期時間、標題、網址，不存全文）、
│  │                       osm/（OpenStreetMap 原始回應）、news/（近期動態）、youbike_log/（舊的 YouBike 車數記錄）
│  └─ processed/           程式產生的資料：gyms.json（網頁讀這個）、news.json
├─ src/                    所有 Python 程式
├─ relay/                  放在 Cloudflare 上的中繼程式（TDX 大眾運輸路線用）
├─ output/                 匯出結果：v1、v2…每一版另存，output/final/ 放你決定採用的版本
├─ docs/                   報告與文件：資料來源紀錄.md、各種自動產生的報告
├─ logs/                   過程紀錄
└─ .github/workflows/      自動更新資料的排程（補座標、YouBike、近期動態、新岩館檢查）
```

YouBike 全台車數和歷史平均不在這個資料夾裡：存在 GitHub 上的 `youbike-data` 分支，每 20 分鐘自動更新，網頁直接從那裡讀。

## 常用操作（在 repo 根目錄執行，只用 Python 內建套件）

| 做什麼 | 指令或做法 |
|---|---|
| 補座標、比對 OSM | `python src/enrich.py` |
| 抓 YouBike 車數、更新歷史平均 | `python src/youbike_history.py --out yb-data`（Actions 每小時 7、27、47 分跑，結果存在 `youbike-data` 分支；本機跑完的 `yb-data/` 只是測試用，可以刪） |
| 找新岩館 | `python src/find_new_gyms.py`（先跑 enrich.py）→ `docs/new_gyms_report.md`；Actions 每年 1 月、7 月自動跑並開 issue，也可以在 Actions → 新岩館檢查 → Run workflow 手動跑 |
| 館的近期動態 | `python src/fetch_news.py` → `data/processed/news.json`；Actions 每月 1、16 日自動跑 |
| 匯出表格 | `python src/export_table.py` → 自動存到下一個 `output/vN/` |
| 新增／修改館 | 改 `data/manual/gyms_seed.json`，新來源加到 `data/raw/sources.csv`，push 後排程會自動補座標 |
| 座標不對 | 在 seed 該館加上 `"lat": 25.0, "lng": 121.5`（手動座標優先），或改 `osm_keywords` |
| 本機看網頁 | 在 repo 根目錄執行 `python -m http.server 8000`，打開 http://localhost:8000 |

GitHub Actions 會自動跑：YouBike 每小時 7、27、47 分；補座標每週一次，或是館資料、來源、程式有改的時候；近期動態每月 1、16 日；新岩館檢查每年 1、7 月。

## 啟用網站（GitHub Pages）

（已經啟用。以下是當初的設定方式，留著備查）repo 的 **Settings → Pages**：Source 選 **Deploy from a branch**，Branch 選 **main**、資料夾選 **/ (root)**，按 Save。約 1 分鐘後網址就能打開。

## 開啟留言區（giscus，要登入 GitHub 才能留言）

1. repo 的 **Settings → General → Features** 勾選 **Discussions**
2. 到 **Discussions** 新增一個分類，名稱「抱石館留言」，格式選 **Announcement**（只有 giscus 能開新討論串）
3. 安裝 giscus App：https://github.com/apps/giscus ，只選這個 repo
4. 打開 https://giscus.app/zh-TW ，填入 `tim062480-create/climbing-map`、選「抱石館留言」分類，頁面下方會出現 `data-repo-id` 和 `data-category-id`
5. 把這兩個值填進 `web/config.js` 的 `repoId`、`categoryId`，push 後每間館就有自己的留言串
