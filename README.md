# 附近抱石館地圖

用手機定位，自動列出附近的室內抱石館；點開可以看價格、營業時間、影片、留言和交通建議（大眾運輸、YouBike）。

- 網址：https://tim062480-create.github.io/climbing-map/（要先在 Settings → Pages 啟用，見下方）
- 資料怎麼來的、怎麼驗證：[docs/資料來源紀錄.md](docs/資料來源紀錄.md)

## 資料夾

```
climbing-map/
├─ index.html              網頁入口（GitHub Pages 從這裡開始）
├─ web/                    網頁程式：app.js、style.css、config.js（留言區設定）
├─ data/
│  ├─ raw/                 原始資料：sources.csv（媒體、日期時間、標題、網址，不存全文）、
│  │                       osm/（OpenStreetMap 原始回應）、youbike_log/（YouBike 車數記錄）
│  ├─ manual/              人工整理的館資料 gyms_seed.json（唯一要手動改的資料檔）
│  └─ processed/           程式產生的資料：gyms.json（網頁讀這個）、youbike_*.json
├─ src/                    所有 Python 程式
├─ output/                 匯出結果：v1、v2…每一版另存，output/final/ 放你決定採用的版本
├─ docs/                   報告與文件：資料來源紀錄.md、enrich_report.md（座標比對報告，自動產生）
├─ logs/                   過程紀錄
└─ .github/workflows/update-data.yml   自動更新資料的排程
```

## 常用操作（在 repo 根目錄執行，只用 Python 內建套件）

| 做什麼 | 指令或做法 |
|---|---|
| 補座標、比對 OSM | `python src/enrich.py` |
| 抓 YouBike 車數 | `python src/youbike_near.py`（加 `--stations` 會更新全台站點位置） |
| 找新岩館 | `python src/find_new_gyms.py`（先跑 enrich.py）→ `docs/new_gyms_report.md`；Actions 每年 1 月、7 月自動跑並開 issue，也可以在 Actions → 新岩館檢查 → Run workflow 手動跑 |
| 匯出表格 | `python src/export_table.py` → 自動存到下一個 `output/vN/` |
| 新增／修改館 | 改 `data/manual/gyms_seed.json`，新來源加到 `data/raw/sources.csv`，push 後排程會自動補座標 |
| 座標不對 | 在 seed 該館加上 `"lat": 25.0, "lng": 121.5`（手動座標優先），或改 `osm_keywords` |
| 本機看網頁 | 在 repo 根目錄執行 `python -m http.server 8000`，打開 http://localhost:8000 |

GitHub Actions 會自動跑：YouBike 每 20 分鐘一次；補座標每週一次，或是館資料、來源、程式有改的時候。

## 啟用網站（GitHub Pages）

repo 的 **Settings → Pages**：Source 選 **Deploy from a branch**，Branch 選 **main**、資料夾選 **/ (root)**，按 Save。約 1 分鐘後網址就能打開。

## 開啟留言區（giscus，要登入 GitHub 才能留言）

1. repo 的 **Settings → General → Features** 勾選 **Discussions**
2. 到 **Discussions** 新增一個分類，名稱「抱石館留言」，格式選 **Announcement**（只有 giscus 能開新討論串）
3. 安裝 giscus App：https://github.com/apps/giscus ，只選這個 repo
4. 打開 https://giscus.app/zh-TW ，填入 `tim062480-create/climbing-map`、選「抱石館留言」分類，頁面下方會出現 `data-repo-id` 和 `data-category-id`
5. 把這兩個值填進 `web/config.js` 的 `repoId`、`categoryId`，push 後每間館就有自己的留言串
