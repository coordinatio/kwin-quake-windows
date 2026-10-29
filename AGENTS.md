# AGENTS.md

## Aim

**Quake Windows** is a KWin 6 (Plasma 6) script that hides/shows up to 7 windows via
global hotkeys ("quake-style" toggling). Windows are matched by title using JavaScript
regular expressions configured through a KDE settings dialog (English + Russian).

## Structure

```
contents/
  code/main.js        # the KWin script itself (all runtime logic)
  config/main.xml     # KConfigXT schema ([Script-quakewindows] keys in kwinrc)
  ui/config.ui        # settings dialog form (7 slots: checkbox + regex field)
  locale/ru/…         # compiled translations (.mo) — committed, built from po/
metadata.json         # KPackage metadata (id: quakewindows, version, translations)
assets/logo.png       # project logo shown in the README
po/                   # translation sources (.pot template + ru.po)
tests/                # test suites (see below)
tools/                # update-po.sh, build-locale.sh (translation workflow)
pack.sh               # builds quakewindows.kwinscript archive for distribution
docs/internals.md     # deep implementation notes (config reloading, trade-offs)
.github/workflows/ci.yml
```

## Conventions

- `main.js`, `main.xml`, `config.ui` and `SLOT_COUNT` are cross-checked by tests —
  keep them in sync when changing slots or config keys.
- User-visible strings in `config.ui` must be translatable; regenerate the catalog with
  `tools/update-po.sh` and rebuild `.mo` files with `tools/build-locale.sh` (commit both
  `po/` and `contents/locale/` together — CI fails on drift).
- The distributable is the `./pack.sh` archive; directory installs include dev files.

## Testing

Dependency-free (always run before committing):

```sh
node tests/main-js-test.mjs      # script logic vs mocked KWin globals
python3 tests/ui-test.py         # config.ui/main.xml structure (+ PyQt6 widgets if present)
python3 tests/locale-test.py     # committed catalogs vs po/ sources
```

Optional (need g++/Qt6/KF6; skip with exit 0 when absent, unless
`QUAKEWINDOWS_TEST_REQUIRE=1`): `./tests/run-kcm-test.sh` (end-to-end KCM check),
`./tests/run-script-engine-test.sh` (real QJSEngine + QTimer).

## Docs

- `README.md` — user-facing; keep it friendly and free of implementation detail.
- `docs/internals.md` — deep internals (config reload protocol, known trade-offs,
  window-flag behavior, journal logging, CI). Put design-level notes there.
