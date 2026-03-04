// Minimal markdown → HTML for chat bubbles (~50 lines)
// Covers: headers, bold, italic, inline code, code blocks, links, lists, blockquotes, hr
import './minimd.css';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function inline(s: string): string {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/__(.+?)__/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/_(.+?)_/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

export function minimd(src: string): string {
  const lines = src.split('\n');
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim();
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        code.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      out.push(`<pre${lang ? ` data-lang="${esc(lang)}"` : ''}><code>${esc(code.join('\n'))}</code></pre>`);
      continue;
    }

    // Header
    const hm = line.match(/^(#{1,4})\s+(.+)/);
    if (hm) { out.push(`<h${hm[1].length}>${inline(hm[2])}</h${hm[1].length}>`); i++; continue; }

    // HR
    if (/^[-*_]{3,}\s*$/.test(line)) { out.push('<hr>'); i++; continue; }

    // Blockquote
    if (line.startsWith('> ')) { out.push(`<blockquote>${inline(line.slice(2))}</blockquote>`); i++; continue; }

    // Unordered list
    if (/^[-*+]\s/.test(line)) {
      out.push('<ul>');
      while (i < lines.length && /^[-*+]\s/.test(lines[i])) {
        out.push(`<li>${inline(lines[i].replace(/^[-*+]\s/, ''))}</li>`);
        i++;
      }
      out.push('</ul>');
      continue;
    }

    // Ordered list
    if (/^\d+\.\s/.test(line)) {
      out.push('<ol>');
      while (i < lines.length && /^\d+\.\s/.test(lines[i])) {
        out.push(`<li>${inline(lines[i].replace(/^\d+\.\s/, ''))}</li>`);
        i++;
      }
      out.push('</ol>');
      continue;
    }

    // Table
    if (line.startsWith('|') && i + 1 < lines.length && /^\|[-\s:|]+\|/.test(lines[i + 1])) {
      const parseRow = (r: string) => r.split('|').slice(1, -1).map(c => c.trim());
      const headers = parseRow(line);
      i += 2; // skip header + separator
      out.push('<table><thead><tr>' + headers.map(h => `<th>${inline(h)}</th>`).join('') + '</tr></thead><tbody>');
      while (i < lines.length && lines[i].startsWith('|')) {
        const cells = parseRow(lines[i]);
        out.push('<tr>' + cells.map(c => `<td>${inline(c)}</td>`).join('') + '</tr>');
        i++;
      }
      out.push('</tbody></table>');
      continue;
    }

    // Empty line
    if (!line.trim()) { i++; continue; }

    // Paragraph
    out.push(`<p>${inline(line)}</p>`);
    i++;
  }

  return out.join('\n');
}
