#!/usr/bin/env python3
"""
preprocess_ibtracs.py — Download IBTrACS CSV and produce compact JSON for TC-RADAR Global Archive.

Usage:
    python preprocess_ibtracs.py

Outputs:
    ibtracs_storms.json   — Storm-level metadata (all storms, ~500KB gzipped)
    ibtracs_tracks.json   — Full track data for all storms (~5-10MB gzipped)

Data source:
    https://www.ncei.noaa.gov/data/international-best-track-archive-for-climate-stewardship-ibtracs/v04r01/access/csv/ibtracs.ALL.list.v04r01.csv
"""

import json
import os
import sys
from pathlib import Path

import pandas as pd
import numpy as np

# ── Configuration ────────────────────────────────────────────────────────────

IBTRACS_URL = (
    "https://www.ncei.noaa.gov/data/international-best-track-archive-for-climate-stewardship-ibtracs/"
    "v04r01/access/csv/ibtracs.ALL.list.v04r01.csv"
)

IBTRACS_LOCAL = "ibtracs.ALL.list.v04r01.csv"  # cached local copy

OUTPUT_DIR = Path(__file__).parent
STORMS_JSON = OUTPUT_DIR / "ibtracs_storms.json"
TRACKS_JSON = OUTPUT_DIR / "ibtracs_tracks.json"

# Saffir-Simpson thresholds (kt)
SS_THRESHOLDS = [
    (137, "C5"), (113, "C4"), (96, "C3"), (83, "C2"),
    (64, "C1"), (34, "TS"), (0, "TD"),
]

# Basin full names
BASIN_NAMES = {
    "NA": "North Atlantic",
    "EP": "Eastern North Pacific",
    "WP": "Western North Pacific",
    "NI": "North Indian",
    "SI": "South Indian",
    "SP": "South Pacific",
    "SA": "South Atlantic",
}

# HURSAT-B1 v06 coverage
HURSAT_START_YEAR = 1978
HURSAT_END_YEAR = 2015


def get_category(wind_kt):
    """Return Saffir-Simpson category string for wind speed in knots."""
    if wind_kt is None or np.isnan(wind_kt):
        return "UN"
    for threshold, cat in SS_THRESHOLDS:
        if wind_kt >= threshold:
            return cat
    return "TD"


def compute_ace(winds):
    """
    Compute Accumulated Cyclone Energy for a storm.
    ACE = sum(vmax^2) / 10^4  for 6-hourly points where vmax >= 34 kt.
    """
    valid = winds.dropna()
    ts_winds = valid[valid >= 34]
    if len(ts_winds) == 0:
        return 0.0
    return float(np.sum(ts_winds.values ** 2) / 1e4)


def download_ibtracs():
    """Download IBTrACS CSV if not already cached locally."""
    if os.path.exists(IBTRACS_LOCAL):
        print(f"Using cached IBTrACS CSV: {IBTRACS_LOCAL}")
        return IBTRACS_LOCAL

    print(f"Downloading IBTrACS CSV from NCEI...")
    import urllib.request
    urllib.request.urlretrieve(IBTRACS_URL, IBTRACS_LOCAL)
    print(f"Downloaded: {IBTRACS_LOCAL} ({os.path.getsize(IBTRACS_LOCAL) / 1e6:.1f} MB)")
    return IBTRACS_LOCAL


def load_ibtracs(csv_path):
    """Load IBTrACS CSV into a pandas DataFrame."""
    print("Loading IBTrACS CSV...")
    # IBTrACS has a header row and a units row (row index 1) — skip units row
    df = pd.read_csv(
        csv_path,
        low_memory=False,
        na_values=[" ", "", "MM"],
        keep_default_na=False,  # Prevent pandas from treating "NA" (North Atlantic) as NaN!
        skiprows=[1],  # skip units row
        dtype={"SID": str, "NAME": str, "BASIN": str},
    )

    # Strip whitespace from string columns (IBTrACS CSV has leading spaces)
    for col in ["SID", "NAME", "BASIN"]:
        if col in df.columns:
            df[col] = df[col].astype(str).str.strip()
            df[col] = df[col].replace({"nan": np.nan, "": np.nan})

    # Parse numeric columns
    for col in ["LAT", "LON", "WMO_WIND", "WMO_PRES"]:
        df[col] = pd.to_numeric(df[col], errors="coerce")

    # Parse datetime
    df["ISO_TIME"] = pd.to_datetime(df["ISO_TIME"], errors="coerce")
    df["YEAR"] = df["ISO_TIME"].dt.year

    # Report basin distribution for verification
    basin_counts = df.groupby("BASIN")["SID"].nunique()
    print(f"Basin distribution:\n{basin_counts.to_string()}")

    print(f"Loaded {len(df):,} track points across {df['SID'].nunique():,} storms")
    return df


def build_storms_json(df):
    """Build storm-level metadata JSON."""
    print("Building storm metadata...")
    storms = []

    for sid, group in df.groupby("SID", sort=False):
        group = group.sort_values("ISO_TIME")

        name = group["NAME"].dropna().iloc[0] if not group["NAME"].dropna().empty else "UNNAMED"
        if name == "NOT_NAMED" or name == "UNNAMED":
            name = "UNNAMED"

        basin = group["BASIN"].dropna().iloc[0] if not group["BASIN"].dropna().empty else "UN"
        year = int(group["YEAR"].dropna().iloc[0]) if not group["YEAR"].dropna().empty else 0

        peak_wind = group["WMO_WIND"].max()
        min_pres = group["WMO_PRES"].min()

        # Genesis location (first valid point)
        first = group.dropna(subset=["LAT", "LON"]).iloc[0] if not group.dropna(subset=["LAT", "LON"]).empty else None
        genesis_lat = round(float(first["LAT"]), 1) if first is not None else None
        genesis_lon = round(float(first["LON"]), 1) if first is not None else None

        # Lifetime maximum intensity (LMI) location
        if not np.isnan(peak_wind):
            lmi_row = group.loc[group["WMO_WIND"].idxmax()]
            lmi_lat = round(float(lmi_row["LAT"]), 1) if not np.isnan(lmi_row["LAT"]) else genesis_lat
            lmi_lon = round(float(lmi_row["LON"]), 1) if not np.isnan(lmi_row["LON"]) else genesis_lon
        else:
            lmi_lat = genesis_lat
            lmi_lon = genesis_lon

        # Dates
        start_date = group["ISO_TIME"].min().strftime("%Y-%m-%d") if pd.notna(group["ISO_TIME"].min()) else None
        end_date = group["ISO_TIME"].max().strftime("%Y-%m-%d") if pd.notna(group["ISO_TIME"].max()) else None

        # ACE
        ace = compute_ace(group["WMO_WIND"])

        # HURSAT availability
        hursat = HURSAT_START_YEAR <= year <= HURSAT_END_YEAR

        storm = {
            "sid": sid,
            "name": name,
            "year": year,
            "basin": basin,
            "peak_wind_kt": round(float(peak_wind), 0) if not np.isnan(peak_wind) else None,
            "min_pres_hpa": round(float(min_pres), 0) if not np.isnan(min_pres) else None,
            "genesis_lat": genesis_lat,
            "genesis_lon": genesis_lon,
            "lmi_lat": lmi_lat,
            "lmi_lon": lmi_lon,
            "start_date": start_date,
            "end_date": end_date,
            "num_points": len(group),
            "ace": round(ace, 2),
            "hursat": hursat,
            "cat": get_category(peak_wind),
        }
        storms.append(storm)

    return storms


def build_tracks_json(df):
    """Build per-storm track data JSON (all storms in one dict).

    Optimizations for file size:
    - Omit keys with null values (saves ~30-40% on file size)
    - Use compact datetime format (drop seconds since IBTrACS is 3/6-hourly)
    - Round coordinates to 1 decimal (8km precision, matches HURSAT grid)
    """
    print("Building track data...")
    tracks = {}

    for sid, group in df.groupby("SID", sort=False):
        group = group.sort_values("ISO_TIME")
        points = []
        for _, row in group.iterrows():
            pt = {}
            if pd.notna(row["ISO_TIME"]):
                # Compact datetime: "2005-08-23T18:00" (drop :00 seconds)
                pt["t"] = row["ISO_TIME"].strftime("%Y-%m-%dT%H:%M")
            if not np.isnan(row["LAT"]):
                pt["la"] = round(float(row["LAT"]), 1)
            if not np.isnan(row["LON"]):
                pt["lo"] = round(float(row["LON"]), 1)
            if not np.isnan(row["WMO_WIND"]):
                pt["w"] = int(row["WMO_WIND"])
            if not np.isnan(row["WMO_PRES"]):
                pt["p"] = int(row["WMO_PRES"])
            points.append(pt)
        tracks[sid] = points

    return tracks


def main():
    # Step 1: Get IBTrACS data
    csv_path = download_ibtracs()

    # Step 2: Load into DataFrame
    df = load_ibtracs(csv_path)

    # Step 3: Build storm metadata
    storms = build_storms_json(df)

    # Count stats
    basins = {}
    for s in storms:
        b = s["basin"]
        basins[b] = basins.get(b, 0) + 1

    storms_output = {
        "metadata": {
            "version": "1.0",
            "ibtracs_version": "v04r01",
            "total_storms": len(storms),
            "hursat_storms": sum(1 for s in storms if s["hursat"]),
            "year_range": [min(s["year"] for s in storms if s["year"]), max(s["year"] for s in storms if s["year"])],
            "basin_counts": basins,
        },
        "storms": storms,
    }

    with open(STORMS_JSON, "w") as f:
        json.dump(storms_output, f, separators=(",", ":"))
    size_mb = os.path.getsize(STORMS_JSON) / 1e6
    print(f"Wrote {STORMS_JSON} ({size_mb:.1f} MB, {len(storms):,} storms)")

    # Step 4: Build track data
    tracks = build_tracks_json(df)
    with open(TRACKS_JSON, "w") as f:
        json.dump(tracks, f, separators=(",", ":"))
    size_mb = os.path.getsize(TRACKS_JSON) / 1e6
    print(f"Wrote {TRACKS_JSON} ({size_mb:.1f} MB, {len(tracks):,} storm tracks)")

    # Summary
    print("\n── Summary ──────────────────────────────")
    print(f"Total storms:  {len(storms):,}")
    print(f"HURSAT avail:  {sum(1 for s in storms if s['hursat']):,} (1978-2015)")
    print(f"Year range:    {storms_output['metadata']['year_range']}")
    print(f"Basins:        {basins}")
    print("Done!")


if __name__ == "__main__":
    main()
