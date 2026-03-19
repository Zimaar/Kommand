import type { FastifyInstance } from 'fastify';
import { eq, and, desc, count as sqlCount } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/connection.js';
import { users, commands as commandsTable } from '../db/schema.js';
import { AppError } from '../utils/errors.js';
import { checkRateLimit } from '../utils/rate-limit.js';
import { ok } from '../utils/response.js';

// ─── Validation ───────────────────────────────────────────────────────────────

const COMMAND_STATUSES = ['pending', 'confirmed', 'executed', 'failed', 'cancelled'] as const;

const CommandsQuerySchema = z.object({
  clerkId: z.string().min(1),
  status:  z.enum(COMMAND_STATUSES).optional(),
  limit:   z.coerce.number().int().min(1).max(100).default(50),
  offset:  z.coerce.number().int().min(0).default(0),
});

// ─── Routes ───────────────────────────────────────────────────────────────────

export async function commandRoutes(app: FastifyInstance) {
  // ── GET /commands ──────────────────────────────────────────────────────────
  // Paginated audit log of all commands executed on behalf of the user.
  // Query: clerkId, status? (pending|confirmed|executed|failed|cancelled), limit, offset
  app.get('/commands', async (request) => {
    const parsed = CommandsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      throw AppError.validationError(
        parsed.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ')
      );
    }

    const { clerkId, status, limit, offset } = parsed.data;

    await checkRateLimit(clerkId);

    const [user] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.clerkId, clerkId))
      .limit(1);

    if (!user) throw AppError.notFound('User not found');

    // Build where clause
    const userFilter   = eq(commandsTable.userId, user.id);
    const whereClause  = status
      ? and(userFilter, eq(commandsTable.status, status))
      : userFilter;

    // Total count
    const [{ value: totalCount }] = await db
      .select({ value: sqlCount() })
      .from(commandsTable)
      .where(whereClause);

    // Rows
    const rows = await db
      .select({
        id:               commandsTable.id,
        commandType:      commandsTable.commandType,
        toolName:         commandsTable.toolName,
        input:            commandsTable.input,
        output:           commandsTable.output,
        status:           commandsTable.status,
        confirmationTier: commandsTable.confirmationTier,
        confirmedAt:      commandsTable.confirmedAt,
        executedAt:       commandsTable.executedAt,
        error:            commandsTable.error,
        createdAt:        commandsTable.createdAt,
      })
      .from(commandsTable)
      .where(whereClause)
      .orderBy(desc(commandsTable.createdAt))
      .limit(limit)
      .offset(offset);

    return ok({
      commands: rows,
      total:    Number(totalCount),
      hasMore:  offset + rows.length < Number(totalCount),
    });
  });
}
