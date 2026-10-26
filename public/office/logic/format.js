// Number and time formatting for the office HUD (French conventions).

/**
 * 1234 → "1,2 k", 3 400 000 → "3,4 M".
 * @param {number} count
 */
export function formatTokens(count) {
  if (!Number.isFinite(count) || count < 0) return '–';
  if (count < 1000) return String(Math.round(count));
  const [value, unit] = count < 1e6 ? [count / 1e3, 'k'] : count < 1e9 ? [count / 1e6, 'M'] : [count / 1e9, 'G'];
  return `${value.toLocaleString('fr-FR', { maximumFractionDigits: value < 10 ? 1 : 0 })} ${unit}`;
}

/**
 * Elapsed time between two instants: "à l’instant", "12 min", "2 h 05".
 * @param {number} from
 * @param {number} now
 */
export function formatSince(from, now) {
  const minutes = Math.max(0, Math.round((now - from) / 60_000));
  if (minutes < 1) return 'à l’instant';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ${String(minutes % 60).padStart(2, '0')}`;
  return `${Math.floor(hours / 24)} j`;
}

/**
 * Last path segment of a working directory, for compact display.
 * @param {string | null} cwd
 */
export function folderName(cwd) {
  if (!cwd) return null;
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? cwd;
}
