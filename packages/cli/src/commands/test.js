'use strict';

// Supabase's `test db`: pgTAP files from motherbase/tests, run on the linked project.

module.exports = {
  summary: 'Run database tests (pgTAP)',
  usage: 'motherbase test db [file.sql ...]',
  subcommands: require('../migration/commands').testSubcommands,
};
