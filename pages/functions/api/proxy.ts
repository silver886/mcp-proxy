// Proxies requests from the setup page to the host agent.
// Same-origin with the setup page — no CORS needed.
// The host agent never receives browser-direct requests.

import { MAX_PAYLOAD_SIZE, json } from "../lib.js";

interface ProxyRequest {
  tunnelUrl: string;
  authToken: string;
  method: "GET" | "POST" | "DELETE";
  path: string; // e.g., "/" or "/servers/echo"
  headers?: Record<string, string>;
  body?: string;
}

export const onRequestPost: PagesFunction = async (context) => {
  const contentLength = parseInt(context.request.headers.get("content-length") ?? "0", 10);
  if (contentLength > MAX_PAYLOAD_SIZE) {
    return json({ error: "Request too large" }, 413);
  }

  let req: ProxyRequest;
  try {
    req = await context.request.json<ProxyRequest>();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  if (!req.tunnelUrl || !req.authToken || !req.method || !req.path) {
    return json({ error: "tunnelUrl, authToken, method, and path are required" }, 400);
  }

  const targetUrl = `${req.tunnelUrl.replace(/\/+$/, "")}${req.path}`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${req.authToken}`,
    ...req.headers,
  };

  try {
    const upstream = await fetch(targetUrl, {
      method: req.method,
      headers,
      body: req.method !== "GET" ? req.body : undefined,
    });

    // Forward response headers we care about
    const responseHeaders: Record<string, string> = {
      "Content-Type": upstream.headers.get("content-type") || "application/json",
    };
    const sessionId = upstream.headers.get("mcp-session-id");
    if (sessionId) responseHeaders["Mcp-Session-Id"] = sessionId;

    return new Response(await upstream.text(), {
      status: upstream.status,
      headers: responseHeaders,
    });
  } catch (err) {
    return json({ error: `Upstream unreachable: ${(err as Error).message}` }, 502);
  }
};
