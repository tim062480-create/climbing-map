"""
把館資料匯出成表格，方便人工檢查、交給別人看
------------------------------------------------
輸入：data/processed/gyms.json
輸出：output/vN/gyms.csv、output/vN/summary.md
  N 自動取 output/ 下最大的版本號 + 1，舊版不覆蓋。
  要採用某一版，由使用者自己複製到 output/final/。

只用 Python 內建套件。
用法：python src/export_table.py
"""

import csv
import json
import re
from collections import Counter
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
GYMS = ROOT / "data" / "processed" / "gyms.json"
OUTPUT = ROOT / "output"
TYPE_NAME = {"bouldering": "抱石", "lead": "上攀", "speed": "速度", "autobelay": "自動確保"}


def next_version_dir():
    """output/v1、v2…裡最大的號碼 + 1；空的 v 資料夾（只有 .gitkeep）就直接用它"""
    nums = sorted(int(m.group(1)) for p in OUTPUT.glob("v*") if (m := re.fullmatch(r"v(\d+)", p.name)))
    for n in nums:
        d = OUTPUT / f"v{n}"
        if not [f for f in d.iterdir() if f.name != ".gitkeep"]:
            return d
    d = OUTPUT / f"v{(nums[-1] if nums else 0) + 1}"
    d.mkdir(parents=True)
    return d


def main():
    data = json.loads(GYMS.read_text(encoding="utf-8"))
    sources = data["sources"]
    out_dir = next_version_dir()
    rows = []
    for g in data["gyms"]:
        src = sorted({sid for ids in g.get("src", {}).values() for sid in ids})
        rows.append({
            "代號": g["id"], "館名": g["name"], "狀態": g.get("status", ""),
            "類型": "、".join(TYPE_NAME.get(t, t) for t in g.get("types", [])),
            "縣市": g.get("city", ""), "區": g.get("district", ""), "地址": g.get("address", ""),
            "電話": g.get("phone", ""), "營業時間": g.get("hours", ""),
            "價格": "；".join(f"{p['item']} {p['price']}" for p in g.get("prices", [])),
            "緯度": g.get("lat") or "", "經度": g.get("lng") or "", "座標來源": g.get("coord_source", ""),
            "YouTube 影片數": len(g.get("youtube", [])),
            "來源": "；".join(f"{sid} {sources[sid]['title']}" for sid in src if sid in sources),
            "待確認": "；".join(g.get("verify", [])),
        })
    with open(out_dir / "gyms.csv", "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)

    status = Counter(r["狀態"] for r in rows)
    coord = Counter(r["座標來源"] for r in rows)
    city = Counter(r["縣市"] for r in rows if r["狀態"] != "已停業")
    lines = [
        f"# 抱石館資料 {out_dir.name}",
        "",
        f"- 產生時間：{datetime.now():%Y-%m-%d %H:%M}（`src/export_table.py`）",
        f"- 資料整理日期：{data.get('checked', '')}；座標更新：{data.get('generated', '')}",
        f"- 共 {len(rows)} 間：" + "、".join(f"{k} {v}" for k, v in status.most_common()),
        f"- 有座標 {sum(1 for r in rows if r['緯度'])} 間；座標來源：" + "、".join(f"{k} {v}" for k, v in coord.most_common()),
        f"- 有價格 {sum(1 for r in rows if r['價格'])} 間；有門牌 {sum(1 for r in rows if re.search(r'[0-9]+號', r['地址']))} 間",
        "",
        "## 各縣市（不含已停業）",
        "",
        "| 縣市 | 間數 |",
        "|---|---|",
        *[f"| {k} | {v} |" for k, v in city.most_common()],
        "",
        "完整表格：`gyms.csv`（用 Excel 開啟即可）",
    ]
    (out_dir / "summary.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"已輸出到 {out_dir.relative_to(ROOT)}/（gyms.csv、summary.md）")


if __name__ == "__main__":
    main()
