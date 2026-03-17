import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import {
  users,
  stores,
  channels,
  scheduledJobs,
} from '../apps/api/src/db/schema.js';

const DATABASE_URL =
  process.env['DATABASE_URL'] ?? 'postgresql://postgres:postgres@localhost:5432/kommand';

async function seed() {
  const client = postgres(DATABASE_URL);
  const db = drizzle(client);

  console.log('Seeding database...\n');

  // Test user
  const [user] = await db
    .insert(users)
    .values({
      clerkId: 'clerk_test_user_001',
      email: 'test@kommand.dev',
      name: 'Test Owner',
      phone: '+971501234567',
      timezone: 'Asia/Dubai',
      plan: 'growth',
    })
    .onConflictDoNothing()
    .returning();

  if (!user) {
    console.log('User already exists, skipping seed.');
    await client.end();
    return;
  }

  console.log('User created:', user.id, user.email);

  // Test Shopify store
  const [store] = await db
    .insert(stores)
    .values({
      userId: user.id,
      platform: 'shopify',
      shopDomain: 'test-store.myshopify.com',
      shopName: 'Test Store',
      accessToken: 'dummy_encrypted_token_aes256gcm',
      tokenIv: 'dummy_iv_hex_string',
      scopes: ['read_orders', 'write_orders', 'read_products'],
      isActive: true,
    })
    .returning();

  console.log('Store created:', store!.id, store!.shopDomain);

  // Test WhatsApp channel
  const [channel] = await db
    .insert(channels)
    .values({
      userId: user.id,
      type: 'whatsapp',
      channelId: 'test-phone-id',
      config: { verified: true },
      isActive: true,
    })
    .returning();

  console.log('Channel created:', channel!.id, channel!.type, channel!.channelId);

  // Morning brief scheduled job
  const [job] = await db
    .insert(scheduledJobs)
    .values({
      userId: user.id,
      jobType: 'morning_brief',
      cronExpression: '0 8 * * *',
      config: { timezone: 'Asia/Dubai' },
      isActive: true,
    })
    .returning();

  console.log('Scheduled job created:', job!.id, job!.jobType, job!.cronExpression);

  console.log('\nSeed complete.');
  await client.end();
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
