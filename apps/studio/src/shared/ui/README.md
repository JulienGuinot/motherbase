# shared/ui

The studio's UI primitives. Before adding markup to a feature, check this list:
if a primitive exists, use it. Anything re-rolled here drifts (padding, colours,
dark mode) and there is no single place left to fix it.

Visual tokens live in `src/index.css` as plain classes: `btn` / `btn-primary` /
`btn-ghost`, `input`, `card`, `chip`, `label`, `mono`, `hairline`. Buttons and
inputs stay as raw elements with those classes; the components below cover the
structures that repeat around them.

Behaviour classes there too, and they replace patterns that used to be inlined:

| Class | Use instead of |
| --- | --- |
| `nav-item` | `onMouseEnter` / `onMouseLeave` writing `style.background`. Covers hover **and** keyboard focus; `data-active` marks the current entry. |
| `row-host` + `row-actions` | `opacity-0 group-hover:opacity-100`, which leaves buttons invisible while they are focused. Reveals on focus-within too. |
| `modal-scrim` | A hardcoded `rgba(4,5,7,…)` backdrop, which swamps light mode. |
| `shimmer` | Any bespoke loading placeholder. `Skeleton` renders exactly this. |

Colour never goes in as a hex. Every hue is a token: `--text` / `--text-dim` /
`--text-mute`, `--surface` / `--surface-2`, `--border`, `--accent`, the status
set `--green` / `--amber` / `--red` / `--blue` / `--purple`, and `--code-bg`
behind editors and response viewers.

## Page structure

| Component | Use for |
| --- | --- |
| `PageHeader` | Any page or panel title. `size="lg"` hero pages, `"md"` console pages, `"sm"` panel headings. |
| `PageShell` | Console page frame: outer padding, centered column, section rhythm. `width="default"` for prose and forms, `"wide"` for table-heavy pages (Logs, Observability, Cron), `"full"` when the page owns its gutters. |
| `WorkbenchShell` | Full-height page that owns its own scrolling: Tables, SQL, Functions, Edge Functions, API explorer. `layout="responsive"` (sidebar beside panel, stacked on mobile), `"row"`, `"column"`. Never add outer padding around it. |
| `Tabs` / `TabPanel` | Underlined tab strip switching views inside a page. A real tablist: arrow keys, Home / End, `aria-selected`. Never re-roll the strip by hand. |
| `SubPage` | Second-level page beside a secondary nav (Authentication section). Owns its own padding and header. |
| `SidebarHeader` | Header of a list sidebar (Tables, SQL Functions, Models), with inline actions and an optional second row. |
| `Section` | Card with header / description / actions / footer. `flush` for full-bleed row lists, `bodyClassName="space-y-3"` for stacked rows, `tone="danger"` for destructive groups. |

## Content

| Component | Use for |
| --- | --- |
| `EmptyState` | Every "nothing here yet" placeholder. Add `icon` for the full-page variant, `action` for the primary CTA. |
| `StatCard` / `StatTile` | Metric tiles. `StatCard` has card chrome, `StatTile` is the bordered in-panel variant. |
| `Badge` / `StatusDot` | Status pills and dots. Pass a `tone` (`neutral` `success` `warn` `danger` `info`), never raw Tailwind colours: tones follow the theme tokens. |
| `DetailField` | Read-only label + value pair in a drawer or detail panel. |
| `ThinkingOrb` | AI waits only: the assistant composing an answer, a tool call running. Ordinary in-flight data keeps `Skeleton` / `RouteLoading` / the topbar `FetchProgress`, so the orb stays a distinct signal. |
| `Pager` | Numbered pages under a server-paginated list with a known total (users, sessions, storage objects). The server filters and pages; never fetch the whole list to slice it here. |
| `LoadMore` | Footer of a cursor-paged list that grows as it is scrolled (the log stream), where page numbers mean nothing because new rows keep arriving. Fetches when it scrolls into view, with a button and the same page-size picker as `Pager`. |

## Forms

| Component | Use for |
| --- | --- |
| `Field` | Label + any control + hint/error. Renders a `<label>`, so the caption focuses the control. |
| `TextField` | The single-line input case, in one line. |
| `ListInput` | A list of short values (origins, domains, scopes…), one chip per entry. Never a comma-separated text field. A setting stored as `"a, b"` goes through `splitList` / `joinList` from `shared/lib/list-values`. |
| `Checkbox` | Checkbox with its caption as one clickable row. |
| `Toggle` / `ToggleRow` | The pill switch, and the labelled switch row inside a Section. |
| `SettingRow` | One setting per row: caption and hint left, control right. |
| `Note` | Muted explanatory block introducing a settings group. |
| `Select`, `SchemaSelect` | Dropdowns. Never use a native `<select>`. |

## Also here

`Modal` (+ `ModalHeader` / `ModalBody` / `ModalFooter`), `DetailDrawer`,
`RowDrawer`, `CodeBlock`, `JsonView`, `CopyButton`, `ExportButton`,
`WriteButton` (capability-gated action), `Skeleton`, `RouteLoading`,
`ContextMenu`, `CommandPalette`, `RangePicker`, charts under `charts/`.

Series colour never gets picked per chart. `charts/palette.ts` owns the eight
categorical hues and their dark steps, and `toSlices(series, theme)` ranks a
list, assigns them in order and folds anything past the eighth into a neutral
`Other`. The order is validated (colourblind and normal-vision separation,
contrast against each surface), so a reshuffle breaks it.

`FetchProgress` sits in the topbar and reports in-flight queries for the whole
app, so no page needs its own "refreshing" spinner. It pairs with the
`placeholderData: keepPreviousFor(selection)` (`shared/lib/query`) on the
selection-driven query hooks: lists keep their rows while a new page or filter
of the *same* selection loads, and the topbar bar is what says the app is
working. Never plain `keepPreviousData`, which also holds them across a table or
bucket change and renders one list under another's headers.

Any new overlay must call `useDialogBehavior(onClose)` from
`shared/hooks/useDialogBehavior` and spread the returned ref on its panel. That
is what makes Escape close it, Tab stay inside it, and focus return to whatever
opened it. `Modal`, `DetailDrawer` and `RowDrawer` already do.
