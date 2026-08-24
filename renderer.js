import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import MarkdownIt from "markdown-it";
import deflist from "markdown-it-deflist";
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
  const inline = source.replace(/\$``([\s\S]*?)``\$/g, "$$$1$");
  return inline.replace(/^( {0,12})```math\s*\n([\s\S]*?)^\1```\s*$/gm, (_, indent, body) => `\n$$\n${body}\n$$\n`);
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
  return new MarkdownIt({ html: true, linkify: true, typographer: false })
    .use(deflist)
    .use(texmath, { engine: katex, delimiters: "dollars", katexOptions: { throwOnError: true, strict: "warn" } });
}

function renderDocumentBody(source) {
  const rendered = markdown().render(source);
  const headings = [];
  const usedIds = new Map();
  const body = rendered.replace(/<h([1-6])>([\s\S]*?)<\/h\1>/g, (_, level, content) => {
    const text = content.replace(/<[^>]+>/g, "").replace(/&[^;]+;/g, " ").trim();
    const base = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "") || `heading-${headings.length + 1}`;
    const count = usedIds.get(base) ?? 0;
    usedIds.set(base, count + 1);
    const id = count ? `${base}-${count + 1}` : base;
    headings.push({ level: Number(level), text, id });
    return `<h${level} id="${id}">${content}</h${level}>`;
  });
  const toc = headings.length > 0
    ? `<nav class="toc" aria-label="目次"><h2>目次</h2><ul>${headings.map((heading) => `<li class="toc-level-${heading.level}"><a href="#${heading.id}">${heading.text}</a></li>`).join("")}</ul></nav>`
    : "";
  return { body, toc };
}

async function page(title, body, depth = 0, toc = "") {
  const katexCss = await fs.readFile(new URL("../node_modules/katex/dist/katex.min.css", import.meta.url), "utf8");
  const fontPrefix = "../".repeat(depth);
  return `<!doctype html>\n<html lang="ja">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>${title}</title>\n<style>${katexCss.replaceAll("url(fonts/", `url(${fontPrefix}fonts/`)}${CSS}</style>\n</head>\n<body><main class="markdown-preview">${toc}${body}</main></body>\n</html>\n`;
}

const CSS = `
:root { color-scheme: light; font-family: "Source Han Serif", "Noto Serif CJK JP", serif; line-height: 1.8; color: #202124; background: #f7f6f2; }
body { margin: 0; }
main { max-width: 56rem; margin: 0 auto; padding: 3rem 1.5rem 6rem; background: #fff; min-height: 100vh; box-sizing: border-box; }
h1, h2, h3, h4, h5, h6 { line-height: 1.35; margin: 2rem 0 1rem; }
h1 { border-bottom: 2px solid #303f9f; padding-bottom: .4rem; }
h2 { border-bottom: 1px solid #c7c9d9; padding-bottom: .25rem; }
a { color: #283593; } img, svg { max-width: 100%; height: auto; }
pre { overflow-x: auto; padding: 1rem; background: #f1f3f4; border-radius: .35rem; }
code { background: #f1f3f4; padding: .1em .25em; border-radius: .2em; }
blockquote { margin: 1rem 0; padding: .5rem 1rem; border-left: 4px solid #9fa8da; background: #f5f6ff; }
table { border-collapse: collapse; display: block; overflow-x: auto; } th, td { border: 1px solid #bdbdbd; padding: .35rem .6rem; }
eq { display: inline; } section { display: block; text-align: center; margin: 1rem 0; }
.diagram { margin: 1.5rem auto; text-align: center; overflow-x: auto; } .diagram svg { max-height: 28rem; }
.toc { border: 1px solid #c7c9d9; background: #f5f6ff; padding: .75rem 1.25rem; margin-bottom: 2rem; }
.toc h2 { font-size: 1.15rem; border: 0; margin: 0 0 .35rem; padding: 0; }
.toc ul { list-style: none; margin: 0; padding: 0; } .toc li { margin: .15rem 0; }
.toc .toc-level-2 { margin-left: 1rem; } .toc .toc-level-3 { margin-left: 2rem; }
.toc .toc-level-4 { margin-left: 3rem; } .toc .toc-level-5 { margin-left: 4rem; } .toc .toc-level-6 { margin-left: 5rem; }
@media print { :root { background: #fff; } main { max-width: none; padding: 0; } }
`;

export async function renderBook(book) {
  const filename = path.join(manuscriptRoot, book.source);
  const source = await readExpanded(filename);
  const withDiagrams = await renderLatexBlocks(normalizeMathSyntax(source));
  const rendered = renderDocumentBody(withDiagrams);
  return page(book.title, rendered.body, 1, rendered.toc);
}

async function renderDocument(filename, destination, targetRoot = outputRoot) {
  const relative = path.relative(manuscriptRoot, filename);
  const source = await readExpanded(filename);
  const withDiagrams = await renderLatexBlocks(normalizeMathSyntax(source));
  const rendered = renderDocumentBody(withDiagrams);
  const depth = path.relative(path.dirname(destination), targetRoot).split(path.sep).length;
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, await page(manuscriptTitle(source, relative), rendered.body, depth, rendered.toc), "utf8");
  return source;
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
    await renderDocument(filename, destination, targetRoot);
  }
  const links = manuscripts.map((filename) => {
    const relative = path.relative(manuscriptRoot, filename);
    const href = `manuscripts/${relative.replace(/\.md$/, "")}/`;
    return `<li><a href="${href}">${manuscriptTitle(sourceCache.get(filename), relative)}</a><code>${relative}</code></li>`;
  }).join("");
  await fs.writeFile(path.join(targetRoot, "index.html"), await page("Markdown manuscripts", `<h1>Markdown manuscripts</h1><p>manuscripts/ 以下の Markdown 原稿一覧</p><ul>${links}</ul>`), "utf8");
}

const sourceCache = new Map();

export { manuscriptRoot, outputRoot };
