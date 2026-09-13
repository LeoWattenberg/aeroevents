import { createReadStream, promises as fs } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 4321);
const base = `/${(process.env.PUBLIC_BASE_PATH ?? "/").replace(/^\/+|\/+$/g, "")}`.replace(/^\/$/, "");
const output = path.resolve(process.cwd(), "dist");
const mimeTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".xml": "application/xml; charset=utf-8",
};

const server = createServer(async (request, response) => {
  try {
    const requested = new URL(request.url ?? "/", `http://${host}:${port}`).pathname;
    if (base && requested !== base && !requested.startsWith(`${base}/`)) {
      response.writeHead(404).end("Not found");
      return;
    }
    const relative = decodeURIComponent(base ? requested.slice(base.length) || "/" : requested);
    let file = path.resolve(output, `.${relative}`);
    if (file !== output && !file.startsWith(`${output}${path.sep}`)) {
      response.writeHead(400).end("Bad request");
      return;
    }
    const initial = await fs.stat(file).catch(() => undefined);
    if (initial?.isDirectory() || (!initial && !path.extname(file))) file = path.join(file, "index.html");
    const stat = await fs.stat(file).catch(() => undefined);
    if (!stat?.isFile()) file = path.join(output, "404.html");
    const finalStat = await fs.stat(file);
    response.writeHead(stat?.isFile() ? 200 : 404, {
      "Content-Length": finalStat.size,
      "Content-Type": mimeTypes[path.extname(file)] ?? "application/octet-stream",
    });
    if (request.method === "HEAD") response.end();
    else createReadStream(file).pipe(response);
  } catch (error) {
    response.writeHead(500).end(error instanceof Error ? error.message : "Server error");
  }
});

server.listen(port, host, () => {
  console.log(`Static testserver: http://${host}:${port}${base || "/"}`);
});
