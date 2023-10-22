# kwin-quake-windows

Make any window behave like a quake-style terminal! Enables window show/hide by hotkey. Can handle up to 7 different windows. Window title is used to recognize windows. Regex supported.

Define windows' titles to handle like that:
```
kwriteconfig5 --file ~/.config/kwinrc --group Script-quakewindows --key WindowName1 <window title regex for the first hotkey>
kwriteconfig5 --file ~/.config/kwinrc --group Script-quakewindows --key WindowName2 <window title regex for the second hotkey>
…
kwriteconfig5 --file ~/.config/kwinrc --group Script-quakewindows --key WindowName7 <window title regex for the seventh hotkey>
```

Disable-Enable the script inside KWin settings after changing the configuration.

The script is inspired by [kwin-toggle-window](https://www.opencode.net/arnek01/kwin-toggle-window) by Arne Keller.
