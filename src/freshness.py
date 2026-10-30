"""
資料要有一年內的來源才相信（使用者 2026-10-28 定的規則）
------------------------------------------------------
每個欄位（地址、電話、營業時間、價格、介紹）看 seed 的 src 對到 sources.csv 的哪幾個來源，
取來源「日期時間」欄裡最新的日期：
  - 最新日期在一年內 → 相信
  - 超過一年、或來源沒寫日期（「未標示」「官網」「較舊」…）、或這個欄位沒有來源 → 不相信
日期只取看得懂的：2026-10-24、2025-05、2026 年 2 月、2026（只有年、月時取最早的那天，寧可算舊）。
「2024-04 發布，2025-12-19 更新」這種取最新的那個。
營業狀態另外參考 data/raw/gmaps_check/ 的逐館 Google 地圖確認記錄（有營業時間才算）。

加到 gyms.json 每間館：
  fresh       {欄位: "YYYY-MM-DD" 最新來源日期，或 null}
  stale       不相信的欄位（網頁上標「超過一年」，不拿來算現在有沒有開、價格排序和預算篩選）
  data_date   所有來源裡最新的日期
  營業中的館如果所有來源都超過一年（或都沒日期），status 改成「待確認」，原本的狀態留在 status_seed，verify 加一條說明

用法：
  python src/freshness.py      直接更新 data/processed/gyms.json，並列出哪些館、哪些欄位不相信
  enrich.py 產生 gyms.json 時也會呼叫 annotate()
"""

import csv
import json
import re
import sys
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SEED = ROOT / "data" / "manual" / "gyms_seed.json"
SOURCES = ROOT / "data" / "raw" / "sources.csv"
GMAPS_CHECK = ROOT / "data" / "raw" / "gmaps_check"   # 逐館看 Google 地圖的結果，檔名是日期
OUT = ROOT / "data" / "processed" / "gyms.json"

MAX_AGE_DAYS = 365
FIELDS = ("address", "phone", "hours", "prices", "features")   # 館名、營業狀態不逐欄標，狀態看全部來源
DATE_RE = re.compile(r"(20\d\d)(?:\s*[-./年]\s*(\d{1,2})(?:\s*[-./月]\s*(\d{1,2}))?)?")


def source_date(text):
    """「日期時間」欄的文字 → 裡面最新的日期（date），看不懂回傳 None"""
    best = None
    for y, m, d in DATE_RE.findall(text or ""):
        try:
            v = date(int(y), int(m or 1), int(d or 1))
        except ValueError:
            continue
        best = max(best, v) if best else v
    return best


def load_source_dates():
    with open(SOURCES, encoding="utf-8-sig") as f:
        return {r["代號"]: source_date(r["日期時間"]) for r in csv.DictReader(f)}


def load_check_dates():
    """data/raw/gmaps_check/日期*.csv → {館 id: 最近一次在 Google 地圖確認還在營業的日期}
    （2026-10-29 那份要 latest_review 有值、has_hours 是 yes；其他份有列到就算）"""
    out = {}
    for f in sorted(GMAPS_CHECK.glob("*.csv")) if GMAPS_CHECK.exists() else []:
        d = source_date(f.stem)
        with open(f, encoding="utf-8-sig") as fh:
            for r in csv.DictReader(fh):
                if r.get("has_hours", "yes").lower() not in ("yes", "y"):
                    continue
                if d and (r["id"] not in out or out[r["id"]] < d):
                    out[r["id"]] = d
    return out


def annotate(g, dates, today=None, checks=None):
    """在一間館（gyms.json 的格式，status 已經是 seed 的值）加上 fresh、stale、data_date；
    不相信的營業時間、價格不拿來算 open_hours、price_min、price_day"""
    today = today or date.today()
    cutoff = today - timedelta(days=MAX_AGE_DAYS)
    src = g.get("src") or {}
    fresh, stale = {}, []
    for field in FIELDS:
        if not g.get(field):
            continue
        ds = [dates.get(s) for s in src.get(field, [])]
        latest = max((d for d in ds if d), default=None)
        fresh[field] = latest.isoformat() if latest else None
        if latest is None or latest < cutoff:
            stale.append(field)
    all_dates = [d for ids in src.values() for d in (dates.get(s) for s in ids) if d]
    if checks and checks.get(g["id"]):   # 在 Google 地圖確認過還在營業，也算營業狀態的來源
        all_dates.append(checks[g["id"]])
        fresh["status"] = checks[g["id"]].isoformat()
    latest_all = max(all_dates, default=None)
    g["fresh"] = fresh
    g["stale"] = stale
    g["data_date"] = latest_all.isoformat() if latest_all else None

    if "hours" in stale:
        g["open_hours"] = None
    if "prices" in stale:
        g["price_min"] = g["price_day"] = None
    if g.get("status") == "營業中" and (latest_all is None or latest_all < cutoff):
        g["status_seed"] = g["status"]
        g["status"] = "待確認"
        why = f"最新的來源是 {latest_all.isoformat()}" if latest_all else "來源都沒有日期"
        g["verify"] = list(g.get("verify") or []) + [f"所有來源都超過一年（{why}），不確定現在是否還在營業"]
    return g


def main():
    import enrich, hours_prices   # 放這裡：enrich.py 也會 import 這個檔案
    data = json.loads(OUT.read_text(encoding="utf-8"))
    seed = {g["id"]: g for g in json.loads(SEED.read_text(encoding="utf-8"))["gyms"]}
    dates = load_source_dates()
    checks = load_check_dates()
    for g in data["gyms"]:
        s = seed.get(g["id"])
        if s:   # 文字欄位以 seed 為準，再重算營業時間規則和最低價，重跑也不會疊加
            for k in ("name", "status", "verify", "src", "address", "phone", "hours", "prices", "features"):
                g[k] = s.get(k)
            g.pop("status_seed", None)
        hours_prices.annotate(g)
        g["price_min"] = enrich.price_min(g)
        g["price_day"] = enrich.price_min(g, hourly=False)
        annotate(g, dates, checks=checks)
    OUT.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")

    undated = sorted(k for k, v in dates.items() if v is None)
    print(f"沒有日期的來源 {len(undated)} 個：{'、'.join(undated)}")
    active = [g for g in data["gyms"] if g.get("status_seed", g.get("status")) != "已停業"]
    print(f"\n營業中改成待確認（所有來源都超過一年）：{sum(1 for g in active if g.get('status_seed'))} 間")
    for g in active:
        if g["stale"] or g.get("status_seed"):
            mark = "【改待確認】" if g.get("status_seed") else ""
            print(f"  {g['name']}{mark}：不相信 {'、'.join(g['stale']) or '—'}（最新來源 {g['data_date'] or '無日期'}）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
