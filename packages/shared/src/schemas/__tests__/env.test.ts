import { parseEnv } from '../env.schema';

// Test parseEnv with a mock environment object
const mockEnv = {
  NODE_ENV: 'development',
  PORT: '3000',
  HOST: '0.0.0.0',
  LOG_LEVEL: 'info',
  API_URL: 'http://localhost:3000',
  DASHBOARD_URL: 'http://localhost:3001',
  DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/kommand',
  REDIS_URL: 'redis://localhost:6379',
  ENCRYPTION_KEY: 'a'.repeat(64), // 32-byte hex string
  ANTHROPIC_API_KEY: 'sk-ant-test-key',
  WHATSAPP_VERIFY_TOKEN: 'kommand-verify-2024',
};

try {
  const config = parseEnv(mockEnv);
  console.log('✓ parseEnv test passed');
  console.log('Config:', {
    NODE_ENV: config.NODE_ENV,
    PORT: config.PORT,
    API_URL: config.API_URL,
  });
} catch (error) {
  console.error('✗ parseEnv test failed:', error);
  process.exit(1);
}
