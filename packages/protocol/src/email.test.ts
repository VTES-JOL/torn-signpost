import { describe, expect, it } from 'vitest';
import { DEFAULT_EMAIL_PREFS, digestDue, EmailPrefs, localHour, validTimeZone } from './email.ts';

describe('digest times (NOTIF-02, M5b leftovers)', () => {
  const daily = DEFAULT_EMAIL_PREFS;
  const twice = { ...DEFAULT_EMAIL_PREFS, digest: 'twice-daily' as const };
  const at = (iso: string) => new Date(iso);

  it('sends at 17:00 UTC when no time zone is set', () => {
    expect(digestDue(daily, at('2026-11-05T17:00:00Z'))).toBe(true);
    expect(digestDue(daily, at('2026-11-05T17:14:00Z'))).toBe(true);
    expect(digestDue(daily, at('2026-11-05T05:00:00Z'))).toBe(false);
    expect(digestDue(twice, at('2026-11-05T05:00:00Z'))).toBe(true);
  });

  it('sends at the user’s own 17:00, daylight saving included', () => {
    const paris = { ...daily, timeZone: 'Europe/Paris' };
    // Winter (CET, UTC+1) and summer (CEST, UTC+2).
    expect(digestDue(paris, at('2026-11-05T16:00:00Z'))).toBe(true);
    expect(digestDue(paris, at('2026-07-05T15:00:00Z'))).toBe(true);
    expect(digestDue(paris, at('2026-07-05T16:00:00Z'))).toBe(false);
    // Half-hour zones: the run at :00 UTC is 17:30 there, still the 17:00 hour.
    expect(digestDue({ ...daily, timeZone: 'Asia/Kolkata' }, at('2026-11-05T12:00:00Z'))).toBe(
      true,
    );
  });

  it('reads the local hour, and falls back to UTC for an unknown zone', () => {
    expect(localHour(at('2026-11-05T23:30:00Z'), 'Australia/Sydney')).toBe(10);
    expect(localHour(at('2026-11-05T00:00:00Z'))).toBe(0);
    expect(digestDue({ ...daily, timeZone: 'Mars/Olympus' }, at('2026-11-05T17:00:00Z'))).toBe(
      true,
    );
  });

  it('accepts IANA zones in the preferences and refuses others', () => {
    expect(validTimeZone('America/Sao_Paulo')).toBe(true);
    expect(validTimeZone('Mars/Olympus')).toBe(false);
    expect(EmailPrefs.safeParse({ ...daily, timeZone: 'Asia/Tokyo' }).success).toBe(true);
    expect(EmailPrefs.safeParse({ ...daily, timeZone: 'Mars/Olympus' }).success).toBe(false);
    expect(EmailPrefs.safeParse(daily).success).toBe(true);
  });
});
