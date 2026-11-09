'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const readline = require('node:readline/promises');

const TEMPLATES = new Set(['next', 'react']);
const TEMPLATE_ROOT = path.join(__dirname, '..', 'templates');

function parseArgs(args) {
  const options = { name: null, template: null, install: true, help: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--no-install') options.install = false;
    else if (arg === '--yes' || arg === '-y') options.yes = true;
    else if (arg === '--template' || arg === '-t') {
      options.template = args[++index];
      if (!options.template) throw new Error('Pass next or react after --template.');
    }
    else if (arg.startsWith('--template=')) options.template = arg.slice('--template='.length);
    else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    else if (options.name) throw new Error('Pass only one project name.');
    else options.name = arg;
  }
  if (options.template && !TEMPLATES.has(options.template)) {
    throw new Error('Template must be "next" or "react".');
  }
  return options;
}

function validateName(name) {
  if (!/^[a-z][a-z0-9-]*$/.test(name) || name.endsWith('-') || name.length > 80) {
    throw new Error('Use a lowercase project name with letters, numbers and hyphens (for example: my-app).');
  }
  if (new Set(['con', 'prn', 'aux', 'nul', 'com1', 'lpt1']).has(name)) {
    throw new Error(`"${name}" is a reserved directory name on Windows.`);
  }
}

function copyTemplate(source, destination, replacements) {
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const target = path.join(destination, entry.name === 'gitignore' ? '.gitignore' : entry.name);
    const from = path.join(source, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(target, { recursive: true });
      copyTemplate(from, target, replacements);
    } else if (entry.isFile()) {
      const content = fs.readFileSync(from, 'utf8');
      fs.writeFileSync(target, content.replaceAll('__APP_NAME__', replacements.name));
    }
  }
}

function scaffold({ name, template, cwd = process.cwd() }) {
  validateName(name);
  if (!TEMPLATES.has(template)) throw new Error('Template must be "next" or "react".');
  const destination = path.join(cwd, name);
  fs.mkdirSync(destination); // Atomic refusal if a folder already exists.
  copyTemplate(path.join(TEMPLATE_ROOT, 'shared'), destination, { name });
  copyTemplate(path.join(TEMPLATE_ROOT, template), destination, { name });
  return destination;
}

async function promptForOptions(options) {
  if (options.name && options.template) return options;
  if (options.yes) return { ...options, name: options.name ?? 'my-motherbase-app', template: options.template ?? 'next' };
  if (!process.stdin.isTTY) throw new Error('Pass a project name and --template next|react (or use --yes).');
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const name = options.name ?? ((await prompt.question('Project name (my-motherbase-app): ')).trim() || 'my-motherbase-app');
    const answer = options.template ?? ((await prompt.question('Template [next/react] (next): ')).trim() || 'next');
    return { ...options, name, template: answer };
  } finally {
    prompt.close();
  }
}

async function run(args) {
  let options = parseArgs(args);
  if (options.help) {
    console.log('Usage: create-motherbase-app [name] [--template next|react] [--no-install] [--yes]');
    return;
  }
  options = await promptForOptions(options);
  const destination = scaffold(options);
  console.log(`Created ${options.template} app in ${destination}`);
  if (options.install) {
    const command = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const result = spawnSync(command, ['install'], {
      cwd: destination,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    if (result.error || result.status !== 0) {
      throw new Error(`Dependency installation failed. Your project is in ${destination}; run npm install there to retry.`);
    }
  }
  const copy = process.platform === 'win32' ? 'copy' : 'cp';
  console.log(`\nNext steps:\n  cd ${options.name}\n  ${copy} .env.example .env.local\n  npm ${options.install ? 'run dev' : 'install\n  npm run dev'}`);
  console.log('Set your Motherbase URL and public key in .env.local before signing in.');
}

module.exports = { parseArgs, scaffold, run };
