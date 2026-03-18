import type { ToolContext } from '@kommand/shared';

export interface PendingConfirmationRecord {
  id: string;
  userId: string;
  commandId: string;
  toolName: string;
  params: unknown;
  context: ToolContext;
  promptText: string;
  expiresAt: Date;
}

export interface ConfirmationEngine {
  create(opts: {
    userId: string;
    commandId: string;
    toolName: string;
    params: unknown;
    context: ToolContext;
    promptText: string;
  }): Promise<PendingConfirmationRecord>;

  get(confirmationId: string): Promise<PendingConfirmationRecord | null>;

  complete(confirmationId: string): Promise<void>;
}

/**
 * In-memory confirmation engine — used in tests and as a placeholder until
 * the full DB-backed implementation is wired in M3.
 */
export class InMemoryConfirmationEngine implements ConfirmationEngine {
  private readonly store = new Map<string, PendingConfirmationRecord>();

  async create(opts: {
    userId: string;
    commandId: string;
    toolName: string;
    params: unknown;
    context: ToolContext;
    promptText: string;
  }): Promise<PendingConfirmationRecord> {
    const record: PendingConfirmationRecord = {
      id: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 10 * 60 * 1000), // 10 min
      ...opts,
    };
    this.store.set(record.id, record);
    return record;
  }

  async get(confirmationId: string): Promise<PendingConfirmationRecord | null> {
    return this.store.get(confirmationId) ?? null;
  }

  async complete(confirmationId: string): Promise<void> {
    this.store.delete(confirmationId);
  }
}
