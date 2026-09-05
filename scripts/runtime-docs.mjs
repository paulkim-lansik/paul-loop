// Markdown resource handling for generated instructions. Fenced/inline code is example data.
import { posix } from 'node:path';
import { createHash } from 'node:crypto';

function maskCode(text) {
  let fence;
  return text.split(/(?<=\n)/).map(line => {
    const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (match && match[1][0] === fence[0] && match[1].length >= fence.length) fence = null;
      return line.replace(/[^\n]/g, ' ');
    }
    if (match) { fence = match[1]; return line.replace(/[^\n]/g, ' '); }
    return line.replace(/(`+)([^`]|(?!\1)`)*?\1/g, value => ' '.repeat(value.length));
  }).join('');
}
export function localMarkdownLinks(text) {
  const visible = maskCode(text), links = [];
  // Inline links/images and reference definitions. Targets may use <space-containing paths>.
  const patterns = [/(!?\[[^\]\n]*\]\(\s*)(?:<([^>\n]+)>|([^\s)]+))/g,
    /^( {0,3}\[[^\]\n]+\]:\s*)(?:<([^>\n]+)>|([^\s]+))/gm];
  for (const pattern of patterns) for (const match of visible.matchAll(pattern)) {
    const target = match[2] ?? match[3];
    if (/^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(target)) continue;
    const split = target.search(/[?#]/), path = split < 0 ? target : target.slice(0, split);
    if (!path) continue;
    links.push({ target, path: decodeURIComponent(path), suffix: split < 0 ? '' : target.slice(split),
      start: match.index + match[1].length + (match[2] !== undefined ? 1 : 0), length: target.length });
  }
  return links.sort((a, b) => a.start - b.start);
}
function replaceLinks(text, transform) {
  for (const link of localMarkdownLinks(text).reverse()) {
    text = text.slice(0, link.start) + transform(link) + text.slice(link.start + link.length);
  }
  return text;
}
const targetPath = (from, link) => posix.normalize(posix.join(posix.dirname(from), link.path));
export function rebaseDocLinks(text, from, to) {
  return replaceLinks(text, link => {
    const target = targetPath(from, link);
    if (target === '..' || target.startsWith('../')) throw new Error(`documentation resource escapes plugin: ${from} -> ${link.target}`);
    return posix.relative(posix.dirname(to), target).split('/').map(encodeURIComponent).join('/') + link.suffix;
  });
}

export const scratchContract = 'Disposable-fixture access: preserve audited source, live state and installed caches. When the investigation permits scratch writes, use only a host-permitted temporary directory (such as /tmp or TMPDIR). A read-only sandbox does not itself guarantee temporary-directory writes. Verify actual host access; do not broaden grants or bypass a denial. If scratch writes are unavailable, mark that check incomplete and continue independent authorized checks. Actual sandbox access and trust remain unverified.';

// A template may move to .codex/agents in any consumer. Embed its Markdown dependency closure;
// never keep a relative plugin resource link that would be resolved from that consumer location.
export function embedRoleResources(instructions, sourcePath, readResource, required = []) {
  const resources = new Map();
  const include = (path) => {
    if (path === '..' || path.startsWith('../') || !path.endsWith('.md')) throw new Error(`agent template requires an unsupported resource: ${path}`);
    if (resources.has(path)) return resources.get(path).anchor;
    const body = readResource(path);
    if (typeof body !== 'string') throw new Error(`agent template resource missing: ${path}`);
    const item = { anchor: 'resource-' + createHash('sha256').update(path).digest('hex').slice(0, 16), body: '' };
    resources.set(path, item); // register before walking, so cycles remain bounded
    item.body = rewrite(body, path);
    return item.anchor;
  };
  const rewrite = (body, from) => replaceLinks(body, link => '#' + include(targetPath(from, link)));
  const body = rewrite(instructions, sourcePath);
  for (const path of required) include(path);
  const mapping = [...resources].map(([path, item]) => `- ${path} is included below as [embedded resource](#${item.anchor}).`).join('\n');
  const embedded = [...resources].map(([path, item]) => `<a id="${item.anchor}"></a>\n\n## Embedded resource: ${path}\n\n${item.body}`).join('\n\n');
  return `${scratchContract}\n\nThis template includes its required plugin contracts below. Relative filenames in their prose identify source documents, not files to resolve from .codex/agents. The caller supplies absolute paths for actual repository/configuration/artifact inputs. Do not fetch extra context to reconstruct a publisher handoff.\n\n${mapping}\n\n${body}\n\n${embedded}\n`;
}

export function validateGeneratedDocRefs(files) {
  let documents = 0, references = 0;
  const errors = [];
  for (const [path, data] of files) {
    const match = /^((?:claude|codex)\/plugins\/[^/]+\/)($|skills\/|agents\/)/.exec(path);
    if (!match || !path.endsWith('.md')) continue;
    documents++;
    for (const link of localMarkdownLinks(data.content.toString('utf8'))) {
      const target = targetPath(path, link);
      if (!target.startsWith(match[1])) { errors.push(`generated documentation escapes plugin: ${path} -> ${link.target}`); continue; }
      if (!files.has(target) && ![...files.keys()].some(p => p.startsWith(target.replace(/\/$/, '') + '/'))) {
        errors.push(`dangling generated documentation reference: ${path} -> ${link.target}`);
      }
      references++;
    }
  }
  if (errors.length) throw new Error(errors.join('\n'));
  return { documents, references };
}
