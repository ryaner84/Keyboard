# Keycap visualizer routines

Canonical instructions for the two daily catalog routines behind `/visualize`.
The scheduled prompts point here, so the steps stay versioned with the code.

The visualizer catalog is three files in `src/data/keycap-visualizer/`:

- `keycaps.json`: one entry per keycap set, keyed by its tracker `slug`. It
  holds only what the tracker doesn't: the five colors and the profile. Name
  shown, status and the "Compare prices" link come from the tracker row, so an
  entry whose slug is not on the tracker never appears.
- `keyboards.json`: the keyboards and their case finishes. `generic` and
  `genericFinishes` cover every keyboard that isn't listed.
- `keyboard-backlog.json`: the queue the keyboard routine works through.

`npm run test:keycap-visualizer` checks all of it (unique ids and slugs,
`#RRGGBB` colors, GMK=cherry / SP DCS=dcs, known layouts, packs pointing at
real sets) and runs in CI.

## Shared steps (both routines)

1. Start from an up-to-date `main`: `git switch main && git pull`.
2. Branch: `visualizer/keycap-<slug>` or `visualizer/keyboard-<id>`.
3. Make the one change the routine describes. One set or one keyboard per run.
4. `npm run test:keycap-visualizer` and `npx tsc --noEmit` must pass.
5. Commit, push, open a PR **ready for review** (never draft), and squash-merge
   once CI is green, as `CLAUDE.md` says. Title: `Visualizer: add <name>`.
6. If there is nothing to add, change nothing and report that.

## Routine 1: add one keycap set from its tracker picture

Scheduled prompt:

> Run the daily keycap visualizer routine for the GMK tracker exactly as
> specified in `docs/keycap-visualizer-routine.md` (Routine 1). Read that file
> first and follow every step. Add exactly one GMK or SP DCS set, working on a
> branch and merging per CLAUDE.md.

Steps:

1. `python scripts/keycap-colors.py candidates` lists tracker GMK and DCS sets
   that have pictures and aren't in `keycaps.json`, newest first. Prefer, in
   order: an `ACTIVE_GB` set, then `IN_STOCK`, then anything else. Skip
   add-on-only listings ("NorDeUK Addon", "Blanks", novelties) and sets whose
   base kit you can't see.
2. `python scripts/keycap-colors.py colors <slug>` downloads that set's tracker
   pictures (keycaplendar thumbs, gmk.net renders) and prints each one's
   dominant colors.
3. **Open the pictures and look at them.** Pick the one that shows the base kit
   on a board. A logo, a kit diagram, or a desk photo where keycaps are a small
   part of the frame is not usable. Try the next picture, and if none works,
   move to the next candidate.
4. Assign the colors by what the picture shows, using the printed hex values
   for the exact shades:
   - `alpha`: letter keys. `mod`: Tab, Shift, Ctrl, the F-row blocks.
   - `accent`: Esc, Enter, arrows (often a third color; may equal mod).
   - `alphaLegend` / `modLegend`: the legend color on each.
   - Ignore background, desk, case, shadow and specular highlights.
5. Add the entry to `keycaps.json`:
   `id` (lowercase, no round suffix needed unless two rounds differ in color),
   `name` as the tracker shows it, `family` `GMK` or `SP DCS`, `profile`
   `cherry` or `dcs`, `slug`, today's `dateAdded`, `colorSource`
   `tracker-image`.
6. When a set's pictures can't be used but the colorway is well known (e.g.
   WoB, Dolch), you may enter its colors from knowledge with `colorSource`
   `known-colorway`. Say so in the PR.

## Routine 2: add one keyboard from the backlog

Scheduled prompt:

> Run the daily keyboard visualizer routine for the GMK tracker exactly as
> specified in `docs/keycap-visualizer-routine.md` (Routine 2). Read that file
> first and follow every step. Add exactly one keyboard, working on a branch
> and merging per CLAUDE.md.

Steps:

1. Take the first entry in `keyboard-backlog.json`. If the queue is empty,
   pick a popular board that is missing (a `KEYBOARD` row on the tracker with
   a `layout` is a good source) and say so in the PR.
2. Look up the board's official case finishes on the maker's product page.
   Record each finish's name as the maker writes it, and a hex sampled from the
   product photo (avoid highlights and shadow).
3. Add it to `keyboards.json` `keyboards` with `id` (lowercase-hyphenated
   name), `name`, `layout` (`60`, `65`, `75`, `tkl` or `full`; pick the
   closest when the board is e.g. 96% or 1800, and say so), today's
   `dateAdded`, and `finishes`.
4. Remove that entry from `keyboard-backlog.json`.
