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
press. There is no need to disable and re-enable the script.

If a hotkey is pressed before that happens, the press is held back and carried out once the
new values have arrived; that press may be delayed by about 200 ms and at most by the 1 s
safety timeout, because it waits for KWin to re-read `kwinrc`. The safety timer is restarted
by every deferred press, so the wait is up to about a second after the *last* press, not
after the first one. If KWin does not confirm the reload within that time, the pending
presses are carried out anyway after re-reading the configuration one last time — a
keypress is never lost.

A press that arrives before Apply is replayed with the configuration as it was before that
Apply: the press happened first, so it is not retroactively applied to the new expression.
The next press uses the new one.

While the Configure dialog stays focused, every press is remembered and asks for a reload.
`requestConfigReload()` ignores a request while one is still pending, so presses spaced
further apart each cost one reconfigure, and KWin itself runs at most one configure pass per
~200 ms.

Leaving System Settings triggers one KWin reconfigure even from an unrelated page, and so
does closing `kcmshell6`: the script cannot tell which configuration module was open. That
is the price of the generic scripted configuration module not notifying KWin after writing
`kwinrc` (upstream TODO).

If the change does not arrive (for instance after editing `kwinrc` by hand), toggle the
script off and on again in *KWin Scripts*.

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
and `po/quakewindows.pot` must agree.

## Credits

The script is inspired by [kwin-toggle-window](https://www.opencode.net/arnek01/kwin-toggle-window) by Arne Keller.
