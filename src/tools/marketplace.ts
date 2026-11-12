import type { Plain } from '../values.ts';

/**
 * Marketplace settings are written in the tool's own format, so the format decides which tool an
 * entry belongs to: Codex has `source_type` + `source` (a string); Claude has a `source` object.
 * The same repository usually also publishes a different marketplace name per tool, so one entry
 * per tool is the honest shape rather than a translated one.
 */
export function isCodexMarketplace(config: Plain): boolean {
  return typeof config.source_type === 'string';
}
