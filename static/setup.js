// Pairing UI logic. Loaded by setup.html, talks to the proxy's pairing
// HTTP server (which is the same origin as this page — both are served by
// the proxy's ephemeral pairing tunnel, so no CORS dance). The bearer token
// rides in the URL fragment so it never appears in server access logs or
// Referer headers.
//
// Discovery is proxy-mediated: the page POSTs host credentials to
// /pair/list-servers and /pair/discover, and the proxy runs the same
// MCP handshake it will use at runtime — including the real client's
// captured capabilities/clientInfo. This is the single source of truth
// for what the user sees during setup vs. what the proxy will see at
// runtime; capability-gated upstreams cannot diverge between the two.

(function () {
   'use strict';

   // Per-fetch budget for everything we send through /pair/*. The proxy
   // applies its own per-upstream budget on top of this; this guard is
   // about not pinning the page on a hung pairing tunnel.
   const DISCOVERY_TIMEOUT_MS = 30000;
   const TOOL_SEPARATOR = '__';

   const hashParams = new URLSearchParams(location.hash.slice(1));
   const pairingToken = hashParams.get('token');

   if (!pairingToken) {
      document.getElementById('step1').classList.remove('active');
      document.getElementById('error-section').style.display = 'block';
      throw new Error('Missing token');
   }

   // hosts: in-order list of { uid, id, tunnelUrl, authToken, servers, errors, capWarnings, status }
   //   uid is a transient DOM key; id is the user-facing host slug.
   //   servers is a map of name → { tools, prompts, resources, templates }.
   //   errors is a map of name → fatal discovery error string (server is
   //     unusable: tools/list failed, transport blew up, init handshake
   //     never completed). Drives the save-gate refusal.
   //   capWarnings is a map of name → optional-capability error string
   //     (prompts/list, resources/list, or resources/templates/list failed
   //     for an otherwise-healthy server). The runtime proxy retries these
   //     independently — surfacing them loudly so the user sees what is
   //     wrong, but NOT blocking save: blocking would refuse pairings the
   //     backend is explicitly designed to tolerate.
   const hosts = [];
   let hostUidCounter = 0;

   // Reconfigure pre-fill: when /pair/info reports an existing config, we
   // remember the prior server/tool allowlists here so renderServerTools()
   // can restore the checkbox state after re-discovery. undefined entries
   // mean "no prior pairing" → fall back to the default-everything-checked
   // behaviour.
   const priorSelections = { selectedServers: undefined, selectedTools: undefined };
   // Host ids captured at bootstrap. priorSelections is only consulted for
   // hosts whose id is in this set — so adding a new host, removing one,
   // or renaming an id falls back to default-everything-checked for that
   // host, while in-place reconfigure (only tunnelUrl/authToken changed)
   // still inherits priors correctly.
   const bootstrapHostIds = new Set();

   function pushHost(initial) {
      const uid = `h${++hostUidCounter}`;
      hosts.push({
         uid,
         id: initial?.id || '',
         tunnelUrl: initial?.tunnelUrl || '',
         authToken: initial?.authToken || '',
         servers: {},
         errors: {},
         capWarnings: {},
         status: '',
      });
      return uid;
   }

   function newHostRow(initialId) {
      pushHost({ id: initialId });
      renderHostRows();
   }

   function removeHost(uid) {
      const idx = hosts.findIndex((h) => h.uid === uid);
      if (idx === -1) return;
      hosts.splice(idx, 1);
      if (hosts.length === 0) newHostRow('host-1');
      else renderHostRows();
   }

   function renderHostRows() {
      const container = document.getElementById('hosts-container');
      container.innerHTML = '';
      for (const host of hosts) {
         const row = document.createElement('div');
         row.className = 'host-row';
         row.dataset.uid = host.uid;
         row.innerHTML = `
            <div class="host-head">
               <div class="host-id" data-role="title">Host ${esc(host.id || '(unnamed)')}</div>
               <button type="button" class="host-remove" data-action="remove">Remove</button>
            </div>
            <label for="id">Host ID</label>
            <input id="id" type="text" data-field="id" value="${esc(host.id)}" placeholder="dev-laptop" required pattern="(?!.*__)[A-Za-z0-9._\\-]+" title="Letters, digits, '.', '_', '-'. Must not contain '__' and must be unique across hosts." />

            <label for="tunnelUrl">Tunnel URL</label>
            <input id="tunnelUrl" type="url" data-field="tunnelUrl" value="${esc(host.tunnelUrl)}" placeholder="https://abc-xyz.trycloudflare.com" required />

            <label for="authToken">Auth Token</label>
            <input id="authToken" type="text" data-field="authToken" value="${esc(host.authToken)}" placeholder="Paste token from host agent" required />

            <div class="host-status ${host.status.startsWith('Error') ? 'error' : host.status.startsWith('Partial') ? 'partial' : host.status ? 'ok' : ''}">${esc(host.status)}</div>
         `;
         container.appendChild(row);
      }
      // Hide remove button when there's only one row.
      const removeBtns = container.querySelectorAll('[data-action="remove"]');
      if (removeBtns.length === 1) removeBtns[0].style.display = 'none';
      // Newly-added rows have no setCustomValidity state and removing a row
      // can resolve a duplicate flag on another; re-sweep so the UI is in
      // sync with the current id values.
      validateHostIdUniqueness();
   }

   document.getElementById('hosts-container').addEventListener('input', (e) => {
      const row = e.target.closest('.host-row');
      if (!row) return;
      const host = hosts.find((h) => h.uid === row.dataset.uid);
      if (!host) return;
      const field = e.target.dataset.field;
      if (!field) return;
      host[field] = e.target.value;
      if (field === 'id') {
         const title = row.querySelector('[data-role="title"]');
         if (title) title.textContent = `Host ${host.id || '(unnamed)'}`;
         // Cross-field constraint: re-evaluate the duplicate-id rule on
         // every keystroke. The pattern/required attributes already cover
         // single-input rules; this is the one check that needs to look at
         // its siblings, so we surface it through setCustomValidity rather
         // than waiting for submit.
         validateHostIdUniqueness();
      }
   });

   // Walk every host-id input and flag duplicates with setCustomValidity.
   // Calling setCustomValidity('') first clears any previous custom error
   // without disturbing the native pattern/required validation, so a field
   // that was duplicate but became unique falls back to its real validity
   // state (which may still be invalid for other reasons). The :user-invalid
   // CSS rule paints the border red uniformly across native and custom
   // failures.
   function validateHostIdUniqueness() {
      const inputs = document.querySelectorAll('input[data-field="id"]');
      const seen = new Map();
      for (const input of inputs) input.setCustomValidity('');
      for (const input of inputs) {
         const v = input.value.trim();
         if (!v) continue;
         const prev = seen.get(v);
         if (prev) {
            const msg = `Host id "${v}" is already used by another host`;
            input.setCustomValidity(msg);
            prev.setCustomValidity(msg);
         } else {
            seen.set(v, input);
         }
      }
   }

   document.getElementById('hosts-container').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action="remove"]');
      if (!btn) return;
      const row = btn.closest('.host-row');
      if (row) removeHost(row.dataset.uid);
   });

   document.getElementById('add-host-btn').addEventListener('click', () => {
      newHostRow(`host-${hosts.length + 1}`);
   });

   // Bootstrap: ask the proxy whether it's already configured. If so,
   // pre-fill the host inputs and remember the prior selections so the
   // user can tweak instead of retyping everything. We render a single
   // empty row immediately so the page is interactive even if /pair/info
   // is slow or fails — the prefill swaps the rows in once the response
   // lands.
   newHostRow('host-1');
   bootstrap().catch((err) => {
      console.warn('Could not load existing pairing config:', err);
   });

   async function bootstrap() {
      const resp = await pairingFetch('/pair/info', { method: 'GET' });
      if (!resp.ok) return;
      const info = await resp.json();
      const current = info && info.current;
      if (!current || !Array.isArray(current.hosts) || current.hosts.length === 0) return;
      hosts.length = 0;
      bootstrapHostIds.clear();
      for (const h of current.hosts) {
         pushHost({ id: h.id, tunnelUrl: h.tunnelUrl, authToken: h.authToken });
         bootstrapHostIds.add(h.id);
      }
      if (Array.isArray(current.selectedServers)) {
         priorSelections.selectedServers = new Set(current.selectedServers);
      }
      if (Array.isArray(current.selectedTools)) {
         priorSelections.selectedTools = new Set(current.selectedTools);
      }
      renderHostRows();
   }

   async function pairingFetch(path, init = {}) {
      const headers = {
         'Authorization': `Bearer ${pairingToken}`,
         'Content-Type': 'application/json',
         ...(init.headers || {}),
      };
      // Per-call timeout so a hung pairing tunnel can't lock up the page.
      const signal = init.signal || AbortSignal.timeout(DISCOVERY_TIMEOUT_MS);
      return fetch(path, { ...init, headers, signal });
   }

   async function pairPost(path, body) {
      const resp = await pairingFetch(path, {
         method: 'POST',
         body: JSON.stringify(body),
      });
      let payload = null;
      try {
         payload = await resp.json();
      } catch {
         // Non-JSON body (transport-layer 502 from the pairing server, etc.).
      }
      return { resp, payload };
   }

   // --- Step 1: Discover servers across all configured hosts ---
   document.getElementById('tunnel-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      // Native form validation has already gated us — the browser blocks
      // submit on any failing required/pattern/type=url constraint, and
      // setCustomValidity wires the cross-field duplicate-id check into
      // the same machinery. So by the time we get here every input is
      // valid; we only need to normalise whitespace and run discovery.
      const btn = document.getElementById('tunnel-btn');
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span> Discovering...';

      for (const host of hosts) {
         host.id = host.id.trim();
         host.tunnelUrl = host.tunnelUrl.replace(/\/+$/, '');
         host.authToken = host.authToken.trim();
      }

      // Parallel host discovery. discoverHost never throws — failures are
      // recorded on host.status / host.errors so one bad host doesn't
      // poison the batch. allSettled is defensive symmetry for the same
      // reason.
      await Promise.allSettled(hosts.map(discoverHost));
      renderServerTools();
      updateSaveState();

      // Strict gate: every host must be reachable AND every server's
      // tools/init must succeed. capWarnings (transient prompts/resources/
      // templates failures) are intentionally NOT blocking — the runtime
      // proxy retries them independently and the server stays online for
      // tools regardless. They're surfaced loudly in the per-server banner
      // so the user can see what was flaky, but they don't refuse the save
      // gate the backend is explicitly designed to accept.
      const failures = [];
      for (const h of hosts) {
         if (h.status.startsWith('Error')) {
            failures.push(`${h.id}: ${h.status.replace(/^Error:\s*/, '')}`);
            continue;
         }
         const serverNames = Object.keys(h.servers);
         if (serverNames.length === 0) {
            failures.push(`${h.id}: no servers exposed`);
            continue;
         }
         for (const name of serverNames) {
            if (h.errors[name]) failures.push(`${h.id}/${name}: ${h.errors[name]}`);
         }
      }
      if (failures.length > 0) {
         showError(`Fix these issues before continuing:\n• ${failures.join('\n• ')}`);
         btn.disabled = false;
         btn.textContent = 'Discover Servers';
         return;
      }
      document.getElementById('step1').classList.remove('active');
      document.getElementById('step2').classList.add('active');

      btn.disabled = false;
      btn.textContent = 'Discover Servers';
   });

   document.getElementById('back-btn').addEventListener('click', () => {
      // Returning to step 1 keeps the host inputs (id/tunnelUrl/authToken)
      // intact in the `hosts` array, so the user can correct one host's
      // token without retyping the others. Discovered servers/errors are
      // cleared because re-pressing "Discover" will repopulate them; we
      // don't want stale error banners hanging around if the underlying
      // host has since been fixed.
      for (const h of hosts) {
         h.servers = {};
         h.errors = {};
         h.capWarnings = {};
         h.status = '';
      }
      document.getElementById('servers-container').innerHTML = '';
      document.getElementById('step2').classList.remove('active');
      document.getElementById('step1').classList.add('active');
      renderHostRows();
   });

   async function discoverHost(host) {
      host.servers = {};
      host.errors = {};
      host.capWarnings = {};
      host.status = 'Discovering…';
      renderHostRows();

      // Step 1: list-servers. The proxy validates the tunnel URL allowlist
      // and returns either the host's server names or a structured error
      // (auth, transport, malformed body — distinguished server-side).
      let listResult;
      try {
         const { resp, payload } = await pairPost('/pair/list-servers', {
            tunnelUrl: host.tunnelUrl,
            authToken: host.authToken,
         });
         if (!resp.ok || !payload || !payload.ok) {
            const msg = (payload && payload.error)
               || (resp.status === 401 ? 'invalid auth token' : `proxy returned ${resp.status}`);
            host.status = `Error: ${msg}`;
            renderHostRows();
            return;
         }
         listResult = payload;
      } catch (err) {
         host.status = `Error: ${err.message || 'unreachable'}`;
         renderHostRows();
         return;
      }

      const serverNames = Array.isArray(listResult.servers) ? listResult.servers : [];
      if (serverNames.length === 0) {
         host.status = 'No servers exposed';
         renderHostRows();
         return;
      }

      // Step 2: per-server discovery. Servers within a host stay sequential
      // — the proxy mediates each call, so parallelising here just shifts
      // load onto the pairing HTTP server and the host's own MCP children
      // without speeding the user-perceived flow. Each server is recorded
      // independently so a single failure surfaces as a per-server error
      // banner without taking the host status with it.
      for (const name of serverNames) {
         await discoverServer(host, name);
      }
      const counts = aggregateCounts(host);
      // host.servers always carries an entry per advertised name (failed
      // discovery leaves a placeholder so the UI still surfaces the row);
      // host.errors is the canonical list of per-server FATAL failures
      // (tools/init failed); host.capWarnings tracks non-fatal optional-
      // capability errors. Status is derived from errors only — caps are
      // displayed but don't change the host's headline state.
      const totalCount = Object.keys(host.servers).length;
      const errorCount = Object.keys(host.errors).length;
      const warnCount = Object.keys(host.capWarnings).length;
      const warnSuffix = warnCount > 0 ? ` (${warnCount} with cap warning${warnCount === 1 ? '' : 's'})` : '';
      if (errorCount === 0) {
         host.status = `OK — ${totalCount} server(s), ${counts.tools} tool(s)${warnSuffix}`;
      } else if (errorCount === totalCount) {
         host.status = `Error: ${errorCount} server(s) failed discovery`;
      } else {
         host.status = `Partial — ${totalCount - errorCount} ok, ${errorCount} failed${warnSuffix}`;
      }
      renderHostRows();
   }

   function aggregateCounts(host) {
      let tools = 0, prompts = 0, resources = 0, templates = 0;
      for (const s of Object.values(host.servers)) {
         tools += s.tools.length;
         prompts += s.prompts.length;
         resources += s.resources.length;
         templates += s.templates.length;
      }
      return { tools, prompts, resources, templates };
   }

   async function discoverServer(host, name) {
      // Empty placeholder so the server still surfaces in the UI on
      // failure (with its banner) rather than disappearing entirely.
      host.servers[name] = { tools: [], prompts: [], resources: [], templates: [] };
      try {
         const { resp, payload } = await pairPost('/pair/discover', {
            tunnelUrl: host.tunnelUrl,
            authToken: host.authToken,
            serverName: name,
         });
         if (!resp.ok || !payload || !payload.ok) {
            // Fatal: tools/list or the init handshake failed. /pair/discover
            // now mirrors /pair/list-servers and returns 401 with
            // "invalid auth token" for upstream auth failures, so trust
            // the server-supplied error before falling back to the status.
            const msg = (payload && payload.error)
               || (resp.status === 401 ? 'invalid auth token' : `proxy returned ${resp.status}`);
            host.errors[name] = msg;
            return;
         }
         host.servers[name] = {
            tools: Array.isArray(payload.tools) ? payload.tools : [],
            prompts: Array.isArray(payload.prompts) ? payload.prompts : [],
            resources: Array.isArray(payload.resources) ? payload.resources : [],
            templates: Array.isArray(payload.resourceTemplates) ? payload.resourceTemplates : [],
         };
         // Per-capability errors come back as a map. These are NON-FATAL —
         // the runtime proxy retries each list independently and the
         // server stays online for tools regardless. Mirror them onto
         // host.capWarnings (separate from host.errors) so the user
         // loudly sees which optional list failed without the save gate
         // refusing the pairing.
         if (payload.capErrors) {
            const parts = [];
            for (const k of ['prompts', 'resources', 'resourceTemplates']) {
               if (payload.capErrors[k]) parts.push(`${k}: ${payload.capErrors[k]}`);
            }
            if (parts.length > 0) host.capWarnings[name] = parts.join('; ');
         }
      } catch (err) {
         host.errors[name] = err.message || String(err);
      }
   }

   function renderServerTools() {
      const container = document.getElementById('servers-container');
      container.innerHTML = '';

      for (const host of hosts) {
         const block = document.createElement('div');
         block.className = 'host-block';
         const head = document.createElement('div');
         head.className = 'host-block-head';
         head.textContent = `${host.id}`;
         block.appendChild(head);

         const serverNames = Object.keys(host.servers);
         if (serverNames.length === 0) {
            const hint = document.createElement('p');
            hint.className = 'hint';
            hint.textContent = 'No servers exposed';
            block.appendChild(hint);
            container.appendChild(block);
            continue;
         }

         // priorSelections is only authoritative for hosts whose id existed
         // at bootstrap. After the user adds, removes, or renames a host
         // the saved allowlist no longer applies to that host — fall back
         // to default-everything-checked instead of silently inheriting
         // stale unchecked state.
         const honorPriors = bootstrapHostIds.has(host.id);

         for (const serverName of serverNames) {
            const server = host.servers[serverName];
            const error = host.errors[serverName];
            const warning = host.capWarnings[serverName];
            const group = document.createElement('div');
            group.className = 'server-group';

            const title = document.createElement('h3');
            title.innerHTML = `<span class="scope">${esc(host.id)}/</span>${esc(serverName)}`;
            group.appendChild(title);
            const counts = document.createElement('div');
            counts.className = 'server-counts';
            counts.textContent = `${server.tools.length} tools, ${server.prompts.length} prompts, ${server.resources.length} resources, ${server.templates.length} templates`;
            group.appendChild(counts);

            // Server-level checkbox. Unchecked = the server is hidden
            // completely: tools, prompts, resources, templates, and the
            // routed methods that read them. Per-tool checkboxes act as
            // a finer-grained filter ON TOP of this. Disabled only on
            // FATAL errors — capWarnings (transient prompts/resources
            // failures) are loud but non-blocking so the user can still
            // pair a server whose tools succeeded. On a reconfigure for
            // a host present at bootstrap, the prior allowlist wins so
            // unchecked servers stay unchecked even if the host happens
            // to discover new capabilities since last pairing.
            const serverToggle = document.createElement('label');
            serverToggle.className = 'server-toggle';
            const serverCb = document.createElement('input');
            serverCb.type = 'checkbox';
            serverCb.dataset.role = 'server';
            serverCb.dataset.host = host.id;
            serverCb.dataset.server = serverName;
            const hasAnything = server.tools.length + server.prompts.length + server.resources.length + server.templates.length > 0;
            const serverKey = `${host.id}${TOOL_SEPARATOR}${serverName}`;
            const priorServerChecked = honorPriors && priorSelections.selectedServers
               ? priorSelections.selectedServers.has(serverKey)
               : hasAnything;
            serverCb.checked = !error && priorServerChecked;
            serverCb.disabled = !!error;
            serverCb.addEventListener('change', () => {
               group.classList.toggle('disabled', !serverCb.checked);
               updateSaveState();
            });
            const labelText = document.createElement('span');
            labelText.textContent = 'Expose this server through the proxy';
            serverToggle.appendChild(serverCb);
            serverToggle.appendChild(labelText);
            group.appendChild(serverToggle);

            if (error) {
               const banner = document.createElement('div');
               banner.className = 'banner error';
               banner.style.fontSize = '0.8rem';
               banner.style.marginBottom = '0.5rem';
               banner.textContent = `Discovery failed: ${error}`;
               group.appendChild(banner);
            }

            // Loud-but-non-blocking warning for non-fatal capability
            // failures. The runtime proxy will retry these on its own
            // schedule; we surface them here so the user understands
            // why a server has fewer prompts/resources than expected,
            // without refusing to pair the server's tools.
            if (warning && !error) {
               const wbanner = document.createElement('div');
               wbanner.className = 'banner warning';
               wbanner.style.fontSize = '0.8rem';
               wbanner.style.marginBottom = '0.5rem';
               wbanner.textContent = `Capability list(s) failed (will retry at runtime): ${warning}`;
               group.appendChild(wbanner);
            }

            if (server.tools.length > 0) {
               group.appendChild(buildToolList(host.id, serverName, server.tools));
            } else if (!error) {
               const hint = document.createElement('p');
               hint.className = 'hint';
               hint.textContent = server.prompts.length + server.resources.length + server.templates.length > 0
                  ? 'No tools (prompts/resources only).'
                  : 'No exposable capabilities.';
               group.appendChild(hint);
            }

            if (!serverCb.checked) group.classList.add('disabled');
            block.appendChild(group);
         }
         container.appendChild(block);
      }
   }

   function buildToolList(hostId, serverName, tools) {
      // priorSelections is consulted only for hosts captured at bootstrap.
      // For hosts the user added/renamed since, fall back to default-checked
      // (same rule as the server-level checkbox).
      const honorPriors = bootstrapHostIds.has(hostId);
      const wrapper = document.createDocumentFragment();
      const actions = document.createElement('div');
      actions.className = 'select-actions';
      const allBtn = document.createElement('button');
      allBtn.type = 'button';
      allBtn.textContent = 'Select all';
      allBtn.addEventListener('click', () => toggleAllTools(hostId, serverName, true));
      const noneBtn = document.createElement('button');
      noneBtn.type = 'button';
      noneBtn.textContent = 'Select none';
      noneBtn.addEventListener('click', () => toggleAllTools(hostId, serverName, false));
      actions.appendChild(allBtn);
      actions.appendChild(noneBtn);
      wrapper.appendChild(actions);

      const list = document.createElement('div');
      list.className = 'tool-list';
      for (const tool of tools) {
         const item = document.createElement('div');
         item.className = 'tool-item';
         const cbId = `tool-${hostId}-${serverName}-${tool.name}`;
         const toolKey = `${hostId}${TOOL_SEPARATOR}${serverName}${TOOL_SEPARATOR}${tool.name}`;
         const checked = honorPriors && priorSelections.selectedTools
            ? priorSelections.selectedTools.has(toolKey)
            : true;
         item.innerHTML = `
            <div class="tool-check">
               <input type="checkbox" id="${esc(cbId)}" data-role="tool" data-host="${esc(hostId)}" data-server="${esc(serverName)}" data-tool="${esc(tool.name)}"${checked ? ' checked' : ''}>
            </div>
            <label class="tool-label" for="${esc(cbId)}">
               <span class="tool-name">${esc(tool.name)}</span>
               ${tool.description ? `<span class="tool-desc">${esc(tool.description)}</span>` : ''}
            </label>
         `;
         list.appendChild(item);
      }
      wrapper.appendChild(list);
      return wrapper;
   }

   function toggleAllTools(hostId, serverName, checked) {
      const safeHost = CSS.escape(hostId);
      const safeServer = CSS.escape(serverName);
      document.querySelectorAll(`input[data-role="tool"][data-host="${safeHost}"][data-server="${safeServer}"]`).forEach((cb) => cb.checked = checked);
      updateSaveState();
   }

   function updateSaveState() {
      const serverChecked = document.querySelectorAll('input[data-role="server"]:checked').length;
      const btn = document.getElementById('save-btn');
      const hint = document.getElementById('save-hint');
      btn.disabled = serverChecked === 0;
      hint.textContent = serverChecked === 0
         ? 'Select at least one server to continue.'
         : `${serverChecked} server${serverChecked === 1 ? '' : 's'} selected.`;
   }

   document.getElementById('servers-container').addEventListener('change', (e) => {
      if (e.target instanceof HTMLInputElement && e.target.dataset.role) updateSaveState();
   });

   document.getElementById('save-btn').addEventListener('click', saveConfig);

   async function saveConfig() {
      const btn = document.getElementById('save-btn');
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span> Saving...';

      // Build the server-level allow list. Each entry is
      // `<hostId>__<serverName>` — the same shape the runtime proxy
      // expects in PairingConfig.selectedServers.
      const selectedServers = [];
      const allowedKeys = new Set();
      document.querySelectorAll('input[data-role="server"]:checked').forEach((cb) => {
         const key = `${cb.dataset.host}${TOOL_SEPARATOR}${cb.dataset.server}`;
         selectedServers.push(key);
         allowedKeys.add(key);
      });

      // Tool-level allow list, scoped to allowed servers. Tools whose
      // server isn't in selectedServers are dropped on the way out so
      // an unchecked server can't smuggle a tool through.
      const selectedTools = [];
      document.querySelectorAll('input[data-role="tool"]:checked').forEach((cb) => {
         const serverKey = `${cb.dataset.host}${TOOL_SEPARATOR}${cb.dataset.server}`;
         if (!allowedKeys.has(serverKey)) return;
         selectedTools.push(`${serverKey}${TOOL_SEPARATOR}${cb.dataset.tool}`);
      });

      const config = {
         hosts: hosts.map((h) => ({ id: h.id, tunnelUrl: h.tunnelUrl, authToken: h.authToken })),
         selectedServers,
         selectedTools,
         sealed: true,
      };

      try {
         const resp = await pairingFetch('/pair/complete', {
            method: 'POST',
            body: JSON.stringify(config),
         });
         const result = await resp.json().catch(() => ({}));

         if (resp.ok && result.ok) {
            showSuccess(config);
         } else {
            showError(result.error || `Failed to save (${resp.status})`);
         }
      } catch (err) {
         showError(err.message);
      }

      btn.disabled = false;
      btn.textContent = 'Complete Setup';
   }

   function esc(s) {
      const d = document.createElement('div');
      d.textContent = s == null ? '' : String(s);
      return d.innerHTML;
   }

   function showSuccess(data) {
      document.getElementById('step1').classList.remove('active');
      document.getElementById('step2').classList.remove('active');
      const r = document.getElementById('result-section');
      r.style.display = 'block';
      const hostList = data.hosts.map((h) => `${esc(h.id)} → <strong>${esc(h.tunnelUrl)}</strong>`).join('<br>');
      r.innerHTML = `
         <div class="banner ok">
            Configuration applied!<br>
            ${hostList}<br>
            Servers: ${data.selectedServers.length} selected<br>
            Tools: ${data.selectedTools.length} selected<br><br>
            Return to your terminal — the proxy is now connected.
            The pairing tunnel has been torn down.
         </div>
      `;
   }

   function showError(msg) {
      const r = document.getElementById('result-section');
      r.style.display = 'block';
      // Preserve newlines so multi-line gating errors render as a list
      // instead of one wall of text. esc() runs first so the original
      // string can't smuggle markup; then we convert just the newlines.
      const html = esc(msg).replace(/\n/g, '<br>');
      r.innerHTML = `<div class="banner error">${html}</div>`;
      setTimeout(() => { r.style.display = 'none'; }, 4000);
   }
})();
