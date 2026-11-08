import http from "node:http";

const links = new Map<string, string>();
const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") { res.end("ok"); return; }
  if (req.method === "GET" && req.url?.startsWith("/latest?")) {
    const to = new URL(req.url, "http://127.0.0.1:3211").searchParams.get("to") ?? "";
    const url = links.get(to);
    res.statusCode = url ? 200 : 404;
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ url })); return;
  }
  if (req.method === "POST" && req.url === "/capture") {
    let body = ""; req.setEncoding("utf8"); req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try { const v = JSON.parse(body) as { to: string; url: string }; links.set(v.to, v.url); res.end("ok"); }
      catch { res.statusCode = 400; res.end("invalid"); }
    }); return;
  }
  res.statusCode = 404; res.end("not found");
});
server.listen(3211, "127.0.0.1");
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => server.close(() => process.exit(0)));
