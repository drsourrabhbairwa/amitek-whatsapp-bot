"""Settings that live in the environment: secrets, connection details, switches.

Business rules (sending hours, daily limit, follow-up gaps) deliberately do NOT
live here. They sit in the company_settings table so the app UI can change them
without anyone editing a file or restarting the service. See settings.py.
"""
from functools import lru_cache
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = ""
    company_id: str = ""

    wa_api_url: str = "https://crmapi.bluetickapi.com/api/meta"
    wa_api_version: str = "v19.0"
    wa_phone_number_id: str = ""
    wa_access_token: str = ""
    webhook_secret: str = ""

    anthropic_api_key: str = ""
    claude_model: str = "claude-sonnet-5-5"

    send_enabled: bool = False
    human_takeover_hours: int = 12
    sales_whatsapp: str = ""

    port: int = 8000
    # Deliberately not called TZ: that name is already the operating system's own
    # timezone variable, and on a server it is usually set to something else.
    bot_tz: str = "Asia/Kolkata"

    def zone(self) -> ZoneInfo:
        """The timezone sending hours are measured in, falling back to IST if the
        name is not one this machine knows."""
        try:
            return ZoneInfo(self.bot_tz)
        except ZoneInfoNotFoundError:
            return ZoneInfo("Asia/Kolkata")

    def missing(self) -> list[str]:
        """What has to be filled in before the service can do anything useful."""
        required = {
            "DATABASE_URL": self.database_url,
            "COMPANY_ID": self.company_id,
            "WA_PHONE_NUMBER_ID": self.wa_phone_number_id,
            "WA_ACCESS_TOKEN": self.wa_access_token,
            "WEBHOOK_SECRET": self.webhook_secret,
            "ANTHROPIC_API_KEY": self.anthropic_api_key,
        }
        return [name for name, value in required.items() if not value]


@lru_cache
def get_settings() -> Settings:
    return Settings()
