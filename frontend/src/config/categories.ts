// ─── Central categories config ────────────────────────────────────────────────
// Keys map to i18n: t("categories.{key}")
// Badge classes used consistently across boards and cards.
// Category is stored as "{key}|" prefix in the on-chain description field,
// stripped before display, extracted for client-side filtering.

export const CATEGORIES = [
  { key: 'design',      badge: 'bg-purple-400/10 text-purple-400 border-purple-400/20' },
  { key: 'development', badge: 'bg-blue-400/10 text-blue-400 border-blue-400/20' },
  { key: 'marketing',   badge: 'bg-green-400/10 text-green-400 border-green-400/20' },
  { key: 'writing',     badge: 'bg-orange-400/10 text-orange-400 border-orange-400/20' },
  { key: 'video',       badge: 'bg-red-400/10 text-red-400 border-red-400/20' },
  { key: 'translation', badge: 'bg-cyan-400/10 text-cyan-400 border-cyan-400/20' },
  { key: 'business',    badge: 'bg-yellow-400/10 text-yellow-400 border-yellow-400/20' },
  { key: 'audio',       badge: 'bg-pink-400/10 text-pink-400 border-pink-400/20' },
  { key: 'data',        badge: 'bg-teal-400/10 text-teal-400 border-teal-400/20' },
  { key: 'legal',       badge: 'bg-indigo-400/10 text-indigo-400 border-indigo-400/20' },
  { key: 'education',   badge: 'bg-lime-400/10 text-lime-400 border-lime-400/20' },
  { key: 'other',       badge: 'bg-gray-400/10 text-gray-400 border-gray-400/20' },
] as const;

export type CategoryKey = typeof CATEGORIES[number]['key'];

export const DEFAULT_CATEGORY: CategoryKey = 'other';

export const CATEGORY_BADGE: Record<CategoryKey, string> = Object.fromEntries(
  CATEGORIES.map(c => [c.key, c.badge])
) as Record<CategoryKey, string>;

/** Extract category key from a stored description ("design|My service text" → "design") */
export function extractCategory(description: string): CategoryKey | null {
  const sep = description.indexOf('|');
  if (sep <= 0 || sep > 20) return null;
  const key = description.slice(0, sep) as CategoryKey;
  return CATEGORIES.some(c => c.key === key) ? key : null;
}

/** Strip category prefix from description for display */
export function stripCategory(description: string): string {
  const sep = description.indexOf('|');
  if (sep <= 0 || sep > 20) return description;
  const key = description.slice(0, sep);
  if (!CATEGORIES.some(c => c.key === key)) return description;
  return description.slice(sep + 1);
}

/** Prepend category key to description for storage */
export function withCategory(key: CategoryKey, description: string): string {
  return `${key}|${description}`;
}
