// Approximate Anthropic API list pricing, USD per million tokens.
// These are best-effort defaults for cost estimation only — verify actual
// spend against the Anthropic Console. Matched by substring against the
// model id recorded in each transcript line (e.g. "claude-sonnet-4-5-20250929").
const PRICING_TABLE = [
  { pattern: /opus/i, input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  { pattern: /sonnet/i, input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  { pattern: /haiku/i, input: 0.8, output: 4, cacheWrite: 1, cacheRead: 0.08 },
];

// Fallback when the model id doesn't match a known family.
const DEFAULT_PRICING = { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 };

export function getPricing(model) {
  if (model) {
    for (const p of PRICING_TABLE) {
      if (p.pattern.test(model)) return p;
    }
  }
  return DEFAULT_PRICING;
}

export function estimateCost(usage, model) {
  const p = getPricing(model);
  return (
    ((usage.inputTokens || 0) / 1e6) * p.input +
    ((usage.outputTokens || 0) / 1e6) * p.output +
    ((usage.cacheCreationTokens || 0) / 1e6) * p.cacheWrite +
    ((usage.cacheReadTokens || 0) / 1e6) * p.cacheRead
  );
}
