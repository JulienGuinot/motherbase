'use strict';

// Minimal, dependency-free presentation helpers: ANSI colour (auto-off when not a
// TTY or NO_COLOR is set), a table printer, a key/value printer, a spinner, and a
// --json passthrough.

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;

function wrap(code) {
  return s => (useColor ? `[${code}m${s}[0m` : String(s));
}

const color = {
  bold: wrap('1'),
  dim: wrap('2'),
  red: wrap('31'),
  green: wrap('32'),
  yellow: wrap('33'),
  cyan: wrap('36'),
  gray: wrap('90'),
};

function print(msg = '') {
  process.stdout.write(msg + '\n');
}

function printErr(msg = '') {
  process.stderr.write(msg + '\n');
}

function success(msg) {
  print(color.green('✓ ') + msg);
}

function info(msg) {
  print(color.cyan('• ') + msg);
}

function warn(msg) {
  printErr(color.yellow('! ') + msg);
}

function json(value) {
  print(JSON.stringify(value, null, 2));
}

// Render an array of flat objects as an aligned table using the given columns
// (array of keys or { key, label } specs). Falls back to a friendly note if empty.
function table(rows, columns) {
  if (!Array.isArray(rows) || rows.length === 0) {
    print(color.dim('(no rows)'));
    return;
  }
  const cols = (columns || Object.keys(rows[0])).map(c =>
    typeof c === 'string' ? { key: c, label: c } : c,
  );
  const widths = cols.map(c => c.label.length);
  const cells = rows.map(row =>
    cols.map((c, i) => {
      const v = row[c.key];
      const s = v === undefined || v === null ? '' : String(v);
      if (s.length > widths[i]) widths[i] = s.length;
      return s;
    }),
  );
  const header = cols.map((c, i) => color.bold(c.label.padEnd(widths[i]))).join('  ');
  print(header);
  print(color.dim(cols.map((_, i) => '-'.repeat(widths[i])).join('  ')));
  for (const rowCells of cells) {
    print(rowCells.map((s, i) => s.padEnd(widths[i])).join('  '));
  }
}

// Print a { key: value } object as aligned "key : value" lines.
function keyValue(obj) {
  if (!obj || typeof obj !== 'object') {
    print(String(obj));
    return;
  }
  const keys = Object.keys(obj);
  const w = keys.reduce((m, k) => Math.max(m, k.length), 0);
  for (const k of keys) {
    let v = obj[k];
    if (v && typeof v === 'object') v = JSON.stringify(v);
    print(`${color.gray(k.padEnd(w))}  ${v === undefined || v === null ? '' : v}`);
  }
}

// A tiny spinner. No-op (single status line) when stderr is not a TTY.
function spinner(text) {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  if (!process.stderr.isTTY) {
    printErr(color.dim(text + ' ...'));
    return { stop() {}, succeed() {}, fail() {} };
  }
  let i = 0;
  const timer = setInterval(() => {
    process.stderr.write(`\r${color.cyan(frames[i++ % frames.length])} ${text}`);
  }, 80);
  const clear = () => {
    clearInterval(timer);
    process.stderr.write('\r[K');
  };
  return {
    stop: clear,
    succeed(msg) { clear(); if (msg) printErr(color.green('✓ ') + msg); },
    fail(msg) { clear(); if (msg) printErr(color.red('✗ ') + msg); },
  };
}

module.exports = { color, print, printErr, success, info, warn, json, table, keyValue, spinner };
