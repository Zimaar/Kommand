import type { ChannelAdapter } from './adapter.interface.js';
import { WhatsAppAdapter } from './adapters/whatsapp/adapter.js';
import { MockAdapter } from './adapters/mock.adapter.js';

// Adapters are singletons — all request handling shares these instances.
// Adapters MUST remain stateless (no per-request mutable fields) for this to be safe.
// Exception: WhatsAppAdapter holds a lazily-initialised WhatsAppSender, which is itself stateless.
const registry: Record<string, ChannelAdapter> = {
  whatsapp: new WhatsAppAdapter(),
  slack:    new MockAdapter(),
  email:    new MockAdapter(),
  telegram: new MockAdapter(),
};

export function getAdapter(channelType: string): ChannelAdapter {
  return registry[channelType] ?? new MockAdapter();
}
