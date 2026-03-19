// @/path mention parser for Metatron chat
// Detects @/path/to/node in text, returns positions for chip rendering and context resolution

export type Mention = {
  path: string;
  start: number;
  end: number;
};

const MENTION_RE = /@(\/[\w\-./]+)/g;

export function parseMentions(text: string): Mention[] {
  const mentions: Mention[] = [];
  let m: RegExpExecArray | null;

  while ((m = MENTION_RE.exec(text)) !== null) {
    mentions.push({
      path: m[1],
      start: m.index,
      end: m.index + m[0].length,
    });
  }

  return mentions;
}

/** Extract unique paths from mentions */
export function uniqueMentionPaths(text: string): string[] {
  const mentions = parseMentions(text);
  return [...new Set(mentions.map(m => m.path))];
}
