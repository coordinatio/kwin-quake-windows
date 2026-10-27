"""UI checks for the Quake Windows settings form.

Two independent parts:

1. Structure of contents/config/main.xml and contents/ui/config.ui, verified with
   the standard library only. These checks always run.
2. The instantiated widgets, loaded from contents/ui/config.ui with PyQt6's uic
   under the offscreen QPA platform, so the form can be exercised without a
   display and without starting System Settings. This part is optional: when
   PyQt6 is missing the script explains that, keeps the structural results and
   exits 0.

    python3 tests/ui-test.py
"""

import os
import sys
import xml.etree.ElementTree as ET

# Forced, not defaulted: a caller that exports another platform must not make the
# optional widget part fail (or try to reach a display).
os.environ["QT_QPA_PLATFORM"] = "offscreen"

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UI_PATH = os.path.join(REPO_ROOT, "contents", "ui", "config.ui")
MAIN_XML_PATH = os.path.join(REPO_ROOT, "contents", "config", "main.xml")

# Mirrors SLOT_COUNT in contents/code/main.js; tests/main-js-test.mjs cross-checks
# that the three definitions stay in sync.
SLOTS = 7

failures = []
checks = 0


def check(condition, message):
    global checks
    checks += 1
    if not condition:
        failures.append(message)
        print("FAIL:", message)
    else:
        print("ok:  ", message)


def summary():
    """One line with the totals, so a run can be compared with the previous one."""
    print("\n%d checks, %d failures" % (checks, len(failures)))


# ---------------------------------------------------------------- config main.xml
KCfg = "{http://www.kde.org/standards/kcfg/1.0}"
tree = ET.parse(MAIN_XML_PATH)
entries = {}
for entry in tree.getroot().iter(KCfg + "entry"):
    entries[entry.get("name")] = (
        entry.get("type"),
        entry.findtext(KCfg + "default"),
    )

expected_entries = set()
for slot in range(1, SLOTS + 1):
    expected_entries.add("Enabled%d" % slot)
    expected_entries.add("WindowName%d" % slot)

check(set(entries) == expected_entries,
      "main.xml declares exactly Enabled1..7 and WindowName1..7 (got %s)" % sorted(entries))
for name, (type_, default) in sorted(entries.items()):
    if name.startswith("Enabled"):
        check(type_ == "Bool" and default == "true", "%s is Bool with default true" % name)
    else:
        check(type_ == "String" and default == "", "%s is String with default ''" % name)

group = tree.getroot().find(KCfg + "group")
check(group is not None and group.get("name") == "", "main.xml keeps the default (empty) group")
kcfgfile = tree.getroot().find(KCfg + "kcfgfile")
check(kcfgfile is not None and kcfgfile.get("name") == "",
      "main.xml uses kcfgfile name='' (kwinrc)")

# ------------------------------------------------------------------------- ui file
ui_tree = ET.parse(UI_PATH)
ui_class = ui_tree.getroot().findtext("class")
check(ui_class == "KWin::QuakeWindowsConfigForm",
      "ui class is KWin::QuakeWindowsConfigForm (got %r)" % ui_class)
root_widget = ui_tree.getroot().find("widget")
check(root_widget.get("name") == ui_class,
      "root objectName equals the translation context (got %r)" % root_widget.get("name"))

kcfg_names = set()
for widget in ui_tree.getroot().iter("widget"):
    name = widget.get("name") or ""
    if name.startswith("kcfg_"):
        kcfg_names.add(name[len("kcfg_"):])
check(kcfg_names == expected_entries,
      "every main.xml entry has a kcfg_ widget and vice versa (missing: %s, extra: %s)"
      % (sorted(expected_entries - kcfg_names), sorted(kcfg_names - expected_entries)))
check(len(kcfg_names) == 2 * SLOTS, "the form holds %d kcfg_* widgets" % len(kcfg_names))

connections = set()
for connection in ui_tree.getroot().iter("connection"):
    connections.add((
        connection.findtext("sender"),
        connection.findtext("signal"),
        connection.findtext("receiver"),
        connection.findtext("slot"),
    ))
for slot in range(1, SLOTS + 1):
    expected = ("kcfg_Enabled%d" % slot, "toggled(bool)",
                "kcfg_WindowName%d" % slot, "setEnabled(bool)")
    check(expected in connections,
          "ui connects kcfg_Enabled%d toggled -> kcfg_WindowName%d setEnabled" % (slot, slot))

# ---------------------------------------------------------------- runtime widgets
try:
    from PyQt6 import QtWidgets, uic
except ImportError as error:
    print("\nSKIP: the widget checks need PyQt6, which is not available (%s)." % error)
    print("      Install it with 'python3 -m pip install PyQt6' or your distribution's")
    print("      python3-pyqt6 package. The settings form itself does not need Python.")
    summary()
    sys.exit(1 if failures else 0)

app = QtWidgets.QApplication(sys.argv)
widget = uic.loadUi(UI_PATH)
check(widget is not None, "uic can instantiate the form")
check(widget.objectName() == ui_class,
      "instantiated form objectName is %r" % widget.objectName())

for slot in range(1, SLOTS + 1):
    checkbox = widget.findChild(QtWidgets.QCheckBox, "kcfg_Enabled%d" % slot)
    edit = widget.findChild(QtWidgets.QLineEdit, "kcfg_WindowName%d" % slot)
    check(checkbox is not None, "kcfg_Enabled%d exists as QCheckBox" % slot)
    check(edit is not None, "kcfg_WindowName%d exists as QLineEdit" % slot)
    if checkbox is None or edit is None:
        continue
    check(checkbox.isChecked(), "kcfg_Enabled%d defaults to checked" % slot)
    check(edit.isEnabled(), "kcfg_WindowName%d defaults to enabled" % slot)
    check(edit.isClearButtonEnabled(), "kcfg_WindowName%d has a clear button" % slot)
    check(checkbox.text() == "Window %d" % slot,
          "kcfg_Enabled%d is labelled %r" % (slot, checkbox.text()))

    checkbox.setChecked(False)
    check(not edit.isEnabled(),
          "unchecking kcfg_Enabled%d disables kcfg_WindowName%d" % (slot, slot))
    checkbox.setChecked(True)
    check(edit.isEnabled(),
          "re-checking kcfg_Enabled%d enables kcfg_WindowName%d" % (slot, slot))

    # A stored "EnabledN=false" must arrive with a disabled field that keeps its text.
    checkbox.setChecked(False)
    edit.setText("^Alacritty$")
    check(edit.text() == "^Alacritty$" and not edit.isEnabled(),
          "expression is preserved while the slot is disabled (%d)" % slot)
    checkbox.setChecked(True)
    edit.clear()

if failures:
    summary()
    sys.exit(1)

summary()
print("All UI checks passed.")
