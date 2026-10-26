"""
每半年找一次有沒有新的攀岩館
----------------------------
輸入：data/processed/gyms.json（先跑 src/enrich.py，裡面的 osm_unmatched 是 OSM 上有、人工清單沒有的攀岩地點）
      data/processed/new_gyms_seen.json（上一次檢查時已經看過的 OSM 地點，第一次跑時沒有）
輸出：
  data/processed/new_gyms_seen.json   這次看過的 OSM 地點（下次只報新出現的）
  docs/new_gyms_report.md             檢查報告；GitHub Actions 會把它開成一則 issue，手機會收到通知

只是「候選」：OSM 上的名稱、位置可能不準，也可能是戶外岩場或已停業。
要收進地圖的館，人工確認後再加到 data/manual/gyms_seed.json（不能確認的寫進 verify）。
OSM 常常比較晚才有新館，所以報告也附上「關注地區」的 Google 地圖搜尋連結，讓人手動對照（不爬 Google）。

只用 Python 內建套件。
用法：python src/find_new_gyms.py
"""

import json
import math
import sys
import urllib.parse
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
GYMS = ROOT / "data" / "processed" / "gyms.json"
SEEN = ROOT / "data" / "processed" / "new_gyms_seen.json"
REPORT = ROOT / "docs" / "new_gyms_report.md"

# 使用者特別關注的地區：名稱、中心點、半徑（公里）、地址裡會出現的字
WATCH = [
    {"name": "宜蘭", "lat": 24.70, "lng": 121.75, "km": 25, "addr": ["宜蘭"]},
    {"name": "永和", "lat": 25.008, "lng": 121.515, "km": 2.5, "addr": ["永和"]},
]


def distance_km(lat1, lng1, lat2, lng2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = (math.sin(math.radians(lat2 - lat1) / 2) ** 2
         + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lng2 - lng1) / 2) ** 2)
    return 2 * 6371 * math.asin(math.sqrt(a))


def watch_area(p):
    """地點在哪個關注地區（看地址標籤或離中心點的距離），都不是就回傳空字串"""
    addr = " ".join(p["tags"].get(k, "") for k in ("addr:city", "addr:district", "addr:full")) + p["name"]
    for w in WATCH:
        if any(a in addr for a in w["addr"]) or distance_km(p["lat"], p["lng"], w["lat"], w["lng"]) <= w["km"]:
            return w["name"]
    return ""


def gmaps_search(q):
    return "https://www.google.com/maps/search/?api=1&query=" + urllib.parse.quote(q)


def main():
    data = json.loads(GYMS.read_text(encoding="utf-8"))
    places = [p for p in data.get("osm_unmatched", []) if p.get("lat") is not None]
    seen = {}
    if SEEN.exists():
        seen = json.loads(SEEN.read_text(encoding="utf-8")).get("seen", {})
    first = not seen
    today = datetime.now().strftime("%Y-%m-%d")

    new = [p for p in places if p["osm"] not in seen]
    for p in places:
        seen.setdefault(p["osm"], {"name": p["name"], "first_seen": today})
    for p in new:
        p["area"] = watch_area(p)
    new.sort(key=lambda p: ([w["name"] for w in WATCH] + [""]).index(p["area"]))

    SEEN.write_text(json.dumps({
        "_說明": "由 src/find_new_gyms.py 產生，不要手動改；記錄已經報告過的 OSM 地點，下次只報新出現的",
        "checked": today, "seen": seen,
    }, ensure_ascii=False, indent=1), encoding="utf-8")

    watched = [p for p in new if p["area"]]
    lines = [
        f"# 新岩館檢查（{today}）",
        "",
        "由 `src/find_new_gyms.py` 在 GitHub Actions 上每半年產生一次（1 月、7 月）。",
        f"OSM 連線：{'成功' if data.get('osm_ok') else '失敗（沿用上次的 OSM 資料，結果可能不完整）'}",
        "",
        ("第一次檢查：以下是 OSM 上目前有、但地圖還沒收錄的攀岩地點。之後只會列出新出現的。" if first else
         f"上次檢查之後，OSM 上新出現 {len(new)} 個地圖還沒收錄的攀岩地點"
         f"（關注地區 {len(watched)} 個）。"),
        "",
        "這些只是候選，可能是戶外岩場、已停業或名稱不準。要收錄的話，確認是室內館後加到 "
        "`data/manual/gyms_seed.json`，不能確認的寫進 `verify`。",
        "",
    ]
    if new:
        lines += ["| 關注地區 | 名稱 | 標籤 | 連結 |", "|---|---|---|---|"]
        for p in new:
            tags = ", ".join(f"{k}={v}" for k, v in p["tags"].items() if k in ("sport", "leisure", "climbing", "website"))
            name = p["name"] or "（無名稱）"
            q = f"{p['name']} 攀岩" if p["name"] else f"{p['lat']},{p['lng']}"   # 沒名稱的用座標查
            lines.append(f"| {('⭐ ' + p['area']) if p['area'] else ''} | {name} | {tags} | "
                         f"[OSM]({p['url']}) [Google 地圖]({gmaps_search(q)}) |")
    else:
        lines.append("OSM 上沒有新出現的攀岩地點。")
    lines += ["", "## 關注地區手動對照", "",
              "OSM 常常比較晚才有新館，請點下面的連結，看有沒有地圖上還沒有的館：", ""]
    known = {}
    for g in data["gyms"]:
        if g.get("status") == "已停業":
            continue
        for w in WATCH:
            if any(a in (g.get("city", "") + (g.get("district") or "") + (g.get("address") or "")) for a in w["addr"]):
                known.setdefault(w["name"], []).append(g["name"])
    for w in WATCH:
        links = " ".join(f"[{kw}]({gmaps_search(w['name'] + ' ' + kw)})" for kw in ("攀岩館", "抱石"))
        lines.append(f"- **{w['name']}**：{links}。地圖已收錄：{'、'.join(known.get(w['name'], [])) or '（無）'}")
    REPORT.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"新出現 {len(new)} 個（關注地區 {len(watched)} 個），報告：{REPORT.relative_to(ROOT)}")


if __name__ == "__main__":
    sys.exit(main())
