#!/usr/bin/env python3
"""Build a multi-source NBA per-game projection consensus snapshot.

Sources (reputable / publicly fetchable):
  1) Sleeper season projections
  2) FantasyPros overall projections
  3) Hashtag Basketball projections (free top of board)

For each counting-stat key present on a player, take the median across
sources that published that key (mean if exactly two). Then write
nba-proj-consensus.js for the HQ tools to score with league settings.
"""
from __future__ import annotations

import json
import re
import statistics
import unicodedata
import urllib.request
from collections import defaultdict
from datetime import datetime, timezone
from html import unescape
from pathlib import Path

OUT = Path(__file__).resolve().parent / "nba-proj-consensus.js"
UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) PatioBoysHQ/1.0"}

# Stats we aggregate into league scoring later.
CORE_STATS = ("pts", "reb", "ast", "stl", "blk", "to", "tpm", "dd", "td",
              "fgmi", "ftmi", "oreb", "fta", "fgm", "fga", "ftm", "tpa")


def norm_name(name: str) -> str:
    s = unicodedata.normalize("NFD", name or "").lower()
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    s = s.replace("'", "").replace(".", "").replace("’", "")
    return re.sub(r"[^a-z0-9]", "", s)


def fetch(url: str) -> bytes:
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=60) as resp:
        return resp.read()


def median_or_mean(vals: list[float]) -> float:
    vals = [float(v) for v in vals if v is not None]
    if not vals:
        raise ValueError("empty")
    if len(vals) == 1:
        return vals[0]
    if len(vals) == 2:
        return statistics.mean(vals)
    return statistics.median(vals)


def parse_num(text: str):
    t = (text or "").strip().replace(",", "").replace("%", "")
    if not t or t in {"-", "—", "N/A"}:
        return None
    try:
        return float(t)
    except ValueError:
        return None


def load_sleeper(season: str = "2026") -> dict:
    raw = json.loads(fetch(f"https://api.sleeper.com/projections/nba/{season}?season_type=regular"))
    out = {}
    for row in raw:
        stats = row.get("stats") or {}
        pl = row.get("player") or {}
        name = (pl.get("full_name")
                or f"{pl.get('first_name') or ''} {pl.get('last_name') or ''}".strip())
        if not name:
            continue
        key = norm_name(name)
        gp = float(stats.get("gp") or 1) or 1.0
        # Sleeper NBA projections are already per-game-ish (gp often 1).
        mapped = {}
        for k in CORE_STATS:
            if stats.get(k) is None:
                continue
            v = float(stats[k])
            # If a row looks like season totals (gp >> 1 and huge pts), normalize.
            if gp > 5 and k in {"pts", "reb", "ast", "stl", "blk", "to", "tpm", "fgmi", "ftmi", "oreb", "fta", "fgm", "fga", "ftm", "tpa", "dd", "td"}:
                v = v / gp
            mapped[k] = v
        if not mapped:
            continue
        prev = out.get(key)
        # Prefer the richer / higher-usage line if duplicates exist.
        score = mapped.get("pts") or 0
        if prev is None or score >= (prev["stats"].get("pts") or 0):
            out[key] = {
                "name": name,
                "sleeperId": str(row.get("player_id") or ""),
                "stats": mapped,
            }
    return out


def load_fantasypros() -> dict:
    html = fetch("https://www.fantasypros.com/nba/projections/overall.php").decode("utf-8", "ignore")
    out = {}
    for tr in re.findall(r"<tr[^>]*>.*?</tr>", html, re.I | re.S):
        if "/nba/players/" not in tr:
            continue
        m = re.search(r'/nba/players/[^"]+"[^>]*>([^<]+)<', tr)
        if not m:
            continue
        name = unescape(m.group(1)).strip()
        # Strip team/pos injury suffixes: "Giannis Antetokounmpo (MIA - PF,C) DTD"
        name = re.sub(r"\s*\(.*$", "", name).strip()
        tds = [unescape(re.sub(r"<[^>]+>", "", td)).strip()
               for td in re.findall(r"<td[^>]*>(.*?)</td>", tr, re.I | re.S)]
        # Player, PTS, REB, AST, BLK, STL, FG%, FT%, 3PM, GP, MIN, TO, ...
        if len(tds) < 12:
            continue
        pts, reb, ast, blk, stl = map(parse_num, tds[1:6])
        tpm, gp, _min, to = map(parse_num, tds[8:12])
        if not gp or gp <= 0:
            continue
        mapped = {}
        for k, total in (("pts", pts), ("reb", reb), ("ast", ast), ("blk", blk),
                         ("stl", stl), ("tpm", tpm), ("to", to)):
            if total is None:
                continue
            mapped[k] = total / gp
        if not mapped:
            continue
        out[norm_name(name)] = {"name": name, "stats": mapped}
    return out


def load_hashtag() -> dict:
    html = fetch("https://hashtagbasketball.com/fantasy-basketball-projections").decode("utf-8", "ignore")
    out = {}
    # Headers: R# ADP PLAYER POS TEAM GP MPG FG% FT% 3PM PTS TREB AST STL BLK TO TOTAL
    for tr in re.findall(r"<tr[^>]*>.*?</tr>", html, re.I | re.S):
        tds = [unescape(re.sub(r"<[^>]+>", "", td)).strip()
               for td in re.findall(r"<td[^>]*>(.*?)</td>", tr, re.I | re.S)]
        if len(tds) < 16:
            continue
        name = tds[2]
        if not name or name.upper() == "PLAYER":
            continue
        # Skip rank/adp non-player rows
        if parse_num(tds[0]) is None:
            continue
        gp = parse_num(tds[5]) or 1.0
        # Free board is already per-game counting stats.
        mapped = {}
        for k, idx in (("tpm", 9), ("pts", 10), ("reb", 11), ("ast", 12),
                       ("stl", 13), ("blk", 14), ("to", 15)):
            v = parse_num(tds[idx])
            if v is not None:
                mapped[k] = v
        if not mapped:
            continue
        out[norm_name(name)] = {"name": name, "stats": mapped, "gp": gp}
    return out


def build_consensus(season: str = "2026") -> dict:
    sleeper = load_sleeper(season)
    fantasypros = load_fantasypros()
    hashtag = load_hashtag()
    sources = {
        "sleeper": sleeper,
        "fantasypros": fantasypros,
        "hashtag": hashtag,
    }
    print("loaded:", {k: len(v) for k, v in sources.items()})

    all_keys = set().union(*(s.keys() for s in sources.values()))
    players = {}
    for key in all_keys:
        by_source = {}
        display = None
        sleeper_id = None
        for src_name, table in sources.items():
            if key not in table:
                continue
            row = table[key]
            by_source[src_name] = row["stats"]
            display = display or row.get("name")
            sleeper_id = sleeper_id or row.get("sleeperId")
        if not by_source:
            continue
        consensus = {}
        for stat in CORE_STATS:
            vals = [st[stat] for st in by_source.values() if stat in st and st[stat] is not None]
            if not vals:
                continue
            consensus[stat] = round(median_or_mean(vals), 4)
        if not consensus:
            continue
        players[key] = {
            "name": display or key,
            "sleeperId": sleeper_id or None,
            "stats": consensus,
            "sources": sorted(by_source.keys()),
            "nSources": len(by_source),
        }

    return {
        "source": "Patio Boys multi-site consensus",
        "season": season,
        "method": "median (mean if exactly 2 sources)",
        "sites": ["Sleeper", "FantasyPros", "Hashtag Basketball"],
        "captured": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "playerCount": len(players),
        "players": players,
    }


def main():
    data = build_consensus("2026")
    js = "/* Auto-generated multi-site NBA projection consensus. Re-run build-proj-consensus.py to refresh. */\n"
    js += "window.NBA_PROJ_CONSENSUS = "
    js += json.dumps(data, separators=(",", ":"))
    js += ";\n"
    OUT.write_text(js)
    print(f"wrote {OUT} ({data['playerCount']} players)")


if __name__ == "__main__":
    main()
