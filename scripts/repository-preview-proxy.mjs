#!/usr/bin/env node

import { createServer, request as createRequest } from "node:http";

const hostname = process.env.REPOSITORY_PREVIEW_HOSTNAME;
if (!hostname || !/^[a-z0-9.-]+$/i.test(hostname)) {
  throw new Error("Repository preview hostname is invalid");
}

createServer((request, response) => {
  if (request.url === "/__mcp_healthz") {
    response.writeHead(204).end();
    return;
  }

  const headers = { ...request.headers, host: hostname };
  delete headers["cf-access-jwt-assertion"];
  delete headers.cookie;
  delete headers.authorization;
  const upstream = createRequest(
    {
      hostname: "127.0.0.1",
      port: 4322,
      path: request.url,
      method: request.method,
      headers,
    },
    (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    },
  );
  upstream.on("error", () => {
    if (!response.headersSent) {
      response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    }
    response.end("Repository preview is starting");
  });
  request.pipe(upstream);
}).listen(4321, "0.0.0.0");
