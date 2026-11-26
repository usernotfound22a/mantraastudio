import { getAdminClient } from '../db/supabase.js';
import { childLogger } from '../config/logger.js';

const log = childLogger('message-broadcast');

export async function broadcastInboundMessage(workspaceId, message) {
  if (!workspaceId || !message) return;

  try {
    const client = getAdminClient();
    const channel = client.channel(`workspace:${workspaceId}:messages`);
    await channel.httpSend('message:new', { message });
    await client.removeChannel(channel);
  } catch (error) {
    log.warn({ err: error.message }, 'Inbound message broadcast failed');
  }
}
