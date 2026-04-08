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

When the MCP client spawns the proxy, the proxy prints a setup URL to stderr:

```
Configure at: https://mcp-proxy.pages.dev/setup.html#code=...&key=...
```

Open the URL in a browser. Enter the tunnel URL and auth token from step 1, discover servers, and select tools. The proxy picks up the config automatically and starts forwarding MCP requests.

## Architecture

### Components

| Component | Role | Runs on |
|-----------|------|---------|
| **Host Agent** (`host`) | HTTP-to-stdio bridge. Spawns MCP servers, manages sessions, serves MCP Streamable HTTP. | Machine with resources |
| **Proxy Server** (`proxy`) | Stdio MCP server that forwards requests to the host agent via tunnel. | Machine with MCP client |
| **Config Page** (Cloudflare Pages) | Device-code pairing. Stores encrypted config in KV with 15-min TTL. | Cloudflare edge |

### Pairing flow

```
1. MCP client spawns the proxy (stdio)
2. Proxy generates pairing code + encryption key, polls Pages RPC
3. User opens setup URL in browser (code + key in URL hash, never sent to server)
4. User enters tunnel URL + auth token, discovers servers, selects tools
5. Setup page encrypts config client-side, stores ciphertext in KV via RPC
6. Proxy polls, decrypts config, discovers servers, starts forwarding
```

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
proxy [options]

--pages-url <url>   Config page URL (default: https://mcp-proxy.pages.dev)
```

Also reads `MCP_PROXY_PAGES_URL` environment variable.

## Error codes

| Code | Name | Meaning |
|------|------|---------|
| `-32603` | `INTERNAL` | Unhandled server error |
| `-32001` | `PROXY_NOT_CONFIGURED` | Proxy hasn't been paired yet |
| `-32002` | `HOST_UNREACHABLE` | Can't reach host agent via tunnel |
| `-32003` | `PROCESS_EXITED` | MCP server child process died |
| `-32004` | `PROCESS_NOT_RUNNING` | Child process isn't running |
| `-32005` | `REQUEST_TIMEOUT` | MCP server didn't respond in time |

## Development

```bash
pnpm install
pnpm run build
pnpm publish --access public --no-git-checks
```
