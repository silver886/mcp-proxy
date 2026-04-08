interface Env {
  MCP_CONFIG: KVNamespace;
}

interface PairingConfig {
  tunnelUrl: string;
  serverName: string;
  createdAt: number;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const TTL = 900; // 15 minutes

// OPTIONS — CORS preflight
export const onRequestOptions: PagesFunction<Env> = async () => {
  return new Response(null, { headers: CORS });
};

// GET /api/config/:code — poll for config
export const onRequestGet: PagesFunction<Env> = async (context) => {
  const code = context.params.code as string;
  const value = await context.env.MCP_CONFIG.get(`pair:${code}`);

  if (!value) {
    return new Response(JSON.stringify({ status: "pending" }), {
      status: 404,
      headers: { "Content-Type": "application/json", ...CORS },
    });
  }

  return new Response(value, {
    headers: { "Content-Type": "application/json", ...CORS },
  });
};

// POST /api/config/:code — store config
export const onRequestPost: PagesFunction<Env> = async (context) => {
  const code = context.params.code as string;

  let body: { tunnelUrl: string; serverName: string };
  try {
    body = await context.request.json<{ tunnelUrl: string; serverName: string }>();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...CORS },
    });
  }

  if (!body.tunnelUrl || !body.serverName) {
    return new Response(JSON.stringify({ error: "tunnelUrl and serverName required" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...CORS },
    });
  }

  const config: PairingConfig = {
    tunnelUrl: body.tunnelUrl.replace(/\/+$/, ""),
    serverName: body.serverName.trim(),
    createdAt: Date.now(),
  };

  await context.env.MCP_CONFIG.put(`pair:${code}`, JSON.stringify(config), {
    expirationTtl: TTL,
  });

  return new Response(JSON.stringify({ ok: true }), {
    headers: { "Content-Type": "application/json", ...CORS },
  });
};

// DELETE /api/config/:code — cleanup
export const onRequestDelete: PagesFunction<Env> = async (context) => {
  const code = context.params.code as string;
  await context.env.MCP_CONFIG.delete(`pair:${code}`);
  return new Response(JSON.stringify({ ok: true }), {
    headers: { "Content-Type": "application/json", ...CORS },
  });
};
