#!/usr/bin/env node
'use strict';

const { run } = require('../src/cli.js');

run(process.argv.slice(2)).catch(error => {
  console.error(`\n${error.message}`);
  process.exitCode = 1;
});
