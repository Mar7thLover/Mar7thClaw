// 极简且安全的 Markdown 渲染：先整体转义 HTML，再处理代码块、行内格式、列表、标题、链接。
(function () {
  const escape = s => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  function inline(text) {
    const codes = [];
    let out = text.replace(/`([^`\n]+)`/g, (_, code) => { codes.push(code); return `\u0000${codes.length - 1}\u0000`; });
    out = out
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
      .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noreferrer">$2</a>');
    return out.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[Number(i)]}</code>`);
  }

  window.renderMarkdown = function (source) {
    const lines = escape(String(source || '')).split('\n');
    const html = [];
    let list = null;
    let para = [];
    const flushPara = () => { if (para.length) { html.push(`<p>${inline(para.join('<br>'))}</p>`); para = []; } };
    const flushList = () => { if (list) { html.push(`</${list}>`); list = null; } };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const fence = /^\s*(```|~~~)(.*)$/.exec(line);
      if (fence) {
        flushPara(); flushList();
        const body = [];
        i++;
        while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++]);
        html.push(`<pre class="code"><div class="code-lang">${fence[2].trim()}</div><code>${body.join('\n')}</code></pre>`);
        continue;
      }
      const heading = /^(#{1,4})\s+(.*)$/.exec(line);
      if (heading) { flushPara(); flushList(); html.push(`<h${heading[1].length + 2}>${inline(heading[2])}</h${heading[1].length + 2}>`); continue; }
      const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
      const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
      if (bullet || ordered) {
        flushPara();
        const type = bullet ? 'ul' : 'ol';
        if (list !== type) { flushList(); html.push(`<${type}>`); list = type; }
        html.push(`<li>${inline((bullet || ordered)[1])}</li>`);
        continue;
      }
      if (/^&gt;\s?/.test(line)) { flushPara(); flushList(); html.push(`<blockquote>${inline(line.replace(/^&gt;\s?/, ''))}</blockquote>`); continue; }
      if (/^-#\s/.test(line)) { flushPara(); flushList(); html.push(`<small class="subtext">${inline(line.slice(3))}</small>`); continue; }
      if (!line.trim()) { flushPara(); flushList(); continue; }
      flushList();
      para.push(line);
    }
    flushPara(); flushList();
    return html.join('');
  };
})();
