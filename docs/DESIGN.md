# DESIGN.md: Sober UI coherence contract

Governs the single `apps/studio` bundle, which ships both the Platform Console and
Project Studio (see [glossary.md](glossary.md)). **Product register**: design serves the
task. Notion-calm, not terminal. The first redesign swapped color tokens but left
the old "Editorial Terminal" structure underneath; this contract removes that DNA
so every page reads as one interface.

Foundation tokens & primitives live in `apps/studio/src/index.css` (already correct). This
file governs how pages *use* them.

## Hard rules (the tear-fixers)

1. **Sentence case only.** Never ALL-CAPS labels. No `.toUpperCase()` on UI text.
   Section headers are `13px` / `font-weight 600`, `--text` or `--text-dim`. The
   `.label` class is for small muted meta (`11px`), not for shouting headings.

2. **Sans everywhere except real code.** `mono` is reserved for SQL, code, shell,
   connection strings, hashes, and opaque IDs. Plain names, counts, percentages,
   timestamps, hostnames use `--font-sans` with `tabular-nums` for figures. No
   `serif` / `numeral` display fonts: headings are sans 600, `tracking -0.01em`.

3. **One accent.** `--accent` carries primary buttons, active nav, focus, and the
   single most important figure on a view. Status colors (`--green/--amber/--red`)
   appear **only** when signalling real state (RLS on, error, warning). No
   decorative rainbow: gauges/bars/metrics are neutral or accent, never assigned
   ember/violet/lime just for variety.

4. **Nothing is sharp.** Every box, bar, meter, badge, and avatar has radius.
   Progress/usage bars use `border-radius: 999px`. No `rounded-none`, no `2px`
   corners. Cards `--radius-md`, controls `--radius-sm`.

5. **Aerated, consistent rhythm.** Page shell `max-w-5xl`/`6xl` centered,
   `px-6 sm:px-10 py-8`. Vertical rhythm `space-y-6` between sections, `space-y-8`
   for major blocks. Card padding `p-5`/`p-6`. Don't crowd; don't scatter.

## Page skeleton

```
<div className="px-6 sm:px-10 py-8">
  <div className="mx-auto max-w-5xl space-y-8 rise">
    <header>
      <h1 className="text-[22px]" style={{ fontWeight: 600, letterSpacing: '-0.01em' }}>Title</h1>
      <p className="mt-1 text-[13px]" style={{ color: 'var(--text-dim)' }}>One-line purpose.</p>
    </header>
    {/* sections, each space-y-6 */}
  </div>
</div>
```

## Component notes

- **Section heading inside a card**: `13px` / `600` / `--text`, optional leading
  icon `13px` `--text-mute`. Not a `.label`, not caps.
- **Stat / gauge**: sans figure (`24-28px`, `600`, `tabular-nums`), sentence-case
  muted label under or beside it. Bar is pill-rounded, neutral track
  (`--surface-2`), accent fill. Only the page's headline number may take accent.
- **Tabs**: active underline uses `--accent`; inactive `--text-mute`.
- **Tables**: use `table.console`. Cell data sans; only ID/code columns mono.
- **Chips/badges**: `.chip`, sentence case. Status badges may take one status color.

## AI assistant tools

Assistant tools call the same authenticated admin API used by Project Studio. They
do not duplicate database queries or bypass controller authorization. This keeps
validation, project scoping, audit behavior, and read-only SQL enforcement in one
server path. The dock renders tool activity as a compact trace so operators can see
which existing operation produced an answer.

## Out of scope
Behavior, data flow, routing, API: unchanged. Visual/structure only. The four
dark code-editor panes (Sql, ApiExplorer, Connect, PolicyEditor) stay dark.
