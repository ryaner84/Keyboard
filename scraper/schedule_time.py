"""
Print the PC-LOCAL time (HH:MM) that equals 00:00 GMT+8 (Singapore).

The WorkSpace's own timezone is NOT assumed to be GMT+8. We build midnight in
GMT+8, convert that exact instant to the machine's local timezone, and print it
so run-scraper.bat can hand it to schtasks. This way the nightly job always
fires at Singapore midnight regardless of how the PC clock is set.
"""

from datetime import datetime, timezone, timedelta

SGT = timezone(timedelta(hours=8))  # Singapore, no DST


def local_hhmm_for_sgt_midnight() -> str:
    # Any date works — we only care about the time-of-day mapping.
    sgt_midnight = datetime.now(SGT).replace(hour=0, minute=0, second=0, microsecond=0)
    local = sgt_midnight.astimezone()  # convert to the PC's local timezone
    return local.strftime("%H:%M")


if __name__ == "__main__":
    print(local_hhmm_for_sgt_midnight())
