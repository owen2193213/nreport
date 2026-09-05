import os
import unittest
from unittest.mock import patch

from tools.configure_bot_webhook import ConfigurationError, destination_from_environment, select_existing_destination


class ConfigureBotWebhookTests(unittest.TestCase):
    def test_builds_the_private_bot_url_from_the_configured_hostname(self) -> None:
        with patch.dict(os.environ, {
            "NREPORT_API_URL": "https://api.something.report/",
            "NREPORT_ADMIN_KEY": "a" * 32,
            "NREPORT_ACCOUNT_ID": "5d0bb0e5-ea68-4f32-863d-425626df026d",
            "REPORT_EVENT_WEBHOOK_SECRET": "b" * 32,
            "NREPORT_BOT_PRIVATE_DOMAIN": "nreportdiscord-dsa-bot.railway.internal",
        }, clear=True):
            destination = destination_from_environment()

        self.assertEqual(destination.api_url, "https://api.something.report")
        self.assertEqual(destination.webhook_url, "http://nreportdiscord-dsa-bot.railway.internal:3000/internal/report-events")
        self.assertEqual(destination.name, "nreport-discord-bot")

    def test_reuses_only_an_active_destination_with_the_exact_name_and_url(self) -> None:
        destination = destination_from_environment({
            "NREPORT_API_URL": "https://api.something.report",
            "NREPORT_ADMIN_KEY": "a" * 32,
            "NREPORT_ACCOUNT_ID": "5d0bb0e5-ea68-4f32-863d-425626df026d",
            "REPORT_EVENT_WEBHOOK_SECRET": "b" * 32,
        })
        existing = [{
            "destinationId": "8d0bb0e5-ea68-4f32-863d-425626df026d",
            "name": "nreport-discord-bot",
            "url": "http://nreportdiscord-dsa-bot.railway.internal:3000/internal/report-events",
            "status": "active",
            "createdAt": "2026-09-05T00:00:00.000Z",
        }]

        self.assertEqual(select_existing_destination(existing, destination), "8d0bb0e5-ea68-4f32-863d-425626df026d")

    def test_refuses_to_reuse_a_destination_name_that_points_somewhere_else(self) -> None:
        destination = destination_from_environment({
            "NREPORT_API_URL": "https://api.something.report",
            "NREPORT_ADMIN_KEY": "a" * 32,
            "NREPORT_ACCOUNT_ID": "5d0bb0e5-ea68-4f32-863d-425626df026d",
            "REPORT_EVENT_WEBHOOK_SECRET": "b" * 32,
        })
        existing = [{
            "destinationId": "8d0bb0e5-ea68-4f32-863d-425626df026d",
            "name": "nreport-discord-bot",
            "url": "https://other.example/internal/report-events",
            "status": "active",
            "createdAt": "2026-09-05T00:00:00.000Z",
        }]

        with self.assertRaisesRegex(ConfigurationError, "different URL"):
            select_existing_destination(existing, destination)
