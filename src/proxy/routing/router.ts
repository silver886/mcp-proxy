import type { Resource, ResourceTemplate, ToolRoute } from "../core/types.js";

// ResourceRouter is now a bookkeeping store — routing itself is structural
// (see resource-uri.ts: every URI the agent sees is wrapped with its
// owning hostId/serverName, so unwrap → route is a pure parse, no map
// lookup, no template engine).
//
// What this class still owns:
//   - The exact-URI list per (host, server), used by getAggregatedResources
//     to render the agent-facing resources/list (with origin-wrapped URIs).
//     Stored as an array, not a URI-keyed map, because two servers can
//     legitimately expose the same concrete URI — both must surface under
//     their own envelopes (hence the wrap step in filtering.ts).
//   - The template list per (host, server), used the same way for
//     resources/templates/list.
//   - Cross-origin collision logging when two servers happen to expose
//     the same raw URI or template string. The wrap step makes them
//     distinct on the wire, so this is informational only — no longer
//     load-bearing for routing correctness.
export class ResourceRouter {
  private exact: Array<{ uri: string; route: ToolRoute }> = [];
  private exactByUri = new Map<string, ToolRoute>();
  private templates: Array<{ uriTemplate: string; route: ToolRoute }> = [];
  private templatesByUri = new Map<string, ToolRoute>();

  clear(): void {
    this.exact = [];
    this.exactByUri.clear();
    this.templates = [];
    this.templatesByUri.clear();
  }

  // Add one server's resources + templates. Returns a list of human-readable
  // collision messages that the caller should write to stderr — kept out of
  // this module so logging stays at the orchestrator layer.
  add(
    hostId: string,
    serverName: string,
    resources: Resource[],
    templates: ResourceTemplate[],
  ): string[] {
    const log: string[] = [];
    const route = (originalName: string): ToolRoute => ({ hostId, serverName, originalName });

    for (const r of resources) {
      const existing = this.exactByUri.get(r.uri);
      if (existing && (existing.hostId !== hostId || existing.serverName !== serverName)) {
        log.push(
          `Resource URI also exposed by ${hostId}/${serverName}: ${r.uri} (already advertised by ${existing.hostId}/${existing.serverName}); both surfaced under their own envelopes`,
        );
      }
      const rt = route(r.uri);
      this.exact.push({ uri: r.uri, route: rt });
      // First-writer wins for the dedup map — only used to detect repeats.
      // The list above is the source of truth for the agent-facing listing.
      if (!existing) this.exactByUri.set(r.uri, rt);
    }

    for (const t of templates) {
      const existing = this.templatesByUri.get(t.uriTemplate);
      if (existing && (existing.hostId !== hostId || existing.serverName !== serverName)) {
        log.push(
          `Resource template also exposed by ${hostId}/${serverName}: ${t.uriTemplate} (already advertised by ${existing.hostId}/${existing.serverName}); both surfaced under their own envelopes`,
        );
      }
      const r = route(t.uriTemplate);
      this.templates.push({ uriTemplate: t.uriTemplate, route: r });
      if (!existing) this.templatesByUri.set(t.uriTemplate, r);
    }

    return log;
  }

  // For getAggregatedResources / templates list. Iteration order matches
  // insertion (array semantics), which matches the order servers were added
  // in rebuildToolRoute — stable across runs. Two servers exposing the same
  // raw URI yield two distinct entries; wrapResourceUri disambiguates them
  // on the way out.
  exactEntries(): Array<{ uri: string; route: ToolRoute }> {
    return this.exact.map(({ uri, route }) => ({ uri, route }));
  }

  templateEntries(): Array<{ uriTemplate: string; route: ToolRoute }> {
    return this.templates.map(({ uriTemplate, route }) => ({ uriTemplate, route }));
  }
}
