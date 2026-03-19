import type { FastifyInstance } from 'fastify';
import { eq, and, desc, count, ilike } from 'drizzle-orm';
import { db } from '../db/connection.js';
import { users, messages, conversations } from '../db/schema.js';
import { AppError } from '../utils/errors.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

export async function conversationRoutes(app: FastifyInstance) {
  // ── GET /conversations ───────────────────────────────────────────────────────
  // Returns paginated messages for the authenticated user, newest first.
  // Query: clerkId, limit (max 100), offset
  app.get(
    '/conversations',
    async (request) => {
      const query = request.query as Record<string, string>;
      const clerkId = query.clerkId;
      if (!clerkId) throw AppError.unauthorized('Missing Clerk authentication');

      const limit  = Math.min(parseInt(query.limit  ?? String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT, MAX_LIMIT);
      const offset = parseInt(query.offset ?? '0', 10) || 0;

      const [user] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.clerkId, clerkId))
        .limit(1);

      if (!user) return { messages: [], total: 0, hasMore: false };

      // Total count for pagination
      const [{ value: total }] = await db
        .select({ value: count() })
        .from(messages)
        .innerJoin(conversations, eq(messages.conversationId, conversations.id))
        .where(eq(conversations.userId, user.id));

      const rows = await db
        .select({
          id:             messages.id,
          direction:      messages.direction,
          role:           messages.role,
          content:        messages.content,
          toolCalls:      messages.toolCalls,
          toolResults:    messages.toolResults,
          tokensUsed:     messages.tokensUsed,
          latencyMs:      messages.latencyMs,
          createdAt:      messages.createdAt,
          conversationId: messages.conversationId,
        })
        .from(messages)
        .innerJoin(conversations, eq(messages.conversationId, conversations.id))
        .where(eq(conversations.userId, user.id))
        .orderBy(desc(messages.createdAt))
        .limit(limit)
        .offset(offset);

      return {
        messages: rows,
        total,
        hasMore: offset + rows.length < total,
      };
    }
  );

  // ── GET /conversations/search ────────────────────────────────────────────────
  // Keyword search across message content (ILIKE).
  // Query: clerkId, q
  app.get(
    '/conversations/search',
    async (request) => {
      const query   = request.query as Record<string, string>;
      const clerkId = query.clerkId;
      if (!clerkId) throw AppError.unauthorized('Missing Clerk authentication');

      const q = query.q?.trim() ?? '';
      if (!q) return { messages: [] };

      const [user] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.clerkId, clerkId))
        .limit(1);

      if (!user) return { messages: [] };

      const rows = await db
        .select({
          id:             messages.id,
          direction:      messages.direction,
          role:           messages.role,
          content:        messages.content,
          toolCalls:      messages.toolCalls,
          toolResults:    messages.toolResults,
          tokensUsed:     messages.tokensUsed,
          latencyMs:      messages.latencyMs,
          createdAt:      messages.createdAt,
          conversationId: messages.conversationId,
        })
        .from(messages)
        .innerJoin(conversations, eq(messages.conversationId, conversations.id))
        .where(and(eq(conversations.userId, user.id), ilike(messages.content, `%${q}%`)))
        .orderBy(desc(messages.createdAt))
        .limit(MAX_LIMIT);

      return { messages: rows };
    }
  );
}
