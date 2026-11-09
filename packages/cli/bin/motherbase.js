#!/usr/bin/env node
'use strict';

const { main } = require('../src/main');

main(process.argv.slice(2))
  .then(code => { process.exitCode = code || 0; })
  .catch(err => {
    process.stderr.write((err && err.message ? err.message : String(err)) + '\n');
    process.exitCode = 1;
  });
