import os
from dataclasses import dataclass, field


def _bool(name: str, default: bool) -> bool:
    v = os.getenv(name)
    return default if v is None else v.strip().lower() in ("1", "true", "yes", "on")


@dataclass(frozen=True)
class Settings:
    claude_model: str = field(default_factory=lambda: os.getenv("CLAUDE_MODEL", "claude-sonnet-5-5"))
    wa_api_url: str = field(default_factory=lambda: os.getenv("WA_API_URL", "https://crmapi.bluetickapi.com/api/meta").rstrip("/"))
    wa_api_version: str = field(default_factory=lambda: os.getenv("WA_API_VERSION", "v19.0"))
    wa_phone_number_id: str = field(default_factory=lambda: os.getenv("WA_PHONE_NUMBER_ID", ""))
    wa_access_token: str = field(default_factory=lambda: os.getenv("WA_ACCESS_TOKEN", ""))
    webhook_secret: str = field(default_factory=lambda: os.getenv("WEBHOOK_SECRET", ""))
    database_url: str = field(default_factory=lambda: os.getenv("DATABASE_URL", "sqlite:///./bot.db"))
    sales_whatsapp: str = field(default_factory=lambda: os.getenv("SALES_WHATSAPP", ""))
    sales_alert_template: str = field(default_factory=lambda: os.getenv("SALES_ALERT_TEMPLATE", ""))
    send_enabled: bool = field(default_factory=lambda: _bool("SEND_ENABLED", False))
    human_takeover_hours: int = field(default_factory=lambda: int(os.getenv("HUMAN_TAKEOVER_HOURS", "12")))
    bot_mode: str = field(default_factory=lambda: os.getenv("BOT_MODE", "gentle"))  # gentle | sales
    hot_lead_sla_hours: int = field(default_factory=lambda: int(os.getenv("HOT_LEAD_SLA_HOURS", "2")))
    unanswered_alert_minutes: int = field(default_factory=lambda: int(os.getenv("UNANSWERED_ALERT_MINUTES", "30")))
    followup_template: str = field(default_factory=lambda: os.getenv("FOLLOWUP_TEMPLATE", ""))
    history_turns: int = field(default_factory=lambda: int(os.getenv("HISTORY_TURNS", "30")))


settings = Settings()
