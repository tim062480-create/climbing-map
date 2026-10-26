"""
全台 YouBike 站點、即時車數和「同時段歷史平均」，依縣市切檔
------------------------------------------------------------
每 20 分鐘由 GitHub Actions 跑一次（.github/workflows/youbike.yml），結果存在 youbike-data 分支，
那個分支每次都覆蓋成只有一個版本，所以不會讓 repo 越來越大。網頁直接從 raw.githubusercontent.com 讀。

輸出（--out 指定的資料夾，預設 yb-data/）：
  index.json             各區代號 → 縣市名、站數、範圍（網頁用位置判斷要讀哪幾區）
  areas/區碼.json         該區每站 [站名, 緯度, 經度, 總車位, 可借, 可還]，可借、可還是這次抓到的即時車數
  pattern/區碼.json       該區每站「平日 wd／假日 we × 48 個半小時」的 [平均可借, 平均可還, 樣本數]，還沒有資料的格子是 0

歷史平均的算法：每次抓到車數，就更新「現在這個半小時」那一格：
  樣本數 n = min(n + 1, N_MAX)，平均 += (這次 - 平均) / n
樣本數到 N_MAX 後就固定，等於越新的資料權重越大，站點搬遷、改裝後會自己調整過來。
不存原始記錄（全台一年約 11 GB，放不進 repo）。

資料來源（兩個都抓，同一站以有車數的為準）：
  1. YouBike 官網用的全台站點 JSON（apis.youbike.com.tw，非正式公開 API，格式可能變），有區碼 area_code
  2. 臺北市 YouBike 2.0 即時資訊（政府資料開放平臺，只有臺北市），用來補臺北市缺的車數
「可借、可還都是 0」代表資料源沒給數字（例如颱風暫停營運），當作沒有資料，不更新平均。

只用 Python 內建套件。
用法：python src/youbike_history.py [--out yb-data] [--seed-logs data/raw/youbike_log]
  --seed-logs：pattern 還是空的時候，先用舊的車數記錄（2026-10-24 起每館附近 4 站）把平均填起來
"""

import csv
import json
import sys
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NATIONAL_URL = "https://apis.youbike.com.tw/json/station-yb2.json"
TAIPEI_URL = "https://tcgbusfs.blob.core.windows.net/dotapp/youbike/v2/youbike_immediate.json"
TW = timezone(timedelta(hours=8))
N_MAX = 20     # 每格最多算幾個樣本（之後新資料權重固定 1/20）
SLOTS = 48     # 一天 48 個半小時
# 官網資料的 area_code 沒寫縣市，依站點範圍對照（2026-10-26 確認）
AREA_NAMES = {
    "00": "臺北市", "01": "臺中市", "05": "新北市", "07": "桃園市", "08": "嘉義市", "09": "新竹市",
    "0A": "苗栗縣", "0B": "新竹縣", "10": "新竹科學園區", "11": "嘉義縣", "12": "高雄市", "13": "臺南市",
    "14": "屏東縣", "15": "臺東縣",
}


def fetch_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        raw = json.loads(resp.read().decode("utf-8-sig"))
    if isinstance(raw, dict):
        for k in ("retVal", "data", "result", "stations"):
            if k in raw:
                raw = raw[k]
                break
        if isinstance(raw, dict):
            raw = list(raw.values())
    return raw


def to_int(v):
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return None


def counts(rent, ret):
    """可借、可還都是 0 代表資料源沒給數字，當作沒有資料"""
    rent, ret = to_int(rent), to_int(ret)
    return (None, None) if rent is None or ret is None or (rent == 0 and ret == 0) else (rent, ret)


def fetch_stations():
    """→ {區碼: {站號: [站名, 緯度, 經度, 總車位, 可借, 可還]}}"""
    areas = {}
    for s in fetch_json(NATIONAL_URL):
        try:
            sno, lat, lng = str(s["station_no"]), round(float(s["lat"]), 6), round(float(s["lng"]), 6)
        except (KeyError, TypeError, ValueError):
            continue
        rent, ret = counts(s.get("available_spaces"), s.get("empty_spaces"))
        areas.setdefault(str(s.get("area_code") or "??"), {})[sno] = [
            str(s.get("name_tw") or "").replace("YouBike2.0_", ""), lat, lng, to_int(s.get("parking_spaces")), rent, ret]
    try:   # 臺北市開放資料補車數
        tp = areas.get("00", {})
        for s in fetch_json(TAIPEI_URL):
            row = tp.get(str(s.get("sno")))
            if row and row[4] is None:
                row[4], row[5] = counts(s.get("available_rent_bikes", s.get("sbi")), s.get("available_return_bikes", s.get("bemp")))
    except Exception as e:
        print(f"臺北市開放資料失敗：{e}")
    return areas


def slot_of(t):
    return ("we" if t.isoweekday() >= 6 else "wd"), t.hour * 2 + t.minute // 30


def update(pattern, sno, daytype, slot, rent, ret):
    """把一次車數加進平均（算法見檔頭）"""
    st = pattern.setdefault(sno, {"wd": [0] * SLOTS, "we": [0] * SLOTS})   # 0 = 這格還沒有資料（比 null 省空間）
    cell = st[daytype][slot]
    if not cell:
        st[daytype][slot] = [float(rent), float(ret), 1]
        return
    n = min(cell[2] + 1, N_MAX)
    st[daytype][slot] = [round(cell[0] + (rent - cell[0]) / n, 1), round(cell[1] + (ret - cell[1]) / n, 1), n]


def seed_from_logs(log_dir, patterns, area_of):
    """用舊的每館附近車數記錄（data/raw/youbike_log/日期.csv）依時間順序填平均"""
    rows = 0
    for f in sorted(Path(log_dir).glob("*.csv")):
        with open(f, encoding="utf-8-sig") as fh:
            for r in csv.DictReader(fh):
                rent, ret = counts(r.get("可借車數"), r.get("可還空位"))
                area = area_of.get(r.get("站號"))
                if rent is None or area is None:
                    continue
                daytype, slot = slot_of(datetime.strptime(r["記錄時間"], "%Y-%m-%d %H:%M"))
                update(patterns.setdefault(area, {}), r["站號"], daytype, slot, rent, ret)
                rows += 1
    print(f"用舊記錄填了 {rows} 筆")


def main():
    args = sys.argv[1:]
    out = Path(args[args.index("--out") + 1]) if "--out" in args else ROOT / "yb-data"
    seed = args[args.index("--seed-logs") + 1] if "--seed-logs" in args else None
    now = datetime.now(TW)
    stamp = now.strftime("%Y-%m-%d %H:%M")

    try:
        areas = fetch_stations()
    except Exception as e:
        print(f"YouBike 全台資料抓不到，這次不更新：{e}")
        return 0
    (out / "areas").mkdir(parents=True, exist_ok=True)
    (out / "pattern").mkdir(parents=True, exist_ok=True)

    patterns = {}
    for code in areas:
        f = out / "pattern" / f"{code}.json"
        patterns[code] = json.loads(f.read_text(encoding="utf-8"))["stations"] if f.exists() else {}
    if seed and not any(patterns.values()):
        seed_from_logs(seed, patterns, {sno: code for code, st in areas.items() for sno in st})

    daytype, slot = slot_of(now)
    index, updated = {}, 0
    for code, st in sorted(areas.items()):
        for sno, (_, _, _, _, rent, ret) in st.items():
            if rent is not None:
                update(patterns[code], sno, daytype, slot, rent, ret)
                updated += 1
        lats, lngs = [v[1] for v in st.values()], [v[2] for v in st.values()]
        index[code] = {"name": AREA_NAMES.get(code, f"區碼 {code}"), "stations": len(st),
                       "with_counts": sum(1 for v in st.values() if v[4] is not None),
                       "bbox": [min(lats), min(lngs), max(lats), max(lngs)]}
        dump = lambda path, obj: (out / path).write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        dump(f"areas/{code}.json", {"updated": stamp, "stations": st})
        dump(f"pattern/{code}.json", {"updated": stamp, "n_max": N_MAX, "stations": patterns[code]})

    (out / "index.json").write_text(json.dumps({
        "_說明": "全台 YouBike 依區切檔，由 climbing-map 的 src/youbike_history.py 產生，每 20 分鐘更新；"
                 "areas/區碼.json 每站 [站名,緯度,經度,總車位,可借,可還]；pattern/區碼.json 每站 wd/we × 48 個半小時 [平均可借,平均可還,樣本數]",
        "updated": stamp, "slot": [daytype, slot], "areas": index,
    }, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{stamp}：{sum(len(v) for v in areas.values())} 站、{len(areas)} 區，{updated} 站有車數，更新 {daytype} 第 {slot} 格")
    return 0


if __name__ == "__main__":
    sys.exit(main())
