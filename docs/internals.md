# Internals

Implementation notes for the **Quake Windows** KWin script. This document collects the
deep details that used to live in the README: how configuration reloading works, the
known trade-offs, what a toggle does to window properties, journal output, and the test
suites.

## Packaging: archive vs directory install

`quakewindows.kwinscript` (built by `./pack.sh`) is the distributable form. A directory
install (`kpackagetool6 --type KWin/Script --install .`) copies the whole tree,
development files included (`tests/`, `po/`, `tools/`, `pack.sh`, the docs):
kpackagetool6 does not honour an ignore file such as `.kpackageignore`, so the archive
built by `./pack.sh` is the only way to keep them out of an installation.

## How configuration reloading works

Why KWin has to be asked: `kwinrc` is only re-read when KWin reconfigures itself or when
its scripting interface is asked to reload, and the generic scripted configuration module
writes the script's group without notifying KWin afterwards (upstream TODO). Scripts get
no signal about their own configuration either, so the script infers *when* to reload from
window focus, and then asks KWin to re-read the file through its scripting interface.

* **On focus loss.** Activating a settings window sets a latch; activating a non-settings
  window with the latch set asks KWin to re-read `kwinrc` by calling
  `org.kde.kwin.Scripting.start` on `/Scripting`. KWin reparses the file synchronously
  inside that call, so its reply is a deterministic "the configuration is fresh now"
  moment instead of something the script has to infer from a timeout. It is also the
  cheap call: it does not re-evaluate the window rules of every window the way
  `org.kde.KWin.reconfigure` (`Workspace::slotReconfigure()`) does, and it does not
  restart this script — KWin's `Script::run()` returns immediately for a script that is
  already running, so only the already loaded script list is refreshed.
* **On the reply.** The callback of that call re-reads the seven slots, stops the
  deadline and replays the presses that were waiting for the new values. Nothing else is
  needed: the reply means the file has been re-read.
* **On a press.** If the configuration may be stale — a reload was requested and not
  confirmed, the dialog was activated since the last reload, or the dialog is focused
  right now — the press is not carried out. Its slot is remembered as an odd/even count
  (toggling is parity-sensitive, so two presses restore the original state and an
  unbounded queue is unnecessary) and a reload is requested. While the dialog stays
  focused, presses keep being remembered that way.
* **On a timeout.** A single 1000 ms deadline is armed by the reload request and re-armed
  by every deferred press, so it fires 1 s after the last of them rather than after the
  first. It has two stages, one per request. When it fires without a reply — for instance
  on a KWin that does not know the scripting method: `Script::callDBus()` drops the error
  reply and never calls the callback — the script falls back once to
  `org.kde.KWin.reconfigure`, which works on every KWin, writes one journal line, and
  re-arms the deadline so that the reconfigure's own answer has a chance to arrive. When
  the second deadline also expires, `awaitingConfig` is cleared (otherwise one unanswered
  request would ignore all later ones forever), one more line is written, the
  configuration is re-read and the remembered presses are replayed. A press is therefore
  never lost because KWin stayed silent.
* **On `options.configChanged`.** Any such signal counts too, whichever reconfigure caused
  it (a KCM applying a KWin setting, for example): KWin reparses its configuration before
  emitting it, so the values are already fresh. It runs the same handler as the reply,
  which is idempotent — an unchanged configuration signature makes the re-read a no-op,
  and the press queue is emptied before it is replayed — so a reply and a `configChanged`
  for the same reload replay the presses exactly once.

### Known trade-offs

* A press that arrives before Apply is replayed against the configuration as it was
  before that Apply — *usually*, because this is a race, not a guarantee: it holds when
  the press was deferred before KWin's reparse finished. If Apply lands first and the
  reload completes before the deferred press is replayed, that press is replayed against
  the new values instead. The next press always uses the new expression.
* A replay that activates a normal window clears the "dialog was used" latch, because the
  activation looks exactly like focus leaving the dialog. So if the Configure dialog is
  still open, the next press can use the values from before the dialog's *next* Apply
  instead of being deferred. The Apply click refocuses the dialog and re-arms the latch,
  so this heals itself and costs at most one press.
* Leaving System Settings asks for one configuration reload even from an unrelated page,
  and so does closing `kcmshell6`: the script cannot tell which configuration module was
  open. That is the price of the generic module not notifying KWin after writing
  `kwinrc`. Only the fallback path costs a full reconfigure, which also re-evaluates
  every window rule, and it is coalesced by KWin's own ~200 ms timer.
* Which windows count as settings windows is a name heuristic over the window class, the
  resource name and the desktop file name (the names ending in `settings` and the
  `kcmshell` modules). A third-party window whose name merely ends with `settings` is
  treated as one too, which costs at most one deferred press and one extra reload.
* If no deadline can be armed — no `QTimer` can be created, or `start()` fails — a press
  with a possibly stale configuration is toggled synchronously instead of waiting
  forever. The same fallback applies when the reload request itself fails. That is
  reported once in the journal, and a reload request is never latched without a deadline
  to end it.
* Holding a hotkey while a settings window is focused defers every auto-repeated press,
  and the parity model then decides the outcome: an odd number of presses toggles the
  slot once after the deadline, an even number toggles nothing at all. That is inherent
  to counting presses instead of queueing them, not a bug.

## How a toggle changes window properties

Toggling does not save and restore the previous values: it always sets `onAllDesktops`,
`skipTaskbar`, `skipPager` and `skipSwitcher` to `!minimized`. A window that already had
one of those flags set therefore ends up with the simplified state rather than with what
it had before. The desktop-change workaround also forces `skipTaskbar = minimized` for
every window matching a slot, which can override a window rule that asks for something
else. Keep the expressions narrow when that matters.

## Reading the journal

Everything the script reports goes to KWin's journal: `journalctl -f -u plasma-kwin_wayland`
shows the `QuakeWindows:` lines live. They are written by the script's `console` calls,
which belong to QJSEngine's console extension, so their logging category is `js` — a
journal record of such a line carries `QT_CATEGORY=js`. `kwin_scripting` is KWin's own
scripting category (the `<file>:<line>: error: …` lines of an uncaught script error), not
this one.

`console.warn` is a warning and is shown by default, like the informational lines. To
quiet the informational ones, export `QT_LOGGING_RULES="js.info=false"` before KWin
starts; `js.debug=true` only affects `console.log`, which this script does not use.

## Tests

`node tests/main-js-test.mjs` runs the logic tests of `contents/code/main.js` against
mocked KWin globals (plain Node, no dependencies). It also cross-checks
`contents/config/main.xml`, `contents/ui/config.ui` and `SLOT_COUNT` against each other.
It also verifies that every translatable string of the form is present in
`po/quakewindows.pot`, that the template holds no obsolete entries, and that
`metadata.json` carries `Name` and `Description` together with their `[ru]` variants.

`python3 tests/ui-test.py` checks the structure of `contents/config/main.xml` and
`contents/ui/config.ui` with the standard library only (entry types and defaults, the
group, the toggle connections, the kcfg_* widget set), then exercises the instantiated
form with PyQt6 (`QT_QPA_PLATFORM` is forced to `offscreen`). The widget part is optional
and skips with an explanation when PyQt6 is missing; the structural checks always run.

`python3 tests/locale-test.py` checks the committed catalogs (Python standard library
only): every `.pot` msgid must have a Russian translation in
`contents/locale/ru/LC_MESSAGES/quakewindows.mo` that differs from the English source and
is exactly the `msgstr` text of `po/ru.po`, the catalog must not hold msgids missing from
the template, and the version in `metadata.json`, `po/ru.po` and `po/quakewindows.pot`
must agree; `X-KWin-Config-TranslationDomain` in `metadata.json` must name the same domain
the catalog is loaded from.

`./tests/run-kcm-test.sh` is the optional end-to-end check of the settings dialog: it
builds `tests/kcm-test.cpp`, installs the package with `kpackagetool6` into a throw-away
`XDG_DATA_HOME` and drives the real KCM (KConfigXT ↔ `config.ui` ↔
`[Script-quakewindows]` ↔ translations), first with `LANG=C.UTF-8` and then with
`LANG=ru_RU.UTF-8` when that locale is installed. Each run also asserts the language of
the intro label, so the translated form is not just exercised but checked. It needs
`g++`, the Qt6/KF6 development headers, `kpackagetool6` and KWin's generic scripted
configuration plugin; when any of them is missing it explains that and exits 0. Nothing
is written outside its temporary directory.

`./tests/run-script-engine-test.sh` is the optional check against a real script engine:
it builds `tests/script-engine-test.cpp`, evaluates `contents/code/main.js` in a
`QJSEngine` where `readConfig`, `registerShortcut`, `callDBus`, `console`, `workspace`
and `options` are recording mocks and `QTimer` is the real Qt class KWin exposes, then
presses the shortcuts, defers a press behind an active settings window, replays it
through the reply of the scripting-interface request and through
`options.configChanged`, and waits for the actual timer to fire — asserting that the
silent-KWin fallback sends exactly one reconfigure and that the replay happens within two
deadlines of the deferral. It needs `g++`, `pkg-config`, `qmake6` (to locate `moc`) and
the Qt6 Core/Qml development files; when any of them is missing it explains that and
exits 0.

Both optional suites - the KCM check and the script engine check - skip with exit status 0
when their dependencies are missing. A CI job must not go green while that coverage
silently disappears, so set `QUAKEWINDOWS_TEST_REQUIRE=1` to turn such a skip into a
failure:

```
QUAKEWINDOWS_TEST_REQUIRE=1 ./tests/run-kcm-test.sh
QUAKEWINDOWS_TEST_REQUIRE=1 ./tests/run-script-engine-test.sh
```

With the variable set, a missing dependency is reported as `FAIL` with exit status 1. The
JavaScript, UI and locale suites have no optional parts and do not look at it.

## Continuous integration

`.github/workflows/ci.yml` runs on every push to `main`, on every pull request and on
demand, in two jobs:

* **suites** - the dependency-free checks (`main-js-test.mjs`, `ui-test.py` without
  PyQt6, `locale-test.py`) and `./pack.sh`. It fails if `pack.sh` warns (a drifted or
  stale catalog), if building modifies a tracked file, or if the archive is missing a
  file the package needs or carries a developer-only entry such as `tests/` or `po/`.
* **kwin** - the optional checks against a real Qt6/KF6/KWin stack in an Arch container:
  the PyQt6 widget part of `ui-test.py`, `run-script-engine-test.sh` and
  `run-kcm-test.sh` with both `C.UTF-8` and `ru_RU.UTF-8`. `QUAKEWINDOWS_TEST_REQUIRE=1`
  is set, so a missing dependency or an absent locale fails the job instead of quietly
  shrinking the coverage.
