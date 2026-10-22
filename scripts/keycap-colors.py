"""Helper for the daily keycap visualizer routine (docs/keycap-visualizer-routine.md).

  python scripts/keycap-colors.py candidates
      GMK and SP DCS sets on the live tracker that have a picture but are not
      in src/data/keycap-visualizer/keycaps.json yet, newest first.

  python scripts/keycap-colors.py colors <slug> [--out DIR]
      Downloads that set's tracker pictures into DIR and prints each one's
      dominant colors, largest share first.

The colors are a starting point. Which one is alpha, mod, accent or legend is
decided by looking at the picture: backgrounds, desks and shadows show up too.
"""
import argparse
import json
import os
import sys
import tempfile
import urllib.parse
import urllib.request

from PIL import Image

SITE = "https://keyboard-six-tau.vercel.app"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CATALOG = os.path.join(ROOT, "src", "data", "keycap-visualizer", "keycaps.json")
MAKERS = {"GMK": "GMK", "SP": "SP DCS"}


def get_json(path, params):
    url = f"{SITE}{path}?{urllib.parse.urlencode(params, doseq=True)}"
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "keycap-visualizer"})) as r:
        return json.load(r)


def catalog_slugs():
    with open(CATALOG, encoding="utf-8") as f:
        return {k["slug"] for k in json.load(f)["keycaps"]}


def tracker_sets(maker, pages=3):
    for page in range(1, pages + 1):
        data = get_json("/api/group-buys", {"type": "KEYCAPS", "maker": maker, "sort": "date-desc", "limit": 50, "page": page})
        yield from data["data"]
        if page * 50 >= data["total"]:
            break


def candidates():
    have = catalog_slugs()
    for maker, family in MAKERS.items():
        for s in tracker_sets(maker):
            if s["slug"] in have or not (s.get("imageUrl") or s.get("images")):
                continue
            # SP also makes SA/DSA/DSS; the visualizer only draws DCS.
            if family == "SP DCS" and "dcs" not in s["name"].lower():
                continue
            print(f"{family:7} {s['status']:15} {s['slug']:45} {s['name']}")


def dominant_colors(path, count=8):
    img = Image.open(path).convert("RGB")
    img.thumbnail((300, 300))
    quantized = img.quantize(colors=count, method=Image.Quantize.MEDIANCUT)
    palette = quantized.getpalette()
    total = img.width * img.height
    for pixels, index in sorted(quantized.getcolors(), reverse=True):
        r, g, b = palette[index * 3:index * 3 + 3]
        yield f"#{r:02X}{g:02X}{b:02X}", pixels / total


def colors(slug, out):
    data = get_json(f"/api/group-buys/{urllib.parse.quote(slug)}", {})
    gb = data.get("data", data)
    urls = list(dict.fromkeys([u for u in [gb.get("imageUrl"), *(gb.get("images") or [])] if u]))[:4]
    if not urls:
        sys.exit(f"{slug} has no pictures on the tracker")
    print(f"{gb.get('name', slug)}  ({len(urls)} pictures)")
    for i, url in enumerate(urls):
        path = os.path.join(out, f"{slug}-{i}.img")
        # gmk.net serves media paths with raw spaces ("Keycaps (2).webp").
        safe = urllib.parse.quote(url, safe=":/?=&%")
        req = urllib.request.Request(safe, headers={"User-Agent": "Mozilla/5.0"})
        try:
            with urllib.request.urlopen(req, timeout=30) as r, open(path, "wb") as f:
                f.write(r.read())
            swatches = "  ".join(f"{h} {share:4.0%}" for h, share in dominant_colors(path))
        except Exception as e:  # a dead link or a non-image shouldn't hide the other pictures
            print(f"\n(skipped) {url}\n  {type(e).__name__}: {e}")
            continue
        print(f"\n{path}\n  {url}\n  {swatches}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("candidates")
    c = sub.add_parser("colors")
    c.add_argument("slug")
    c.add_argument("--out", default=os.path.join(tempfile.gettempdir(), "keycap-colors"))
    args = parser.parse_args()
    if args.cmd == "candidates":
        candidates()
    else:
        os.makedirs(args.out, exist_ok=True)
        colors(args.slug, args.out)
