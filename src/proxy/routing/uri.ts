// Resource URIs are namespaced with the upstream's (hostId, serverName) so
// routing is structural — every URI the agent ever sees encodes its origin
// server, and `resources/read` / `subscribe` / completion can be dispatched
// without consulting any routing table or template engine. This eliminates
// the cross-server overlap problem that first-match-wins template routing
// had before: two upstreams exposing `file:///{path}` are now distinct
// `mcp+host://hostA/srvA/file:///{path}` and `mcp+host://hostB/srvB/...`
// strings the agent cannot conflate.
//
// Format: `mcp+host://<hostId>/<serverName>/<originalUri>` — the original
// URI is appended verbatim. hostId and serverName are validated upstream
// to match `[A-Za-z0-9._-]+` (see SERVER_NAME_PATTERN in shared/protocol),
// so they cannot contain `/` and the parse is unambiguous.

const SCHEME = "mcp+host://";

export function wrapResourceUri(hostId: string, serverName: string, original: string): string {
  return `${SCHEME}${hostId}/${serverName}/${original}`;
}

export interface UnwrappedResourceUri {
  hostId: string;
  serverName: string;
  originalUri: string;
}

export function unwrapResourceUri(wrapped: string): UnwrappedResourceUri | null {
  if (!wrapped.startsWith(SCHEME)) return null;
  const rest = wrapped.slice(SCHEME.length);
  const firstSlash = rest.indexOf("/");
  if (firstSlash <= 0) return null;
  const hostId = rest.slice(0, firstSlash);
  const afterHost = rest.slice(firstSlash + 1);
  const secondSlash = afterHost.indexOf("/");
  if (secondSlash <= 0) return null;
  const serverName = afterHost.slice(0, secondSlash);
  const originalUri = afterHost.slice(secondSlash + 1);
  if (!originalUri) return null;
  return { hostId, serverName, originalUri };
}
