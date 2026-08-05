#!/usr/bin/env python3
"""Build a snapshot of recent "good" NBA contracts for cut/drop protection.

Source: Spotrac free-agent signing tables (by FA year). A good deal is a
real multi-year commitment or a high AAV — not a minimum / two-way.

Refresh periodically:
  python3 build-nba-contracts.py
"""
from __future__ import annotations

import json
import re
import unicodedata
import urllib.request
from datetime import datetime, timezone
from html import unescape
from pathlib import Path

OUT = Path(__file__).resolve().parent / "nba-contracts-snapshot.js"
UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) PatioBoysHQ/1.0"}

# Rolling window: FA class years to scrape (relative to "now").
LOOKBACK_FA_YEARS = 3
# Good-contract bar — franchise skin in the game, not roster-filler mins.
MIN_AAV_MULTI = 6_000_000
MIN_YEARS_MULTI = 2
MIN_AAV_ANY = 12_000_000


def norm_name(name: str) -> str:
    s = unicodedata.normalize("NFD", name or "").lower()
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    s = s.replace("'", "").replace(".", "").replace("’", "")
    return re.sub(r"[^a-z0-9]", "", s)


def fetch(url: str) -> str:
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read().decode("utf-8", "replace")


def is_good(aav: int, years: int) -> bool:
    if aav >= MIN_AAV_ANY:
        return True
    return aav >= MIN_AAV_MULTI and years >= MIN_YEARS_MULTI


def parse_fa_year(year: int) -> list[dict]:
    url = f"https://www.spotrac.com/nba/free-agents/_/year/{year}"
    html = fetch(url)
    parts = re.split(
        r'<a href="https://www\.spotrac\.com/nba/player/_/id/\d+/[^"]+" class="link">',
        html,
    )
    rows: list[dict] = []
    for part in parts[1:]:
        mname = re.match(r"([^<]+)</a>", part)
        if not mname:
            continue
        name = unescape(mname.group(1)).strip()
        if not name:
            continue
        sorts = re.findall(r'data-sort="(\d+)"', part[:2500])
        if len(sorts) < 3:
            continue
        years = int(sorts[0])
        total = int(sorts[1])
        aav = int(sorts[2])
        if years < 1 or years > 6 or aav < 100_000:
            continue
        if not is_good(aav, years):
            continue
        rows.append({
            "name": name,
            "key": norm_name(name),
            "faYear": year,
            "years": years,
            "total": total,
            "aav": aav,
            "source": "spotrac-fa",
        })
    # Prefer the richest deal if a name appears twice in one year.
    by_key: dict[str, dict] = {}
    for row in rows:
        prev = by_key.get(row["key"])
        if not prev or row["aav"] > prev["aav"]:
            by_key[row["key"]] = row
    return list(by_key.values())


def main() -> None:
    now = datetime.now(timezone.utc)
    as_of_year = now.year
    # Include current FA class + prior LOOKBACK_FA_YEARS-1 (covers ~2 calendar years).
    fa_years = list(range(as_of_year - (LOOKBACK_FA_YEARS - 1), as_of_year + 1))
    deals: list[dict] = []
    errors: list[str] = []
    for year in fa_years:
        try:
            year_rows = parse_fa_year(year)
            print(f"FA {year}: {len(year_rows)} good deals")
            deals.extend(year_rows)
        except Exception as e:
            errors.append(f"{year}: {e}")
            print(f"FA {year}: ERROR {e}")

    # Keep newest deal per player across years.
    by_key: dict[str, dict] = {}
    for row in sorted(deals, key=lambda r: (r["faYear"], r["aav"])):
        by_key[row["key"]] = row
    deals = sorted(by_key.values(), key=lambda r: (-r["aav"], r["name"]))

    payload = {
        "source": "spotrac.com free-agent signings",
        "captured": now.strftime("%Y-%m-%d"),
        "asOfYear": as_of_year,
        "protectYears": 2,
        "goodRule": {
            "minAavMulti": MIN_AAV_MULTI,
            "minYearsMulti": MIN_YEARS_MULTI,
            "minAavAny": MIN_AAV_ANY,
        },
        "faYears": fa_years,
        "deals": deals,
        "errors": errors,
    }
    js = (
        "/* Recent good NBA contracts; refresh with build-nba-contracts.py */\n"
        "window.NBA_CONTRACTS_SNAPSHOT = "
        + json.dumps(payload, separators=(",", ":"))
        + ";\n"
    )
    OUT.write_text(js, encoding="utf-8")
    print(f"Wrote {OUT.name}: {len(deals)} protected deals")


if __name__ == "__main__":
    main()
