#!/usr/bin/env node
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { build, discoverManuscripts, manuscriptRoot, previewRoot, previewSourcePath, renderPreviewDocument, renderPreviewIndex } from "./renderer.js";

const command = process.argv[2] ?? "preview";
if (command === "build" || command === "check") {
  await build();
  if (command === "check") console.log(`Rendered ${(await discoverManuscripts(manuscriptRoot)).filter((filename) => !filename.includes("/contents/")).length} published documents successfully.`);
  else console.log("Generated site/.");
  process.exit(0);
}
if (command !== "preview") throw new Error(`Unknown command: ${command}`);

await build(previewRoot, "preview");
const port = Number(process.env.PORT ?? 4173);
const clients = new Set();

function notify(pathname) {
  for (const client of clients) {
    if (client.path !== pathname) continue;
    client.response.write(`data: ${JSON.stringify({ path: pathname })}\n\n`);
  }
}

async function dependsOn(filename, target, seen = new Set()) {
  const absolute = path.resolve(filename);
  const wanted = path.resolve(target);
  if (absolute === wanted) return true;
  if (seen.has(absolute)) return false;
  seen.add(absolute);
  let source;
  try { source = await fs.readFile(absolute, "utf8"); }
  catch { return false; }
  for (const match of source.matchAll(/^@import\s+["']([^"']+)["']\s*$/gm)) {
    if (await dependsOn(path.resolve(path.dirname(absolute), match[1]), wanted, seen)) return true;
  }
  return false;
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const requested = decodeURIComponent(url.pathname);
  if (requested === "/__preview/events") {
    const pagePath = url.searchParams.get("path") || "/";
    response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" });
    response.write(": connected\n\n");
    const client = { path: pagePath, response };
    clients.add(client);
    request.on("close", () => clients.delete(client));
    return;
  }
  const relative = requested === "/" ? "index.html" : requested.replace(/^\//, "");
  const filename = relative.endsWith("/") ? `${previewRoot}/${relative}index.html` : `${previewRoot}/${relative}`;
  try {
    const content = await fs.readFile(filename);
    response.writeHead(200, { "content-type": filename.endsWith(".html") ? "text/html; charset=utf-8" : "application/octet-stream" });
    response.end(content);
  } catch { response.writeHead(404); response.end("Not found"); }
});
server.listen(port, () => console.log(`Preview: http://localhost:${port}/`));
const watcher = (await import("node:fs")).watch(manuscriptRoot, { recursive: true });
for await (const event of watcher) {
  if (!event.filename?.endsWith(".md")) continue;
  const changed = path.resolve(manuscriptRoot, event.filename);
  const activePaths = [...new Set([...clients].map((client) => client.path))];
  for (const pagePath of activePaths) {
    try {
      if (pagePath === "/") {
        await renderPreviewIndex();
        notify(pagePath);
        console.log(`Rebuilt ${pagePath} after ${event.filename}`);
        continue;
      }
      const source = previewSourcePath(pagePath);
      if (!source || !(await dependsOn(source, changed))) continue;
      await renderPreviewDocument(source);
      notify(pagePath);
      console.log(`Rebuilt ${pagePath} after ${event.filename}`);
    } catch (error) { console.error(error.message); }
  }
}
