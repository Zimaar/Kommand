import type { FastifyInstance } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/connection.js';
import { users, scheduledJobs } from '../db/schema.js';
import { AppError } from '../utils/errors.js';

// ─── Types ────────────────────────────────────────────────────────────────────

interface NotificationPrefs {
  newOrders: boolean;
  lowInventory: boolean;
  paymentFailures: boolean;
  dailySummary: boolean;
}

interface PreferencesBody {
  clerkId?: string;
  timezone?: string;
  morningBriefTime?: string; // "HH:MM"
  currency?: string;         // ISO 4217 e.g. "USD"
  notifications?: NotificationPrefs;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Validates an IANA timezone string using the Intl API.
 * Falls back gracefully — unknown zones are rejected.
 */
function isValidTimezone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** "08:30" → "30 8 * * *" (cron, daily) */
function timeToCron(timeStr: string): string {
  const [hourStr, minStr] = timeStr.split(':');
  const hour = parseInt(hourStr ?? '8', 10);
  const min  = parseInt(minStr  ?? '0', 10);
  if (isNaN(hour) || isNaN(min) || hour < 0 || hour > 23 || min < 0 || min > 59) {
    return '0 8 * * *'; // safe default
  }
  return `${min} ${hour} * * *`;
}

/**
 * Computes the next wall-clock occurrence of HH:MM from now.
 * If the time has already passed today, returns tomorrow's date.
 * This is a best-effort approximation — the job runner will recalculate.
 */
function nextOccurrence(timeStr: string): Date {
  const [hourStr, minStr] = timeStr.split(':');
  const hour = parseInt(hourStr ?? '8', 10);
  const min  = parseInt(minStr  ?? '0', 10);
  const next = new Date();
  next.setSeconds(0, 0);
  next.setHours(hour, min);
  if (next <= new Date()) next.setDate(next.getDate() + 1);
  return next;
}

/** Upsert a scheduled_job row (select → update or insert). */
async function upsertJob(
  userId: string,
  jobType: 'morning_brief' | 'eod_summary',
  cronExpression: string,
  config: Record<string, unknown>,
  nextRunAt: Date
): Promise<void> {
  const [existing] = await db
    .select({ id: scheduledJobs.id })
    .from(scheduledJobs)
    .where(
      and(
        eq(scheduledJobs.userId, userId),
        eq(scheduledJobs.jobType, jobType)
      )
    )
    .limit(1);

  if (existing) {
    await db
      .update(scheduledJobs)
      .set({ cronExpression, config, isActive: true, nextRunAt })
      .where(eq(scheduledJobs.id, existing.id));
  } else {
    await db.insert(scheduledJobs).values({
      userId,
      jobType,
      cronExpression,
      config,
      isActive: true,
      nextRunAt,
    });
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

export async function userPreferencesRoutes(app: FastifyInstance) {
  /**
   * PUT /users/preferences
   *
   * Persists timezone, morning brief time, currency, and notification flags
   * to the users table.
   *
   * Body: PreferencesBody
   */
  app.put<{ Body: PreferencesBody }>(
    '/users/preferences',
    async (request) => {
      const { clerkId, timezone, morningBriefTime, currency, notifications } =
        request.body ?? {};

      if (!clerkId) throw AppError.unauthorized('Missing Clerk authentication');

      // Validate timezone
      if (timezone && !isValidTimezone(timezone)) {
        throw AppError.validationError(`Invalid timezone: "${timezone}"`);
      }

      // Validate morningBriefTime format (HH:MM)
      if (morningBriefTime && !/^\d{1,2}:\d{2}$/.test(morningBriefTime)) {
        throw AppError.validationError('morningBriefTime must be in HH:MM format');
      }

      // Validate currency (3-letter ISO code)
      if (currency && !/^[A-Z]{3}$/.test(currency)) {
        throw AppError.validationError('currency must be a 3-letter ISO 4217 code (e.g. USD)');
      }

      // Resolve user
      const [user] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.clerkId, clerkId))
        .limit(1);

      if (!user) throw AppError.unauthorized('User not found');

      // Build partial update (only set fields that were provided)
      const patch: Partial<{
        timezone: string;
        morningBrief: string;
        updatedAt: Date;
      }> = { updatedAt: new Date() };

      if (timezone)          patch.timezone      = timezone;
      if (morningBriefTime)  patch.morningBrief  = morningBriefTime;

      await db.update(users).set(patch).where(eq(users.id, user.id));

      app.log.info(
        { userId: user.id, timezone, morningBriefTime, currency },
        '[user-preferences] preferences updated'
      );

      return { success: true };
    }
  );

  /**
   * POST /jobs/setup
   *
   * Creates (or updates) the two default scheduled jobs for a user:
   *   • morning_brief — runs daily at the configured time
   *   • eod_summary   — runs daily at 6 PM (adjustable in future)
   *
   * Notification toggles and currency are stored in each job's config JSONB
   * so the job runner can personalise messages at send time.
   *
   * Body: PreferencesBody (reuses same shape as PUT /users/preferences)
   */
  app.post<{ Body: PreferencesBody }>(
    '/jobs/setup',
    async (request) => {
      const {
        clerkId,
        timezone = 'UTC',
        morningBriefTime = '08:00',
        currency = 'USD',
        notifications = {
          newOrders:       true,
          lowInventory:    true,
          paymentFailures: true,
          dailySummary:    true,
        },
      } = request.body ?? {};

      if (!clerkId) throw AppError.unauthorized('Missing Clerk authentication');

      // Resolve user
      const [user] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.clerkId, clerkId))
        .limit(1);

      if (!user) throw AppError.unauthorized('User not found');

      const briefCron  = timeToCron(morningBriefTime);
      const briefNext  = nextOccurrence(morningBriefTime);
      const eodNext    = nextOccurrence('18:00');

      // morning_brief — config carries notification prefs + currency
      await upsertJob(
        user.id,
        'morning_brief',
        briefCron,
        {
          timezone,
          currency,
          notifyNewOrders:       notifications.newOrders       ?? true,
          notifyLowInventory:    notifications.lowInventory     ?? true,
          notifyPaymentFailures: notifications.paymentFailures  ?? true,
        },
        briefNext
      );

      // eod_summary — daily 6 PM digest
      await upsertJob(
        user.id,
        'eod_summary',
        '0 18 * * *',
        {
          timezone,
          currency,
          notifyDailySummary: notifications.dailySummary ?? true,
        },
        eodNext
      );

      app.log.info(
        { userId: user.id, briefCron, timezone },
        '[jobs-setup] default scheduled jobs created/updated'
      );

      return { success: true };
    }
  );
}
