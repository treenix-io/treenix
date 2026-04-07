// String utilities — fuzzy matching, transliteration

const CYR_TO_LAT: Record<string, string> = {
  а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'yo',ж:'zh',з:'z',и:'i',й:'y',
  к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',
  х:'kh',ц:'ts',ч:'ch',ш:'sh',щ:'shch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya',
};

/** Transliterate non-latin characters to ASCII. Cyrillic built-in, extensible via custom map. */
export function transliterate(str: string, extra?: Record<string, string>): string {
  const map = extra ? { ...CYR_TO_LAT, ...extra } : CYR_TO_LAT;
  let out = '';
  for (const ch of str) {
    const lower = ch.toLowerCase();
    const mapped = map[lower];
    if (mapped !== undefined) {
      out += ch === lower ? mapped : mapped.charAt(0).toUpperCase() + mapped.slice(1);
    } else {
      out += ch;
    }
  }
  return out;
}

export function cleanSlug(str: string) {
  return transliterate(str.trim()).toLowerCase().replace(/[^a-z0-9_\-]+/g, '-').replace(/^-|-$/g, '');
}

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
