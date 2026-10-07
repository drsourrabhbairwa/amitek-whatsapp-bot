"""Lead and message storage. SQLite for tests, Postgres in production."""
from datetime import datetime, timezone

from sqlalchemy import (Column, DateTime, Integer, MetaData, String, Table, Text, create_engine, insert, select,
                        update)
from sqlalchemy.engine import Engine

metadata = MetaData()

leads = Table(
    "leads", metadata,
    Column("phone", String(20), primary_key=True),  # 91XXXXXXXXXX
    Column("lead_id", String(20)),
    Column("name", String(200)),
    Column("business_name", String(300)),
    Column("category", String(30)),       # Applicator / Contractor / Builder / Architect / Dealer / Manufacturer / Other
    Column("tier", String(30)),           # End Client / Applicator / Project / Dealer / Bulk / To confirm
    Column("city", String(100)),
    Column("state", String(100)),
    Column("stage", String(20), default="New"),  # New, Discover, Diagnose, Recommend, Quote, Close, Won, Lost
    Column("status", String(20), default="New"),  # New, Contacted, Replied, Qualified, Hot, Quoted, Won, Lost, Opted out
    Column("opt_in", String(20), default="Not Asked"),
    Column("language", String(20)),
    Column("requirement", Text),          # free-text notes the bot keeps: surface, area, leak, timeline
    Column("area_sqft", Integer),
    Column("assigned_to", String(100)),
    Column("campaign", String(50)),
    Column("bot_paused_until", DateTime(timezone=True)),
    # ---- tracking: nothing should go off road
    Column("next_follow_up", DateTime(timezone=True)),
    Column("follow_up_note", Text),
    Column("handoff_at", DateTime(timezone=True)),
    Column("last_outbound_at", DateTime(timezone=True)),
    Column("last_human_contact_at", DateTime(timezone=True)),
    Column("unanswered_alerted_at", DateTime(timezone=True)),
    Column("followup_alerted_at", DateTime(timezone=True)),
    Column("sla_alerts", Integer, default=0),
    Column("lost_reason", Text),
    Column("last_inbound_at", DateTime(timezone=True)),
    Column("created_at", DateTime(timezone=True)),
    Column("updated_at", DateTime(timezone=True)),
)

messages = Table(
    "messages", metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("wa_message_id", String(200), unique=True),
    Column("phone", String(20), index=True),
    Column("direction", String(10)),      # in / out
    Column("sender", String(10)),         # lead / bot / human
    Column("body", Text),
    Column("created_at", DateTime(timezone=True)),
)

lead_log = Table(  # audit trail: every status/stage/owner/follow-up change
    "lead_log", metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("phone", String(20), index=True),
    Column("actor", String(30)),          # bot / sales / system / import
    Column("change", Text),
    Column("created_at", DateTime(timezone=True)),
)

events = Table(  # raw webhook payloads, kept so we can debug BlueTick's exact format
    "webhook_events", metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("payload", Text),
    Column("created_at", DateTime(timezone=True)),
)


def now() -> datetime:
    return datetime.now(timezone.utc)


def make_engine(url: str) -> Engine:
    kwargs = {"connect_args": {"check_same_thread": False}} if url.startswith("sqlite") else {"pool_pre_ping": True}
    if url.startswith("postgres://"):  # Render gives postgres://
        url = "postgresql+psycopg://" + url[len("postgres://"):]
    elif url.startswith("postgresql://"):
        url = "postgresql+psycopg://" + url[len("postgresql://"):]
    engine = create_engine(url, **kwargs)
    metadata.create_all(engine)
    return engine


class Store:
    def __init__(self, engine: Engine):
        self.engine = engine

    # ---- leads
    def get_lead(self, phone: str) -> dict | None:
        with self.engine.connect() as c:
            row = c.execute(select(leads).where(leads.c.phone == phone)).mappings().first()
            return dict(row) if row else None

    TRACKED = ("status", "stage", "category", "tier", "assigned_to", "next_follow_up", "opt_in", "lost_reason")

    def upsert_lead(self, phone: str, actor: str = "system", **fields) -> dict:
        fields = {k: v for k, v in fields.items() if k in leads.c}
        with self.engine.begin() as c:
            exists = c.execute(select(leads).where(leads.c.phone == phone)).mappings().first()
            if exists:
                if fields:
                    c.execute(update(leads).where(leads.c.phone == phone).values(**fields, updated_at=now()))
                    changes = [f"{k}: {exists[k]} -> {v}" for k, v in fields.items()
                               if k in self.TRACKED and exists[k] != v]
                    if changes:
                        c.execute(insert(lead_log).values(phone=phone, actor=actor, change="; ".join(changes),
                                                          created_at=now()))
            else:
                base = {"stage": "New", "status": "New", "opt_in": "Not Asked", "category": "Other",
                        "tier": "To confirm", "created_at": now(), "updated_at": now()}
                base.update(fields)
                c.execute(insert(leads).values(phone=phone, **base))
        return self.get_lead(phone)

    def log(self, phone: str, actor: str, change: str) -> None:
        with self.engine.begin() as c:
            c.execute(insert(lead_log).values(phone=phone, actor=actor, change=change, created_at=now()))

    def lead_log(self, phone: str) -> list[dict]:
        with self.engine.connect() as c:
            return [dict(r) for r in c.execute(select(lead_log).where(lead_log.c.phone == phone)
                                               .order_by(lead_log.c.id)).mappings()]

    def active_leads(self) -> list[dict]:
        """Leads someone has engaged with (excludes untouched imports, won/lost/opted out)."""
        closed = ("Won", "Lost", "Opted out")
        with self.engine.connect() as c:
            q = select(leads).where(leads.c.status.notin_(closed), leads.c.status != "New")
            return [dict(r) for r in c.execute(q).mappings()]

    def all_leads(self) -> list[dict]:
        with self.engine.connect() as c:
            return [dict(r) for r in c.execute(select(leads).order_by(leads.c.updated_at.desc())).mappings()]

    # ---- messages
    def seen(self, wa_message_id: str) -> bool:
        with self.engine.connect() as c:
            return c.execute(select(messages.c.id).where(messages.c.wa_message_id == wa_message_id)).first() is not None

    def add_message(self, phone: str, direction: str, sender: str, body: str, wa_message_id: str | None = None) -> bool:
        """Returns False if this WhatsApp message id was already stored (duplicate webhook)."""
        with self.engine.begin() as c:
            if wa_message_id and c.execute(
                    select(messages.c.id).where(messages.c.wa_message_id == wa_message_id)).first():
                return False
            c.execute(insert(messages).values(phone=phone, direction=direction, sender=sender, body=body,
                                              wa_message_id=wa_message_id, created_at=now()))
        return True

    def history(self, phone: str, limit: int) -> list[dict]:
        with self.engine.connect() as c:
            rows = c.execute(select(messages).where(messages.c.phone == phone)
                             .order_by(messages.c.id.desc()).limit(limit)).mappings().all()
        return [dict(r) for r in reversed(rows)]

    def log_event(self, payload: str) -> None:
        with self.engine.begin() as c:
            c.execute(insert(events).values(payload=payload, created_at=now()))


def aware(dt: datetime | None) -> datetime | None:
    """SQLite returns naive datetimes; everything we store is UTC."""
    if dt is None:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
