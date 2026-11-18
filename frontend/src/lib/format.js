/** Display formatting helpers. */

/** "just now", "4m", "3h", "Tue", "12 Mar" - tuned for the inbox list. */
export function relativeTime(value) {
  if (!value) return '';
  const date = new Date(value);
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);

  if (seconds < 45) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  if (seconds < 604800) return `${Math.round(seconds / 86400)}d`;

  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

export function clockTime(value) {
  if (!value) return '';
  return new Date(value).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export function fullDate(value) {
  if (!value) return '';
  return new Date(value).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Day heading inside the message thread. */
export function dayLabel(value) {
  if (!value) return '';
  const date = new Date(value);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);

  const sameDay = (a, b) => a.toDateString() === b.toDateString();
  if (sameDay(date, today)) return 'Today';
  if (sameDay(date, yesterday)) return 'Yesterday';
  return date.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' });
}

/** 3725 -> "1h 2m". Used for response-time metrics. */
export function duration(seconds) {
  if (seconds === null || seconds === undefined) return '-';
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return '0s';
  if (value < 60) return `${Math.round(value)}s`;
  if (value < 3600) return `${Math.floor(value / 60)}m ${value % 60}s`;
  const hours = Math.floor(value / 3600);
  const minutes = Math.round((value % 3600) / 60);
  return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
}

export function number(value) {
  if (value === null || value === undefined) return '0';
  return new Intl.NumberFormat().format(Number(value));
}

export function percent(value, places = 0) {
  if (value === null || value === undefined) return '-';
  return `${Number(value).toFixed(places)}%`;
}

/** Turns HANDOVER_REASON into a sentence an agent can act on. */
export const HANDOVER_LABELS = {
  low_confidence: 'The assistant was not confident enough to answer',
  llm_declined: 'The assistant decided a human was needed',
  customer_requested_human: 'The customer asked for a person',
  negative_sentiment: 'The customer sounded upset',
  quota_exhausted: 'The AI reply allowance ran out',
  manual: 'An agent took over',
};

export const handoverLabel = (reason) => HANDOVER_LABELS[reason] ?? reason ?? 'Handed to a human';

export const CHANNEL_LABELS = {
  website: 'Website',
  messenger: 'Messenger',
  instagram: 'Instagram',
  whatsapp: 'WhatsApp',
};

export const INTENT_LABELS = {
  refund: 'Refund',
  delivery: 'Delivery',
  cancellation: 'Cancellation',
  complaint: 'Complaint',
  pricing: 'Pricing',
  hours: 'Opening hours',
  product: 'Product',
  support: 'Support',
  account: 'Account',
  other: 'General',
};

/** Shortens text for a one-line preview. */
export function truncate(text, max = 90) {
  if (!text) return '';
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}
