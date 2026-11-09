'use strict';

// The Supabase MCP server's account and project tools, for what Motherbase
// already serves. Same names and arguments where they fit, so an agent that
// knows Supabase's tools can use these without learning new ones.
//
// Two scopes, because a session may have either or both:
//   - console tools (organizations, projects) go through `api.consoleRequest`
//     and need a console login, not a linked project;
//   - project tools act on the linked (or direct-mode) project through
//     `api.adminRequest`, like every tool in tools.js.
//
// Not here, because there is nothing behind them yet: branching, cost
// confirmation, docs search, and Supabase's per-call `project_id` on project
// tools (a session serves the one project it was started for).

const api = require('../api');
const { upsertFunction } = require('../commands/functions');

const str = description => ({ type: 'string', description });
const noArgs = { type: 'object', properties: {} };
const enc = encodeURIComponent;

const FUNCTION_NAME = /^[a-z0-9][a-z0-9-]*$/;

/** A project from the console listing, by name or id; the listing is the only read. */
async function findProject(ctx, id) {
  const projects = await api.consoleRequest(ctx, 'GET', '/projects');
  const project = (Array.isArray(projects) ? projects : []).find(p => p.name === id || p.id === id);
  if (!project) throw new Error(`No project "${id}" on this console. list_projects shows the ones you can see.`);
  return project;
}

/** An edge function by the slug Supabase's tools take: its route, name or id. */
async function findFunction(ctx, slug) {
  const listing = await api.adminRequest(ctx, 'GET', '/edge-functions');
  const fn = ((listing && listing.functions) || []).find(f => f.route === slug || f.name === slug || f.id === slug);
  if (!fn) throw new Error(`No edge function "${slug}". list_edge_functions shows what is deployed.`);
  return fn;
}

/**
 * The single source file a function deploys as. Supabase's tool takes a file
 * set; Motherbase stores one module per function, so a set that needs more than
 * its entrypoint is refused rather than deployed half-complete.
 */
function entrypointSource(files, entrypoint) {
  if (!Array.isArray(files) || !files.length) throw new Error('files must hold at least the entrypoint.');
  const wanted = entrypoint || 'index.ts';
  // A lone file is the entrypoint whatever it is called, unless one was named.
  const entry = files.find(f => f && f.name === wanted) || (!entrypoint && files.length === 1 ? files[0] : undefined);
  if (!entry) throw new Error(`No file named ${wanted} among files.`);
  if (files.length > 1) {
    throw new Error('Edge functions deploy as a single module here: inline the other files into the entrypoint.');
  }
  return String(entry.content);
}

/** Account-level reads. Need a console login. */
function consoleReadTools(ctx) {
  return [
    {
      name: 'list_organizations',
      description: 'List the organizations the logged-in operator belongs to, with their role and project count.',
      inputSchema: noArgs,
      run: () => api.consoleRequest(ctx, 'GET', '/orgs'),
    },
    {
      name: 'get_organization',
      description: 'Details of one organization: name, members count and settings.',
      inputSchema: { type: 'object', properties: { id: str('Organization id.') }, required: ['id'] },
      run: args => api.consoleRequest(ctx, 'GET', `/orgs/${enc(args.id)}`),
    },
    {
      name: 'list_projects',
      description: 'List the projects on this console the operator can see, with their status and domain.',
      inputSchema: {
        type: 'object',
        properties: { organization_id: str('Only the projects of this organization.') },
      },
      run: args => api.consoleRequest(ctx, 'GET', '/projects', { query: { org: args.organization_id } }),
    },
    {
      name: 'get_project',
      description: 'Details of one project: status, domain and organization.',
      inputSchema: { type: 'object', properties: { id: str('Project name or id.') }, required: ['id'] },
      run: args => findProject(ctx, args.id),
    },
  ];
}

/** Account-level changes. Only with `--write`. */
function consoleWriteTools(ctx) {
  return [
    {
      name: 'create_project',
      description:
        'Create a project: a new, isolated stack (database, auth, storage, functions). Provisioning takes a while; poll get_project for its status.',
      inputSchema: {
        type: 'object',
        properties: {
          name: str('Project name: lowercase letters, digits and hyphens. Also its id.'),
          organization_id: str('Organization to create it in. Defaults to the default organization.'),
          domain: str('Domain it is served on. Required unless the console runs in dev mode.'),
        },
        required: ['name'],
      },
      run: args =>
        api.consoleRequest(ctx, 'POST', '/projects', {
          body: { name: args.name, domain: args.domain, orgId: args.organization_id },
        }),
    },
    {
      name: 'pause_project',
      description: 'Stop a project\'s containers. Its data is kept; restore_project starts it again.',
      inputSchema: { type: 'object', properties: { project_id: str('Project name or id.') }, required: ['project_id'] },
      run: args => api.consoleRequest(ctx, 'POST', `/projects/${enc(args.project_id)}/stop`),
    },
    {
      name: 'restore_project',
      description: 'Start a paused project again.',
      inputSchema: { type: 'object', properties: { project_id: str('Project name or id.') }, required: ['project_id'] },
      run: args => api.consoleRequest(ctx, 'POST', `/projects/${enc(args.project_id)}/start`),
    },
  ];
}

/** Reads on the served project. */
function projectReadTools(ctx) {
  return [
    {
      name: 'get_project_url',
      description: 'The API URL (and realtime URL) a client app uses to reach this project.',
      inputSchema: noArgs,
      run: async () => {
        const info = await api.adminRequest(ctx, 'GET', '/connect-info');
        return { url: info.apiUrl, realtimeUrl: info.wsUrl };
      },
    },
    {
      name: 'get_publishable_keys',
      description:
        'The publishable API keys a client app ships with. Safe to embed: row level security decides what they reach. Secret keys are never returned.',
      inputSchema: noArgs,
      run: async () => {
        const data = await api.adminRequest(ctx, 'GET', '/api-keys');
        const keys = ((data && data.keys) || [])
          .filter(k => k.type === 'publishable' && !k.revokedAt)
          .map(k => ({ name: k.name, api_key: k.token }));
        return { keys };
      },
    },
    {
      name: 'list_extensions',
      description: 'Postgres extensions available in the project database, and which are installed.',
      inputSchema: noArgs,
      run: () => api.adminRequest(ctx, 'GET', '/schema/extensions'),
    },
    {
      name: 'list_migrations',
      description: 'Schema migrations recorded for the project, with their status and when they were applied.',
      inputSchema: noArgs,
      run: () => api.adminRequest(ctx, 'GET', '/migrations'),
    },
    {
      name: 'list_edge_functions',
      description: 'Deployed edge functions: name, route, whether enabled, and limits. get_edge_function returns the source.',
      inputSchema: noArgs,
      run: async () => {
        const data = await api.adminRequest(ctx, 'GET', '/edge-functions');
        // The source of every function is noise in a listing; get_edge_function has it.
        const functions = ((data && data.functions) || []).map(({ code: _code, ...meta }) => meta);
        return { functions };
      },
    },
    {
      name: 'get_edge_function',
      description: 'One deployed edge function with its source code.',
      inputSchema: {
        type: 'object',
        properties: { function_slug: str('The function\'s route (also accepts its name or id).') },
        required: ['function_slug'],
      },
      run: async args => {
        const fn = await findFunction(ctx, args.function_slug);
        return api.adminRequest(ctx, 'GET', `/edge-functions/${enc(fn.id)}`);
      },
    },
    {
      name: 'list_storage_buckets',
      description: 'Storage buckets with their visibility, quota and usage.',
      inputSchema: noArgs,
      run: () => api.adminRequest(ctx, 'GET', '/storage/buckets'),
    },
  ];
}

/** Changes to the served project. Only with `--write`. */
function projectWriteTools(ctx) {
  return [
    {
      name: 'deploy_edge_function',
      description:
        'Deploy an edge function, creating it or replacing the one at the same route. The name is also its route. The code runs on Deno with the Web platform; export a default handler (req: Request) => Response.',
      inputSchema: {
        type: 'object',
        properties: {
          name: str('Function name: lowercase letters, digits and hyphens.'),
          entrypoint_path: str('Which of files is the entrypoint. Defaults to index.ts.'),
          files: {
            type: 'array',
            description: 'The function source: its single entrypoint module.',
            items: {
              type: 'object',
              properties: { name: str('File name, e.g. index.ts.'), content: str('File contents.') },
              required: ['name', 'content'],
            },
          },
        },
        required: ['name', 'files'],
      },
      run: args => {
        if (!FUNCTION_NAME.test(args.name || '')) {
          throw new Error('Function names are lowercase letters, digits and hyphens (the name is also the route).');
        }
        const code = entrypointSource(args.files, args.entrypoint_path);
        return upsertFunction(ctx, { name: args.name, route: args.name, code });
      },
    },
  ];
}

module.exports = { consoleReadTools, consoleWriteTools, projectReadTools, projectWriteTools, entrypointSource };
