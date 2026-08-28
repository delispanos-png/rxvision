"""Minimal RFC-5545 iCalendar builder — pure text, no external deps. Backs the read-only
calendar feeds (Google Calendar / Outlook 365 / Apple) that pharmacists & patients subscribe to.

Two time kinds are used:
  • absolute UTC (`floating=False`) — appointments happen at a fixed instant.
  • floating local (`floating=True`) — a medication dose fires at a wall-clock time (08:00)
    in whatever timezone the viewer's calendar is set to. When DTSTART is floating, any RRULE
    UNTIL must ALSO be floating (no trailing Z) — the caller builds the RRULE accordingly.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone


def _esc(text) -> str:
    return (str(text if text is not None else "")
            .replace("\\", "\\\\").replace(";", "\\;")
            .replace(",", "\\,").replace("\r\n", "\\n").replace("\n", "\\n"))


def _fold(line: str) -> str:
    """Fold to ≤75 octets per RFC 5545 (continuation lines start with a single space),
    without splitting a multibyte UTF-8 character across the boundary."""
    raw = line.encode("utf-8")
    if len(raw) <= 75:
        return line
    parts: list[str] = []
    while len(raw) > 75:
        cut = 75
        while cut > 0 and (raw[cut] & 0xC0) == 0x80:   # don't cut mid-codepoint
            cut -= 1
        if cut == 0:                                    # pathological — force progress
            cut = 75
        parts.append(raw[:cut].decode("utf-8", "ignore"))
        raw = raw[cut:]
    parts.append(raw.decode("utf-8", "ignore"))
    return "\r\n ".join(parts)


def _utc(dt: datetime) -> str:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def _floating(dt: datetime) -> str:
    return dt.strftime("%Y%m%dT%H%M%S")


@dataclass
class Event:
    uid: str
    summary: str
    start: datetime
    end: datetime | None = None
    floating: bool = False        # wall-clock (meds) vs absolute UTC (appointments)
    description: str = ""
    location: str = ""
    status: str = ""              # CONFIRMED | TENTATIVE | CANCELLED
    rrule: str = ""               # e.g. "FREQ=DAILY;UNTIL=20260401T235959"
    categories: str = ""

    def render(self, stamp: str) -> list[str]:
        fmt = _floating if self.floating else _utc
        lines = ["BEGIN:VEVENT", f"UID:{self.uid}", f"DTSTAMP:{stamp}",
                 f"DTSTART:{fmt(self.start)}"]
        if self.end:
            lines.append(f"DTEND:{fmt(self.end)}")
        if self.rrule:
            lines.append(f"RRULE:{self.rrule}")
        lines.append(f"SUMMARY:{_esc(self.summary)}")
        if self.description:
            lines.append(f"DESCRIPTION:{_esc(self.description)}")
        if self.location:
            lines.append(f"LOCATION:{_esc(self.location)}")
        if self.categories:
            lines.append(f"CATEGORIES:{_esc(self.categories)}")
        if self.status:
            lines.append(f"STATUS:{self.status}")
        lines.append("TRANSP:TRANSPARENT")
        lines.append("END:VEVENT")
        return lines


def build_calendar(name: str, events: list[Event], *, tz: str = "Europe/Athens") -> str:
    stamp = datetime.now(tz=timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    out = ["BEGIN:VCALENDAR", "VERSION:2.0",
           "PRODID:-//RxVision//Calendar//EL", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
           f"X-WR-CALNAME:{_esc(name)}", f"X-WR-TIMEZONE:{tz}",
           "REFRESH-INTERVAL;VALUE=DURATION:PT3H", "X-PUBLISHED-TTL:PT3H"]
    for ev in events:
        out.extend(ev.render(stamp))
    out.append("END:VCALENDAR")
    return "\r\n".join(_fold(line) for line in out) + "\r\n"
