import { config as dotenvConfig } from 'dotenv';
import { parseEnv } from '@kommand/shared';

dotenvConfig({ override: true });

export const config = parseEnv();

export const MAX_MESSAGE_LENGTH = 4000;
export const CONVERSATION_HISTORY_LIMIT = 10;
export const CONFIRMATION_TIMEOUT_MS = 600_000; // 10 min
