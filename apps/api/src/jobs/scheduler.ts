import { Queue, Worker } from 'bullmq';
import type { Job, ConnectionOptions } from 'bullmq';
import { eq } from 'drizzle-orm';
import { db } from '../db/connection.js';
import { scheduledJobs } from '../db/schema.js';

// ─── Types ────────────────────────────────────────────────────────────────────

// DB-persisted job types (must match the schema enum)
type DbJobType = 'morning_brief' | 'eod_summary' | 'stock_check' | 'invoice_reminder';

// All supported job types (includes programmatic-only types)
export type JobType = DbJobType | 'alert_check';

export type JobHandler = (data: Record<string, unknown>) => Promise<void>;

// ─── Constants ────────────────────────────────────────────────────────────────

const QUEUE_NAME   = 'kommand-jobs';
const DLQ_NAME     = 'kommand-jobs-dlq';
const MAX_ATTEMPTS = 3;

const DB_JOB_TYPES = new Set<string>(['morning_brief', 'eod_summary', 'stock_check', 'invoice_reminder']);

// ─── JobScheduler ─────────────────────────────────────────────────────────────

export class JobScheduler {
  private readonly connection: ConnectionOptions;
  private readonly queue: Queue;
  private readonly dlq: Queue;
  private worker: Worker | null = null;
  private readonly handlers = new Map<JobType, JobHandler>();

  constructor(redisUrl: string) {
    // BullMQ accepts a plain ConnectionOptions object; it manages its own ioredis connections
    // (workers use blocking commands that require maxRetriesPerRequest: null internally)
    this.connection = { url: redisUrl, maxRetriesPerRequest: null, enableReadyCheck: false };

    this.queue = new Queue(QUEUE_NAME, {
      connection: this.connection,
      defaultJobOptions: {
        attempts: MAX_ATTEMPTS,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: { count: 100 },
        removeOnFail: false, // Retain failed jobs so the DLQ handler can inspect them
      },
    });

    this.dlq = new Queue(DLQ_NAME, {
      connection: this.connection,
      defaultJobOptions: {
        removeOnComplete: { count: 500 },
        removeOnFail: { count: 500 },
      },
    });
  }

  // ── Handler registration + optional cron scheduling ──────────────────────────

  /**
   * Register a handler for a job type.
   * If `cronExpression` is supplied the job is also added as a repeating cron.
   * A stable `jobId` of `cron:<name>` prevents duplicate schedules on restart.
   */
  async registerJob(name: JobType, handler: JobHandler, cronExpression?: string): Promise<void> {
    this.handlers.set(name, handler);

    if (cronExpression) {
      await this.queue.add(name, {}, {
        repeat:  { pattern: cronExpression },
        jobId:   `cron:${name}`,
      });
    }
  }

  // ── One-off dispatch ─────────────────────────────────────────────────────────

  /** Enqueue a one-off job with an optional delay in milliseconds. */
  async enqueue(name: JobType, data: Record<string, unknown> = {}, delayMs = 0): Promise<void> {
    await this.queue.add(name, data, { delay: delayMs });
  }

  // ── Worker ───────────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    this.worker = new Worker(
      QUEUE_NAME,
      async (job: Job) => {
        const handler = this.handlers.get(job.name as JobType);
        if (!handler) throw new Error(`No handler registered for job type: ${job.name}`);

        await handler((job.data ?? {}) as Record<string, unknown>);
        await this._markRan(job.name);
      },
      { connection: this.connection, concurrency: 5 }
    );

    // Dead-letter queue: move a job there once all retry attempts are exhausted
    this.worker.on('failed', (job, err) => {
      if (!job) return;
      const maxAttempts = job.opts.attempts ?? MAX_ATTEMPTS;
      if (job.attemptsMade >= maxAttempts) {
        void this.dlq.add(`dlq:${job.name}`, {
          originalJobName: job.name,
          originalData:    job.data,
          error:           err.message,
          attemptsMade:    job.attemptsMade,
          failedAt:        new Date().toISOString(),
        });
      }
    });

    this.worker.on('error', (err) => {
      console.error('[JobScheduler] Worker error:', err);
    });
  }

  // ── DB bootstrap ─────────────────────────────────────────────────────────────

  /**
   * Load all active rows from `scheduled_jobs` and register their cron schedules.
   * Call this after all handlers are registered so the worker can dispatch them.
   */
  async loadFromDb(): Promise<void> {
    const rows = await db
      .select()
      .from(scheduledJobs)
      .where(eq(scheduledJobs.isActive, true));

    for (const row of rows) {
      // Per-user cron jobs use a compound jobId to avoid collisions
      await this.queue.add(row.jobType, (row.config ?? {}) as Record<string, unknown>, {
        repeat: { pattern: row.cronExpression },
        jobId:  `cron:${row.jobType}:${row.userId}`,
      });
    }
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  async close(): Promise<void> {
    await this.worker?.close();
    await this.queue.close();
    await this.dlq.close();
  }

  // ── Internals ────────────────────────────────────────────────────────────────

  private async _markRan(jobType: string): Promise<void> {
    if (!DB_JOB_TYPES.has(jobType)) return;
    await db
      .update(scheduledJobs)
      .set({ lastRunAt: new Date() })
      .where(eq(scheduledJobs.jobType, jobType as DbJobType));
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

let _scheduler: JobScheduler | null = null;

export function getScheduler(redisUrl: string): JobScheduler {
  if (!_scheduler) {
    _scheduler = new JobScheduler(redisUrl);
  }
  return _scheduler;
}
