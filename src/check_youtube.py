"""
檢查 data/manual/gyms_seed.json 裡的 YouTube 影片還在不在、實際標題和頻道是什麼。

用 YouTube 公開的 oEmbed（不用金鑰）；影片設成私人或禁止嵌入會回 401／403，被刪除會回 404。
輸出：docs/youtube_check.md（AI 自動產生的報告，用來人工判斷影片和館是否對得上）
"""
import json
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SEED = ROOT / "data" / "manual" / "gyms_seed.json"
REPORT = ROOT / "docs" / "youtube_check.md"
OEMBED = "https://www.youtube.com/oembed?format=json&url="


def oembed(vid):
    url = OEMBED + urllib.parse.quote(f"https://www.youtube.com/watch?v={vid}", safe="")
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "climbing-map"}), timeout=20) as r:
            return json.loads(r.read().decode("utf-8")), None
    except urllib.error.HTTPError as e:
        return None, f"HTTP {e.code}"
    except Exception as e:
        return None, f"連線失敗：{e}"


def main():
    seed = json.loads(SEED.read_text(encoding="utf-8"))
    rows, bad = [], 0
    for g in seed["gyms"]:
        for v in g.get("youtube", []):
            info, err = oembed(v["id"])
            if err:
                bad += 1
            cell = f"❌ {err}" if err else f"{info.get('title', '')}（{info.get('author_name', '')}）"
            rows.append(f"| {g['name']} | [{v['id']}](https://www.youtube.com/watch?v={v['id']}) | {v.get('title', '')} | {cell} |")
            print(f"{g['id']:24s} {v['id']} {'失敗 ' + err if err else 'OK'}")
    lines = [
        "# YouTube 影片檢查",
        "",
        f"產生時間：{datetime.now():%Y-%m-%d %H:%M}（由 `src/check_youtube.py` 產生）",
        "",
        f"共 {len(rows)} 支，{bad} 支打不開。請對照「實際標題」看影片是不是真的在拍這間館。",
        "",
        "| 館 | 影片 | seed 裡寫的標題 | 實際標題（頻道） |",
        "|---|---|---|---|",
        *rows,
    ]
    REPORT.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"完成：{len(rows)} 支，{bad} 支打不開 → {REPORT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
