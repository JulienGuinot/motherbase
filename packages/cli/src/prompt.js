'use strict';

// readline-based prompting, including hidden password entry. Built-ins only.

const readline = require('readline');

function question(query) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(query, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// Hidden input. Reads the TTY in raw mode so nothing echoes, masking each typed
// character with '*'. Handles backspace, Enter, Ctrl+C, Ctrl+D and swallows
// escape sequences (arrow keys etc.) so they never land in the value. When
// stdin is not a TTY (pipes, CI) we fall back to a plain, unmasked line read.
function password(query = 'Password: ') {
  const stdin = process.stdin;
  const stdout = process.stdout;
  if (!stdin.isTTY) return question(query);

  return new Promise(resolve => {
    let value = '';
    let inEscape = false;
    stdout.write(query);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    const done = result => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write('\n');
      resolve(result);
    };

    const onData = chunk => {
      for (const ch of chunk) {
        if (inEscape) {
          // Terminators of a CSI/escape sequence (e.g. arrow keys): stop swallowing.
          if (/[a-zA-Z~]/.test(ch)) inEscape = false;
          continue;
        }
        switch (ch) {
          case '\r':
          case '\n':
          case '\u0004': // Ctrl-D
            return done(value);
          case '\u0003': // Ctrl-C
            stdin.setRawMode(false);
            stdin.pause();
            stdout.write('\n');
            process.exit(130);
            return;
          case '\u007f': // Backspace / Delete
          case '\b':
            if (value.length > 0) {
              value = value.slice(0, -1);
              stdout.write('\b \b');
            }
            break;
          case '\u001b': // ESC: start of an escape sequence
            inEscape = true;
            break;
          default:
            // Ignore remaining control characters; mask printable ones.
            if (ch >= ' ') {
              value += ch;
              stdout.write('*');
            }
        }
      }
    };

    stdin.on('data', onData);
  });
}

async function confirm(query, defaultYes = false) {
  const suffix = defaultYes ? ' [Y/n] ' : ' [y/N] ';
  const answer = (await question(query + suffix)).toLowerCase();
  if (!answer) return defaultYes;
  return answer === 'y' || answer === 'yes';
}

module.exports = { question, password, confirm };
