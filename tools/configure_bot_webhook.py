"""Create or reuse NReport's private bot webhook destination and assign it to one account.

Set the required environment variables, then run from this directory with:
    py -3 tools/configure_bot_webhook.py

The signing secret is sent only to the API and is never printed.
"""

from __future__ import annotations

import json
import os
import sys
from dataclasses import dataclass
from typing import Mapping
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


ADMIN_BASE_PATH = "/v1/admin/discord/dsa"
DEFAULT_BOT_PRIVATE_DOMAIN = "nreportdiscord-dsa-bot.railway.internal"
DEFAULT_DESTINATION_NAME = "nreport-discord-bot"


class ConfigurationError(ValueError):
    """The local configuration is incomplete or would mutate an unexpected destination."""


@dataclass(frozen=True)
class DestinationConfig:
    api_url: str
    admin_key: str
    account_id: str
    signing_secret: str
    name: str
    webhook_url: str


def required(environment: Mapping[str, str], name: str) -> str:
    value = environment.get(name, "").strip()
    if not value:
        raise ConfigurationError(f"{name} must be set.")
    return value


def destination_from_environment(environment: Mapping[str, str] | None = None) -> DestinationConfig:
    values = os.environ if environment is None else environment
    api_url = required(values, "NREPORT_API_URL").rstrip("/")
    if not api_url.startswith("https://"):
        raise ConfigurationError("NREPORT_API_URL must begin with https://.")
    admin_key = required(values, "NREPORT_ADMIN_KEY")
    account_id = required(values, "NREPORT_ACCOUNT_ID")
    signing_secret = required(values, "REPORT_EVENT_WEBHOOK_SECRET")
    if len(admin_key) < 32:
        raise ConfigurationError("NREPORT_ADMIN_KEY must contain at least 32 characters.")
    if len(signing_secret) < 32:
        raise ConfigurationError("REPORT_EVENT_WEBHOOK_SECRET must contain at least 32 characters.")
    private_domain = values.get("NREPORT_BOT_PRIVATE_DOMAIN", DEFAULT_BOT_PRIVATE_DOMAIN).strip().lower()
    if not private_domain.endswith(".railway.internal") or ":" in private_domain or "/" in private_domain:
        raise ConfigurationError("NREPORT_BOT_PRIVATE_DOMAIN must be a Railway private hostname.")
    name = values.get("NREPORT_BOT_WEBHOOK_NAME", DEFAULT_DESTINATION_NAME).strip()
    if not 2 <= len(name) <= 100:
        raise ConfigurationError("NREPORT_BOT_WEBHOOK_NAME must contain 2-100 characters.")
    return DestinationConfig(
        api_url=api_url,
        admin_key=admin_key,
        account_id=account_id,
        signing_secret=signing_secret,
        name=name,
        webhook_url=f"http://{private_domain}:3000/internal/report-events",
    )


def select_existing_destination(destinations: list[object], config: DestinationConfig) -> str | None:
    matches = [item for item in destinations if isinstance(item, dict) and item.get("name") == config.name]
    if not matches:
        return None
    exact = [item for item in matches if item.get("url") == config.webhook_url and item.get("status") == "active"]
    if len(exact) == 1 and isinstance(exact[0].get("destinationId"), str):
        return exact[0]["destinationId"]
    if any(item.get("url") != config.webhook_url for item in matches):
        raise ConfigurationError(f"A destination named {config.name!r} already exists with a different URL; refusing to overwrite it.")
    raise ConfigurationError(f"A destination named {config.name!r} exists but is not active; enable it in the API or use a new name.")


def api_request(config: DestinationConfig, method: str, path: str, payload: dict[str, object] | None = None) -> object:
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    request = Request(
        f"{config.api_url}{ADMIN_BASE_PATH}{path}",
        data=body,
        method=method,
        headers={
            "Authorization": f"Bearer {config.admin_key}",
            "Accept": "application/json",
            **({"Content-Type": "application/json"} if body is not None else {}),
        },
    )
    try:
        with urlopen(request, timeout=20) as response:
            raw = response.read()
    except HTTPError as error:
        try:
            detail = json.loads(error.read().decode("utf-8"))
            message = detail.get("error", {}).get("message", "Request failed.") if isinstance(detail, dict) else "Request failed."
        except (UnicodeDecodeError, json.JSONDecodeError):
            message = "Request failed."
        raise RuntimeError(f"API request failed with HTTP {error.code}: {message}") from error
    except URLError as error:
        raise RuntimeError("Could not reach NREPORT_API_URL.") from error
    if not raw:
        return None
    try:
        return json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RuntimeError("API returned an invalid JSON response.") from error


def configure_destination(config: DestinationConfig) -> str:
    listed = api_request(config, "GET", "/webhook-destinations")
    if not isinstance(listed, dict) or not isinstance(listed.get("items"), list):
        raise RuntimeError("API returned an invalid webhook-destination list.")
    destination_id = select_existing_destination(listed["items"], config)
    if destination_id is None:
        created = api_request(config, "POST", "/webhook-destinations", {
            "name": config.name,
            "url": config.webhook_url,
            "signingSecret": config.signing_secret,
        })
        if not isinstance(created, dict) or not isinstance(created.get("destinationId"), str):
            raise RuntimeError("API returned an invalid created destination.")
        destination_id = created["destinationId"]
    api_request(config, "PUT", f"/accounts/{config.account_id}/webhook-destination", {"destinationId": destination_id})
    return destination_id


def main() -> int:
    try:
        config = destination_from_environment()
        destination_id = configure_destination(config)
    except (ConfigurationError, RuntimeError) as error:
        print(f"Webhook setup failed: {error}", file=sys.stderr)
        return 1
    print(f"Webhook destination {destination_id} is assigned to account {config.account_id}.")
    print("The API can now send signed report events to the bot over Railway private networking.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

