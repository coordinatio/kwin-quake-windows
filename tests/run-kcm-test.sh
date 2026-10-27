#!/bin/bash
#
# Optional end-to-end check of the Quake Windows settings KCM.
#
# Builds tests/kcm-test.cpp, installs the package with kpackagetool6 into a
# throw-away XDG_DATA_HOME, writes a kwinrc fixture and drives the real KCModule
# through KCMultiDialog. It covers the wiring no other test can reach:
# contents/config/main.xml <-> contents/ui/config.ui <-> [Script-quakewindows]
# <-> KLocalizedTranslator.
#
# The check runs twice, once with LANG=C.UTF-8 and once with LANG=ru_RU.UTF-8
# when that locale is installed, so the translated form is exercised too.
#
# Everything - build tree, installed package, kwinrc, XDG dirs - lives in one
# mktemp -d directory that is removed on exit. The repository, ~/.config and
# ~/.local/share are never written to, so a live KWin session is not disturbed.
#
# The check is optional by design: without g++, the Qt6/KF6 development headers,
# kpackagetool6 or KWin's generic scripted configuration plugin it explains what
# is missing and exits 0. QUAKEWINDOWS_TEST_REQUIRE=1 turns that skip into a
# failure, so a CI job cannot go green while the coverage silently disappears.
#
#   ./tests/run-kcm-test.sh
#
# SPDX-License-Identifier: GPL-3.0-or-later

set -uo pipefail

TESTS_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(dirname "$TESTS_DIR")"
PACKAGE_ID="quakewindows"
CONFIG_PLUGIN="kwin/effects/configs/kcm_kwin4_genericscripted.so"

skip() {
    echo "SKIP: $1"
    shift
    for line in "$@"; do
        echo "      $line"
    done
    echo "      Nothing was built, installed or run."
    # A CI job must not go green while the coverage silently disappears.
    if [ "${QUAKEWINDOWS_TEST_REQUIRE:-}" = "1" ]; then
        echo "FAIL: QUAKEWINDOWS_TEST_REQUIRE=1 asks for this check, but it cannot" >&2
        echo "      run here: install the dependencies listed above or unset the variable." >&2
        exit 1
    fi
    exit 0
}

# ---------------------------------------------------------------- dependencies
missing=()

if ! command -v g++ >/dev/null 2>&1; then
    missing+=("g++ (a C++20 compiler)")
fi
if ! command -v kpackagetool6 >/dev/null 2>&1; then
    missing+=("kpackagetool6 (the KPackage install tool)")
fi

# KF6 headers live in a directory per framework, so every one of them becomes its
# own -I flag, exactly like the $(pkg-config --cflags KF6...) expansion would.
KF6_INCLUDE="/usr/include/KF6"
kf6_flags=()
if [ -f "$KF6_INCLUDE/KCMUtils/KCMultiDialog" ] && [ -f "$KF6_INCLUDE/KConfigWidgets/KConfigDialog" ]; then
    shopt -s nullglob
    for dir in "$KF6_INCLUDE"/*; do
        [ -d "$dir" ] && kf6_flags+=("-I$dir")
    done
    shopt -u nullglob
else
    missing+=("the KF6 development headers ($KF6_INCLUDE/KCMUtils)")
fi

qt_root=""
for candidate in /usr/include/qt6 /usr/include/x86_64-linux-gnu/qt6 /usr/lib/qt6/include; do
    if [ -f "$candidate/QtWidgets/QApplication" ] && [ -f "$candidate/QtCore/QCoreApplication" ]; then
        qt_root="$candidate"
        break
    fi
done
qt_flags=()
if [ -n "$qt_root" ]; then
    qt_flags+=("-I$qt_root")
    shopt -s nullglob
    for dir in "$qt_root"/*; do
        [ -d "$dir" ] && qt_flags+=("-I$dir")
    done
    shopt -u nullglob
else
    missing+=("the Qt6 development headers (QtWidgets/QApplication)")
fi

plugin_path=""
plugin_dirs=()
if [ -n "${QT_PLUGIN_PATH:-}" ]; then
    IFS=':' read -r -a plugin_dirs <<<"$QT_PLUGIN_PATH"
fi
plugin_dirs+=(
    /usr/lib/qt6/plugins
    /usr/lib64/qt6/plugins
    /usr/lib/x86_64-linux-gnu/qt6/plugins
    /usr/local/lib/qt6/plugins
)
for dir in "${plugin_dirs[@]}"; do
    if [ -f "$dir/$CONFIG_PLUGIN" ]; then
        plugin_path="$dir/$CONFIG_PLUGIN"
        break
    fi
done
if [ -z "$plugin_path" ]; then
    missing+=("KWin's generic scripted configuration plugin ($CONFIG_PLUGIN)")
fi

if [ ${#missing[@]} -gt 0 ]; then
    lines=()
    for item in "${missing[@]}"; do
        lines+=("- $item")
    done
    lines+=("On Arch/Plasma install: base-devel qt6-base kf6-kcmutils kf6-kconfigwidgets kwin.")
    lines+=("The JavaScript, UI and locale suites do not need any of this.")
    skip "the optional KCM check cannot run here, the following is missing:" "${lines[@]}"
fi

# ------------------------------------------------------------------ temp sandbox
work="$(mktemp -d "${TMPDIR:-/tmp}/quakewindows-kcm.XXXXXX")"
trap 'rm -rf "$work"' EXIT

mkdir -p "$work/build" "$work/pkg"
cp -a "$REPO_ROOT/contents" "$REPO_ROOT/LICENSE" "$REPO_ROOT/metadata.json" "$work/pkg/"

# ---------------------------------------------------------------- build the test
echo "==> building tests/kcm-test.cpp"
if ! g++ -std=c++20 -fPIC -O0 -o "$work/build/kcm-test" "$TESTS_DIR/kcm-test.cpp" \
        "${kf6_flags[@]}" "${qt_flags[@]}" \
        -lKF6KCMUtils -lKF6KCMUtilsCore -lKF6ConfigCore -lKF6ConfigGui \
        -lKF6ConfigWidgets -lKF6CoreAddons -lKF6WidgetsAddons \
        -lQt6Widgets -lQt6Gui -lQt6Core; then
    echo "FAIL: the KCM test did not compile" >&2
    exit 1
fi

# --------------------------------------------------------------- one locale run
# Each run gets its own XDG tree: the test applies changes and finally presses
# Defaults, so the kwinrc fixture has to start from scratch every time.
# The third argument is the language the test has to see in the form: "C" for
# English, "ru" for the Russian catalog. The test skips the Russian assertion
# itself when Qt did not pick the locale up, so an installed-locale check here is
# enough.
run_locale() {
    local lang="$1"
    local tag="$2"
    local expect="$3"
    local root="$work/$tag"

    mkdir -p "$root/data" "$root/config" "$root/cache" "$root/run" "$root/home"
    chmod 700 "$root/run"

    # The installed package must come from the temporary copy, never from the
    # working tree, and it must land in the temporary XDG_DATA_HOME.
    if ! XDG_DATA_HOME="$root/data" XDG_CONFIG_HOME="$root/config" \
            XDG_CACHE_HOME="$root/cache" XDG_RUNTIME_DIR="$root/run" HOME="$root/home" \
            kpackagetool6 --type KWin/Script --install "$work/pkg" >"$root/install.log" 2>&1; then
        echo "FAIL: kpackagetool6 could not install the package" >&2
        cat "$root/install.log" >&2
        return 1
    fi

    cat >"$root/config/kwinrc" <<'EOF'
[Plugins]
quakewindowsEnabled=true

[Script-quakewindows]
WindowName1=^Alacritty$
WindowName2=^.*Rocket\.Chat.*$
Enabled3=false
WindowName3=Чат и звонки
EOF

    echo "==> running the KCM test with LANG=$lang"
    XDG_DATA_HOME="$root/data" XDG_CONFIG_HOME="$root/config" \
        XDG_CACHE_HOME="$root/cache" XDG_RUNTIME_DIR="$root/run" HOME="$root/home" \
        QUAKEWINDOWS_TEST_EXPECT_LANG="$expect" \
        QT_QPA_PLATFORM=offscreen LANG="$lang" LC_ALL="$lang" \
        "$work/build/kcm-test"
}

status=0
run_locale "C.UTF-8" "c" "C" || status=1

# The Russian run is only meaningful when the locale exists on this machine.
if [ "$status" -eq 0 ] && locale -a 2>/dev/null | grep -qi '^ru_RU'; then
    run_locale "ru_RU.UTF-8" "ru" "ru" || status=1
elif [ "$status" -eq 0 ]; then
    echo "==> skipping the ru_RU.UTF-8 run: the locale is not installed here"
fi

if [ "$status" -ne 0 ]; then
    echo "FAIL: the KCM test reported failures" >&2
    exit 1
fi

echo
echo "The KCM round trip passed; nothing outside $work was written to."
