// Fuzzy string matching utilities for type search

export function editDistance(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  const dp = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[n];
}

export function matchTokens(text: string, sTokens: string[]): number {
  const vTokens = text.split(/[.\s\-_]+/).filter(Boolean);
  let total = 0;
  for (const st of sTokens) {
    let best = 0;
    for (const vt of vTokens) {
      if (vt.startsWith(st)) { best = Math.max(best, 0.9); continue; }
      if (vt.includes(st)) { best = Math.max(best, 0.7); continue; }
      if (st.length >= 2) {
        const maxDist = st.length <= 3 ? 1 : Math.floor(st.length / 3);
        if (editDistance(st, vt) <= maxDist) { best = Math.max(best, 0.5); continue; }
        if (vt.length > st.length && editDistance(st, vt.slice(0, st.length + 1)) <= maxDist) {
          best = Math.max(best, 0.4);
        }
      }
    }
    total += best;
  }
  return sTokens.length > 0 ? total / sTokens.length : 0;
}

export function typeFilter(value: string, search: string, keywords?: string[]): number {
  const s = search.toLowerCase().trim();
  if (!s) return 1;
  const v = value.toLowerCase();

  // Exact substring in type name — top priority
  if (v.includes(s)) return 1;

  const sTokens = s.split(/\s+/).filter(Boolean);

  // Match against type name (high weight)
  const typeScore = matchTokens(v, sTokens);
  if (typeScore >= 0.3) return 0.5 + typeScore * 0.5;

  // Match against keywords (label + description, lower weight)
  if (keywords?.length) {
    const kwText = keywords.join(' ').toLowerCase();
    if (kwText.includes(s)) return 0.5;
    const kwScore = matchTokens(kwText, sTokens);
    if (kwScore >= 0.3) return kwScore * 0.4;
  }

  return 0;
}
