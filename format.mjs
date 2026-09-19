#!/usr/bin/env node
/**
 * Разметка для Telegram: Markdown → HTML и нарезка на сообщения ≤ 4096.
 * Отдельный модуль, чтобы его можно было юнит-тестировать без запуска бота.
 */

// ---------------------------------------------------------------------------
// Markdown → Telegram HTML
// ---------------------------------------------------------------------------

export const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Инлайновая разметка. На вход — уже экранированный текст. */
export function inline(raw) {
  const stash = [];
  let s = String(raw).replace(/`([^`\n]+)`/g, (_m, code) => {
    stash.push(`<code>${code}</code>`);
    return `\u0000${stash.length - 1}\u0000`;
  });

  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
  s = s.replace(/\*\*\*([^*\n]+)\*\*\*/g, '<b><i>$1</i></b>');
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  s = s.replace(/(^|[^\w_])__([^_\n]+)__(?!_)/g, '$1<b>$2</b>');
  s = s.replace(/~~([^~\n]+)~~/g, '<s>$1</s>');
  // содержимое курсива не должно начинаться/заканчиваться пробелом —
  // иначе «2 * 3 * 4» превращалось бы в курсив
  s = s.replace(/(^|[^*\w])\*(\S(?:[^*\n]*\S)?)\*(?!\*)/g, '$1<i>$2</i>');
  s = s.replace(/(^|[^_\w])_(\S(?:[^_\n]*\S)?)_(?!_)/g, '$1<i>$2</i>');

  // «голые» ссылки, которых нет внутри уже сделанного <a href="...">
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<>)\u0000]+)/g, (m, pre, url) => `${pre}<a href="${url}">${url}</a>`);

  return s.replace(/\u0000(\d+)\u0000/g, (_m, i) => stash[Number(i)]);
}

export const inlineMd = (text) => inline(escapeHtml(text));

/** Markdown → HTML, понятный Telegram (без MarkdownV2-экранирования). */
export function renderMarkdown(md) {
  const src = String(md ?? '').replace(/\r\n?/g, '\n').replace(/\u0000/g, '').trim();
  if (!src) return '';
  const out = [];
  const lines = src.split('\n');
  let preOpen = false;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    const fence = line.match(/^\s*(```+|~~~+)\s*([\w.+#-]*)\s*$/);
    if (fence) {
      if (!preOpen) {
        const lang = fence[2] ? ` class="language-${escapeHtml(fence[2].toLowerCase())}"` : '';
        out.push(`<pre><code${lang}>`);
        preOpen = true;
      } else {
        out.push('</code></pre>');
        preOpen = false;
      }
      i++;
      continue;
    }
    if (preOpen) {
      out.push(escapeHtml(line));
      i++;
      continue;
    }

    // таблица → выровненный <pre>
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(lines[i++]);
      const body = rows
        .filter((r) => !/^\s*\|?[\s:|-]+\|?\s*$/.test(r))
        .map((r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
      if (body.length) {
        const cols = Math.max(...body.map((r) => r.length));
        const widths = [];
        for (let c = 0; c < cols; c++) widths[c] = Math.max(...body.map((r) => (r[c] ?? '').length));
        const pad = (v, n) => (v ?? '').padEnd(n);
        out.push(`<pre>${escapeHtml(body.map((r) => r.map((c, k) => pad(c, widths[k])).join(' | ').replace(/\s+$/, '')).join('\n'))}</pre>`);
      }
      continue;
    }

    // цитата
    if (/^\s*>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote>${buf.map(inlineMd).join('\n')}</blockquote>`);
      continue;
    }

    // заголовок
    const h = line.match(/^\s{0,3}(#{1,6})\s+(.*)$/);
    if (h) {
      out.push(`<b>${inlineMd(h[2].replace(/\s*#+\s*$/, ''))}</b>`);
      i++;
      continue;
    }

    // горизонтальная линия
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
      out.push('———');
      i++;
      continue;
    }

    // пункт списка
    const li = line.match(/^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/);
    if (li) {
      const marker = /^\d/.test(li[2]) ? li[2].replace(/[.)]$/, ')') : '•';
      out.push(`${li[1]}${marker} ${inlineMd(li[3])}`);
      i++;
      continue;
    }

    out.push(inlineMd(line));
    i++;
  }
  if (preOpen) out.push('</code></pre>');
  return out.join('\n').replace(/\n{4,}/g, '\n\n\n').trim();
}

const TAG_RE = /<(\/?)([a-zA-Z][\w-]*)([^>]*?)>/g;

export function scanTags(line, stack) {
  TAG_RE.lastIndex = 0;
  let m;
  while ((m = TAG_RE.exec(line))) {
    const name = m[2].toLowerCase();
    if (m[1] === '/') {
      for (let k = stack.length - 1; k >= 0; k--) {
        if (stack[k].name === name) {
          stack.splice(k, 1);
          break;
        }
      }
    } else if (!m[3].trim().endsWith('/')) {
      stack.push({ name, open: m[0] });
    }
  }
}

/** Режет HTML на куски ≤ limit, закрывая и переоткрывая <pre>/<blockquote>. */
export function splitHtml(html, limit = 3800) {
  if (html.length <= limit) return [html];
  const closeAll = (stack) => [...stack].reverse().map((t) => `</${t.name}>`).join('');
  const openAll = (stack) => stack.map((t) => t.open).join('');

  const chunks = [];
  const stack = [];
  let cur = [];
  let size = 0;

  for (const line of html.split('\n')) {
    if (line.length > limit - 400) {                       // одна мега-строка (код в одну строку)
      if (cur.length) {
        chunks.push(cur.join('\n') + closeAll(stack));
        cur = [];
        size = 0;
      }
      const head = openAll(stack);
      const tail = closeAll(stack);
      const room = Math.max(500, limit - head.length - tail.length - 5);
      for (let off = 0; off < line.length; off += room) {
        chunks.push(head + line.slice(off, off + room) + tail);
      }
      continue;
    }
    if (cur.length && size + line.length + 1 > limit) {
      chunks.push(cur.join('\n') + closeAll(stack));
      const reopen = openAll(stack);
      cur = [reopen];
      size = reopen.length + 1;
    }
    cur.push(line);
    size += line.length + 1;
    scanTags(line, stack);
  }
  if (cur.length) chunks.push(cur.join('\n'));
  return chunks.filter((c) => c.trim());
}

export const stripHtml = (s) => String(s).replace(/<[^>]+>/g, '');

/** Достаёт <think>…</think> (режим GIGACODE_SHOW_REASONING=tags) из ответа. */
export function splitThink(text) {
  let reasoning = '';
  const content = String(text).replace(/<think(?:ing)?>([\s\S]*?)(?:<\/think(?:ing)?>|$)/gi, (_m, inner) => {
    reasoning += inner;
    return '';
  });
  return { content, reasoning };
}
