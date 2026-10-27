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

### Hotkeys

Hotkeys are not part of this dialog — they are managed by KDE. Assign them in
*System Settings → Keyboard → Shortcuts → KWin* and search for **Toggle Window 1** …
**Toggle Window 7**. Existing assignments keep working after an upgrade: the shortcut
identifiers did not change.

### Applying changes

Press **Apply** or **OK**. The new values are applied as soon as the configuration window
loses focus or closes — no need to disable and re-enable the script. If a hotkey is pressed
before that happens, the press is held back and carried out once the new values have
arrived; that single press may be delayed by roughly half a second, because it waits for
KWin to re-read `kwinrc`.

If the change does not arrive (for instance after editing `kwinrc` by hand), toggle the
script off and on again in *KWin Scripts*.

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

Existing `WindowName1` … `WindowName7` values and existing global shortcuts are unchanged.

## Translations

The settings dialog ships in English and Russian. Translation sources live in `po/`:

```
tools/update-po.sh                     # regenerate po/quakewindows.pot from contents/ui/config.ui
msgmerge --update po/ru.po po/quakewindows.pot
tools/build-locale.sh                  # compile po/*.po into contents/locale/<lang>/LC_MESSAGES/*.mo
```

## Credits

The script is inspired by [kwin-toggle-window](https://www.opencode.net/arnek01/kwin-toggle-window) by Arne Keller.
