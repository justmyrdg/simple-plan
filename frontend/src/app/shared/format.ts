/** Date/time helpers. Backend datetimes are local time without a timezone suffix. */

export function toDate(v: string | Date): Date {
  return v instanceof Date ? v : new Date(v);
}

export function fmtTime(v: string | Date): string {
  return toDate(v).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function fmtDay(v: string | Date, now = new Date()): string {
  const d = toDate(v);
  const days = dayDiff(d, now);
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days === -1) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

export function fmtDateTime(v: string | Date): string {
  return `${fmtDay(v)} · ${fmtTime(v)}`;
}

/** "in 2h 15m", "in 3 days", "now" */
export function fmtUntil(v: string | Date, now = new Date()): string {
  const mins = Math.round((toDate(v).getTime() - now.getTime()) / 60000);
  if (mins <= 0) return 'now';
  if (mins < 60) return `in ${mins} min`;
  if (mins < 24 * 60) {
    const h = Math.floor(mins / 60), m = mins % 60;
    return m ? `in ${h}h ${m}m` : `in ${h}h`;
  }
  const d = Math.round(mins / (24 * 60));
  return `in ${d} day${d > 1 ? 's' : ''}`;
}

/** "just now", "5 min ago", "3h ago", "2 days ago" */
export function fmtAgo(v: string | Date | null, now = new Date()): string {
  if (!v) return 'never';
  const mins = Math.round((now.getTime() - toDate(v).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  if (mins < 24 * 60) return `${Math.floor(mins / 60)}h ago`;
  const d = Math.floor(mins / (24 * 60));
  return `${d} day${d > 1 ? 's' : ''} ago`;
}

function dayDiff(d: Date, now: Date) {
  const a = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const b = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return Math.round((a - b) / 86400000);
}
