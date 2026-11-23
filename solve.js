const own = Object.hasOwn;
const order = (a, b) => a < b ? -1 : Number(a > b);
const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const entity = ch => entities[ch];
const special = /[&<>"']/;
function escape(text) {
  return special.test(text) ? text.replace(/[&<>"']/g, entity) : text;
}

function slugger() {
  const cache = new Map();
  return text => {
    let slug = cache.get(text);
    if (slug !== undefined) return slug;
    const ascii = /[^\x00-\x7f]/.test(text)
      ? text.normalize('NFKD').replace(/\p{M}/gu, '') : text;
    slug = ascii.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-/, '')
      .slice(0, 64).replace(/-$/, '').toLowerCase() || 'untitled';
    cache.set(text, slug);
    return slug;
  };
}

function allocate(slug, used) {
  let result = slug;
  let suffix = used.get(slug);
  if (suffix !== undefined) {
    do {
      result = slug + '-' + suffix++;
    } while (used.has(result));
    used.set(slug, suffix);
  }
  used.set(result, 2);
  return result;
}

const fields = new Set(['title', 'summary', 'date', 'tags', 'draft', 'layout', 'slug']);
const months = 'January February March April May June July August September October November December'.split(' ');
const monthDays = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function fieldValue(key, value) {
  switch (key) {
    case 'title':
    case 'summary': {
      if (value[0] === '[') throw 'a bare string opens on [';
      if (value[0] !== '"') return value;
      if (value.length < 2 || !value.endsWith('"')) throw 'a quoted string is not closed';
      const inside = value.slice(1, -1);
      const tokens = /\\["\\]|["\\]/g;
      for (const token of inside.matchAll(tokens)) {
        if (token[0] === '"') throw 'a quoted string holds a stray quote';
        if (token[0] === '\\') throw 'a quoted string holds an escape other than \\" or \\\\';
      }
      return inside.replace(/\\(["\\])/g, '$1');
    }
    case 'date': {
      const year = +value.slice(0, 4);
      const month = +value.slice(5, 7);
      const day = +value.slice(8, 10);
      const leap = month === 2 && year % 4 === 0 && year !== 1900 && year !== 2100;
      if (/^\d{4}-\d\d-\d\d$/.test(value) && year >= 1970 && year <= 2099 &&
          day >= 1 && day <= monthDays[month - 1] + Number(leap)) return value;
      throw 'not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)';
    }
    case 'tags': {
      if (value[0] !== '[' || !value.endsWith(']')) throw 'not a list [a, b]';
      const inner = value.slice(1, -1);
      if (!inner.trim()) return [];
      const names = inner.split(',').map(name => name.trim());
      if (names.some(name => !name || /["[\]]/.test(name))) throw 'an empty tag, or one holding " [ or ]';
      return names;
    }
    case 'draft':
      if (value === 'true' || value === 'false') return value === 'true';
      throw 'true or false';
    case 'layout':
      if (/^[a-z0-9-]+$/.test(value)) return value;
      throw 'not a template name';
    case 'slug':
      if (value.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) return value;
      throw 'not a slug';
  }
}

function readHeader(text) {
  if (text === '---') return 'the front matter is not closed';
  if (!text.startsWith('---\n')) return 'no front matter';
  const delimiter = /(?:^|\n)---(?=\n|$)/g;
  delimiter.lastIndex = 3;
  const close = delimiter.exec(text);
  if (!close) return 'the front matter is not closed';
  const metadata = {};
  const lines = text.slice(4, Math.max(4, close.index)).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line[0] === '#' || /^[ \t]*$/.test(line)) continue;
    const entry = /^([a-z_]+):(?: (.*))?$/.exec(line);
    if (!entry) return `line ${i + 2} is not "key: value"`;
    const key = entry[1];
    if (!fields.has(key)) return `unknown key "${key}"`;
    if (own(metadata, key)) return `key "${key}" is given twice`;
    const value = entry[2]?.replace(/[ \t]+$/, '');
    if (!value) return `key "${key}" has no value`;
    try {
      metadata[key] = fieldValue(key, value);
    } catch (reason) {
      return `key "${key}": ${reason}`;
    }
  }
  if (!own(metadata, 'title')) return 'no title';
  return { metadata, body: text.slice(close.index + close[0].length + 1) };
}

const slashEscapes = '\\`*_[]()#+-.!>';
function closingMark(text, start, mark) {
  for (let i = start; i < text.length; i++) {
    if (text[i] === '\\' && i + 1 < text.length && slashEscapes.includes(text[i + 1])) {
      i++;
    } else if (text[i] === mark[0]) {
      if (mark === '*' && text[i + 1] === '*') i++;
      else if (mark.length === 1 || text[i + 1] === '*') return i;
    }
  }
  return -1;
}

function inline(text, href) {
  const markers = /[\\`*\[]/g;
  let output = '';
  let cursor = 0;
  for (let match; (match = markers.exec(text));) {
    const at = match.index;
    if (at > cursor) output += escape(text.slice(cursor, at));
    const ch = match[0];
    let end = at + 1;
    let html = ch;
    if (ch === '\\') {
      if (end < text.length && slashEscapes.includes(text[end])) html = escape(text[end++]);
    } else if (ch === '`') {
      const close = text.indexOf('`', end);
      if (close > end) {
        html = '<code>' + escape(text.slice(end, close)) + '</code>';
        end = close + 1;
      }
    } else if (ch === '*') {
      const strong = text[end] === '*';
      if (strong) {
        html = '**';
        end++;
      }
      const close = closingMark(text, end, html);
      if (close > end) {
        const tag = strong ? 'strong' : 'em';
        html = `<${tag}>${inline(text.slice(end, close), href)}</${tag}>`;
        end = close + (strong ? 2 : 1);
      }
    } else {
      const bracket = closingMark(text, end, ']');
      if (bracket >= 0 && text[bracket + 1] === '(') {
        const start = bracket + 2;
        const close = text.indexOf(')', start);
        if (close > start) {
          const target = text.slice(start, close);
          if (!/\s/.test(target)) {
            html = `<a href="${escape(href(target))}">${inline(text.slice(end, bracket), href)}</a>`;
            end = close + 1;
          }
        }
      }
    }
    output += html;
    markers.lastIndex = cursor = end;
  }
  return output + escape(cursor ? text.slice(cursor) : text);
}

const blank = /^[ \t]*$/;
const fence = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const endFence = /^```[ \t]*$/;
const heading = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const rule = /^(?:---|\*\*\*)[ \t]*$/;
const bullets = /^[-*] (.*)$/;
const numbers = /^(\d{1,9})\. (.*)$/;
const continuation = /^ {2,}\S/;
function trim(line) {
  let start = 0;
  let end = line.length;
  while (line[start] === ' ' || line[start] === '\t') start++;
  while (end > start && (line[end - 1] === ' ' || line[end - 1] === '\t')) end--;
  return start === 0 && end === line.length ? line : line.slice(start, end);
}

function markdown(body, href, slug) {
  const lines = body.split('\n');
  const headings = new Map();
  const toc = [];
  let html = '';
  let excerpt;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i++];
    const first = line[0];
    if ((!first || first === ' ' || first === '\t') && blank.test(line)) continue;
    const code = first === '`' && fence.exec(line);
    if (code) {
      html += code[1] ? `<pre><code class="language-${code[1]}">` : '<pre><code>';
      while (i < lines.length && !endFence.test(lines[i])) html += escape(lines[i++]) + '\n';
      i++;
      html += '</code></pre>\n';
      continue;
    }
    const head = first === '#' && heading.exec(line);
    if (head && head[2]) {
      const level = head[1].length;
      const id = allocate(slug(head[2]), headings);
      const title = inline(head[2], href);
      if (level === 2 || level === 3) toc.push({ level, id, html: title });
      html += `<h${level} id="${id}">${title}</h${level}>\n`;
      continue;
    }
    if ((first === '-' || first === '*') && rule.test(line)) {
      html += '<hr>\n';
      continue;
    }
    if (first === '>') {
      let quote = trim(line.slice(1));
      while (i < lines.length && lines[i][0] === '>') {
        const part = trim(lines[i++].slice(1));
        if (part) quote += (quote ? '\n' : '') + part;
      }
      html += '<blockquote>\n' + (quote ? `<p>${inline(quote, href)}</p>\n` : '') + '</blockquote>\n';
      continue;
    }
    const ordered = first >= '0' && first <= '9';
    const marker = ordered ? numbers : bullets;
    let item = (ordered || first === '-' || first === '*') && marker.exec(line);
    if (item) {
      const start = ordered ? +item[1] : 1;
      const tag = ordered ? 'ol' : 'ul';
      html += ordered && start !== 1 ? `<ol start="${start}">\n` : `<${tag}>\n`;
      do {
        let value = trim(item[ordered ? 2 : 1]);
        while (i < lines.length && continuation.test(lines[i])) value += '\n' + trim(lines[i++]);
        html += `<li>${inline(value, href)}</li>\n`;
        item = i < lines.length && marker.exec(lines[i]);
        if (item) i++;
      } while (item);
      html += `</${tag}>\n`;
      continue;
    }
    let paragraph = trim(line);
    while (i < lines.length) {
      const next = lines[i];
      const ch = next[0];
      if ((!ch || ch === ' ' || ch === '\t') && blank.test(next) ||
          ch === '`' && fence.test(next) || ch === '#' && heading.exec(next)?.[2] ||
          (ch === '-' || ch === '*') && rule.test(next)) break;
      paragraph += '\n' + trim(next);
      i++;
    }
    const rendered = inline(paragraph, href);
    excerpt ??= rendered;
    html += `<p>${rendered}</p>\n`;
  }
  return { html, toc, excerpt: excerpt ?? '' };
}

const pathPattern = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const spaces = /^[ \t]*$/;
const quoted = JSON.stringify;

function templateTokens(source, fail) {
  const tokens = [];
  const openers = /\{\{\{|\{\{|\{%/g;
  let cursor = 0;
  for (let match; (match = openers.exec(source));) {
    const opener = match[0];
    const at = match.index;
    const tag = opener === '{%';
    const start = at + opener.length;
    const closer = tag ? '%}' : opener === '{{' ? '}}' : '}}}';
    const close = source.indexOf(closer, start);
    if (close < 0) fail('a ' + opener + ' is not closed');
    let after = close + closer.length;
    let before = at;
    if (tag) {
      const line = source.lastIndexOf('\n', at - 1) + 1;
      const newline = source.indexOf('\n', after);
      const end = newline < 0 ? source.length : newline;
      if (spaces.test(source.slice(line, at)) && spaces.test(source.slice(after, end))) {
        before = line;
        after = newline < 0 ? end : end + 1;
      }
    }
    if (before > cursor) tokens.push(['text', source.slice(cursor, before)]);
    const value = source.slice(start, close).trim();
    if (!tag && !pathPattern.test(value)) fail(quoted(value) + ' is not a path');
    tokens.push([opener, value]);
    openers.lastIndex = cursor = after;
  }
  if (cursor < source.length) tokens.push(['text', source.slice(cursor)]);
  return tokens;
}

function property(value, key) {
  return value !== null && typeof value === 'object' && own(value, key) ? value[key] : undefined;
}

function firstValue(frame, root, key) {
  for (; frame !== null; frame = frame.parent) {
    if (key === 'loop') return frame.loop;
    if (key === frame.name) return frame.value;
  }
  return own(root, key) ? root[key] : undefined;
}

function stringify(value) {
  switch (typeof value) {
    case 'string': return value;
    case 'number':
    case 'boolean': return String(value);
    default: return Array.isArray(value) ? value.map(stringify).join(', ') : '';
  }
}

function truth(value) {
  return Array.isArray(value) ? value.length !== 0 :
    value !== undefined && value !== null && value !== false && value !== '' && value !== 0;
}

function renderer(name, source, includes, escaped) {
  const fail = reason => { throw `template "${name}": ${reason}`; };
  const tokens = templateTokens(source, fail);
  const stack = [];
  const loops = [];
  const dependencies = new Set();
  const children = [];
  const js = ['let out = "";'];
  let loopCount = 0;
  const current = () => loops.length ? 'f' + loops.at(-1).id : 'frame';
  function expr(path) {
    if (!pathPattern.test(path)) fail(quoted(path) + ' is not a path');
    const [first, ...rest] = path.split('.');
    const binding = loops.findLast(loop => first === 'loop' || first === loop.name);
    if (!binding) dependencies.add(first);
    let value = binding ? (first === 'loop' ? 'f' + binding.id + '.loop' : 'v' + binding.id)
      : `firstValue(frame,root,${quoted(first)})`;
    for (const key of rest) value = `property(${value},${quoted(key)})`;
    return value;
  }

  for (const [kind, value] of tokens) {
    if (kind === 'text') {
      js.push(`out += ${quoted(value)};`);
      continue;
    }
    if (kind !== '{%') {
      js.push(`out += ${kind === '{{' ? 'escaped' : 'stringify'}(${expr(value)});`);
      continue;
    }
    let parts;
    const top = stack.at(-1);
    if ((parts = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/.exec(value))) {
      const list = expr(parts[2]);
      const id = loopCount++;
      const parent = current();
      const x = 'x' + id, i = 'i' + id, v = 'v' + id, n = 'n' + id;
      js.push(`const ${x} = ${list};
if (Array.isArray(${x})) for (let ${i}=0, ${n}=${x}.length; ${i}<${n}; ${i}++) {
if (!(${i} in ${x})) continue;
const ${v} = ${x}[${i}];
const f${id} = {parent:${parent},name:${quoted(parts[1])},value:${v},
loop:{index:${i}+1,first:${i}===0,last:${i}===${n}-1,length:${n}}};`);
      const entry = { kind: 'for', name: parts[1], id };
      stack.push(entry);
      loops.push(entry);
    } else if ((parts = /^if (not )?(\S+)$/.exec(value))) {
      js.push(`if (${parts[1] ? '!' : ''}truth(${expr(parts[2])})) {`);
      stack.push({ kind: 'if', otherwise: false });
    } else if (value === 'else') {
      if (top?.kind !== 'if' || top.otherwise) fail('an else outside an if');
      top.otherwise = true;
      js.push('} else {');
    } else if (value === 'endif' || value === 'endfor') {
      const expected = value.slice(3);
      if (top?.kind !== expected) fail(`an ${value} with no open ${expected}`);
      stack.pop();
      if (expected === 'for') loops.pop();
      js.push('}');
    } else if ((parts = /^include "([a-z0-9-]+)"$/.exec(value))) {
      children.push({ name: parts[1], bound: new Set(loops.flatMap(loop => [loop.name, 'loop'])) });
      js.push(`if (depth < 8) out += includes[${quoted(parts[1])}]?.[depth+1](root,${current()},depth+1) ?? "";`);
    } else {
      fail(`{% ${value} %} is not a tag`);
    }
  }
  if (stack.length) fail(`a ${stack.at(-1).kind} is not closed`);
  js.push('return out;');
  const render = new Function('firstValue', 'property', 'truth', 'stringify', 'escaped', 'includes',
    'return function(root,frame,depth){\n' + js.join('\n') + '\n}')(
    firstValue, property, truth, stringify, escaped, includes);
  return { render, dependencies, children };
}

function memoize(render, dependencies) {
  if (dependencies.size > 1) return render;
  if (dependencies.size === 0) {
    let html;
    return (root, frame, depth) => html ??= render(root, frame, depth);
  }
  const [name] = dependencies;
  const cache = new Map();
  return (root, frame, depth) => {
    const key = firstValue(frame, root, name);
    let html = cache.get(key);
    if (html === undefined) {
      html = render(root, frame, depth);
      cache.set(key, html);
    }
    return html;
  };
}

// At the depth limit only direct references matter. Each earlier layer also
// sees its includes' outer references, except names bound by a local loop.
function linkIncludes(templates, includes) {
  for (const name of templates.keys()) includes[name] = [];
  let deeper = new Map();
  for (let depth = 8; depth > 0; depth--) {
    const current = new Map();
    for (const [name, template] of templates) {
      const needed = new Set(template.dependencies);
      for (const { name: child, bound } of template.children) {
        const inherited = deeper.get(child);
        if (inherited) for (const key of inherited) if (!bound.has(key)) needed.add(key);
      }
      current.set(name, needed);
      includes[name][depth] = memoize(template.render, needed);
    }
    deeper = current;
  }
}

const folder = path => path.slice(0, Math.max(0, path.lastIndexOf('/')));
const external = /^(?:[A-Za-z][A-Za-z0-9+.-]*:|[/#])/;

function relative(directory, path) {
  const pieces = directory ? directory.split('/') : [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!pieces.length) return null;
      pieces.pop();
    } else {
      pieces.push(part);
    }
  }
  return pieces.join('/');
}

function tagEntries(names, slug) {
  const entries = new Map();
  if (names) for (const name of names) {
    const key = slug(name);
    if (!entries.has(key)) entries.set(key, name);
  }
  return entries;
}

function dateText(date) {
  return date ? `${+date.slice(8, 10)} ${months[+date.slice(5, 7) - 1]} ${date.slice(0, 4)}` : '';
}

function makeLink(source) {
  if (!source) return null;
  const date = source.metadata.date ?? '';
  return { title: source.metadata.title, url: source.url, date, date_long: dateText(date) };
}

export function run(input) {
  const base = input.site.base_url.replace(/\/+$/, '');
  const templates = new Map();
  const includes = Object.create(null);
  const report = [];
  const escapedStrings = new Map();
  const escaped = value => {
    const string = stringify(value);
    if (!special.test(string)) return string;
    if (string.length < 256) {
      let html = escapedStrings.get(string);
      if (html === undefined) {
        html = string.replace(/[&<>"']/g, entity);
        escapedStrings.set(string, html);
      }
      return html;
    }
    return string.replace(/[&<>"']/g, entity);
  };
  for (const name of Object.keys(input.templates).sort()) {
    try {
      templates.set(name, renderer(name, input.templates[name], includes, escaped));
    } catch (error) {
      if (typeof error !== 'string') throw error;
      report.push(error);
    }
  }
  linkIncludes(templates, includes);

  const files = input.files.slice().sort((a, b) => order(a.path, b.path));
  const sources = [];
  const statics = [];
  const staticPaths = new Set();
  const urls = new Map();
  const posts = [];
  const slug = slugger();
  const directories = new Map([['', new Map([['posts', 2], ['page', 2], ['tags', 2]])]]);
  for (const file of files) {
    const { path, content } = file;
    if (!path.endsWith('.md')) {
      statics.push(file);
      staticPaths.add(path);
      continue;
    }
    const header = readHeader(content.replace(/\r\n?/g, '\n'));
    const post = path.startsWith('posts/');
    const reserved = path.startsWith('tags/') ? 'tags' : path.startsWith('page/') ? 'page' : '';
    let reason;
    if (typeof header === 'string') reason = header;
    else if (reserved) reason = reserved + "/ is the generator's own";
    else if (post && !own(header.metadata, 'date')) reason = 'a post needs a date';
    const layout = header.metadata?.layout ?? (post ? 'post' : 'page');
    if (!reason && !templates.has(layout)) reason = `layout "${layout}" is no template that parses`;
    if (reason) {
      report.push(`refused ${path}: ${reason}`);
      continue;
    }
    const { metadata, body } = header;
    if (metadata.draft) {
      report.push('draft ' + path);
      continue;
    }
    const dir = folder(path);
    const dest = post ? 'posts' : dir;
    let used = directories.get(dest);
    if (!used) directories.set(dest, used = new Map());
    const id = allocate(metadata.slug ?? slug(metadata.title), used);
    const out = (dest ? dest + '/' : '') + id;
    const url = base + '/' + out + '/';
    const source = { path, dir, url, out, id, layout, metadata, body, post, postIndex: -1, card: null, md: null };
    sources.push(source);
    urls.set(path, url);
    if (post) posts.push(source);
  }

  const broken = new Set();
  for (const source of sources) {
    source.md = markdown(source.body, target => {
      if (external.test(target)) return target;
      const hash = target.indexOf('#');
      const path = relative(source.dir, hash < 0 ? target : target.slice(0, hash));
      const fragment = hash < 0 ? '' : target.slice(hash);
      const url = urls.get(path);
      if (url !== undefined) return url + fragment;
      if (staticPaths.has(path)) return base + '/' + path + fragment;
      broken.add(`broken-link ${source.path} -> ${target}`);
      return target;
    }, slug);
  }

  posts.sort((a, b) => order(b.metadata.date, a.metadata.date) || order(a.id, b.id));
  const tagsBySlug = new Map();
  function card(source, collect) {
    const tags = [];
    const { metadata, body, md } = source;
    const record = {
      ...makeLink(source), summary: metadata.summary ?? '', excerpt: md.excerpt,
      reading_minutes: Math.max(1, Math.ceil((body.trim().split(/\s+/).length) / 200)), tags,
    };
    for (const [key, name] of tagEntries(metadata.tags, slug)) {
      let tag = tagsBySlug.get(key);
      if (!tag && collect) {
        tag = { label: { name, slug: key, url: base + '/tags/' + key + '/' }, cards: [] };
        tagsBySlug.set(key, tag);
      }
      if (collect) tag.cards.push(record);
      tags.push(tag?.label ?? { name, slug: key, url: '' });
    }
    return record;
  }
  const cards = posts.map((source, index) => {
    source.postIndex = index;
    return source.card = card(source, true);
  });
  const tags = [...tagsBySlug.values()].sort((a, b) =>
    b.cards.length - a.cards.length || order(a.label.slug, b.label.slug));
  const labels = tags.map(tag => ({ ...tag.label, count: tag.cards.length }));
  const common = {
    site: { title: input.site.title, base_url: base },
    tags: labels,
    recent: cards.slice(0, input.site.recent),
  };
  const output = {};
  for (const source of sources) {
    const index = source.postIndex;
    const page = {
      ...(source.card ?? card(source, false)),
      slug: source.id,
      content: source.md.html,
      toc: source.md.toc,
      newer: source.post ? makeLink(posts[index - 1]) : null,
      older: source.post ? makeLink(posts[index + 1]) : null,
      is_post: source.post,
    };
    output[source.out + '/index.html'] = templates.get(source.layout).render({ ...common, page }, null, 0);
  }

  const per = input.site.per_page;
  const total = Math.max(1, Math.ceil(posts.length / per));
  const indexTemplate = templates.get('index')?.render;
  const indexUrl = number => number === 1 ? base + '/' : `${base}/page/${number}/`;
  if (indexTemplate) for (let number = 1; number <= total; number++) {
    const pager = {
      number, total, url: indexUrl(number),
      newer_url: number === 1 ? '' : indexUrl(number - 1),
      older_url: number === total ? '' : indexUrl(number + 1),
    };
    const path = number === 1 ? 'index.html' : `page/${number}/index.html`;
    output[path] = indexTemplate({ ...common, posts: cards.slice((number - 1) * per, number * per), pager }, null, 0);
  }
  const tagTemplate = templates.get('tag')?.render;
  if (tagTemplate) for (let i = 0; i < tags.length; i++) {
    const tag = { ...labels[i], posts: tags[i].cards };
    output[`tags/${tag.slug}/index.html`] = tagTemplate({ ...common, tag }, null, 0);
  }
  if (templates.has('tags')) output['tags/index.html'] = templates.get('tags').render(common, null, 0);
  for (const { path, content } of statics) {
    if (own(output, path)) report.push(`shadowed ${path}: a built page has its path`);
    else output[path] = content;
  }
  for (const line of broken) report.push(line);
  report.sort();
  report.push(`built ${sources.length - posts.length} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = report.join('\n') + '\n';
  return output;
}
