"""Date/Time Tool — mirrors backend/src/services/tools/datetime.ts."""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from typing import Any

from ..logger import info as log_info
from . import ToolContext, ToolDefinition, ToolParam, ToolResult, register_tool

TIMEZONE_OFFSETS: dict[str, int] = {
    "utc": 0, "gmt": 0, "z": 0,
    "est": -300, "edt": -240,
    "cst": -360, "cdt": -300,
    "mst": -420, "mdt": -360,
    "pst": -480, "pdt": -420,
    "cet": 60, "cest": 120,
    "eet": 120, "eest": 180,
    "msk": 180, "ist": 330,
    "cst_china": 480, "jst": 540, "kst": 540,
    "aest": 600, "aedt": 660,
    "nzst": 720, "nzdt": 780,
    "hst": -600, "akst": -540,
    "brt": -180, "art": -180,
    "wast": 120, "cat": 120, "eat": 180,
}

TIMEZONE_NAMES: dict[str, str] = {
    "eastern": "EST", "central": "CST", "mountain": "MST", "pacific": "PST",
    "europe": "CET", "japan": "JST", "china": "CST", "india": "IST",
    "australia": "AEST", "new zealand": "NZST", "korea": "KST",
    "hawaii": "HST", "alaska": "AKST", "brazil": "BRT", "argentina": "ART",
}

MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
FULL_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
FULL_DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]


def get_offset_minutes(tz: str) -> int | None:
    clean = re.sub(r"\s+", "_", tz.strip().lower())
    if clean in TIMEZONE_OFFSETS:
        return TIMEZONE_OFFSETS[clean]
    if clean in TIMEZONE_NAMES:
        key = TIMEZONE_NAMES[clean].lower().split(" ")[0]
        return TIMEZONE_OFFSETS.get(key)
    m = re.search(r"utc([+-]?)(\d+)(?::(\d+))?", clean, re.IGNORECASE)
    if m:
        sign = -1 if m.group(1) == "-" else 1
        hours = int(m.group(2))
        mins = int(m.group(3)) if m.group(3) else 0
        return sign * (hours * 60 + mins)
    m = re.match(r"^([+-]?)(\d{1,2})(?::(\d{2}))?$", clean)
    if m:
        sign = -1 if m.group(1) == "-" else 1
        hours = int(m.group(2))
        mins = int(m.group(3)) if m.group(3) else 0
        if hours <= 14:
            return sign * (hours * 60 + mins)
    return None


def format_date(date: datetime, fmt: str) -> str:
    mapping = {
        "YYYY": f"{date.year:04d}",
        "YY": f"{date.year % 100:02d}",
        "MONTH": FULL_MONTHS[date.month - 1],
        "MON": MONTHS[date.month - 1],
        "MM": f"{date.month:02d}",
        "DAYFULL": FULL_DAYS[(date.weekday() + 1) % 7],
        "DAY": DAYS[(date.weekday() + 1) % 7],
        "DD": f"{date.day:02d}",
        "HH": f"{date.hour:02d}",
        "mm": f"{date.minute:02d}",
        "ss": f"{date.second:02d}",
        "ISO": date.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z"),
    }
    result = fmt
    # Longer patterns first to avoid partial replacement
    for key in sorted(mapping, key=len, reverse=True):
        result = result.replace(key, mapping[key])
    return result


def parse_date_input(input_text: str) -> datetime | None:
    s = input_text.strip()
    if re.match(r"^now|current|today$", s, re.IGNORECASE):
        return datetime.now()
    if re.match(r"^tomorrow$", s, re.IGNORECASE):
        return datetime.now() + timedelta(days=1)
    if re.match(r"^yesterday$", s, re.IGNORECASE):
        return datetime.now() - timedelta(days=1)
    try:
        return datetime.fromisoformat(s)
    except ValueError:
        pass
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d", "%b %d, %Y", "%B %d, %Y", "%d/%m/%Y", "%m/%d/%Y"):
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            continue
    return None


DATE_MATH_OPS = [
    (re.compile(r"(\d+)\s*(day|days)\s+(from|after|from now|ahead)", re.IGNORECASE), "days", +1),
    (re.compile(r"(\d+)\s*(day|days)\s+(before|ago|earlier|back)", re.IGNORECASE), "days", -1),
    (re.compile(r"(\d+)\s*(week|weeks)\s+(from|after|from now|ahead)", re.IGNORECASE), "weeks", +1),
    (re.compile(r"(\d+)\s*(week|weeks)\s+(before|ago|earlier|back)", re.IGNORECASE), "weeks", -1),
    (re.compile(r"(\d+)\s*(month|months)\s+(from|after|from now|ahead)", re.IGNORECASE), "months", +1),
    (re.compile(r"(\d+)\s*(month|months)\s+(before|ago|earlier|back)", re.IGNORECASE), "months", -1),
    (re.compile(r"(\d+)\s*(year|years)\s+(from|after|from now|ahead)", re.IGNORECASE), "years", +1),
    (re.compile(r"(\d+)\s*(year|years)\s+(before|ago|earlier|back)", re.IGNORECASE), "years", -1),
    (re.compile(r"(\d+)\s*(hour|hours)\s+(from now|ahead|later)", re.IGNORECASE), "hours", +1),
    (re.compile(r"(\d+)\s*(hour|hours)\s+ago", re.IGNORECASE), "hours", -1),
    (re.compile(r"(\d+)\s*(minute|minutes|min|mins)\s+(from now|ahead|later)", re.IGNORECASE), "minutes", +1),
    (re.compile(r"(\d+)\s*(minute|minutes|min|mins)\s+ago", re.IGNORECASE), "minutes", -1),
]


def date_math(input_text: str) -> dict[str, Any] | None:
    for pattern, unit, sign in DATE_MATH_OPS:
        m = pattern.search(input_text)
        if m:
            n = int(m.group(1)) * sign
            d = datetime.now()
            if unit == "days":
                d += timedelta(days=n)
            elif unit == "weeks":
                d += timedelta(weeks=n)
            elif unit == "months":
                month = d.month - 1 + n
                year = d.year + month // 12
                month = month % 12 + 1
                day = min(d.day, [31, 29 if year % 4 == 0 and (year % 100 != 0 or year % 400 == 0) else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1])
                d = d.replace(year=year, month=month, day=day)
            elif unit == "years":
                try:
                    d = d.replace(year=d.year + n)
                except ValueError:  # Feb 29
                    d = d.replace(year=d.year + n, day=28)
            elif unit == "hours":
                d += timedelta(hours=n)
            elif unit == "minutes":
                d += timedelta(minutes=n)
            return {
                "result": d,
                "description": f"{abs(n)} {unit.rstrip('s') if abs(n) == 1 else unit} {'from now' if n > 0 else 'ago'}",
            }
    return None


def duration_between(d1: datetime, d2: datetime) -> str:
    ms = abs((d2 - d1).total_seconds() * 1000)
    seconds = int(ms // 1000)
    minutes = seconds // 60
    hours = minutes // 60
    days = hours // 24
    weeks = days // 7
    months = int(days / 30.44)
    years = int(days / 365.25)

    parts: list[str] = []
    if years > 0:
        parts.append(f"{years} year{'' if years == 1 else 's'}")
    if months > 0:
        parts.append(f"{months} month{'' if months == 1 else 's'}")
    if weeks > 0 and years == 0:
        parts.append(f"{weeks} week{'' if weeks == 1 else 's'}")
    if days > 0 and months == 0:
        parts.append(f"{days} day{'' if days == 1 else 's'}")
    if hours > 0 and days == 0:
        parts.append(f"{hours} hour{'' if hours == 1 else 's'}")
    if minutes > 0 and hours == 0:
        parts.append(f"{minutes} minute{'' if minutes == 1 else 's'}")
    if seconds < 60:
        parts.append(f"{seconds} second{'' if seconds == 1 else 's'}")
    return ", ".join(parts) or "0 seconds"


DEFINITION = ToolDefinition(
    id="datetime",
    name="Date & Time",
    description="Current time in any timezone, date math (what is 2 weeks from now?), timezone conversion, duration calculation, date formatting",
    version="1.0.0",
    icon="\U0001f550",
    params=[
        ToolParam(name="action", type="string", description="Action: now, convert, math, duration, format", required=True),
        ToolParam(name="date", type="string", description="Date/time string to process", required=False),
        ToolParam(name="from", type="string", description="Source timezone (e.g., UTC, EST, PST, CET)", required=False),
        ToolParam(name="to", type="string", description="Target timezone (e.g., UTC, EST, PST, CET)", required=False),
        ToolParam(name="format", type="string", description="Output format: ISO, YYYY-MM-DD, readable, or custom", required=False),
    ],
)


async def execute(params: dict[str, Any], ctx: ToolContext) -> ToolResult:
    action = str(params.get("action") or "now").lower()
    user_input = str(params.get("query") or ctx.userInput or "")
    date_str = str(params.get("date") or "")
    from_tz = str(params.get("from") or "").strip()
    to_tz = str(params.get("to") or "").strip()
    fmt = str(params.get("format") or "readable").lower()

    now = datetime.now()

    if action in ("now", "current", "time"):
        offset = get_offset_minutes(to_tz) if to_tz else None
        if offset is not None:
            utc_now = datetime.now(timezone.utc) + timedelta(minutes=offset)
            return ToolResult(
                success=True,
                output=f"Current time in {to_tz.upper()}: {format_date(utc_now, 'YYYY-MM-DD HH:mm:ss')}",
                data={"timezone": to_tz.upper(), "datetime": utc_now.isoformat(), "offset": offset},
            )
        return ToolResult(
            success=True,
            output=f"Current time: {format_date(now, 'YYYY-MM-DD HH:mm:ss')} (local)\nUTC: {format_date(now.astimezone(timezone.utc), 'ISO')}",
            data={"local": now.isoformat(), "timestamp": int(now.timestamp() * 1000)},
        )

    if action in ("convert", "tz", "timezone"):
        src_offset = get_offset_minutes(from_tz) if from_tz else None
        dst_offset = get_offset_minutes(to_tz)
        if dst_offset is None:
            return ToolResult(success=False, output=f'Unknown timezone "{to_tz}". Try: UTC, EST, PST, CET, JST, or UTC+5')
        local_offset = -int((datetime.now().astimezone().utcoffset() or timedelta(0)).total_seconds() / 60)
        if src_offset is None:
            src_offset = local_offset
        src_date = parse_date_input(date_str) if date_str else now
        if src_date is None:
            return ToolResult(success=False, output=f'Could not parse date "{date_str}".')
        diff = dst_offset - src_offset
        result_date = src_date + timedelta(minutes=diff)
        from_label = from_tz or "local"
        return ToolResult(
            success=True,
            output=f"{format_date(src_date, 'YYYY-MM-DD HH:mm:ss')} {from_label} \u2192 {format_date(result_date, 'YYYY-MM-DD HH:mm:ss')} {to_tz.upper()}",
            data={"from": from_label, "to": to_tz.upper(), "input": src_date.isoformat(), "result": result_date.isoformat(), "offset": diff},
        )

    if action in ("math", "add", "subtract", "calc"):
        math_result = date_math(user_input or date_str)
        if math_result:
            d = math_result["result"]
            return ToolResult(
                success=True,
                output=f"{math_result['description']}: {format_date(d, 'YYYY-MM-DD HH:mm:ss')} ({format_date(d, 'DAYFULL')})",
                data={"result": d.isoformat(), "description": math_result["description"]},
            )
        return ToolResult(success=False, output='Could not parse date math. Try: "2 weeks from now", "3 days ago", "1 month from now"')

    if action in ("duration", "between", "diff", "difference"):
        parts = re.split(r"\s+(?:and|to|until)\s+|\s*[-\u2013]\s*", user_input, flags=re.IGNORECASE)
        if len(parts) >= 2:
            d1 = parse_date_input(parts[0].strip())
            d2 = parse_date_input(parts[1].strip())
            if d1 and d2:
                dur = duration_between(d1, d2)
                return ToolResult(
                    success=True,
                    output=f"Between {format_date(d1, 'YYYY-MM-DD')} and {format_date(d2, 'YYYY-MM-DD')}: {dur}",
                    data={"from": d1.isoformat(), "to": d2.isoformat(), "duration": dur},
                )
        return ToolResult(success=False, output='Provide two dates: "Jan 1, 2024 and Mar 15, 2024" or "today and tomorrow"')

    if action in ("format", "strftime"):
        date_to_format = (parse_date_input(date_str) if date_str else None) or now
        formatted = format_date(date_to_format, "ISO" if fmt == "iso" else fmt.upper())
        return ToolResult(success=True, output=formatted, data={"input": date_to_format.isoformat(), "formatted": formatted, "format": fmt})

    return ToolResult(success=False, output=f'Unknown action "{action}". Available: now, convert, math, duration, format')


def detect(input_text: str) -> dict[str, Any] | None:
    if re.search(r"what('s| is) (the )?(current )?(time|date|day|hour)", input_text, re.IGNORECASE):
        return {"confidence": 0.9, "params": {"action": "now"}}
    if re.search(r"what time is it", input_text, re.IGNORECASE):
        return {"confidence": 0.95, "params": {"action": "now"}}
    if re.search(r"time\s+in\s+\w{2,5}", input_text, re.IGNORECASE) or re.search(r"convert.*time", input_text, re.IGNORECASE) or re.search(r"what.*time.*in", input_text, re.IGNORECASE):
        m = re.search(r"(?:in|to)\s+(\w{2,7})\b", input_text, re.IGNORECASE)
        return {"confidence": 0.7, "params": {"action": "now", "to": m.group(1) if m else "UTC"}}
    if re.search(r"(\d+)\s*(day|week|month|year|hour|minute)s?\s+(from|after|ago|before|now)", input_text, re.IGNORECASE):
        return {"confidence": 0.85, "params": {"action": "math", "query": input_text}}
    if re.search(r"(?:how long|duration|time between|difference between)", input_text, re.IGNORECASE):
        return {"confidence": 0.7, "params": {"action": "duration", "query": input_text}}
    return None


def register_datetime_tool() -> None:
    register_tool(DEFINITION, execute)
    log_info("[tools] Date & Time registered")
