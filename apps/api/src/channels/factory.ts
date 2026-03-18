import type { ChannelAdapter } from './adapter.interface.js';
import { WhatsAppAdapter } from './adapters/whatsapp/adapter.js';
import { MockAdapter } from './adapters/mock.adapter.js';

const registry: Record<string, ChannelAdapter> = {
  whatsapp: new WhatsAppAdapter(),
  slack:    new MockAdapter(),
  email:    new MockAdapter(),
  telegram: new MockAdapter(),
};

export function getAdapter(channelType: string): ChannelAdapter {
  return registry[channelType] ?? new MockAdapter();
}
