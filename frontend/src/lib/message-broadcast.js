import { supabase } from './supabase.js';

export function subscribeToMessageBroadcast(workspaceId, handler) {
  if (!workspaceId) return () => {};

  const channel = supabase
    .channel(`workspace:${workspaceId}:messages`)
    .on('broadcast', { event: 'message:new' }, handler)
    .subscribe();

  return () => {
    supabase.removeChannel(channel);
  };
}
