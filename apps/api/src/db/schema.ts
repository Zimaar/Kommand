import {
  pgTable,
  uuid,
  text,
  boolean,
  timestamp,
  jsonb,
  integer,
  time,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';

// ─── users ────────────────────────────────────────────────────────────────────

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  clerkId: text('clerk_id').unique().notNull(),
  email: text('email').unique().notNull(),
  name: text('name'),
  phone: text('phone'),
  timezone: text('timezone').default('UTC').notNull(),
  morningBrief: time('morning_brief').default('08:00'),
  plan: text('plan', { enum: ['trial', 'starter', 'growth', 'pro'] }).default('trial').notNull(),
  planExpiresAt: timestamp('plan_expires_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// ─── stores ───────────────────────────────────────────────────────────────────

export const stores = pgTable(
  'stores',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    platform: text('platform', { enum: ['shopify', 'woocommerce', 'bigcommerce'] }).notNull(),
    shopDomain: text('shop_domain').notNull(),
    shopName: text('shop_name'),
    accessToken: text('access_token').notNull(),
    tokenIv: text('token_iv').notNull(),
    scopes: text('scopes').array(),
    isActive: boolean('is_active').default(true).notNull(),
    installedAt: timestamp('installed_at', { withTimezone: true }).defaultNow().notNull(),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('stores_user_platform_domain_idx').on(t.userId, t.platform, t.shopDomain)]
);

// ─── accounting_connections ───────────────────────────────────────────────────

export const accountingConnections = pgTable(
  'accounting_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    platform: text('platform', { enum: ['xero', 'quickbooks', 'freshbooks'] }).notNull(),
    tenantId: text('tenant_id'),
    tenantName: text('tenant_name'),
    accessToken: text('access_token').notNull(),
    refreshToken: text('refresh_token').notNull(),
    tokenIv: text('token_iv').notNull(),
    tokenExpiresAt: timestamp('token_expires_at', { withTimezone: true }),
    scopes: text('scopes').array(),
    isActive: boolean('is_active').default(true).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('accounting_user_platform_tenant_idx').on(t.userId, t.platform, t.tenantId),
  ]
);

// ─── channels ─────────────────────────────────────────────────────────────────

export const channels = pgTable(
  'channels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text('type', { enum: ['whatsapp', 'slack', 'email', 'telegram'] }).notNull(),
    channelId: text('channel_id').notNull(),
    config: jsonb('config').default({}).notNull(),
    isActive: boolean('is_active').default(true).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('channels_user_type_channel_idx').on(t.userId, t.type, t.channelId)]
);

// ─── conversations ────────────────────────────────────────────────────────────

export const conversations = pgTable('conversations', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  channelId: uuid('channel_id')
    .notNull()
    .references(() => channels.id),
  startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
  lastMessageAt: timestamp('last_message_at', { withTimezone: true }).defaultNow().notNull(),
  metadata: jsonb('metadata').default({}).notNull(),
});

// ─── messages ─────────────────────────────────────────────────────────────────

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    direction: text('direction', { enum: ['inbound', 'outbound'] }).notNull(),
    role: text('role', { enum: ['user', 'assistant', 'system'] }).notNull(),
    content: text('content').notNull(),
    channelMessageId: text('channel_message_id'),
    toolCalls: jsonb('tool_calls'),
    toolResults: jsonb('tool_results'),
    tokensUsed: integer('tokens_used'),
    latencyMs: integer('latency_ms'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('idx_messages_conversation').on(t.conversationId, t.createdAt),
    index('idx_messages_dedup').on(t.channelMessageId),
  ]
);

// ─── commands ─────────────────────────────────────────────────────────────────

export const commands = pgTable(
  'commands',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    messageId: uuid('message_id').references(() => messages.id),
    commandType: text('command_type').notNull(),
    toolName: text('tool_name').notNull(),
    input: jsonb('input').notNull(),
    output: jsonb('output'),
    status: text('status', {
      enum: ['pending', 'confirmed', 'executed', 'failed', 'cancelled'],
    })
      .default('pending')
      .notNull(),
    confirmationTier: integer('confirmation_tier').default(0).notNull(),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    executedAt: timestamp('executed_at', { withTimezone: true }),
    error: text('error'),
    idempotencyKey: text('idempotency_key').unique(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('idx_commands_user').on(t.userId, t.createdAt),
    index('idx_commands_status').on(t.status),
  ]
);

// ─── pending_confirmations ────────────────────────────────────────────────────

export const pendingConfirmations = pgTable(
  'pending_confirmations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    commandId: uuid('command_id')
      .notNull()
      .references(() => commands.id, { onDelete: 'cascade' }),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id),
    promptText: text('prompt_text').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    status: text('status', { enum: ['pending', 'confirmed', 'cancelled', 'expired'] })
      .default('pending')
      .notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('idx_pending_user').on(t.userId, t.status)]
);

// ─── scheduled_jobs ───────────────────────────────────────────────────────────

export const scheduledJobs = pgTable(
  'scheduled_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    jobType: text('job_type', {
      enum: ['morning_brief', 'eod_summary', 'stock_check', 'invoice_reminder'],
    }).notNull(),
    cronExpression: text('cron_expression').notNull(),
    config: jsonb('config').default({}).notNull(),
    isActive: boolean('is_active').default(true).notNull(),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    nextRunAt: timestamp('next_run_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('idx_jobs_next_run').on(t.nextRunAt, t.isActive)]
);

// ─── alert_rules ──────────────────────────────────────────────────────────────

export const alertRules = pgTable('alert_rules', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  type: text('type', {
    enum: ['inventory_low', 'revenue_drop', 'invoice_overdue', 'custom'],
  }).notNull(),
  condition: jsonb('condition').notNull(),
  messageTemplate: text('message_template'),
  isActive: boolean('is_active').default(true).notNull(),
  lastTriggeredAt: timestamp('last_triggered_at', { withTimezone: true }),
  cooldownMinutes: integer('cooldown_minutes').default(60).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

// ─── Relations ────────────────────────────────────────────────────────────────

export const usersRelations = relations(users, ({ many }) => ({
  stores: many(stores),
  accountingConnections: many(accountingConnections),
  channels: many(channels),
  conversations: many(conversations),
  commands: many(commands),
  scheduledJobs: many(scheduledJobs),
  alertRules: many(alertRules),
}));

export const storesRelations = relations(stores, ({ one }) => ({
  user: one(users, { fields: [stores.userId], references: [users.id] }),
}));

export const accountingConnectionsRelations = relations(accountingConnections, ({ one }) => ({
  user: one(users, { fields: [accountingConnections.userId], references: [users.id] }),
}));

export const channelsRelations = relations(channels, ({ one, many }) => ({
  user: one(users, { fields: [channels.userId], references: [users.id] }),
  conversations: many(conversations),
  pendingConfirmations: many(pendingConfirmations),
}));

export const conversationsRelations = relations(conversations, ({ one, many }) => ({
  user: one(users, { fields: [conversations.userId], references: [users.id] }),
  channel: one(channels, { fields: [conversations.channelId], references: [channels.id] }),
  messages: many(messages),
}));

export const messagesRelations = relations(messages, ({ one }) => ({
  conversation: one(conversations, {
    fields: [messages.conversationId],
    references: [conversations.id],
  }),
}));

export const commandsRelations = relations(commands, ({ one, many }) => ({
  user: one(users, { fields: [commands.userId], references: [users.id] }),
  message: one(messages, { fields: [commands.messageId], references: [messages.id] }),
  pendingConfirmations: many(pendingConfirmations),
}));

export const pendingConfirmationsRelations = relations(pendingConfirmations, ({ one }) => ({
  user: one(users, { fields: [pendingConfirmations.userId], references: [users.id] }),
  command: one(commands, {
    fields: [pendingConfirmations.commandId],
    references: [commands.id],
  }),
  channel: one(channels, {
    fields: [pendingConfirmations.channelId],
    references: [channels.id],
  }),
}));

export const scheduledJobsRelations = relations(scheduledJobs, ({ one }) => ({
  user: one(users, { fields: [scheduledJobs.userId], references: [users.id] }),
}));

export const alertRulesRelations = relations(alertRules, ({ one }) => ({
  user: one(users, { fields: [alertRules.userId], references: [users.id] }),
}));
