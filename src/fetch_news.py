"""
抓每間館的近期動態（每半個月一次）
----------------------------------
輸入：data/manual/gyms_seed.json
輸出：
  data/raw/news/日期.json      這次抓到的項目（只存日期、來源、標題、網址，不存內文）
  data/processed/news.json     網頁讀的資料：館 id → 最近 180 天內最多 8 則動態（跟上一次的結果合併）

來源（都是公開的 RSS，不用金鑰）：
  1. Google 新聞 RSS：用館的 osm_keywords 第一組關鍵字搜尋。
     標題要包含任一組關鍵字的全部字、而且有「攀岩／抱石／岩館…」，才算是這間館的新聞（避免同名的店、地名）
  2. 館的 YouTube 頻道（links.youtube）：頻道的影片 RSS
  3. 館的官網（links.website）：網頁裡有宣告 RSS／Atom 才抓。官網只是大網站的一個子頁面時，
     一樣要求標題有攀岩相關字，避免整個網站的其他文章混進來
Facebook、Instagram 沒有不用登入的公開資料可以抓，網頁上只附連結讓人點過去看。

只用 Python 內建套件。容器連不到 Google、YouTube 時交給 GitHub Actions 跑。
用法：python src/fetch_news.py
"""

import json
import re
import sys
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from html import unescape
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SEED = ROOT / "data" / "manual" / "gyms_seed.json"
RAW_DIR = ROOT / "data" / "raw" / "news"
OUT = ROOT / "data" / "processed" / "news.json"

UA = "Mozilla/5.0 (compatible; climbing-map/1.0; +https://github.com/tim062480-create/climbing-map)"
KEEP_DAYS = 180
KEEP_N = 8
CLIMB = re.compile(r"攀岩|抱石|岩館|岩場|攀登|climb|boulder", re.I)
TW = timezone(timedelta(hours=8))
STATS = {"news_raw": 0, "sample": None}   # Google 新聞過濾前的總則數，全部是 0 時印出回應開頭，方便查是不是被擋


def get(url, timeout=30):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "zh-TW,zh;q=0.9"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8", errors="replace")


def norm(s):
    s = (s or "").lower().replace("臺", "台")
    return re.sub(r"[\s\-_·•・.()（）]", "", s)


def parse_date(s):
    """RSS 的 pubDate（RFC 822）或 Atom 的 ISO 8601 → 台灣時間 YYYY-MM-DD；看不懂回傳空字串"""
    if not s:
        return ""
    try:
        d = parsedate_to_datetime(s)
    except (TypeError, ValueError):
        try:
            d = datetime.fromisoformat(s.strip().replace("Z", "+00:00"))
        except ValueError:
            return ""
    if d.tzinfo is None:
        d = d.replace(tzinfo=timezone.utc)
    return d.astimezone(TW).strftime("%Y-%m-%d")


def parse_feed(xml):
    """RSS 或 Atom → [{date, title, url, source}]"""
    root = ET.fromstring(xml)
    items = []
    for it in root.iter():
        tag = it.tag.split("}")[-1]
        if tag not in ("item", "entry"):
            continue
        f = {}
        for c in it:
            f.setdefault(c.tag.split("}")[-1], c)   # 同名的欄位（Atom 的 link 可能有好幾個）取第一個
        text = lambda k: (f[k].text or "").strip() if k in f else ""
        title = unescape(text("title"))
        link = text("link") or (f["link"].get("href", "") if "link" in f else "")
        date = parse_date(text("pubDate") or text("published") or text("updated"))
        source = text("source")
        if title and link:
            items.append({"date": date, "title": title, "url": link.strip(), "source": source})
    return items


def keyword_hit(gym, title):
    t = norm(title)
    return any(all(norm(k) in t for k in group) for group in gym.get("osm_keywords", []))


def google_news(gym):
    groups = gym.get("osm_keywords") or []
    if not groups:
        return []
    q = " ".join(f'"{k}"' for k in groups[0]) + " (攀岩 OR 抱石)"
    url = "https://news.google.com/rss/search?" + urllib.parse.urlencode(
        {"q": f"{q} when:{KEEP_DAYS}d", "hl": "zh-TW", "gl": "TW", "ceid": "TW:zh-Hant"})
    xml = get(url)
    raw = parse_feed(xml)
    STATS["news_raw"] += len(raw)
    if STATS["sample"] is None:
        STATS["sample"] = xml[:300]
    out = []
    for it in raw:
        # Google 新聞的標題結尾是「 - 媒體名稱」
        title = re.sub(r"\s+-\s+[^-]+$", "", it["title"]) if it["source"] else it["title"]
        # 沒通過過濾的也回傳（match=False），存進原始資料，方便檢查過濾條件是不是太嚴
        out.append({**it, "title": title, "kind": "news", "source": it["source"] or "Google 新聞",
                    "match": bool(keyword_hit(gym, title) and CLIMB.search(title))})
    return out


def youtube(gym):
    page_url = (gym.get("links") or {}).get("youtube", "")
    if not page_url:
        return []
    m = re.search(r"/channel/(UC[\w-]{22})", page_url)
    cid = m.group(1) if m else None
    if not cid:
        m = re.search(r'"(?:channelId|externalId)":"(UC[\w-]{22})"', get(page_url))
        cid = m.group(1) if m else None
    if not cid:
        return []
    items = parse_feed(get(f"https://www.youtube.com/feeds/videos.xml?channel_id={cid}"))
    return [{**it, "kind": "youtube", "source": "YouTube"} for it in items]


def website(gym):
    site = (gym.get("links") or {}).get("website", "")
    if not site:
        return []
    html = get(site)
    m = (re.search(r'<link[^>]+type="application/(?:rss|atom)\+xml"[^>]*>', html, re.I))
    href = re.search(r'href="([^"]+)"', m.group(0)) if m else None
    if not href:
        return []
    items = parse_feed(get(urllib.parse.urljoin(site, unescape(href.group(1)))))
    sub_page = urllib.parse.urlparse(site).path.strip("/") != ""
    return [{**it, "kind": "website", "source": "官網"} for it in items if not sub_page or CLIMB.search(it["title"])]


def main():
    seed = json.loads(SEED.read_text(encoding="utf-8"))
    old = {}
    if OUT.exists():
        old = json.loads(OUT.read_text(encoding="utf-8")).get("gyms", {})
    today = datetime.now(TW)
    cutoff = (today - timedelta(days=KEEP_DAYS)).strftime("%Y-%m-%d")

    raw, result, errors = {}, {}, []
    for g in seed["gyms"]:
        if g.get("status") == "已停業":
            continue
        found = []
        for name, fn in (("Google 新聞", google_news), ("YouTube", youtube), ("官網", website)):
            try:
                found += fn(g)
            except Exception as e:   # 連不到、格式不對：這個來源這次跳過，沿用上次的結果
                errors.append(f"{g['id']} {name}：{e}")
            time.sleep(1.5)
        raw[g["id"]] = found
        found = [{k: v for k, v in it.items() if k != "match"} for it in found if it.get("match", True)]
        merged = {}
        for it in old.get(g["id"], []) + found:
            merged.setdefault(it["url"], it)
        items = sorted((it for it in merged.values() if it.get("date", "") >= cutoff),
                       key=lambda it: it["date"], reverse=True)[:KEEP_N]
        if items:
            result[g["id"]] = items
        print(f"{g['id']:24s} 這次 {len(found):2d} 則，保留 {len(items)} 則")

    RAW_DIR.mkdir(parents=True, exist_ok=True)
    (RAW_DIR / f"{today:%Y-%m-%d}.json").write_text(json.dumps(raw, ensure_ascii=False, indent=1), encoding="utf-8")
    OUT.write_text(json.dumps({
        "_說明": "由 src/fetch_news.py 產生，不要手動改；只存日期、來源、標題、網址",
        "updated": today.strftime("%Y-%m-%d %H:%M"),
        "gyms": result,
    }, ensure_ascii=False, indent=1), encoding="utf-8")
    for e in errors:
        print("失敗：" + e)
    print(f"\nGoogle 新聞過濾前共 {STATS['news_raw']} 則")
    if not STATS["news_raw"] and STATS["sample"] is not None:
        print("Google 新聞回應開頭：" + STATS["sample"])
    print(f"\n完成：{len(result)} 間館有近期動態；{len(errors)} 個來源失敗")


if __name__ == "__main__":
    sys.exit(main())
