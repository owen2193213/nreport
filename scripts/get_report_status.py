"""Fetch and print one report's current backend and Discord lifecycle status."""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request


API_BASE_URL = os.environ.get(
    "DSA_API_BASE_URL", "https://discord-dsa-production.up.railway.app"
).rstrip("/")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("internal_report_id", help="Internal report ID returned at creation")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    api_key = os.environ.get("DSA_API_KEY")
    if not api_key:
        print("Set DSA_API_KEY before running.", file=sys.stderr)
        return 2

    report_id = urllib.parse.quote(args.internal_report_id, safe="")
    request = urllib.request.Request(
        f"{API_BASE_URL}/v1/reports/{report_id}",
        method="GET",
        headers={"Authorization": f"Bearer {api_key}"},
    )

    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            print(json.dumps(json.load(response), indent=2))
            return 0
    except urllib.error.HTTPError as error:
        response_body = error.read().decode("utf-8", errors="replace")
        print(f"HTTP {error.code}: {response_body}", file=sys.stderr)
        return 1
    except urllib.error.URLError as error:
        print(f"Request failed: {error.reason}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
