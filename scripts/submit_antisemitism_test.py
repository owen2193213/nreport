"""Create one real message report through the deployed Discord DSA backend."""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
import uuid


API_BASE_URL = os.environ.get(
    "DSA_API_BASE_URL", "https://discord-dsa-production.up.railway.app"
).rstrip("/")
API_KEY = os.environ.get("DSA_API_KEY")
DISCORD_USER_ID = "1197857362942378017"
REPORT_COUNTRY = "DE"


def main() -> int:
    if not API_KEY or not DISCORD_USER_ID:
        print("Set DSA_API_KEY and DISCORD_USER_ID before running.", file=sys.stderr)
        return 2

    body = json.dumps(
        {
            "country": REPORT_COUNTRY,
            "flow": "message_urf",
            "reportType": "sub_other_hate_speech",
            "messageUrl": (
                "https://discord.com/channels/427067963137589258/"
                "427069953078853633/1414818522701369355"
            ),
            "context": "The reported message contains antisemitic hate speech.",
            "submitterDiscordUserId": DISCORD_USER_ID,
        }
    ).encode("utf-8")
    request = urllib.request.Request(
        f"{API_BASE_URL}/v1/reports",
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {API_KEY}",
            "Content-Type": "application/json",
            "Idempotency-Key": f"python-test-{uuid.uuid4()}",
        },
    )

    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            result = json.load(response)
            print(json.dumps(result, indent=2))
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
