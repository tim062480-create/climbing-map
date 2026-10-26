"""
抓每間館的近期動態（每半個月一次）
----------------------------------
輸入：data/manual/gyms_seed.json
輸出：
  data/raw/news/日期.json      這次抓到的項目（只存日期、來源、標題、網址，不存內文）
  data/processed/news.json     網頁讀的資料：館 id → 最近 180 天內最多 8 則動態（跟上一次的結果合併）

來源（都是公開資料，不用金鑰）：
  1. Google 新聞 RSS：用 seed 每間館的 news.names（館的專有名稱，例如「原岩攀岩」「趣攀岩」「MegaSTONE」）搜尋。
     過濾規則（Google 是比對全文，所以會混進只是順帶提到攀岩的整理文，要靠標題判斷）：
       - 標題要出現其中一個名稱
       - news.climb 為 true（名稱太一般，例如「內湖運動中心」）時，標題還要有攀岩、抱石等字
       - 連鎖品牌（名稱跟別間共用）：標題提到這間的分店字（news.branch）就算；提到別間的分店字就不算；
         都沒提到分店時，算品牌的消息，每間分店都放
     同一組名稱只查一次（例如原岩 5 間分店共用一次查詢）
  2. 原岩官網的「原岩新訊」（tupclimbing.tw/news）：列表上有日期、標題和適用分店，「全部分店」放到每間
  3. climbrock.vip 岩館系統的「活動及課程」（爬森、BABO PAPAK 等官網）：頁面內嵌課程資料，日期用建立時間
  4. 館的 YouTube 頻道（links.youtube）：頻道的影片 RSS
  5. 館的官網（links.website）：網頁裡有宣告 RSS／Atom 才抓。官網只是大網站的一個子頁面時，
     一樣要求標題有攀岩相關字，避免整個網站的其他文章混進來

2026-10-26 使用者決定先只抓官方來源（2～5），Google 新聞（1）關掉：台灣新聞很少報導單一間岩館，
人工看過抓到的都不是館的消息。要再打開就把 USE_GOOGLE_NEWS 改成 True。
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
USE_GOOGLE_NEWS = False   # 先只抓官方來源（見檔案開頭）
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


def siblings(gym, gyms):
    """名稱跟這間共用的其他館（同一個連鎖品牌的其他分店）"""
    mine = {norm(n) for n in gym["news"]["names"]}
    return [g for g in gyms if g is not gym and "news" in g and mine & {norm(n) for n in g["news"]["names"]}]


def news_match(gym, title, gyms):
    """這則標題是不是這間館的消息（規則見檔案開頭）"""
    t, cfg = norm(title), gym.get("news") or {}
    if not any(norm(n) in t for n in cfg.get("names", [])):
        return False
    if cfg.get("climb") and not CLIMB.search(title):
        return False
    if cfg.get("branch") and norm(cfg["branch"]) in t:
        return True
    return not any(s["news"].get("branch") and norm(s["news"]["branch"]) in t for s in siblings(gym, gyms))


_NEWS_CACHE = {}


def google_news(gym, gyms):
    names = (gym.get("news") or {}).get("names") or []
    if not names:
        return []
    q = "(" + " OR ".join(f'"{n}"' for n in names) + ")"
    if gym["news"].get("climb"):   # 名稱太一般（例如「嗨翻」）時，搜尋就加上攀岩，少抓不相干的新聞
        q += " (攀岩 OR 抱石)"
    if q not in _NEWS_CACHE:   # 連鎖品牌的分店共用同一次查詢
        url = "https://news.google.com/rss/search?" + urllib.parse.urlencode(
            {"q": f"{q} when:{KEEP_DAYS}d", "hl": "zh-TW", "gl": "TW", "ceid": "TW:zh-Hant"})
        xml = get(url)
        _NEWS_CACHE[q] = parse_feed(xml)
        STATS["news_raw"] += len(_NEWS_CACHE[q])
        if STATS["sample"] is None:
            STATS["sample"] = xml[:300]
        time.sleep(1.5)
    out = []
    for it in _NEWS_CACHE[q]:
        # Google 新聞的標題結尾是「 - 媒體名稱」
        title = re.sub(r"\s+-\s+[^-]+$", "", it["title"]) if it["source"] else it["title"]
        # 沒通過過濾的也回傳（match=False），存進原始資料，方便檢查過濾條件是不是太嚴
        out.append({**it, "title": title, "kind": "news", "source": it["source"] or "Google 新聞",
                    "match": news_match(gym, title, gyms)})
    return out


TUP_NEWS = "https://tupclimbing.tw/news"


def tup_news():
    """原岩官網「原岩新訊」第一頁 → [{date, title, url, branches:[分店字…]}]；沒標分店或「全部分店」時 branches 是空的"""
    html = get(TUP_NEWS)
    out = []
    for art in re.findall(r"<article\b.*?</article>", html, re.S):
        d = re.search(r"(\d{4})年(\d{1,2})月(\d{1,2})日", art)
        a = re.search(r'<h3 class="node__title">\s*<a href="([^"]+)"[^>]*>(.*?)</a>', art, re.S)
        if not (d and a):
            continue
        branches = [re.sub(r"店$", "", unescape(b).strip()) for b in re.findall(r'<div class="field__item">([^<]+)</div>', art)]
        out.append({"date": f"{d.group(1)}-{int(d.group(2)):02d}-{int(d.group(3)):02d}",
                    "title": unescape(re.sub(r"<[^>]+>", "", a.group(2))).strip(),
                    "url": urllib.parse.urljoin(TUP_NEWS, a.group(1)),
                    "branches": [] if any("全部" in b for b in branches) else branches})
    return out


def tup_for(gym, items):
    """把原岩新訊分給分店：標了這間的分店，或沒標分店（全部分店）"""
    if "tupclimbing.tw" not in (gym.get("links") or {}).get("website", ""):
        return []
    branch = (gym.get("news") or {}).get("branch", "")
    # 沒標分店、但標題寫了某間分店（例如「A19店結束營業」）：只算那間
    other_branch = lambda title: re.search(r"[A-Z]\d+店|[一-鿿]{2}店", title) and branch not in title
    return [{"date": it["date"], "title": it["title"], "url": it["url"], "kind": "website", "source": "原岩官網"}
            for it in items if branch in it["branches"] or (not it["branches"] and not other_branch(it["title"]))]


def climbrock(gym):
    """官網是 climbrock.vip 岩館系統時，抓「活動及課程」頁內嵌的課程資料（Inertia 的 data-page JSON）"""
    site = (gym.get("links") or {}).get("website", "")
    u = urllib.parse.urlparse(site)
    if not u.hostname or not u.hostname.endswith(".climbrock.vip"):
        return []
    origin = f"{u.scheme}://{u.hostname}"
    m = re.search(r'data-page="([^"]+)"', get(origin + "/courses"))
    if not m:
        return []
    courses = json.loads(unescape(m.group(1))).get("props", {}).get("courses") or []
    if isinstance(courses, dict):   # 有分頁時資料在 data 裡
        courses = courses.get("data", [])
    return [{"date": parse_date(c.get("created_at")), "title": c["title"].strip(), "url": f"{origin}/courses/{c['id']}",
             "kind": "website", "source": "官網活動與課程"}
            for c in courses if c.get("title") and c.get("is_active", True) and not c.get("is_archived")]


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
    gyms = [g for g in seed["gyms"] if g.get("status") != "已停業"]
    try:
        tup = tup_news()
    except Exception as e:
        tup = []
        errors.append(f"原岩官網：{e}")
    for g in gyms:
        found = tup_for(g, tup)
        sources = [("climbrock 官網", climbrock), ("YouTube", youtube), ("官網", website)]
        if USE_GOOGLE_NEWS:
            sources.insert(0, ("Google 新聞", lambda x: google_news(x, gyms)))
        for name, fn in sources:
            try:
                found += fn(g)
            except Exception as e:   # 連不到、格式不對：這個來源這次跳過，沿用上次的結果
                errors.append(f"{g['id']} {name}：{e}")
        time.sleep(1)
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
    if USE_GOOGLE_NEWS:
        print(f"\nGoogle 新聞過濾前共 {STATS['news_raw']} 則")
    if USE_GOOGLE_NEWS and not STATS["news_raw"] and STATS["sample"] is not None:
        print("Google 新聞回應開頭：" + STATS["sample"])
    print(f"\n完成：{len(result)} 間館有近期動態；{len(errors)} 個來源失敗")


if __name__ == "__main__":
    sys.exit(main())
