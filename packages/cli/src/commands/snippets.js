'use strict';

const api = require('../api');
const { output, requireArg } = require('./_util');

// SQL Editor snippets, kept by the project (see the Studio's SQL Editor). Like
// `supabase snippets`: list what you can see, download one as plain SQL.
const subcommands = {
  list: {
    summary: 'List SQL snippets (yours and the ones shared with the project)',
    usage: 'motherbase snippets list',
    async run(ctx) {
      const data = await api.adminRequest(ctx, 'GET', '/content', { query: { type: 'sql' } });
      const items = (data && data.items) || [];
      output(ctx, data, (_d, ui) =>
        ui.table(items.map(item => ({ ...item, visibility: item.visibility === 'project' ? 'shared' : 'private' })), [
          { key: 'id', label: 'ID' },
          { key: 'name', label: 'NAME' },
          { key: 'visibility', label: 'VISIBILITY' },
          { key: 'ownerId', label: 'OWNER' },
          { key: 'updatedAt', label: 'UPDATED' },
        ]),
      );
    },
  },
  download: {
    summary: 'Print a snippet as plain SQL (redirect it to a file to save it)',
    usage: 'motherbase snippets download <id>',
    async run(ctx, args) {
      const id = requireArg(args[0], 'id');
      const data = await api.adminRequest(ctx, 'GET', `/content/${encodeURIComponent(id)}`);
      const item = data && data.item;
      // Structured output keeps the whole record; the default is the bare SQL,
      // with no decoration, so `> query.sql` writes a runnable file.
      output(ctx, item, () => process.stdout.write(`${item.content.sql}\n`));
    },
  },
};

module.exports = {
  summary: 'SQL Editor snippets',
  usage: 'motherbase snippets <list|download> ...',
  subcommands,
};
