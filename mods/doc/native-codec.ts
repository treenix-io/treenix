import { getComponent } from '@treenx/core';
import type { RawFsTextCodec } from '@treenx/core/kernel/store/rawfs-codec';
import { serializeFrontmatter, splitFrontmatter, type DocFrontmatterData } from './frontmatter';
import { mdToTiptap, tiptapToMd, type TiptapNode } from './markdown';

/** Decode charged Markdown bytes while resolving links in the mounted namespace. */
export function decodeMarkdown(raw: string, path: string, outerPath: string) {
  // Strip YAML frontmatter (---...---) before parsing markdown body so it doesn't
  // get rendered as content. Known keys (title/description/tags/section/order)
  // become a typed `doc.frontmatter` component; unknown keys go into `extra`.
  const { frontmatter, body } = splitFrontmatter(raw);
  // Resolve relative links against the OUTER tree path so navigation lands on the
  // correct mounted node (e.g. /docs/public/index.md → links into /docs/public/...).
  const content = mdToTiptap(body, outerPath);
  // Title precedence: frontmatter `title:` > first H1 > empty.
  let title = frontmatter?.title ?? '';
  const first = content.content?.[0];
  if (first?.type === 'heading' && first.attrs?.level === 1) {
    if (!title) title = first.content?.map((node) => node.text ?? '').join('') ?? '';
    // Always strip the H1 from content (whether or not it became the title).
    content.content = content.content!.slice(1);
  }
  return {
    $path: path,
    $type: 'doc.page',
    title,
    content,
    // Attach as a named-key component (composition pattern). The key name matches
    // the type for clarity at the wire level.
    ...(frontmatter === null
      ? {}
      : { 'doc.frontmatter': { $type: 'doc.frontmatter', ...frontmatter } }),
  };
}

/** Serialize the existing document contract and keep relative links rooted at its public path. */
export function encodeMarkdown(
  node: { $path: string; title?: string; content?: TiptapNode },
  outerPath: string,
  frontmatter?: DocFrontmatterData,
): string {
  const heading = node.title ? `# ${node.title}\n\n` : '';
  return `${(serializeFrontmatter(frontmatter) + heading + (node.content === undefined ? '' : tiptapToMd(node.content, outerPath))).trimEnd()}\n`;
}

export const markdownCodec: RawFsTextCodec = {
  type: 'doc.page',
  fields: ['title', 'content', '#frontmatter'],
  decode(raw, path, outerPath) {
    const { 'doc.frontmatter': frontmatter, ...document } = decodeMarkdown(raw, path, outerPath);
    return {
      ...document,
      $v: 0,
      ...(frontmatter === undefined ? {} : { '#frontmatter': { ...frontmatter, $v: 0 } }),
    };
  },
  encode(node, outerPath) {
    const document = getComponent<{ title: string; content: TiptapNode }>(node, 'doc.page');
    if (document === undefined) throw new Error('Markdown codec requires a document');
    return encodeMarkdown(
      { ...document, $path: node.$path },
      outerPath,
      getComponent<DocFrontmatterData>(node, 'doc.frontmatter'),
    );
  },
};
