# kwin-quake-windows

Simple script to toggle the visibility of a window by (un-)minimizing and hiding it from the task panel, pager and application switcher when minimized. It allows you to have the quick access to running applications that you must review frequently during the day. For example, I use the script with the file manager, task list, e-mail client and chat windows.  
The script can handle up to 7 different windows.

The relevant window is selected by testing the supplied regex against window titles. The regex could be specified by the command like:

```
kwriteconfig5 --file ~/.config/kwinrc --group Script-quakewindows --key WindowName1 <window title regex>
```

Disable-Enable the script inside KWin settings after changing the configuration.

The script is inspired by [kwin-toggle-window](https://www.opencode.net/arnek01/kwin-toggle-window) by Arne Keller.
