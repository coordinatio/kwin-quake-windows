# Quake Windows

A KWin script that makes any window behave like a quake-style drop-down terminal:
press a hotkey and the window slides in; press it again and the window hides.

Despite the name, it works with **any** application — a terminal, a chat window, a
music player — anything you want one keystroke away.

**Features**

- Up to **7 windows**, each with its own hotkey and matching rule
- Windows are recognized by **title**, with full **regular expression** support
- A built-in settings dialog (available in English and Russian)

**Requirements:** KWin 6 (KDE Plasma 6).

## Installation

Download `quakewindows.kwinscript` from the
[releases page](../../releases) and install it:

```sh
kpackagetool6 --type KWin/Script --install quakewindows.kwinscript
```

Then enable **Quake Windows** in
*System Settings → Window Management → KWin Scripts*.

> Building from source? Clone the repository, run `./pack.sh` to produce the
> `.kwinscript` archive, and install that. Installing the directory itself works too
> but includes development files — see [docs/internals.md](docs/internals.md#packaging-archive-vs-directory-install).

## Quick start

1. **Match your window.** Open *System Settings → Window Management → KWin Scripts*,
   select **Quake Windows** and press **Configure**. The dialog has seven slots; in a
   free slot, enter a regular expression that matches the window title, e.g.
   `^Alacritty$` for a terminal whose title is exactly "Alacritty". Press **OK**.
2. **Assign a hotkey.** Go to *System Settings → Keyboard → Shortcuts → KWin*, search
   for **Toggle Window 1** … **Toggle Window 7** and bind each to a key of your choice
   (many people like `` Meta+` ``).
3. **Toggle!** Focus your window once so KWin knows it, then press the hotkey to hide
   and show it.

### Matching tips

- Matching is **case-sensitive** and searches **anywhere** in the title. Use
  `^...$` when the expression must match the whole title.
- Patterns are JavaScript regular expressions, so `^(Chat|Messenger)$` and
  `\.rocket\.chat` work as expected. Invalid patterns are ignored and reported in the
  KWin journal; the other slots keep working.
- A field that contains only whitespace counts as empty and disables the slot.
  Otherwise the expression is used verbatim — leading and trailing spaces are
  significant.
- Expressions run for every window on every hotkey press and desktop switch, so keep
  them narrow: a pathological pattern can stall window handling.
- **Defaults** in the dialog clears every expression and enables every slot.
- Unchecking a slot (or clearing its expression) disables it — the expression is
  preserved.

## Applying configuration changes

Press **Apply** or **OK** and you are done — the new values take effect within a
second or two (once System Settings loses focus, or on the next hotkey press). There is
no need to disable and re-enable the script, and a hotkey pressed in between is not
lost. If a change somehow does not arrive (for instance after editing `kwinrc` by
hand), toggle the script off and on again in *KWin Scripts*.

The details of how the script reloads `kwinrc` — and the known corner cases around
presses that race with **Apply** — are documented in
[docs/internals.md](docs/internals.md#how-configuration-reloading-works).

## Manual configuration (legacy)

The settings dialog writes plain `kwinrc` keys in the `[Script-quakewindows]` group,
so they can still be set by hand:

```sh
kwriteconfig6 --file ~/.config/kwinrc --group Script-quakewindows --key WindowName1 '^Alacritty$'
kwriteconfig6 --file ~/.config/kwinrc --group Script-quakewindows --key Enabled1 true
```

`WindowName1` … `WindowName7` hold the expressions, `Enabled1` … `Enabled7` (optional,
default `true`) switch the slots on and off. `kwriteconfig6` escapes the value for you,
but a line typed into `kwinrc` by hand must have every backslash doubled (`\\`) because
KConfig reads the file as an escaped string — unlike the form field, which stores the
expression verbatim. After a manual edit either reopen the configuration dialog and
press OK, or disable and re-enable the script.

## A note on window flags

Toggling does not save and restore window properties: a managed window always ends up
on all virtual desktops with the taskbar/pager/switcher flags simplified, and those
flags can override window rules asking for something else. Keep your expressions narrow
when that matters. Details:
[docs/internals.md](docs/internals.md#how-a-toggle-changes-window-properties).

## Troubleshooting

Everything the script reports goes to KWin's journal:

```sh
journalctl -f -u plasma-kwin_wayland
```

Look for lines starting with `QuakeWindows:` (for example, reports about invalid
regular expressions). More about the log output, including how to quiet the
informational lines, is in
[docs/internals.md](docs/internals.md#reading-the-journal).

## Migration from 2.1

Previously every slot fell back to the expression `Alacritty`, even slots that were
never configured. An empty slot is now simply inactive. If you relied on that implicit
default, enter `Alacritty` in the slot explicitly.

Slot matching also requires a non-empty window caption now, so a catch-all pattern such
as `.*` no longer matches caption-less windows that 2.1 accepted.

Existing `WindowName1` … `WindowName7` values and existing global shortcuts are
unchanged.

## Translations

The settings dialog ships in English and Russian. Translation sources live in `po/`:

```sh
tools/update-po.sh                     # regenerate po/quakewindows.pot from contents/ui/config.ui
msgmerge --update po/ru.po po/quakewindows.pot
tools/build-locale.sh                  # compile po/*.po into contents/locale/<lang>/LC_MESSAGES/*.mo
```

## Development

Run the dependency-free checks with:

```sh
node tests/main-js-test.mjs            # script logic against mocked KWin globals
python3 tests/ui-test.py               # config.ui / main.xml structure (+ widgets if PyQt6 is present)
python3 tests/locale-test.py           # committed translation catalogs
```

Two optional suites (`tests/run-kcm-test.sh`, `tests/run-script-engine-test.sh`)
exercise the real KCM and a real Qt script engine; they skip cleanly when their
dependencies are missing. `QUAKEWINDOWS_TEST_REQUIRE=1` turns such a skip into a
failure, which is what CI uses. Full descriptions of every suite and of the CI jobs are
in [docs/internals.md](docs/internals.md#tests).

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).

## Credits

The script is inspired by [kwin-toggle-window](https://www.opencode.net/arnek01/kwin-toggle-window) by Arne Keller.
