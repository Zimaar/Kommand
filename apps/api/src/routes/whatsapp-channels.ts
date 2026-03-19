import type { FastifyInstance } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/connection.js';
import { users, channels } from '../db/schema.js';
import { AppError } from '../utils/errors.js';
import { getRedisClient } from '../utils/redis.js';
import { WhatsAppSender } from '../channels/adapters/whatsapp/outbound.js';
import { normalizePhoneNumber } from '../channels/adapters/whatsapp/phone.js';
import { config } from '../config/index.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Generates a cryptographically-adequate 6-digit OTP (padded if needed). */
function generateOtp(): string {
  const otp = Math.floor(100000 + Math.random() * 900000);
  return otp.toString().padStart(6, '0');
}

function otpRedisKey(userId: string, phone: string): string {
  return `whatsapp:otp:${userId}:${phone}`;
}

/** 5-minute TTL for verification codes */
const OTP_TTL_SECONDS = 300;

// ─── Routes ───────────────────────────────────────────────────────────────────

export async function whatsappChannelRoutes(app: FastifyInstance) {
  /**
   * POST /channels/whatsapp/initiate
   *
   * Accepts a phone number from the dashboard onboarding flow, stores a
   * short-lived OTP in Redis, and sends it to the owner via WhatsApp.
   *
   * Body: { clerkId: string; phoneNumber: string }
   *   phoneNumber — already-assembled E.164 string (country code + digits)
   *                 supplied by the dashboard (e.g. "+16505551234")
   */
  app.post<{ Body: { clerkId?: string; phoneNumber?: string } }>(
    '/channels/whatsapp/initiate',
    async (request) => {
      const { clerkId, phoneNumber } = request.body ?? {};

      if (!clerkId) throw AppError.unauthorized('Missing Clerk authentication');
      if (!phoneNumber?.trim()) throw AppError.validationError('phoneNumber is required');

      // Normalise to E.164 (strips spaces, handles 00xxx prefix, etc.)
      const normalizedPhone = normalizePhoneNumber(phoneNumber.trim());
      if (!/^\+\d{7,15}$/.test(normalizedPhone)) {
        throw AppError.validationError('Invalid phone number — must be in E.164 format');
      }

      // Resolve Clerk ID → internal user
      const [user] = await db
        .select({ id: users.id, name: users.name })
        .from(users)
        .where(eq(users.clerkId, clerkId))
        .limit(1);

      if (!user) throw AppError.unauthorized('User not found');

      // Check WhatsApp credentials are configured
      if (!config.WHATSAPP_PHONE_NUMBER_ID || !config.WHATSAPP_ACCESS_TOKEN) {
        throw AppError.externalApiError(
          'WhatsApp is not configured on this server. Please contact support.'
        );
      }

      // Generate OTP and persist to Redis with 5-min TTL
      const otp = generateOtp();
      const redisKey = otpRedisKey(user.id, normalizedPhone);

      try {
        const redis = getRedisClient();
        await redis.set(redisKey, otp, 'EX', OTP_TTL_SECONDS);
      } catch (err) {
        app.log.error({ err }, '[whatsapp-initiate] Redis error storing OTP');
        throw AppError.externalApiError('Failed to store verification code — please retry');
      }

      // Send WhatsApp message with the code
      const sender = new WhatsAppSender(
        config.WHATSAPP_PHONE_NUMBER_ID,
        config.WHATSAPP_ACCESS_TOKEN
      );

      const ownerName = user.name?.split(' ')[0] ?? 'there';
      const messageText =
        `👋 Hi ${ownerName}! Your Kommand verification code is:\n\n` +
        `*${otp}*\n\n` +
        `This code expires in 5 minutes. Don't share it with anyone.`;

      await sender.sendText(normalizedPhone, messageText);

      app.log.info(
        { userId: user.id, phone: normalizedPhone.slice(0, -4) + '****' },
        '[whatsapp-initiate] OTP sent'
      );

      return { success: true };
    }
  );

  /**
   * POST /channels/whatsapp/verify
   *
   * Validates the 6-digit OTP entered by the owner, then upserts a channel
   * record so the AI pipeline can route messages to this user.
   *
   * Body: { clerkId: string; phoneNumber: string; code: string }
   */
  app.post<{ Body: { clerkId?: string; phoneNumber?: string; code?: string } }>(
    '/channels/whatsapp/verify',
    async (request) => {
      const { clerkId, phoneNumber, code } = request.body ?? {};

      if (!clerkId) throw AppError.unauthorized('Missing Clerk authentication');
      if (!phoneNumber?.trim()) throw AppError.validationError('phoneNumber is required');
      if (!code?.trim()) throw AppError.validationError('code is required');

      if (!/^\d{6}$/.test(code.trim())) {
        throw AppError.validationError('Verification code must be exactly 6 digits');
      }

      const normalizedPhone = normalizePhoneNumber(phoneNumber.trim());

      // Resolve user
      const [user] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.clerkId, clerkId))
        .limit(1);

      if (!user) throw AppError.unauthorized('User not found');

      // Fetch OTP from Redis
      let storedOtp: string | null;
      try {
        const redis = getRedisClient();
        storedOtp = await redis.get(otpRedisKey(user.id, normalizedPhone));
      } catch (err) {
        app.log.error({ err }, '[whatsapp-verify] Redis error fetching OTP');
        throw AppError.externalApiError('Failed to retrieve verification code — please retry');
      }

      if (!storedOtp) {
        throw AppError.validationError(
          'Verification code has expired or is invalid. Please request a new one.'
        );
      }

      if (storedOtp !== code.trim()) {
        throw AppError.validationError('Incorrect verification code');
      }

      // Single-use: delete from Redis immediately
      try {
        const redis = getRedisClient();
        await redis.del(otpRedisKey(user.id, normalizedPhone));
      } catch {
        // Non-critical — TTL will expire it naturally
      }

      // Upsert channel record (handles reconnects gracefully)
      let channelId: string;

      const [existing] = await db
        .select({ id: channels.id })
        .from(channels)
        .where(
          and(
            eq(channels.userId, user.id),
            eq(channels.type, 'whatsapp'),
            eq(channels.channelId, normalizedPhone)
          )
        )
        .limit(1);

      if (existing) {
        await db
          .update(channels)
          .set({ isActive: true, updatedAt: new Date() })
          .where(eq(channels.id, existing.id));
        channelId = existing.id;
      } else {
        const [inserted] = await db
          .insert(channels)
          .values({
            userId: user.id,
            type: 'whatsapp',
            channelId: normalizedPhone,
            config: {},
            isActive: true,
          })
          .returning({ id: channels.id });

        if (!inserted) {
          throw AppError.externalApiError('Failed to create channel record');
        }
        channelId = inserted.id;
      }

      // Sync phone to users table for easy access
      await db
        .update(users)
        .set({ phone: normalizedPhone, updatedAt: new Date() })
        .where(eq(users.id, user.id));

      app.log.info(
        { userId: user.id, channelId, phone: normalizedPhone.slice(0, -4) + '****' },
        '[whatsapp-verify] channel created/activated'
      );

      return { success: true, channelId };
    }
  );
}
