import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/connection.js';
import { users, stores, accountingConnections, channels } from '../db/schema.js';
import { AppError } from '../utils/errors.js';
import { checkRateLimit } from '../utils/rate-limit.js';
import { ok } from '../utils/response.js';

// ─── Validation ───────────────────────────────────────────────────────────────

const UpdateMeSchema = z.object({
  name:     z.string().min(1).max(120).optional(),
  timezone: z.string().min(1).max(64).optional(),
});

// ─── Routes ───────────────────────────────────────────────────────────────────

export async function meRoutes(app: FastifyInstance) {
  // ── GET /me ────────────────────────────────────────────────────────────────
  // Returns the current user's profile plus a summary of their connections.
  // Query: clerkId
  app.get('/me', async (request) => {
    const query   = request.query as Record<string, string>;
    const clerkId = query.clerkId;
    if (!clerkId) throw AppError.unauthorized('Missing Clerk authentication');

    await checkRateLimit(clerkId);

    const [user] = await db
      .select({
        id:            users.id,
        clerkId:       users.clerkId,
        email:         users.email,
        name:          users.name,
        phone:         users.phone,
        timezone:      users.timezone,
        morningBrief:  users.morningBrief,
        plan:          users.plan,
        planExpiresAt: users.planExpiresAt,
        createdAt:     users.createdAt,
      })
      .from(users)
      .where(eq(users.clerkId, clerkId))
      .limit(1);

    if (!user) throw AppError.notFound('User not found');

    // Connections summary — active rows only (one shopify, one accounting, all channels)
    const [shopify] = await db
      .select({ id: stores.id, platform: stores.platform, shopName: stores.shopName, shopDomain: stores.shopDomain, isActive: stores.isActive })
      .from(stores)
      .where(eq(stores.userId, user.id))
      .limit(1);

    const [accounting] = await db
      .select({ id: accountingConnections.id, platform: accountingConnections.platform, tenantName: accountingConnections.tenantName, isActive: accountingConnections.isActive })
      .from(accountingConnections)
      .where(eq(accountingConnections.userId, user.id))
      .limit(1);

    const channelRows = await db
      .select({ id: channels.id, type: channels.type, channelId: channels.channelId, isActive: channels.isActive })
      .from(channels)
      .where(eq(channels.userId, user.id));

    return ok({
      user,
      connections: {
        shopify:    shopify    ?? null,
        accounting: accounting ?? null,
        channels:   channelRows,
      },
    });
  });

  // ── PUT /me ────────────────────────────────────────────────────────────────
  // Updates user profile fields (name and/or timezone).
  // Body: { clerkId, name?, timezone? }
  app.put<{ Body: unknown }>('/me', async (request) => {
    const body    = request.body as Record<string, unknown> ?? {};
    const clerkId = body.clerkId as string | undefined;
    if (!clerkId) throw AppError.unauthorized('Missing Clerk authentication');

    await checkRateLimit(clerkId);

    const parsed = UpdateMeSchema.safeParse(body);
    if (!parsed.success) {
      throw AppError.validationError(
        parsed.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ')
      );
    }

    const { name, timezone } = parsed.data;
    if (!name && !timezone) throw AppError.validationError('At least one field (name, timezone) is required');

    if (timezone) {
      try {
        Intl.DateTimeFormat(undefined, { timeZone: timezone });
      } catch {
        throw AppError.validationError(`Invalid IANA timezone: "${timezone}"`);
      }
    }

    const [user] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.clerkId, clerkId))
      .limit(1);

    if (!user) throw AppError.notFound('User not found');

    const patch: { name?: string; timezone?: string; updatedAt: Date } = { updatedAt: new Date() };
    if (name)     patch.name     = name;
    if (timezone) patch.timezone = timezone;

    await db.update(users).set(patch).where(eq(users.id, user.id));

    return ok({ updated: true });
  });
}
