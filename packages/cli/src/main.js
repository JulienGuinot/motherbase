"use strict";

const path = require("path");
const { registry, groups } = require("./commands");
const { createContext, CliError } = require("./context");
const { FORMATS } = require("./format");
const ui = require("./ui");

// Flags that never consume a following value.
const PURE_BOOLEAN = new Set([
  "json",
  "yes",
  "help",
  "version",
  "force",
  "preview",
  "app",
  "no-data",
  "no-auth",
  "f",
  "debug",
  // Codegen: `--check` and `--local` never take a value, so a trailing
  // `--check database.types.ts` must not silently swallow the path.
  "check",
  "local",
  // `rls preset <table> <preset> --replace` must not swallow a following word.
  "replace",
  // `storage cp --recursive ./dir ss:///bucket` must not swallow the source.
  "recursive",
  // Migration workflow switches: `db push --dry-run` must not eat a positional.
  "dry-run",
  "include-seed",
  "include-all",
  "schema-only",
  "data-only",
  "use-copy",
  "confirm",
  "no-seed",
  "linked",
  // `postgres-config` and `db publications` switches, never followed by a value.
  "replace-existing-overrides",
  "no-restart",
  "all-tables",
  // Branching, keys and database access: trailing switches that must not
  // swallow the next word.
  "with-data",
  "append",
  "enable-db-ssl-enforcement",
  "disable-db-ssl-enforcement",
]);
// Short flag aliases → canonical (with whether they take a value).
const SHORT = {
  y: { name: "yes", boolean: true },
  h: { name: "help", boolean: true },
  v: { name: "version", boolean: true },
  p: { name: "project", boolean: false },
  u: { name: "url", boolean: false },
  e: { name: "e", boolean: false },
  f: { name: "f", boolean: true },
  o: { name: "output", boolean: false },
  r: { name: "recursive", boolean: true },
};

/**
 * Is this token the next flag rather than a value that happens to start with
 * `-`? `--anything` is: long flags are free-form here, so the parser accepts
 * any name. A single-dash token only is when `SHORT` declares it, which is why
 * `-s3cret!` and `-5` are not.
 *
 * PURE_BOOLEAN cannot answer this on its own. It lists the flags that must not
 * swallow a following *positional* (`db push --dry-run` before a path), and a
 * switch with no positional after it was never added to it -- `--superuser`,
 * `--write`, `--no-storage`. Treating every switch missing from that list as a
 * flag that needs a value is what turned `db roles create app --login
 * --superuser` into an error.
 */
function isFlagToken(token) {
  if (token.startsWith("--")) return token.length > 2;
  return Object.prototype.hasOwnProperty.call(SHORT, token.slice(1));
}

/**
 * A value flag followed by a dash-leading token that is *not* a flag is
 * ambiguous: the token could be the value or a typo. This used to resolve
 * silently in the worst direction -- the flag became a bare `true` and the
 * value was re-parsed as short flags, so `--password -s3cret!` sent no password
 * and set `-s`, `-3`, `-c`... The `--flag=value` form is unambiguous, so say so
 * instead of guessing (PKG-16).
 */
function dashValue(flag, value) {
  return new CliError(
    `${flag} needs a value, and "${value}" starts with "-". Write ${flag}=${value} instead.`,
  );
}

// Tokenize argv into positionals + flags. Repeated flags collapse into arrays.
function tokenize(argv) {
  const positionals = [];
  const flags = {};
  const setFlag = (key, value) => {
    if (key in flags) {
      flags[key] = [].concat(flags[key], value);
    } else {
      flags[key] = value;
    }
  };

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }

    if (tok.startsWith("--")) {
      const body = tok.slice(2);
      const eq = body.indexOf("=");
      if (eq >= 0) {
        setFlag(body.slice(0, eq), body.slice(eq + 1));
        continue;
      }
      const next = argv[i + 1];
      if (PURE_BOOLEAN.has(body)) {
        setFlag(body, true);
        continue;
      }
      if (next === undefined || isFlagToken(next)) {
        setFlag(body, true);
        continue;
      }
      if (next.startsWith("-")) throw dashValue(`--${body}`, next);
      setFlag(body, next);
      i++;
    } else if (tok.startsWith("-") && tok.length > 1 && tok !== "-") {
      const spec = SHORT[tok.slice(1)];
      if (!spec) {
        setFlag(tok.slice(1), true);
        continue;
      }
      const next = argv[i + 1];
      if (spec.boolean || next === undefined || isFlagToken(next)) {
        setFlag(spec.name, true);
        continue;
      }
      if (next.startsWith("-")) throw dashValue(`--${spec.name}`, next);
      setFlag(spec.name, next);
      i++;
    } else {
      positionals.push(tok);
    }
  }
  return { positionals, flags };
}

// Fold the Supabase spellings of global flags into the names commands read:
// `--project-ref` is `--project`, and `-o/--output <format>` becomes `format`
// (with `json` kept in step, since commands test it for machine output).
// `--output` stays a file path on commands that declare `outputIsPath`.
function normalizeFlags(flags, command = {}) {
  const out = { ...flags };
  if (out.project === undefined && out["project-ref"] !== undefined)
    out.project = out["project-ref"];
  if (out.output !== undefined && FORMATS.includes(out.output)) {
    out.format = out.output;
    delete out.output;
  } else if (out.output !== undefined && !command.outputIsPath) {
    throw new CliError(`--output must be one of: ${FORMATS.join(", ")}`);
  }
  out.format = out.format || (out.json ? "json" : "pretty");
  out.json = out.format === "json";
  return out;
}

function version() {
  try {
    return require(path.join(__dirname, "..", "package.json")).version;
  } catch {
    return "0.0.0";
  }
}

function pad(s, n) {
  return String(s).padEnd(n);
}

function topLevelHelp() {
  ui.print(ui.color.bold("Motherbase CLI") + ` v${version()}`);
  ui.print("");
  ui.print("Usage: motherbase <command> [subcommand] [args] [flags]");
  ui.print("");
  const width = Object.keys(registry).reduce((m, k) => Math.max(m, k.length), 0) + 2;
  for (const group of groups) {
    ui.print(ui.color.bold(group.title));
    for (const name of group.names) {
      const entry = registry[name];
      if (!entry) continue;
      ui.print(
        "  " +
          ui.color.cyan(pad(name, width)) +
          ui.color.dim(entry.summary || ""),
      );
    }
    ui.print("");
  }
  ui.print(
    "Global flags: -o/--output pretty|json|yaml|env  --json  --yes/-y  --project/-p/--project-ref <id>  --url/-u <consoleUrl>",
  );
  ui.print(
    "              --token <t>  --workdir <dir>  --debug  -h/--help  -v/--version",
  );
  ui.print("Run `motherbase <command> -h` for command-specific help.");
}

function commandHelp(name, entry, trail) {
  const full = ["motherbase", ...trail].join(" ");
  ui.print(ui.color.bold(full) + (entry.summary ? `, ${entry.summary}` : ""));
  ui.print("");
  if (entry.usage) {
    ui.print("Usage: " + entry.usage);
    ui.print("");
  }
  if (entry.subcommands) {
    ui.print(ui.color.bold("Subcommands"));
    const subs = Object.keys(entry.subcommands);
    const width = subs.reduce((m, k) => Math.max(m, k.length), 0) + 2;
    for (const sub of subs) {
      const s = entry.subcommands[sub];
      ui.print(
        "  " + ui.color.cyan(pad(sub, width)) + ui.color.dim(s.summary || ""),
      );
    }
  }
}

async function main(argv) {
  const { positionals, flags } = tokenize(argv);

  // Only bare: `migration squash --version <v>` is Supabase's own flag.
  if (flags.version && positionals.length === 0) {
    ui.print(version());
    return 0;
  }

  if (positionals.length === 0) {
    topLevelHelp();
    return 0;
  }

  const name = positionals[0];
  const entry = registry[name];
  if (!entry) {
    ui.printErr(ui.color.red(`Unknown command: ${name}`));
    ui.printErr("Run `motherbase --help` to see available commands.");
    return 1;
  }

  // Descend into subcommands.
  let current = entry;
  const trail = [name];
  const rest = positionals.slice(1);
  while (current.subcommands && rest.length && current.subcommands[rest[0]]) {
    current = current.subcommands[rest[0]];
    trail.push(rest.shift());
  }

  // Help requested, or a group with no runnable action here.
  if (flags.help || (!current.run && !current.subcommands)) {
    commandHelp(name, current, trail);
    return 0;
  }
  if (!current.run) {
    // Group node: either no subcommand given or an unknown one.
    if (rest.length)
      ui.printErr(
        ui.color.red(`Unknown subcommand: ${trail.join(" ")} ${rest[0]}`),
      );
    commandHelp(name, current, trail);
    return rest.length ? 1 : 0;
  }

  try {
    const resolved = normalizeFlags(flags, current);
    if (resolved.debug) process.env.MOTHERBASE_DEBUG = "1";
    const cwd = resolved.workdir
      ? path.resolve(String(resolved.workdir))
      : process.cwd();
    await current.run(
      createContext(resolved, process.env, cwd),
      rest,
      resolved,
    );
    return 0;
  } catch (err) {
    if (err instanceof CliError || err.isCliError) {
      ui.printErr(ui.color.red(err.message));
    } else {
      ui.printErr(ui.color.red(`Error: ${err.message}`));
    }
    return 1;
  }
}

module.exports = { main, tokenize, normalizeFlags, version };
