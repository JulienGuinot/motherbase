# MCP server

This documentation now lives on the website, which is the single source of truth
for product documentation.

<https://www.motherbase.site/docs/platform/mcp/>

## Where the code lives (contributors)

The server lives in the CLI package: `packages/cli/src/mcp/protocol.js` (transport)
and `packages/cli/src/mcp/tools.js` (tools; the console and storage tools are in
`platform-tools.js` and `storage-tools.js` beside it). There is no separate `packages/mcp`:
the CLI already owns context resolution and the admin HTTP layer, so a second
package would have duplicated both.
