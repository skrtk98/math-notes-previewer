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

export const books = [
  { source: "Introduction-to-Category-Theory.md", slug: "category-theory", title: "速習圏論" },
  { source: "Introduction-to-Monoidal-Category-Theory.md", slug: "monoidal-category-theory", title: "速習モノイダル圏論" },
  { source: "Introduction-to-Enriched-Categor-over-Monoidal-base-Theory.md", slug: "enriched-category-theory", title: "速習モノイダル基底上の豊穣圏論" },
];

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

async function page(title, body, depth = 0) {
  const katexCss = await fs.readFile(new URL("../node_modules/katex/dist/katex.min.css", import.meta.url), "utf8");
  const fontPrefix = depth ? "../" : "";
  return `<!doctype html>\n<html lang="ja">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>${title}</title>\n<style>${katexCss.replaceAll("url(fonts/", `url(${fontPrefix}fonts/`)}${CSS}</style>\n</head>\n<body><main class="markdown-preview">${body}</main></body>\n</html>\n`;
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
@media print { :root { background: #fff; } main { max-width: none; padding: 0; } }
`;

export async function renderBook(book) {
  const filename = path.join(manuscriptRoot, book.source);
  const source = await readExpanded(filename);
  const withDiagrams = await renderLatexBlocks(source);
  const html = markdown().render(withDiagrams);
  return page(book.title, html, 1);
}

export async function build() {
  await fs.mkdir(outputRoot, { recursive: true });
  await fs.cp(new URL("../node_modules/katex/dist/fonts", import.meta.url), path.join(outputRoot, "fonts"), { recursive: true });
  for (const book of books) {
    const destination = path.join(outputRoot, book.slug, "index.html");
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, await renderBook(book), "utf8");
  }
  await fs.writeFile(path.join(outputRoot, "index.html"), await page("Category Theory Notes", `<h1>Category Theory Notes</h1><p>圏論とその発展的な話題に関する入門ノートです。</p><ul>${books.map((book) => `<li><a href="${book.slug}/">${book.title}</a></li>`).join("")}</ul>`), "utf8");
}

export { manuscriptRoot, outputRoot };
