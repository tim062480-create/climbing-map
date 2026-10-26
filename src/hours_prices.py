"""
把 seed 裡文字寫的營業時間和票價，轉成網頁可以算「現在有沒有開、現在入場多少錢」的規則
------------------------------------------------------------------------------------
加到 gyms.json 每間館：
  open_hours = {"week": [週一…週日], "holiday": 國定假日}
      每天是 [[開始分鐘, 結束分鐘], …]（例如 [[600, 1380]] 是 10:00–23:00）；[] 是公休；null 是不知道
      國定假日：營業時間有寫「假日／週末」就用週六的，不然用週日的
  prices[i].when = 這個票什麼時候能用
      []         沒有限制（全日票、單次入場）
      [條件, …]  符合其中一個就能用；條件 = {"days": "wd"|"we"|[0-6…], "from": 分鐘, "to": 分鐘, "before_close": 分鐘}
                 days："wd" 平日、"we" 假日（含國定假日）、數字是星期幾（0=週一）；from/to 沒寫就是從開門／到打烊
      null       看不出時段（例如只寫「平日星光」），網頁不拿來算「現在的價格」
  prices[i].kind = "entry" 一次入場 | "hourly" 計時 | "other" 租借、課程、學生票等

用法：
  python src/hours_prices.py      直接更新 data/processed/gyms.json（不用重跑 enrich.py、不用連 OSM）
  enrich.py 產生 gyms.json 時也會呼叫 annotate()
"""

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SEED = ROOT / "data" / "manual" / "gyms_seed.json"
OUT = ROOT / "data" / "processed" / "gyms.json"

WD = {"一": 0, "二": 1, "三": 2, "四": 3, "五": 4, "六": 5, "日": 6, "天": 6}
DAY = "[一二三四五六日天]"
TIME = r"(\d{1,2}):(\d\d)"
RANGE = re.compile(TIME + r"\s*[–\-~～至]\s*" + TIME)
# 跟 enrich.py 的 price_min 一樣：不算「入場」的項目
NOT_ENTRY = re.compile(r"租|體驗|課|入會|會費|陪同|學生|兒童|幼兒|起價|三個月|包場|持照")
PER_HOUR = re.compile(r"／\s*小?時|/\s*h", re.I)


def minutes(h, m):
    return int(h) * 60 + int(m)


def day_spec(seg):
    """營業時間一段開頭的「週一至週五」「平日」「週六、日」… → (星期幾的集合, 剩下的文字)；沒寫星期回傳 (None, seg)"""
    s = seg.strip()
    for pat, days in ((r"^(每日|每天|週一至週日|平假日)", range(7)), (r"^平日", range(5)), (r"^(假日|週末)", (5, 6))):
        m = re.match(pat, s)
        if m:
            return set(days), s[m.end():]
    m = re.match(rf"^週({DAY})\s*[至到–\-~]\s*週?({DAY})", s)
    if m:
        a, b = WD[m.group(1)], WD[m.group(2)]
        return {(a + i) % 7 for i in range((b - a) % 7 + 1)}, s[m.end():]   # 「週四至週二」會繞一圈
    m = re.match(rf"^週({DAY}(?:\s*[、,]\s*週?{DAY})*)", s)
    if m:
        return {WD[c] for c in re.findall(DAY, m.group(1))}, s[m.end():]
    return None, s


def subtract(intervals, gap):
    out = []
    for a, b in intervals:
        if gap[1] <= a or gap[0] >= b:
            out.append([a, b])
        else:
            if a < gap[0]:
                out.append([a, gap[0]])
            if gap[1] < b:
                out.append([gap[1], b])
    return out


def parse_hours(text):
    """營業時間文字 → {"week": [7 天], "holiday": …}；完全看不懂回傳 None"""
    if not text:
        return None
    week = [None] * 7
    seen_any = False
    for seg in re.split(r"[；;]", text):
        # 括號裡的「17:00–18:00 休息」是中間休息；其他括號內容（來源說明、預約制…）不管
        breaks = [[minutes(*m[:2]), minutes(*m[2:])] for p in re.findall(r"（([^）]*休息[^）]*)）", seg) for m in RANGE.findall(p)]
        body = re.sub(r"（[^）]*）|\([^)]*\)", "", seg)
        days, rest = day_spec(body)
        if days is None:
            days = set(range(7))
        if re.search(r"公休|休館", rest):
            for d in days:
                week[d] = []
            seen_any = True
            continue
        if re.search(r"待確認|未列", rest):
            continue   # 留 None（不知道）
        intervals = [[minutes(*m[:2]), minutes(*m[2:])] for m in RANGE.findall(rest)]
        if not intervals:
            continue
        for g in breaks:
            intervals = subtract(intervals, g)
        intervals = [[a, 1440 if b == 0 else b] for a, b in intervals]   # 「到 00:00」是午夜
        for d in days:
            week[d] = intervals
        seen_any = True
    if not seen_any:
        return None
    return {"week": week, "holiday": week[5] if re.search(r"假日|週末", text) else week[6]}


PERIOD = {"早上": (None, 720), "上午": (None, 720), "下午": (720, 1080), "晚上": (1080, None)}


def days_word(s):
    if "平假日" in s:
        return None
    if "平日" in s:
        return "wd"
    if re.search(r"假日|週末", s):
        return "we"
    return None


def price_when(item, note=""):
    """一個票價項目什麼時候能用（格式見檔案開頭）"""
    text = f"{item} {note}"
    # 「平日晚上、假日下午與晚上」（尖峰、離峰）
    if re.search(r"(平日|假日)(早上|上午|下午|晚上)", note):
        conds = []
        for part in re.split(r"[、，,]", note):
            d = days_word(part)
            for p in re.findall(r"早上|上午|下午|晚上", part):
                a, b = PERIOD[p]
                conds.append({"days": d, "from": a, "to": b})
        return conds
    # 「平日 18:00 前離場、假日 18:00 後入場」
    if re.search(r"(平日|假日)\s*" + TIME + r"\s*(前|後)", note):
        conds = []
        for part in re.split(r"[、，,]", note):
            m = re.search(TIME + r"\s*(前|後)", part)
            if m:
                t = minutes(m.group(1), m.group(2))
                conds.append({"days": days_word(part), **({"to": t} if m.group(3) == "前" else {"from": t})})
        return conds
    # 「週六 19:30–22:00、週日 19:00–21:30」
    per_day = re.findall(rf"週({DAY})\s*{TIME}\s*[–\-~～]\s*{TIME}", note)
    if per_day:
        return [{"days": [WD[d]], "from": minutes(h1, m1), "to": minutes(h2, m2)} for d, h1, m1, h2, m2 in per_day]

    if item.startswith("其他時段"):
        return []   # 「其他時段」= 其他票不適用時的原價，任何時候都能買
    days = days_word(item)
    cond = {"days": days}
    r = RANGE.search(item)
    before = re.search(TIME + r"\s*前", item)
    after = re.search(TIME + r"\s*後", item)
    close = re.search(r"(?:閉館|閉店|營業結束|結束營業)前\s*([\d.]+)\s*小時|最後(兩|二|\d)\s*小時", text)
    if r:
        cond.update({"from": minutes(*r.groups()[:2]), "to": minutes(*r.groups()[2:])})
    elif before:
        cond["to"] = minutes(*before.groups())
    elif after:
        cond["from"] = minutes(*after.groups())
    elif close:
        n = close.group(1) or {"兩": "2", "二": "2"}.get(close.group(2), close.group(2))
        cond["before_close"] = round(float(n) * 60)
    elif re.search(r"星光|時段|離峰|尖峰|白天|晚上|下午|早上", item):
        return None   # 有時段但沒寫幾點，看不出來
    return [cond] if (days or len(cond) > 1) else []


def kind(p):
    if NOT_ENTRY.search(p.get("item", "")):
        return "other"
    if PER_HOUR.search(str(p.get("price", ""))) or "計時" in p.get("item", ""):
        return "hourly"
    return "entry"


def annotate(g):
    """在一間館（gyms.json 的格式）加上 open_hours 和每個票價的 when、kind"""
    g["open_hours"] = parse_hours(g.get("hours"))
    for p in g.get("prices") or []:
        p["kind"] = kind(p)
        p["when"] = price_when(p.get("item", ""), p.get("note", "")) if p["kind"] != "other" else None
    return g


def main():
    data = json.loads(OUT.read_text(encoding="utf-8"))
    seed = {g["id"]: g for g in json.loads(SEED.read_text(encoding="utf-8"))["gyms"]}
    for g in data["gyms"]:
        if g["id"] in seed:   # 營業時間、票價以 seed 為準（seed 改了但還沒跑 enrich.py 時也對）
            g["hours"] = seed[g["id"]].get("hours")
            g["prices"] = seed[g["id"]].get("prices")
        annotate(g)
    OUT.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    active = [g for g in data["gyms"] if g.get("status") != "已停業"]
    print(f"營業時間看得懂：{sum(1 for g in active if g['open_hours'])}/{len(active)} 間；"
          f"入場票價看得出時段：{sum(1 for g in active for p in g.get('prices') or [] if p['kind'] != 'other' and p['when'] is not None)}"
          f"/{sum(1 for g in active for p in g.get('prices') or [] if p['kind'] != 'other')} 個")
    return 0


if __name__ == "__main__":
    sys.exit(main())
