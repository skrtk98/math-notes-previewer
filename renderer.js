import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import MarkdownIt from "markdown-it";
import deflist from "markdown-it-deflist";
import footnote from "markdown-it-footnote";
import texmath from "markdown-it-texmath";
import katex from "katex";

const execFileAsync = promisify(execFile);
const root = path.resolve(new URL(".", import.meta.url).pathname, "..");
const manuscriptRoot = path.join(root, "manuscripts");
const outputRoot = path.join(root, "site");
export const previewRoot = path.join(root, "build", "preview-site");

export async function discoverManuscripts(directory = manuscriptRoot) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await discoverManuscripts(filename));
    else if (entry.isFile() && entry.name.endsWith(".md")) files.push(filename);
  }
  return files.sort();
}

export function manuscriptTitle(source, relative) {
  return source.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? relative;
}

function documentSlug(relative) {
  return path.basename(relative, ".md");
}

async function readExpanded(filename) {
  const seen = new Set();
  async function visit(file) {
    const absolute = path.resolve(file);
    if (seen.has(absolute)) throw new Error(`Circular import: ${absolute}`);
    seen.add(absolute);
    const source = await fs.readFile(absolute, "utf8");
    const expanded = [];
    for (const line of source.split("\n")) {
      const match = line.match(/^@import\s+["']([^"']+)["']\s*$/);
      if (!match) expanded.push(line);
      else expanded.push(await visit(path.resolve(path.dirname(absolute), match[1])));
    }
    seen.delete(absolute);
    return expanded.join("\n");
  }
  return visit(filename);
}

function normalizeMathSyntax(source) {
  const inline = source.replace(/\$`([\s\S]*?)`\$/g, "$$$1$");
  return inline.replace(/^( {0,12})```math\s*\n([\s\S]*?)^\1```\s*$/gm, (_, indent, body) => {
    const dedented = body.replace(new RegExp(`^${indent}`, "gm"), "");
    const indented = dedented.split("\n").map((line) => line ? `${indent}${line}` : "").join("\n");
    return `\n${indent}$$\n${indented}\n${indent}$$\n`;
  });
}

async function compileLatex(source, index) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "category-notes-"));
  const tex = path.join(directory, `diagram-${index}.tex`);
  const dvi = path.join(directory, `diagram-${index}.dvi`);
  try {
    await fs.writeFile(tex, source, "utf8");
    await execFileAsync("latex", ["-interaction=nonstopmode", "-halt-on-error", `-output-directory=${directory}`, tex], { timeout: 120000 });
    const converted = await execFileAsync("dvisvgm", ["--no-fonts", "--exact-bbox", "--stdout", dvi], { timeout: 120000, maxBuffer: 20 * 1024 * 1024 });
    return converted.stdout;
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function renderLatexBlocks(source) {
  const pattern = /^ {0,12}```latex(?:\s+\{[^\n]*\})?\n([\s\S]*?)^ {0,12}```\s*$/gm;
  let index = 0;
  const replacements = [];
  let match;
  while ((match = pattern.exec(source))) {
    const svg = await compileLatex(match[1], index++);
    replacements.push({ start: match.index, end: pattern.lastIndex, value: `\n<div class="diagram">${svg}</div>\n` });
  }
  let result = source;
  for (let i = replacements.length - 1; i >= 0; i--) {
    const item = replacements[i];
    result = result.slice(0, item.start) + item.value + result.slice(item.end);
  }
  return result;
}

function markdown() {
  return new MarkdownIt({ html: true, linkify: true, typographer: false, breaks: true })
    .use(deflist)
    .use(footnote)
    .use(texmath, { engine: katex, delimiters: "dollars", katexOptions: { throwOnError: true, strict: "warn" } });
}

function renderDocumentBody(source) {
  const rendered = markdown().render(source);
  const headings = [];
  const sourceHeadings = [...source.matchAll(/^#{1,6}\s+(.+)$/gm)].map((match) => match[1].trim());
  const usedIds = new Map();
  const body = rendered
    .replace(/<section><eqn>([\s\S]*?)<\/eqn><\/section>/g, '<p class="math">$1</p>')
    .replace(/<h([1-6])>([\s\S]*?)<\/h\1>/g, (_, level, content) => {
    const text = content.replace(/<[^>]+>/g, "").replace(/&[^;]+;/g, " ").trim();
    const sourceText = sourceHeadings[headings.length] ?? text;
    const slugText = sourceText
      .replace(/\$`([\s\S]*?)`\$/g, "$1")
      .replace(/\$([^$]+)\$/g, "$1")
      .replace(/[\\{}]/g, "")
      .replace(/[`*~]/g, "");
    const base = slugText.toLowerCase().replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-|-$/g, "") || `heading-${headings.length + 1}`;
    const count = usedIds.get(base) ?? 0;
    usedIds.set(base, count + 1);
    const id = count ? `${base}-${count}` : base;
    headings.push({ level: Number(level), text, html: content.replace(/<\/?eq>/g, ""), id });
    return `<h${level} id="${id}">${content}</h${level}>`;
    }).replace(/<\/?eq>/g, "");
  const tocNodes = [];
  const tocStack = [{ level: 0, children: tocNodes }];
  for (const heading of headings) {
    while (tocStack.at(-1).level >= heading.level) tocStack.pop();
    const node = { heading, children: [] };
    tocStack.at(-1).children.push(node);
    tocStack.push({ level: heading.level, children: node.children });
  }
  const renderTocNodes = (nodes) => nodes.map(({ heading, children }) => {
    const link = `<a href="#${heading.id}" class="md-toc-link">${heading.html}</a>`;
    if (children.length === 0) return `<div class="md-toc-link-wrapper" data-level="${heading.level - 1}">${link}</div>`;
    return `<details open class="md-toc-details"><summary class="md-toc-link-wrapper" data-level="${heading.level - 1}">${link}</summary>${renderTocNodes(children)}</details>`;
  }).join("");
  const toc = headings.length > 0 ? `<div class="md-toc" aria-label="目次">${renderTocNodes(tocNodes)}</div>` : "";
  return { body, toc };
}

async function page(title, body, depth = 0, toc = "", liveReload = false) {
  const katexCss = await fs.readFile(new URL("../node_modules/katex/dist/katex.min.css", import.meta.url), "utf8");
  const fontPrefix = "../".repeat(depth);
  const reloadScript = liveReload
    ? `<script>(function(){var source=new EventSource("/__preview/events?path="+encodeURIComponent(window.location.pathname));source.onmessage=function(event){var message=JSON.parse(event.data);if(message.path===window.location.pathname){window.location.reload();}};})();</script>`
    : "";
  return `<!doctype html>\n<html lang="ja">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>${title}</title>\n<style>${katexCss.replaceAll("url(fonts/", `url(${fontPrefix}fonts/`)}${CSS}</style>\n</head>\n<body for="html-export"><div class="crossnote markdown-preview">${body}<div class="md-sidebar-toc">${toc}</div></div><a id="sidebar-toc-btn">≡</a><script>var sidebarTOCBtn=document.getElementById("sidebar-toc-btn");sidebarTOCBtn.addEventListener("click",function(event){event.stopPropagation();if(document.body.hasAttribute("html-show-sidebar-toc")){document.body.removeAttribute("html-show-sidebar-toc");}else{document.body.setAttribute("html-show-sidebar-toc",true);}});</script>${reloadScript}</body>\n</html>\n`;
}

const CSS = `
html body { font-family: 'Helvetica Neue', Helvetica, 'Segoe UI', Arial, freesans, sans-serif; font-size: 16px; line-height: 1.6; color: #333; background: #fff; overflow: initial; box-sizing: border-box; word-wrap: break-word; }
body { margin: 0; }
html body h1, html body h2, html body h3, html body h4, html body h5, html body h6 { line-height: 1.2; margin-top: 1em; margin-bottom: 16px; color: #000; }
html body h1 { font-size: 2.25em; font-weight: 300; padding-bottom: .3em; }
html body h2 { font-size: 1.75em; font-weight: 400; padding-bottom: .3em; }
html body h3 { font-size: 1.5em; font-weight: 500; } html body h4 { font-size: 1.25em; font-weight: 600; }
html body h1, html body h2, html body h3, html body h4, html body h5 { font-weight: 600; }
html body h5 { font-size: 1em; } html body h6 { color: #5c5c5c; }
html body strong { color: #000; } html body a { color: #08c; text-decoration: none; } html body a:hover { color: #00a3f5; }
html body img { max-width: 100%; } html body > p { margin-top: 0; margin-bottom: 16px; word-wrap: break-word; }
html body ol, html body ul { padding-left: 2em; } html body li { margin-bottom: 0; }
html body blockquote { margin: 16px 0; padding: 0 15px; color: #5c5c5c; background: #f0f0f0; border-left: 4px solid #d6d6d6; }
html body hr { height: 4px; margin: 32px 0; background: #d6d6d6; border: 0; }
html body table { margin: 10px 0 15px; border-collapse: collapse; display: block; width: 100%; overflow: auto; }
html body table td, html body table th { border: 1px solid #d6d6d6; padding: 6px 13px; }
html body dl { padding: 0; } html body dl dt { padding: 0; margin-top: 16px; font-weight: 700; } html body dl dd { padding: 0 16px; margin-bottom: 16px; }
html body code { font-family: Menlo, Monaco, Consolas, 'Courier New', monospace; font-size: .85em; color: #000; background: #f0f0f0; border-radius: 3px; padding: .2em 0; }
html body pre { padding: 1em; overflow: auto; line-height: 1.45; border-radius: 3px; } html body pre code { padding: 0; background: transparent; }
html body[for="html-export"]:not([data-presentation-mode]) { position: relative; width: 100%; height: 100%; top: 0; left: 0; margin: 0; padding: 0; overflow: auto; }
html body[for="html-export"]:not([data-presentation-mode]) .markdown-preview { position: relative; top: 0; min-height: 100vh; }
@media screen and (min-width: 914px) { html body[for="html-export"]:not([data-presentation-mode]) .markdown-preview { padding: 2em calc(50% - 457px + 2em); } }
@media screen and (max-width: 914px) { html body[for="html-export"]:not([data-presentation-mode]) .markdown-preview { padding: 2em; } }
@media screen and (max-width: 450px) { html body[for="html-export"]:not([data-presentation-mode]) .markdown-preview { font-size: 14px !important; padding: 1em; } }
@media print { html body[for="html-export"]:not([data-presentation-mode]) #sidebar-toc-btn { display: none; } }
html body[for="html-export"]:not([data-presentation-mode]) #sidebar-toc-btn { position: fixed; bottom: 8px; left: 8px; font-size: 28px; cursor: pointer; color: inherit; z-index: 99; width: 32px; text-align: center; opacity: .4; }
html body[for="html-export"]:not([data-presentation-mode])[html-show-sidebar-toc] #sidebar-toc-btn { opacity: 1; }
html body[for="html-export"]:not([data-presentation-mode])[html-show-sidebar-toc] .md-sidebar-toc { position: fixed; top: 0; left: 0; width: 300px; height: 100%; padding: 32px 0 48px 0; font-size: 14px; box-shadow: 0 0 4px rgba(150,150,150,.33); box-sizing: border-box; overflow: auto; background-color: inherit; z-index: 98; }
html body[for="html-export"]:not([data-presentation-mode])[html-show-sidebar-toc] .md-sidebar-toc a { text-decoration: none; }
html body[for="html-export"]:not([data-presentation-mode])[html-show-sidebar-toc] .md-sidebar-toc .md-toc { padding: 0 16px; }
html body[for="html-export"]:not([data-presentation-mode])[html-show-sidebar-toc] .md-sidebar-toc .md-toc .md-toc-details { margin: 0; padding: 0; border: none; }
html body[for="html-export"]:not([data-presentation-mode])[html-show-sidebar-toc] .md-sidebar-toc .md-toc .md-toc-link-wrapper .md-toc-link { display: inline; padding: .25rem 0; }
html body[for="html-export"]:not([data-presentation-mode])[html-show-sidebar-toc] .md-sidebar-toc .md-toc .md-toc-link-wrapper .md-toc-link div { display: inline; }
html body[for="html-export"]:not([data-presentation-mode])[html-show-sidebar-toc] .md-sidebar-toc .md-toc .md-toc-link-wrapper[data-level="0"] { padding-left: 0; }
html body[for="html-export"]:not([data-presentation-mode])[html-show-sidebar-toc] .md-sidebar-toc .md-toc .md-toc-link-wrapper[data-level="1"] { padding-left: 16px; }
html body[for="html-export"]:not([data-presentation-mode])[html-show-sidebar-toc] .md-sidebar-toc .md-toc .md-toc-link-wrapper[data-level="2"] { padding-left: 32px; }
html body[for="html-export"]:not([data-presentation-mode])[html-show-sidebar-toc] .md-sidebar-toc .md-toc .md-toc-link-wrapper[data-level="3"] { padding-left: 48px; }
html body[for="html-export"]:not([data-presentation-mode])[html-show-sidebar-toc] .md-sidebar-toc .md-toc .md-toc-link-wrapper[data-level="4"] { padding-left: 64px; }
html body[for="html-export"]:not([data-presentation-mode])[html-show-sidebar-toc] .md-sidebar-toc .md-toc .md-toc-link-wrapper[data-level="5"] { padding-left: 80px; }
html body[for="html-export"]:not([data-presentation-mode])[html-show-sidebar-toc] .markdown-preview { left: 300px; width: calc(100% - 300px); padding: 2em calc(50% - 457px - 150px); margin: 0; box-sizing: border-box; }
html body[for="html-export"]:not([data-presentation-mode]):not([html-show-sidebar-toc]) .markdown-preview { left: 50%; transform: translateX(-50%); }
html body[for="html-export"]:not([data-presentation-mode]):not([html-show-sidebar-toc]) .md-sidebar-toc { display: none; }
.diagram { margin: 1.5rem auto; text-align: center; overflow-x: auto; } .diagram svg { max-height: 28rem; }
@media screen and (max-width: 1274px) { html body[for="html-export"]:not([data-presentation-mode])[html-show-sidebar-toc] .markdown-preview { padding: 2em; } }
@media screen and (max-width: 450px) { html body[for="html-export"]:not([data-presentation-mode])[html-show-sidebar-toc] .markdown-preview { width: 100%; } }
@media print { html body[for="html-export"]:not([data-presentation-mode]) .md-sidebar-toc { display: none; } }
`;

export async function renderBook(book) {
  const filename = path.join(manuscriptRoot, book.source);
  const source = await readExpanded(filename);
  const withDiagrams = await renderLatexBlocks(normalizeMathSyntax(source));
  const rendered = renderDocumentBody(withDiagrams);
  return page(book.title, rendered.body, 1, rendered.toc);
}

export async function renderDocument(filename, destination, targetRoot = outputRoot, liveReload = false) {
  const relative = path.relative(manuscriptRoot, filename);
  const source = await readExpanded(filename);
  const withDiagrams = await renderLatexBlocks(normalizeMathSyntax(source));
  const rendered = renderDocumentBody(withDiagrams);
  const depth = path.relative(path.dirname(destination), targetRoot).split(path.sep).length;
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, await page(manuscriptTitle(source, relative), rendered.body, depth, rendered.toc, liveReload), "utf8");
  return source;
}

export function previewDocumentPath(relative) {
  const normalized = relative.split(path.sep).join("/").replace(/\.md$/, "");
  return `/manuscripts/${normalized}/`;
}

export function previewSourcePath(pathname) {
  const normalized = pathname.replace(/^\/+|\/+$/g, "");
  if (!normalized.startsWith("manuscripts/") || normalized === "manuscripts") return null;
  const parts = normalized.split("/").slice(1);
  if (parts.length === 0) return null;
  const basename = parts.pop();
  return path.join(manuscriptRoot, ...parts, `${basename}.md`);
}

export async function renderPreviewDocument(filename) {
  const relative = path.relative(manuscriptRoot, filename);
  const destination = path.join(previewRoot, "manuscripts", relative.replace(/\.md$/, ""), "index.html");
  await fs.mkdir(path.dirname(destination), { recursive: true });
  return renderDocument(filename, destination, previewRoot, true);
}

export async function renderPreviewIndex() {
  const manuscripts = await discoverManuscripts();
  const links = [];
  for (const filename of manuscripts) {
    const relative = path.relative(manuscriptRoot, filename);
    const source = await readExpanded(filename);
    sourceCache.set(filename, source);
    links.push(`<li><a href="${previewDocumentPath(relative)}">${manuscriptTitle(source, relative)}</a><code>${relative}</code></li>`);
  }
  await fs.writeFile(path.join(previewRoot, "index.html"), await page("Markdown manuscripts", `<h1>Markdown manuscripts</h1><p>manuscripts/ 以下の Markdown 原稿一覧</p><ul>${links.join("")}</ul>`, 0, "", true), "utf8");
}

export async function build(targetRoot = outputRoot, mode = "published") {
  await fs.mkdir(targetRoot, { recursive: true });
  await fs.cp(new URL("../node_modules/katex/dist/fonts", import.meta.url), path.join(targetRoot, "fonts"), { recursive: true });
  if (mode === "published") {
    const manuscripts = (await discoverManuscripts()).filter((filename) => path.dirname(path.relative(manuscriptRoot, filename)) === ".");
    const links = [];
    for (const filename of manuscripts) {
      const relative = path.relative(manuscriptRoot, filename);
      const destination = path.join(targetRoot, documentSlug(relative), "index.html");
      const source = await renderDocument(filename, destination, targetRoot);
      links.push(`<li><a href="${documentSlug(relative)}/">${manuscriptTitle(source, relative)}</a></li>`);
    }
    await fs.writeFile(path.join(targetRoot, "index.html"), await page("Personal Mathematical Documents", `<h1>Personal Mathematical Documents</h1><p>個人的な数学の教科書的資料を含む静的ドキュメント群。</p><ul>${links.join("")}</ul>`), "utf8");
    return;
  }

  const manuscripts = await discoverManuscripts();
  for (const filename of manuscripts) {
    const relative = path.relative(manuscriptRoot, filename);
    const relativeDirectory = path.dirname(relative);
    const basename = path.basename(relative, ".md");
    const destination = path.join(targetRoot, "manuscripts", relativeDirectory, basename, "index.html");
    await fs.mkdir(path.dirname(destination), { recursive: true });
    const source = await readExpanded(filename);
    sourceCache.set(filename, source);
    await renderDocument(filename, destination, targetRoot, true);
  }
  await renderPreviewIndex();
}

const sourceCache = new Map();

export { manuscriptRoot, outputRoot };
