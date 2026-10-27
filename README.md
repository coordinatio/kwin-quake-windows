# kwin-quake-windows

Make any window behave like a quake-style terminal! Enables window show/hide by hotkey.
Can handle up to 7 different windows. Window title is used to recognize windows.
Regex supported.

Requires KWin 6 (Plasma 6).

## Installation

```
kpackagetool6 --type KWin/Script --install quakewindows.kwinscript
```

Or install the directory itself while developing:

```
kpackagetool6 --type KWin/Script --install .
```

`quakewindows.kwinscript` is the distributable form. A directory install copies the whole
tree, development files included (`tests/`, `po/`, `tools/`, `pack.sh`, this README):
kpackagetool6 does not honour an ignore file such as `.kpackageignore`, so the archive
built by `./pack.sh` is the only way to keep them out of an installation.

Then enable **Quake Windows** in *System Settings → Window Management → KWin Scripts*.

## Configuration

Open *System Settings → Window Management → KWin Scripts*, select **Quake Windows** and
press **Configure**.

The dialog has seven window slots. Every slot consists of an enable checkbox and a regular
expression matched against the window title:

* Uncheck a slot (or clear its expression) to disable it — the expression is preserved.
* Matching is **case-sensitive** and searches **anywhere** in the title. Use `^...$` when
  the expression must match the whole title, e.g. `^Alacritty$`.
* Patterns are JavaScript regular expressions, so `^(Chat|Messenger)$` and
  `\.rocket\.chat` work as expected. Invalid patterns are ignored and reported in the KWin
  journal; the other slots keep working.
* Expressions are evaluated in KWin's scripting thread for every window on every press and on
  every desktop switch, so a pathological pattern can stall window handling — keep them narrow.
* **Defaults** in the dialog clears every expression and enables every slot.
* A field that contains only whitespace is treated as empty, so the slot is disabled. Any
  other expression is used verbatim, so leading and trailing spaces are significant: a
  pattern that ends with a space only matches a caption that ends with that space.

### Hotkeys

Hotkeys are not part of this dialog — they are managed by KDE. Assign them in
*System Settings → Keyboard → Shortcuts → KWin* and search for **Toggle Window 1** …
**Toggle Window 7**. Existing assignments keep working after an upgrade: the shortcut
identifiers did not change.

### Applying changes

Press **Apply** or **OK**. Closing the Configure dialog only returns focus to System Settings,
which is itself a settings window, so the script cannot treat that as "the dialog is gone":
the new values are applied once System Settings itself loses focus, or on the next hotkey
press. There is no need to disable and re-enable the script, and a hotkey pressed in between
is not lost — it waits for the new values, normally about 200 ms after KWin confirms the
reconfigure. If KWin never confirms, the deferred press is replayed about 1 s after the most
recent deferred press, so several quick presses can stretch the wait.

If the change does not arrive (for instance after editing `kwinrc` by hand), toggle the
script off and on again in *KWin Scripts*.

### How configuration reloading works

Why KWin has to be asked: `kwinrc` is only re-read when KWin reconfigures itself, and the
generic scripted configuration module writes the script's group without notifying KWin
afterwards (upstream TODO). Scripts get no signal about their own configuration either, so
the script infers it from window focus.

A possible future optimisation is a script restart that reports its completion
(`Scripting.start`): the script could then re-read its configuration once instead of
inferring the reload from focus. Today that call only re-parses the script and reports
nothing, so the inference above is what is left.

* **On focus loss.** Activating a settings window sets a latch; activating a non-settings
  window with the latch set asks KWin to reconfigure through D-Bus
  (`org.kde.KWin.reconfigure`). KWin then emits `options.configChanged`, which is the moment
  `readConfig()` starts returning the new values. KWin coalesces reconfigure requests with
  its own ~200 ms timer, so the script does not debounce on its own; it only ignores a new
  request while the previous one is still unanswered, which means presses spaced further
  apart each cost one reconfigure pass.
* **On a press.** If the configuration may be stale — a reload was requested and not
  confirmed, the dialog was activated since the last reload, or the dialog is focused right
  now — the press is not carried out. Its slot is remembered as an odd/even count (toggling
  is parity-sensitive, so two presses restore the original state and an unbounded queue is
  unnecessary) and a reload is requested. While the dialog stays focused, presses keep being
  remembered that way.
* **On a timeout.** A single 1000 ms deadline is armed by the reload request and re-armed by
  every deferred press, so it fires 1 s after the last of them rather than after the first.
  When it fires, `awaitingConfig` is cleared (otherwise one unanswered request would ignore
  all later ones forever, since `callDBus()` drops error replies), one line is written to the
  journal, the configuration is re-read and the remembered presses are replayed. A press is
  therefore never lost because KWin stayed silent.
* **On `options.configChanged`.** Any such signal counts, whichever reconfigure caused it:
  KWin reparses its configuration before emitting it, so the values are already fresh. The
  script recompiles the slots, stops the deadline and replays the remembered presses in
  slot order.

Known trade-offs:

* A press that arrives before Apply is replayed against the configuration as it was before
  that Apply — *usually*, because this is a race, not a guarantee: it holds when the press
  was deferred before KWin's reparse finished. If Apply lands first and KWin's ~200 ms
  reparse completes before the deferred press is replayed, that press is replayed against the
  new values instead. The next press always uses the new expression.
* Leaving System Settings triggers one KWin reconfigure even from an unrelated page, and so
  does closing `kcmshell6`: the script cannot tell which configuration module was open. That
  is the price of the generic module not notifying KWin after writing `kwinrc`.
* Which windows count as settings windows is a name heuristic over the window class, the
  resource name and the desktop file name (the names ending in `settings` and the `kcmshell`
  modules). A third-party window whose name merely ends with `settings` is treated as one
  too, which costs at most one deferred press and one extra reconfigure.
* If no deadline can be armed — no `QTimer` can be created, or `start()` fails — a press
  with a possibly stale configuration is toggled synchronously instead of waiting forever.
  The same fallback applies when the reconfigure request itself fails. That is reported
  once in the journal, and a reload request is never latched without a deadline to end it.

### Reading the journal

Everything the script reports goes to KWin's journal: `journalctl -f -u plasma-kwin_wayland`
shows the `QuakeWindows:` lines live, and `QT_LOGGING_RULES="kwin_scripting.debug=true"`
(exported before KWin starts) raises the scripting category to debug level when a warning is
not enough.

### How a toggle changes window properties

Toggling does not save and restore the previous values: it always sets `onAllDesktops`,
`skipTaskbar`, `skipPager` and `skipSwitcher` to `!minimized`. A window that already had
one of those flags set therefore ends up with the simplified state rather than with what it
had before. The desktop-change workaround also forces `skipTaskbar = minimized` for every
window matching a slot, which can override a window rule that asks for something else. Keep
the expressions narrow when that matters.

## Manual configuration (legacy)

The settings dialog writes plain `kwinrc` keys in the `[Script-quakewindows]` group, so
they can still be set by hand:

```
kwriteconfig6 --file ~/.config/kwinrc --group Script-quakewindows --key WindowName1 '^Alacritty$'
kwriteconfig6 --file ~/.config/kwinrc --group Script-quakewindows --key Enabled1 true
```

`WindowName1` … `WindowName7` hold the expressions, `Enabled1` … `Enabled7` (optional,
default `true`) switch the slots on and off. After a manual edit either reopen the
configuration dialog and press OK, or disable and re-enable the script.

## Migration from 2.1

Previously every slot fell back to the expression `Alacritty`, even slots that were never
configured. An empty slot is now simply inactive. If you relied on that implicit default,
enter `Alacritty` in the slot explicitly.

Slot matching also requires a non-empty window caption now, so a catch-all pattern such as
`.*` no longer matches caption-less windows that 2.1 accepted.

Existing `WindowName1` … `WindowName7` values and existing global shortcuts are unchanged.

## Translations

The settings dialog ships in English and Russian. Translation sources live in `po/`:

```
tools/update-po.sh                     # regenerate po/quakewindows.pot from contents/ui/config.ui
msgmerge --update po/ru.po po/quakewindows.pot
tools/build-locale.sh                  # compile po/*.po into contents/locale/<lang>/LC_MESSAGES/*.mo
```

## Tests

`node tests/main-js-test.mjs` runs the logic tests of `contents/code/main.js` against mocked
KWin globals (plain Node, no dependencies). It also cross-checks `contents/config/main.xml`,
`contents/ui/config.ui` and `SLOT_COUNT` against each other. It also verifies that every
translatable string of the form is present in `po/quakewindows.pot`, that the template holds
no obsolete entries, and that `metadata.json` carries `Name` and `Description` together with
their `[ru]` variants.

`python3 tests/ui-test.py` checks the structure of `contents/config/main.xml` and
`contents/ui/config.ui` with the standard library only (entry types and defaults, the group,
the toggle connections, the kcfg_* widget set), then exercises the instantiated form with
PyQt6 (`QT_QPA_PLATFORM` is forced to `offscreen`). The widget part is optional and skips
with an explanation when PyQt6 is missing; the structural checks always run.

`python3 tests/locale-test.py` checks the committed catalogs (Python standard library only):
every `.pot` msgid must have a Russian translation in `contents/locale/ru/LC_MESSAGES/quakewindows.mo`
that differs from the English source and is exactly the `msgstr` text of `po/ru.po`, the catalog
must not hold msgids missing from the template, and the version in `metadata.json`, `po/ru.po`
and `po/quakewindows.pot` must agree; `X-KWin-Config-TranslationDomain` in `metadata.json` must
name the same domain the catalog is loaded from.

`./tests/run-kcm-test.sh` is the optional end-to-end check of the settings dialog: it builds
`tests/kcm-test.cpp`, installs the package with `kpackagetool6` into a throw-away `XDG_DATA_HOME`
and drives the real KCM (KConfigXT ↔ `config.ui` ↔ `[Script-quakewindows]` ↔ translations), first
with `LANG=C.UTF-8` and then with `LANG=ru_RU.UTF-8` when that locale is installed. Each run also
asserts the language of the intro label, so the translated form is not just exercised but
checked. It needs `g++`, the Qt6/KF6 development headers, `kpackagetool6` and KWin's generic
scripted configuration plugin; when any of them is missing it explains that and exits 0. Nothing
is written outside its temporary directory.

`./tests/run-script-engine-test.sh` is the optional check against a real script engine: it builds
`tests/script-engine-test.cpp`, evaluates `contents/code/main.js` in a `QJSEngine` where
`readConfig`, `registerShortcut`, `callDBus`, `console`, `workspace` and `options` are recording
mocks and `QTimer` is the real Qt class KWin exposes, then presses the shortcuts, defers a press
behind an active settings window, replays it through `options.configChanged` and waits for the
actual timer to fire — asserting that the replay happens within about 1 s of the deferral. It
needs `g++`, `pkg-config`, `qmake6` (to locate `moc`) and the Qt6 Core/Qml development files;
when any of them is missing it explains that and exits 0.

## Credits

The script is inspired by [kwin-toggle-window](https://www.opencode.net/arnek01/kwin-toggle-window) by Arne Keller.
