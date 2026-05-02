# MCP Proxy

MCP proxy bridge that forwards [Model Context Protocol](https://modelcontextprotocol.io/) requests across network boundaries via [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/).

Works with any MCP client (Claude Code, Cursor, Windsurf, Cline, etc.) and any OS.

## Why

MCP servers that need local resources (Chrome browser, filesystem, GPU, etc.) can't run inside containers or remote environments. This proxy bridges the gap:

```
MCP Client (container/remote)
    |  stdio
Proxy Server (same machine as client)
    |  HTTP via Cloudflare Tunnel
Host Agent (machine with the resources)
    |  stdio
Real MCP Servers (chrome-devtools, filesystem, etc.)
```

## Quick start

### 1. Start the host agent

On the machine where your MCP servers run:

```bash
npx -p @silver886/mcp-proxy host --config config.json --tunnel
```

Example `config.json`:

```json
{
  "servers": {
    "chrome-devtools": {
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp@latest"],
      "shell": true
    },
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"],
      "shell": true
    }
  }
}
```

The host agent prints a tunnel URL and auth token. Keep it running.

### 2. Configure your MCP client

Add the proxy as a stdio MCP server. The client launches it automatically.

**Claude Code** (`claude mcp add` or `.claude.json`):

```json
{
  "mcpServers": {
    "chrome-devtools": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "-p", "@silver886/mcp-proxy", "proxy"]
    }
  }
}
```

**Cursor / Windsurf / other MCP clients** — same pattern, add as a stdio server with `npx -p @silver886/mcp-proxy proxy` as the command.

### 3. Pair

The proxy starts idle. Ask your MCP client to call the `configure` tool (or
prompt) — the proxy then spins up an ephemeral pairing tunnel that serves
both the setup page and the pairing API on the same origin, and prints a
setup URL to stderr:

```
Configure at: https://abc-xyz.trycloudflare.com/#token=...
```

Open the URL in a browser. Add one or more host agents — each row takes a
host id (a slug you choose), tunnel URL, and auth token — discover servers,
and select tools. The proxy applies the config and tears down the pairing
tunnel automatically.

A single proxy can fan out to multiple hosts at once. Tools are namespaced
as `<hostId>__<serverName>__<toolName>` so the same server name can appear
on more than one host without collision. (The host agent itself stays
single-proxy, in line with MCP's one-server-one-client model.)

## Architecture

### Components

| Component | Role | Runs on |
|-----------|------|---------|
| **Host Agent** (`host`) | HTTP-to-stdio bridge. Spawns MCP servers, manages sessions, serves MCP Streamable HTTP over a long-lived Cloudflare tunnel. | Machine with resources |
| **Proxy Server** (`proxy`) | Stdio MCP server. Idle at startup; on `configure` it spins up an ephemeral pairing tunnel via the bundled wrapper, serves the setup page on that same tunnel, accepts the pairing handshake, then talks to the host's tunnel for ongoing MCP traffic. | Machine with MCP client |

### Pairing flow (lazy-start, single-origin)

```
1. MCP client spawns the proxy (stdio). Proxy is idle — no tunnel, no polling.
2. Agent calls the `configure` tool. Proxy spawns a Node wrapper that owns
   a `cloudflared` quick tunnel pointing at a local pairing HTTP server.
   That HTTP server serves both the setup page (GET /) and the pairing API
   (POST /pair/list-servers, POST /pair/discover, POST /pair/complete) on
   the same origin.
3. Wrapper prints the tunnel URL. Proxy mints a bearer token and emits a
   setup URL — `<tunnel>/#token=<token>`. Token rides in the URL fragment
   so it never appears in server access logs or Referer headers.
4. User opens the setup URL. The page is served by the proxy itself, so
   browser fetches to the pairing API are same-origin — no CORS dance.
   Pairing endpoints are gated by the bearer token.
5. Through the pairing API, the page discovers servers and tools on each
   configured host's MCP tunnel, then submits the final configuration
   (a list of hosts plus the selected tools).
6. Proxy applies the config, signals the wrapper to tear down `cloudflared`,
   and shuts the pairing HTTP server. From here on the proxy talks only to
   the host's long-lived MCP tunnel — no public infrastructure, no polling.
```

The wrapper guarantees `cloudflared` cannot outlive the proxy. When the
proxy exits (or the wrapper sees stdin EOF), the wrapper kills the
`cloudflared` child immediately. Detection latency is 0ms on
Linux, macOS, and Windows.

### Protocol

- **Client <-> Proxy**: stdio (JSON-RPC, newline-delimited)
- **Proxy <-> Host Agent**: HTTP via Cloudflare Tunnel (MCP Streamable HTTP)
- **Host Agent <-> MCP Servers**: stdio (JSON-RPC, newline-delimited)
- **Session management**: `Mcp-Session-Id` header between proxy and host agent

## Configuration

### Host agent config

```json
{
  "servers": {
    "server-name": {
      "command": "node",
      "args": ["path/to/server.js"],
      "env": { "API_KEY": "..." },
      "shell": false
    }
  },
  "host": "127.0.0.1",
  "port": 6270
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `servers` | _(required)_ | Map of server name to spawn config |
| `servers.*.command` | _(required)_ | Executable to spawn |
| `servers.*.args` | `[]` | Command arguments |
| `servers.*.env` | `{}` | Extra environment variables |
| `servers.*.shell` | `false` | Use shell for PATH resolution (set `true` for `npx`, etc.) |
| `host` | `127.0.0.1` | Listen address |
| `port` | `6270` | Listen port |

### CLI

**Host agent:**

```
host [options]

--config <path>    Config file (default: config.json)
--tunnel           Start a Cloudflare quick tunnel
--timeout <ms>     MCP request timeout (default: 120000)
```

**Proxy server:**

```
proxy
```

The proxy takes no flags. The setup page is bundled with the npm package
and served by the proxy itself on the ephemeral pairing tunnel — there's
no external infrastructure to point at and no env vars to configure.

The pairing handshake runs entirely between the browser and the proxy's
ephemeral pairing tunnel, gated by a bearer token from the URL fragment.

Server names exposed by the host agent — and host ids you assign during
pairing — must match `[A-Za-z0-9._-]+` so they stay safe inside URLs and
the proxy's tool-name routing. Names that violate the policy are rejected
at host startup or pairing time.

### Server-initiated requests

The proxy fully bridges server→client requests (sampling, elicitation,
roots/list, ping, …). When an upstream MCP server sends a request over its
SSE notification channel, the proxy remaps the request id, forwards it to
the MCP client, and routes the client's response back to the originating
host session with the original id restored. The real client's
`capabilities` are forwarded to each upstream server during initialize so
servers see the actual feature support rather than an empty capabilities
object.

## Error codes

| Code | Name | Meaning |
|------|------|---------|
| `-32603` | `INTERNAL` | Unhandled server error |
| `-32001` | `PROXY_NOT_CONFIGURED` | Proxy hasn't been paired yet |
| `-32002` | `HOST_UNREACHABLE` | Can't reach host agent via tunnel |
| `-32003` | `PROCESS_EXITED` | MCP server child process died |
| `-32004` | `PROCESS_NOT_RUNNING` | Child process isn't running |
| `-32005` | `REQUEST_TIMEOUT` | MCP server didn't respond in time |
