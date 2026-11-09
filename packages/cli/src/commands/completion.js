'use strict';

// `completion <shell>`: a completion script generated from the command
// registry, so it can never list a command that does not exist.

const { requireArg } = require('./_util');
const { CliError } = require('../context');

// Every command path that has children, with those children:
// [{ path: 'storage buckets', children: [{ name: 'list', summary }] }, ...].
// The root is the path ''.
function commandPaths(registry) {
  const out = [];
  const walk = (path, subcommands) => {
    const names = Object.keys(subcommands);
    out.push({ path, children: names.map(name => ({ name, summary: subcommands[name].summary || '' })) });
    for (const name of names) {
      const sub = subcommands[name].subcommands;
      if (sub) walk(path ? `${path} ${name}` : name, sub);
    }
  };
  walk('', registry);
  return out;
}

// The words typed so far, flags skipped, are the path whose children complete.
function bash(paths) {
  const cases = paths
    .map(p => `    "${p.path}") words="${p.children.map(c => c.name).join(' ')}" ;;`)
    .join('\n');
  return `# motherbase bash completion. Load with: source <(motherbase completion bash)
_motherbase() {
  local cur="\${COMP_WORDS[COMP_CWORD]}" path="" words="" i
  for ((i = 1; i < COMP_CWORD; i++)); do
    [[ \${COMP_WORDS[i]} == -* ]] && continue
    path="\${path:+$path }\${COMP_WORDS[i]}"
  done
  case "$path" in
${cases}
  esac
  COMPREPLY=($(compgen -W "$words" -- "$cur"))
}
complete -F _motherbase motherbase
`;
}

// zsh runs the bash function through its bashcompinit shim.
function zsh(paths) {
  return `# motherbase zsh completion. Load with: source <(motherbase completion zsh)
autoload -U +X bashcompinit && bashcompinit
${bash(paths).split('\n').slice(1).join('\n')}`;
}

function fishQuote(text) {
  return `'${String(text).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function fish(paths) {
  const lines = paths.flatMap(p =>
    p.children.map(
      c => `complete -c motherbase -f -n ${fishQuote(`__motherbase_at '${p.path}'`)} -a ${fishQuote(c.name)} -d ${fishQuote(c.summary)}`,
    ),
  );
  return `# motherbase fish completion. Load with: motherbase completion fish | source
function __motherbase_at
    set -l path (string join ' ' -- (string match -v -- '-*' (commandline -opc)[2..-1]))
    test "$path" = "$argv[1]"
end
${lines.join('\n')}
`;
}

const SHELLS = { bash, zsh, fish };

function completionScript(shell, registry) {
  if (!SHELLS[shell]) throw new CliError(`shell must be one of: ${Object.keys(SHELLS).join(', ')}`);
  return SHELLS[shell](commandPaths(registry));
}

module.exports = {
  summary: 'Generate the autocompletion script for a shell',
  usage: 'motherbase completion <bash|zsh|fish>',
  run(ctx, args) {
    const shell = requireArg(args[0], 'shell');
    // Required here, not at the top: the registry itself requires this file.
    const { registry } = require('./index');
    process.stdout.write(completionScript(shell, registry));
  },
  completionScript,
};
