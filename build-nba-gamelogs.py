#!/usr/bin/env python3
"""Build per-game NBA box-score snapshot for smash samples.

Pulls every regular-season box score from ESPN for the target seasons,
maps athletes to Sleeper player IDs by normalized name, and writes compact
counting-stat rows. The site scores those rows live under league settings.

Refresh:
  python3 build-nba-gamelogs.py
  python3 build-nba-gamelogs.py --seasons 2025 2024
"""
from __future__ import annotations

import argparse
import concurrent.futures
import gzip
import json
import re
import time
import unicodedata
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

OUT = Path(__file__).resolve().parent / "nba-gamelogs-snapshot.js"
UA = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
    )
}

# Compact field order stored per game. Client expands to scoring keys.
FIELDS = ["pts", "reb", "oreb", "ast", "stl", "blk", "to", "fgmi", "ftmi", "tpm"]

# Sleeper NBA season year → ESPN season year (ESPN uses ending calendar year).
# Sleeper 2025 = 2025-26 NBA = ESPN 2026.
def espn_season_for_sleeper(sleeper_season: int) -> int:
    return int(sleeper_season) + 1


def fetch_json(url: str, retries: int = 4) -> dict | list:
    last: Exception | None = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=45) as resp:
                raw = resp.read()
                enc = (resp.headers.get("Content-Encoding") or "").lower()
                if enc == "gzip" or raw[:2] == b"\x1f\x8b":
                    raw = gzip.decompress(raw)
                return json.loads(raw.decode("utf-8"))
        except Exception as e:  # noqa: BLE001 — retry network / 5xx
            last = e
            time.sleep(0.4 * (2**attempt))
    raise RuntimeError(f"fetch failed {url}: {last}")


def normalize_name(name: str | None) -> str:
    if not name:
        return ""
    s = unicodedata.normalize("NFKD", str(name))
    s = "".join(ch for ch in s if not unicodedata.combining(ch))
    s = s.lower()
    s = s.replace("&", " and ")
    s = re.sub(r"\b(jr|sr|ii|iii|iv|v)\b\.?", " ", s)
    s = re.sub(r"[^a-z0-9]+", "", s)
    return s


def parse_made_att(cell: str | None) -> tuple[int, int]:
    if not cell or "-" not in str(cell):
        return 0, 0
    left, right = str(cell).split("-", 1)
    try:
        return int(float(left)), int(float(right))
    except ValueError:
        return 0, 0


def to_int(cell: str | None) -> int:
    if cell is None or cell == "" or cell == "-":
        return 0
    try:
        return int(float(str(cell).replace("+", "")))
    except ValueError:
        return 0


def load_sleeper_name_map() -> dict[str, str]:
    """normalized full name → sleeper player_id (prefer active / with team)."""
    players = fetch_json("https://api.sleeper.app/v1/players/nba")
    assert isinstance(players, dict)
    best: dict[str, tuple[int, str]] = {}
    for pid, p in players.items():
        if not isinstance(p, dict):
            continue
        if p.get("sport") and p.get("sport") != "nba":
            continue
        names = [
            p.get("full_name"),
            ((" " + " ").join(
                filter(None, [p.get("first_name"), p.get("last_name")])
            )).strip()
            or None,
        ]
        # Prefer players who look roster-relevant.
        rank = 0
        if p.get("active"):
            rank += 4
        if p.get("team"):
            rank += 2
        if p.get("fantasy_positions"):
            rank += 1
        for name in names:
            key = normalize_name(name)
            if not key:
                continue
            prev = best.get(key)
            if prev is None or rank > prev[0]:
                best[key] = (rank, str(pid))
    return {k: v[1] for k, v in best.items()}


def list_event_ids(espn_season: int) -> list[str]:
    ids: list[str] = []
    page = 1
    while True:
        url = (
            "https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba"
            f"/seasons/{espn_season}/types/2/events?limit=1000&page={page}"
        )
        data = fetch_json(url)
        assert isinstance(data, dict)
        for item in data.get("items") or []:
            ref = (item or {}).get("$ref") or ""
            m = re.search(r"/events/(\d+)", ref)
            if m:
                ids.append(m.group(1))
        pages = int(data.get("pageCount") or 1)
        if page >= pages:
            break
        page += 1
    # Preserve chronological order as returned; de-dupe.
    seen: set[str] = set()
    out: list[str] = []
    for gid in ids:
        if gid not in seen:
            seen.add(gid)
            out.append(gid)
    return out


def parse_boxscore(payload: dict) -> list[tuple[str, str, list[int]]]:
    """Return list of (espn_athlete_id, display_name, field row)."""
    box = payload.get("boxscore") or {}
    rows: list[tuple[str, str, list[int]]] = []
    for team_block in box.get("players") or []:
        for group in team_block.get("statistics") or []:
            labels = [str(x).upper() for x in (group.get("labels") or [])]
            if not labels:
                continue
            idx = {lab: i for i, lab in enumerate(labels)}
            needed = ("PTS", "REB", "AST", "TO", "STL", "BLK", "FG", "FT", "3PT")
            if any(k not in idx for k in needed):
                continue
            for ath in group.get("athletes") or []:
                athlete = ath.get("athlete") or {}
                espn_id = str(athlete.get("id") or "").strip()
                name = athlete.get("displayName") or athlete.get("shortName") or ""
                stats = ath.get("stats") or []
                if not espn_id or ath.get("didNotPlay"):
                    continue
                # Skip DNP / empty minutes when present.
                if "MIN" in idx:
                    mins = str(stats[idx["MIN"]]) if idx["MIN"] < len(stats) else ""
                    if mins in ("", "-", "0", "00", "0:00"):
                        continue

                def cell(lab: str) -> str | None:
                    i = idx.get(lab)
                    if i is None or i >= len(stats):
                        return None
                    return stats[i]

                fgm, fga = parse_made_att(cell("FG"))
                ftm, fta = parse_made_att(cell("FT"))
                tpm, _tpa = parse_made_att(cell("3PT"))
                row = [
                    to_int(cell("PTS")),
                    to_int(cell("REB")),
                    to_int(cell("OREB")),
                    to_int(cell("AST")),
                    to_int(cell("STL")),
                    to_int(cell("BLK")),
                    to_int(cell("TO")),
                    max(0, fga - fgm),
                    max(0, fta - ftm),
                    tpm,
                ]
                # Ignore pure empty lines.
                if sum(row) == 0:
                    continue
                rows.append((espn_id, name, row))
    return rows


def fetch_game_rows(game_id: str) -> list[tuple[str, str, list[int]]]:
    url = (
        "https://site.web.api.espn.com/apis/site/v2/sports/basketball/nba/"
        f"summary?event={game_id}"
    )
    try:
        payload = fetch_json(url)
    except Exception as e:  # noqa: BLE001
        print(f"  warn: boxscore {game_id}: {e}")
        return []
    assert isinstance(payload, dict)
    return parse_boxscore(payload)


def build_season(
    sleeper_season: str,
    name_map: dict[str, str],
    workers: int,
) -> tuple[dict[str, list[list[int]]], dict]:
    espn_season = espn_season_for_sleeper(int(sleeper_season))
    print(f"Season sleeper={sleeper_season} espn={espn_season}")
    event_ids = list_event_ids(espn_season)
    print(f"  events: {len(event_ids)}")

    by_pid: dict[str, list[list[int]]] = {}
    unmatched_names: dict[str, int] = {}
    matched_games = 0
    athlete_lines = 0

    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        futs = {pool.submit(fetch_game_rows, gid): gid for gid in event_ids}
        done = 0
        for fut in concurrent.futures.as_completed(futs):
            done += 1
            if done % 200 == 0 or done == len(futs):
                print(f"  boxscores {done}/{len(futs)}")
            rows = fut.result()
            if not rows:
                continue
            matched_games += 1
            for _espn_id, name, row in rows:
                athlete_lines += 1
                key = normalize_name(name)
                pid = name_map.get(key)
                if not pid:
                    unmatched_names[name] = unmatched_names.get(name, 0) + 1
                    continue
                by_pid.setdefault(pid, []).append(row)

    meta = {
        "sleeperSeason": str(sleeper_season),
        "espnSeason": espn_season,
        "events": len(event_ids),
        "gamesParsed": matched_games,
        "athleteLines": athlete_lines,
        "playersMapped": len(by_pid),
        "unmatchedNames": len(unmatched_names),
        "unmatchedTop": sorted(
            unmatched_names.items(), key=lambda kv: -kv[1]
        )[:15],
    }
    print(
        f"  mapped players={meta['playersMapped']} lines={athlete_lines} "
        f"unmatchedNames={meta['unmatchedNames']}"
    )
    return by_pid, meta


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--seasons",
        nargs="+",
        default=["2025", "2024"],
        help="Sleeper NBA season years (e.g. 2025 = 2025-26)",
    )
    ap.add_argument("--workers", type=int, default=16)
    args = ap.parse_args()

    t0 = time.time()
    print("Loading Sleeper player name map…")
    name_map = load_sleeper_name_map()
    print(f"  name keys: {len(name_map)}")

    seasons: dict[str, dict[str, list[list[int]]]] = {}
    season_meta: list[dict] = []
    for season in args.seasons:
        by_pid, meta = build_season(str(season), name_map, args.workers)
        seasons[str(season)] = by_pid
        season_meta.append(meta)

    payload = {
        "source": "ESPN box scores (regular season)",
        "method": "Every game box score → counting stats → Sleeper id by name",
        "captured": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "fields": FIELDS,
        "seasons": seasons,
        "meta": {
            "seasonMeta": season_meta,
            "elapsedSec": round(time.time() - t0, 1),
            "note": (
                "Rows are [pts,reb,oreb,ast,stl,blk,to,fgmi,ftmi,tpm]. "
                "Site scores live under league settings (dd/td/40+ derived)."
            ),
        },
    }

    body = json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
    OUT.write_text(
        "/* Auto-generated by build-nba-gamelogs.py — do not edit */\n"
        f"window.NBA_GAMELOGS = {body};\n",
        encoding="utf-8",
    )
    size_kb = OUT.stat().st_size / 1024
    print(f"Wrote {OUT.name} ({size_kb:.0f} KB) in {payload['meta']['elapsedSec']}s")


if __name__ == "__main__":
    main()
