#!/usr/bin/env python3
"""Build NBA contract snapshot for cut protection + Trade ★ bias.

Sources:
  1) Spotrac free-agent signings — recent "good deals" (cut/drop protect)
  2) Basketball-Reference current contracts — salary tier for Trade ★
  3) Hoops Rumors buyout market watch — completed buyouts/waives
  4) EXTENSION_OVERRIDES — fresh extensions BBRef lags on (e.g. Naji Marshall)

Refresh:
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

LOOKBACK_FA_YEARS = 3
MIN_AAV_MULTI = 6_000_000
MIN_YEARS_MULTI = 2
MIN_AAV_ANY = 12_000_000

# Current-season salary tiers (y1).
TIER_LARGE = 18_000_000
TIER_MID = 6_000_000
TIER_MIN = 2_800_000

BUYOUT_PAGES = [
    "https://www.hoopsrumors.com/2026/02/2026-nba-buyout-market-watch.html",
    "https://www.hoopsrumors.com/2025/02/2025-nba-buyout-market-watch.html",
]

# Fresh extensions BBRef / Spotrac FA tables often lag on (yearsLeft + protect deals).
# Salaries: remaining seasons including current. Deals: extension terms (faYear = sign year).
EXTENSION_OVERRIDES = [
    {
        "name": "Naji Marshall",
        "key": "najimarshall",
        "team": "DAL",
        # 2026-27 still on prior deal; extension 2027-28..2029-30 (Spotrac cash).
        "y1": 9_428_571,
        "yearsLeft": 4,
        "guaranteed": 61_628_571,  # 9.428571 + 18.1956 + 17.323584 + 16.680816
        "tier": "mid",
        "source": "manual-extension-2026-08",
        "deal": {
            "faYear": 2026,
            "years": 3,
            "total": 52_200_000,
            "aav": 17_400_000,
            "source": "manual-extension-2026-08",
        },
    },
]


def apply_extension_overrides(salaries: list[dict], deals: list[dict]) -> None:
    sal_by = {s["key"]: s for s in salaries}
    deal_by = {d["key"]: d for d in deals}
    for row in EXTENSION_OVERRIDES:
        key = row["key"]
        sal = {
            "name": row["name"],
            "key": key,
            "team": row.get("team"),
            "y1": row["y1"],
            "yearsLeft": row["yearsLeft"],
            "guaranteed": row.get("guaranteed"),
            "tier": row.get("tier") or salary_tier(row["y1"]),
            "source": row.get("source") or "manual-extension",
        }
        prev = sal_by.get(key)
        if not prev or int(sal["yearsLeft"]) >= int(prev.get("yearsLeft") or 0):
            sal_by[key] = sal
            print(f"Override salary: {row['name']} → {sal['yearsLeft']}y / "
                  f"${(sal.get('guaranteed') or 0)/1e6:.1f}M rem")
        deal_info = row.get("deal")
        if deal_info:
            deal = {
                "name": row["name"],
                "key": key,
                "faYear": deal_info["faYear"],
                "years": deal_info["years"],
                "total": deal_info["total"],
                "aav": deal_info["aav"],
                "source": deal_info.get("source") or row.get("source") or "manual-extension",
            }
            prev_d = deal_by.get(key)
            if (not prev_d
                or int(deal["faYear"]) > int(prev_d.get("faYear") or 0)
                or (int(deal["faYear"]) == int(prev_d.get("faYear") or 0)
                    and int(deal["aav"]) >= int(prev_d.get("aav") or 0))):
                deal_by[key] = deal
                print(f"Override deal: {row['name']} → {deal['years']}y / "
                      f"${deal['aav']/1e6:.1f}M AAV ({deal['faYear']})")
    salaries[:] = sorted(sal_by.values(), key=lambda r: (-(r.get("y1") or 0), r["name"]))
    deals[:] = sorted(deal_by.values(), key=lambda r: (-r["aav"], r["name"]))


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


def salary_tier(y1: int | None) -> str | None:
    if y1 is None:
        return None
    if y1 >= TIER_LARGE:
        return "large"
    if y1 >= TIER_MID:
        return "mid"
    if y1 < TIER_MIN:
        return "min"
    return "scale"  # often rookies / mid-min — neutral for Trade ★


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
    by_key: dict[str, dict] = {}
    for row in rows:
        prev = by_key.get(row["key"])
        if not prev or row["aav"] > prev["aav"]:
            by_key[row["key"]] = row
    return list(by_key.values())


def parse_bbref_salaries() -> list[dict]:
    html = fetch("https://www.basketball-reference.com/contracts/players.html")
    tables = re.findall(r"<!--(.*?id=\"player-contracts\".*?)-->", html, re.S)
    src = tables[0] if tables else html
    start = src.find('id="player-contracts"')
    section = src[start:] if start >= 0 else src
    rows: list[dict] = []
    for m in re.finditer(
        r'<tr[^>]*>\s*<th[^>]*data-stat="ranker"[^>]*>.*?</tr>',
        section,
        re.S,
    ):
        row = m.group(0)
        nm = re.search(r'data-stat="player"[^>]*>.*?<a[^>]*>([^<]+)</a>', row, re.S)
        if not nm:
            continue
        name = unescape(nm.group(1)).strip()
        y1m = re.search(r'data-stat="y1"[^>]*csk="(\d+)"', row)
        if not y1m:
            continue
        y1 = int(y1m.group(1))
        years = len(re.findall(r'data-stat="y[1-6]"[^>]*csk="\d+"', row))
        gtdm = re.search(r'data-stat="remain_gtd"[^>]*csk="(\d+)"', row)
        gtd = int(gtdm.group(1)) if gtdm else None
        tm = re.search(r'data-stat="team_id"[^>]*>.*?<a[^>]*>([^<]+)</a>', row, re.S)
        team = unescape(tm.group(1)).strip() if tm else None
        tier = salary_tier(y1)
        rows.append({
            "name": name,
            "key": norm_name(name),
            "team": team,
            "y1": y1,
            "yearsLeft": years,
            "guaranteed": gtd,
            "tier": tier,
            "source": "bbref-contracts",
        })
    by_key: dict[str, dict] = {}
    for row in rows:
        by_key[row["key"]] = row
    return list(by_key.values())


def parse_buyout_page(url: str, season: int) -> list[dict]:
    html = fetch(url)
    out: list[dict] = []

    def add(name: str, status: str) -> None:
        name = unescape(name).strip()
        if not name or len(name) < 3:
            return
        out.append({
            "name": name,
            "key": norm_name(name),
            "season": season,
            "status": status,
            "source": "hoopsrumors-buyout",
        })

    # Only structured list rows — ignore names mentioned in prose.
    li_name = re.compile(
        r"<li[^>]*>\s*<strong>\s*<a[^>]*>([^<]+)</a>\s*</strong>",
        re.I,
    )

    m = re.search(
        r"Veterans who have been recently bought out or waived and remain unsigned:"
        r"(.*?)"
        r"(?:Veterans who have been bought out|Other veterans who are candidates|$)",
        html,
        re.S | re.I,
    )
    if m:
        for nm in li_name.findall(m.group(1)):
            add(nm, "unsigned")

    m2 = re.search(
        r"Veterans who have been bought out or released and joined new teams:"
        r"(.*?)"
        r"(?:Other veterans who are candidates|The most realistic|$)",
        html,
        re.S | re.I,
    )
    if m2:
        for nm in li_name.findall(m2.group(1)):
            add(nm, "resigned")

    # Spotrac-style "via Buyout" crumbs if present
    for m3 in re.finditer(
        r'<a href="https://www\.spotrac\.com/nba/player/_/id/\d+/[^"]+"[^>]*>'
        r"([^<]+)</a>.{0,240}via Buyout",
        html,
        re.I | re.S,
    ):
        add(m3.group(1), "buyout")

    by_key: dict[str, dict] = {}
    for row in out:
        prev = by_key.get(row["key"])
        if not prev or (prev["status"] == "resigned" and row["status"] == "unsigned"):
            by_key[row["key"]] = row
    return list(by_key.values())


def main() -> None:
    now = datetime.now(timezone.utc)
    as_of_year = now.year
    fa_years = list(range(as_of_year - (LOOKBACK_FA_YEARS - 1), as_of_year + 1))
    errors: list[str] = []

    deals: list[dict] = []
    for year in fa_years:
        try:
            year_rows = parse_fa_year(year)
            print(f"FA {year}: {len(year_rows)} good deals")
            deals.extend(year_rows)
        except Exception as e:
            errors.append(f"fa-{year}: {e}")
            print(f"FA {year}: ERROR {e}")

    by_key: dict[str, dict] = {}
    for row in sorted(deals, key=lambda r: (r["faYear"], r["aav"])):
        by_key[row["key"]] = row
    deals = sorted(by_key.values(), key=lambda r: (-r["aav"], r["name"]))

    salaries: list[dict] = []
    try:
        salaries = parse_bbref_salaries()
        print(f"Salaries: {len(salaries)} "
              f"(large={sum(1 for s in salaries if s['tier']=='large')}, "
              f"mid={sum(1 for s in salaries if s['tier']=='mid')}, "
              f"min={sum(1 for s in salaries if s['tier']=='min')}, "
              f"scale={sum(1 for s in salaries if s['tier']=='scale')})")
    except Exception as e:
        errors.append(f"salaries: {e}")
        print(f"Salaries: ERROR {e}")

    buyouts: list[dict] = []
    for url in BUYOUT_PAGES:
        season_m = re.search(r"/(20\d{2})-", url)
        season = int(season_m.group(1)) if season_m else as_of_year
        try:
            rows = parse_buyout_page(url, season)
            print(f"Buyouts {season}: {len(rows)} from {url.split('/')[-1]}")
            buyouts.extend(rows)
        except Exception as e:
            errors.append(f"buyout-{season}: {e}")
            print(f"Buyouts {season}: ERROR {e}")

    # Also scan recent Spotrac transaction crumbs for "via Buyout"
    try:
        tx = fetch("https://www.spotrac.com/nba/transactions/")
        for m in re.finditer(
            r'<a href="https://www\.spotrac\.com/nba/player/_/id/\d+/[^"]+"[^>]*>'
            r"([^<]+)</a>.{0,260}via Buyout",
            tx,
            re.I | re.S,
        ):
            name = unescape(m.group(1)).strip()
            # strip position suffix " (SG)"
            name = re.sub(r"\s*\([^)]*\)\s*$", "", name)
            buyouts.append({
                "name": name,
                "key": norm_name(name),
                "season": as_of_year,
                "status": "buyout",
                "source": "spotrac-tx",
            })
    except Exception as e:
        errors.append(f"spotrac-tx: {e}")

    buy_by: dict[str, dict] = {}
    for row in sorted(buyouts, key=lambda r: r.get("season") or 0):
        buy_by[row["key"]] = row
    buyouts = sorted(buy_by.values(), key=lambda r: (-(r.get("season") or 0), r["name"]))
    print(f"Buyouts total: {len(buyouts)}")

    apply_extension_overrides(salaries, deals)

    payload = {
        "source": "spotrac FA + bbref contracts + hoopshrumors buyouts + manual extension overrides",
        "captured": now.strftime("%Y-%m-%d"),
        "asOfYear": as_of_year,
        "protectYears": 2,
        "goodRule": {
            "minAavMulti": MIN_AAV_MULTI,
            "minYearsMulti": MIN_YEARS_MULTI,
            "minAavAny": MIN_AAV_ANY,
        },
        "tierRule": {
            "large": TIER_LARGE,
            "mid": TIER_MID,
            "min": TIER_MIN,
        },
        "faYears": fa_years,
        "deals": deals,
        "salaries": salaries,
        "buyouts": buyouts,
        "errors": errors,
    }
    js = (
        "/* NBA contracts for cut protect + Trade ★; refresh via build-nba-contracts.py */\n"
        "window.NBA_CONTRACTS_SNAPSHOT = "
        + json.dumps(payload, separators=(",", ":"))
        + ";\n"
    )
    OUT.write_text(js, encoding="utf-8")
    print(f"Wrote {OUT.name}: {len(deals)} deals, {len(salaries)} salaries, {len(buyouts)} buyouts")


if __name__ == "__main__":
    main()
