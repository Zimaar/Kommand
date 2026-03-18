import type { OutboundMessage } from '@kommand/shared';
import { AppError, ErrorCode } from '../utils/errors.js';

export interface PipelineErrorContext {
  platform?: string;
  action?: string;
}

export function handlePipelineError(
  error: unknown,
  userId: string,
  channelType: string,
  context: PipelineErrorContext = {}
): OutboundMessage {
  // Always log the full error
  console.error('[Pipeline Error]', { userId, channelType, context, error });

  const text = categorizeError(error, context);

  return {
    userId,
    channelType: channelType as OutboundMessage['channelType'],
    text,
  };
}

function categorizeError(error: unknown, context: PipelineErrorContext): string {
  if (error instanceof AppError) {
    switch (error.code) {
      case ErrorCode.RATE_LIMIT_EXCEEDED:
        return "You've sent a lot of messages. Give me a moment and try again in a few minutes.";

      case ErrorCode.EXTERNAL_API_ERROR: {
        const platform = context.platform ?? 'the service';
        return `I'm having trouble connecting to ${platform}. This is usually temporary — try again in a minute.`;
      }

      case ErrorCode.TOOL_EXECUTION_ERROR: {
        const action = context.action ?? 'complete that action';
        const friendly = sanitizeErrorMessage(error.message);
        return `I tried to ${action} but something went wrong. Here's what I know: ${friendly}. Want me to try again?`;
      }

      case ErrorCode.UNAUTHORIZED:
        return "I don't have permission to do that. Check that your integrations are properly connected.";

      case ErrorCode.NOT_FOUND:
        return "I couldn't find what you were looking for. Can you double-check the details?";

      case ErrorCode.VALIDATION_ERROR:
        return `There's a problem with the request: ${sanitizeErrorMessage(error.message)}`;

      default:
        return "Something unexpected happened on my end. I've logged the issue. Can you try that again?";
    }
  }

  // Claude API down
  if (isAnthropicError(error)) {
    return "I'm having a brain freeze. For urgent tasks, check your Shopify admin directly. I'll be back shortly.";
  }

  // DB down
  if (isDatabaseError(error)) {
    return "I can't access my memory right now. Please try again in a moment.";
  }

  // Redis down — this is caught upstream; this fallback is for anything that slips through
  if (isRedisError(error)) {
    return "I'm running in reduced mode right now. Things may be slower than usual.";
  }

  return "Something unexpected happened on my end. I've logged the issue. Can you try that again?";
}

function sanitizeErrorMessage(msg: string): string {
  // Strip anything that looks like a raw API key, URL, or stack trace fragment
  return msg
    .replace(/https?:\/\/\S+/g, '[url]')
    // Anthropic keys: sk-ant-... or sk-...
    .replace(/sk-[a-zA-Z0-9_-]+/g, '[key]')
    // Shopify token formats: shpat_, shpca_, shppa_, shpss_, shptk_, shpua_
    .replace(/shp[a-z]{2}_[a-zA-Z0-9]+/g, '[token]')
    // Strip stack trace lines (  at Foo.bar (/path/file.ts:10:5) or  at async fn (...))
    .replace(/\s+at\s+[^\n(]+\([^)]*\)/g, '')
    .slice(0, 200);
}

function isAnthropicError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.constructor.name === 'APIError' ||
    error.message.toLowerCase().includes('anthropic') ||
    error.message.toLowerCase().includes('overloaded')
  );
}

function isDatabaseError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();
  return (
    msg.includes('connection refused') ||
    msg.includes('econnrefused') ||
    msg.includes('no pg_hba.conf entry') ||
    msg.includes('database') && msg.includes('connect')
  );
}

function isRedisError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();
  return msg.includes('redis') || msg.includes('econnrefused') && msg.includes('6379');
}
