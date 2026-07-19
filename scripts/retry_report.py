"""Safely restart one retryable failed report lifecycle."""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid


API_BASE_URL = os.environ.get(
    "DSA_API_BASE_URL", "https://discord-dsa-production.up.railway.app"
).rstrip("/")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("internal_report_id", help="Failed internal report ID")
    parser.add_argument("discord_user_id", help="Discord user ID that owns the report")
    parser.add_argument(
        "--idempotency-key",
        help="Reuse this value if the previous retry request had an uncertain response",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    api_key = os.environ.get("DSA_API_KEY")
    if not api_key:
        print("Set DSA_API_KEY before running.", file=sys.stderr)
        return 2

    idempotency_key = args.idempotency_key or f"retry-{uuid.uuid4()}"
    print(f"Idempotency-Key: {idempotency_key}", file=sys.stderr)
    report_id = urllib.parse.quote(args.internal_report_id, safe="")
    body = json.dumps(
        {"submitterDiscordUserId": args.discord_user_id}
    ).encode("utf-8")
    request = urllib.request.Request(
        f"{API_BASE_URL}/v1/reports/{report_id}/retry",
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Idempotency-Key": idempotency_key,
        },
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
