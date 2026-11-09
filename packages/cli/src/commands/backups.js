'use strict';

// Supabase's top-level `backups`. The implementations live under `db`, which
// keeps its own names for them.

const db = require('./db');
const { alias } = require('./_util');

module.exports = {
  summary: 'List and restore database backups',
  usage: 'motherbase backups <list|restore> ...',
  subcommands: {
    list: alias(db.subcommands.backups, 'motherbase backups list', 'List database backups'),
    restore: alias(db.subcommands.restore, 'motherbase backups restore <file> | --key <remoteKey>  --confirm'),
  },
};
