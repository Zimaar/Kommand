export type CommandStatus = 'pending' | 'confirmed' | 'executed' | 'failed' | 'cancelled';

export interface Command {
  readonly id: string;
  readonly userId: string;
  readonly messageId?: string;
  readonly commandType: string;
  readonly toolName: string;
  readonly input: Record<string, unknown>;
  readonly output?: Record<string, unknown>;
  readonly status: CommandStatus;
  readonly confirmationTier: number;
  readonly confirmedAt?: Date;
  readonly executedAt?: Date;
  readonly error?: string;
  readonly idempotencyKey?: string;
  readonly createdAt: Date;
}

export interface PendingConfirmation {
  readonly id: string;
  readonly userId: string;
  readonly commandId: string;
  readonly channelId: string;
  readonly promptText: string;
  readonly expiresAt: Date;
  readonly status: 'pending' | 'confirmed' | 'cancelled' | 'expired';
  readonly createdAt: Date;
}
