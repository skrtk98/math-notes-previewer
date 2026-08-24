#!/usr/bin/env node
import fs from "node:fs/promises";
import http from "node:http";
import { build, discoverManuscripts, manuscriptRoot, previewRoot } from "./renderer.js";

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
const server = http.createServer(async (request, response) => {
  const requested = decodeURIComponent(new URL(request.url, `http://${request.headers.host}`).pathname);
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
  try { await build(previewRoot, "preview"); console.log(`Rebuilt after ${event.filename}`); }
  catch (error) { console.error(error.message); }
}
