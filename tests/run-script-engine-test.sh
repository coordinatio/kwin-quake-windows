#!/bin/bash
#
# Optional check of contents/code/main.js against a real Qt script engine.
#
# Builds tests/script-engine-test.cpp and evaluates the script in a QJSEngine
# where QTimer is registered exactly like KWin registers it, and drives the seven
# shortcuts, the deferral behind an active settings window, the replay through
# options.configChanged and the real timer timeout. It is the only suite that can
# prove the script uses nothing KWin does not expose.
#
# Everything - build tree and the meta-object code moc generates - lives in one
# mktemp -d directory that is removed on exit. The repository and the user's
# configuration are never written to, and no D-Bus call is ever made: callDBus is
# a recording fake here.
#
# The check is optional by design: without a C++20 compiler, pkg-config, qmake6,
# moc or the Qt6 Core/Qml development files it explains what is missing and
# exits 0. Nothing happens before that check, not even mktemp.
#
# QUAKEWINDOWS_TEST_SCRIPT overrides the script under test, which is how the
# suite is shown to fail on a deliberately broken copy.
#
#   ./tests/run-script-engine-test.sh
#
# SPDX-License-Identifier: GPL-3.0-or-later

set -uo pipefail

# Pure builtins, so the skip path below works with an empty PATH.
TESTS_DIR="$(cd -- "${BASH_SOURCE[0]%/*}" && pwd)"
REPO_ROOT="$(cd -- "${BASH_SOURCE[0]%/*}/.." && pwd)"
SCRIPT="${QUAKEWINDOWS_TEST_SCRIPT:-$REPO_ROOT/contents/code/main.js}"

# ---------------------------------------------------------------- dependencies
missing=()

compiler=""
for candidate in g++ c++ clang++; do
    if command -v "$candidate" >/dev/null 2>&1; then
        compiler="$(command -v "$candidate")"
        break
    fi
done
if [ -z "$compiler" ]; then
    missing+=("a C++20 compiler (g++ or clang++)")
fi

if ! command -v pkg-config >/dev/null 2>&1; then
    missing+=("pkg-config (to find the Qt6 flags)")
elif ! pkg-config --exists Qt6Core Qt6Qml 2>/dev/null; then
    missing+=("the Qt6 Core/Qml development files (pkg-config Qt6Core Qt6Qml)")
fi

moc=""
if ! command -v qmake6 >/dev/null 2>&1; then
    missing+=("qmake6 (to locate moc)")
else
    for candidate in \
        "$(qmake6 -query QT_HOST_LIBEXECS 2>/dev/null)/moc" \
        /usr/lib/qt6/libexec/moc \
        /usr/lib/qt6/moc \
        /usr/lib64/qt6/moc \
        /usr/lib/x86_64-linux-gnu/qt6/libexec/moc; do
        if [ -x "$candidate" ]; then
            moc="$candidate"
            break
        fi
    done
    if [ -z "$moc" ]; then
        missing+=("moc (the Qt meta-object compiler)")
    fi
fi

if [ ${#missing[@]} -gt 0 ]; then
    echo "SKIP: the optional script engine check cannot run here, the following is missing:"
    for item in "${missing[@]}"; do
        echo "      - $item"
    done
    echo "      On Arch/Plasma install: base-devel qt6-base qt6-declarative."
    echo "      The JavaScript, UI and locale suites do not need any of this."
    echo "      Nothing was built or run."
    exit 0
fi

if [ ! -f "$SCRIPT" ]; then
    echo "FAIL: the script under test does not exist: $SCRIPT" >&2
    exit 1
fi

# ------------------------------------------------------------------ temp sandbox
work="$(mktemp -d "${TMPDIR:-/tmp}/quakewindows-script-engine.XXXXXX")"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/build"

# --------------------------------------------------------- meta-object code
#
# The Q_OBJECT classes live in the .cpp next to main(), so moc writes to the build
# directory and the compiler finds it through -I.
echo "==> generating the meta-object code with $moc"
if ! "$moc" "$TESTS_DIR/script-engine-test.cpp" -o "$work/build/script-engine-test.moc"; then
    echo "FAIL: moc did not generate the meta-object code" >&2
    exit 1
fi

read -r -a qt_cflags <<<"$(pkg-config --cflags Qt6Core Qt6Qml)"
read -r -a qt_libs <<<"$(pkg-config --libs Qt6Core Qt6Qml)"

# ---------------------------------------------------------------- build the test
echo "==> building tests/script-engine-test.cpp"
if ! "$compiler" -std=c++20 -fPIC -O0 -o "$work/build/script-engine-test" \
        "$TESTS_DIR/script-engine-test.cpp" -I"$work/build" \
        "${qt_cflags[@]}" "${qt_libs[@]}"; then
    echo "FAIL: the script engine test did not compile" >&2
    exit 1
fi

# ------------------------------------------------------------------ run the test
echo "==> running the script engine test against $SCRIPT"
if ! "$work/build/script-engine-test" "$SCRIPT"; then
    echo "FAIL: the script engine test reported failures" >&2
    exit 1
fi

echo
echo "The script engine checks passed; nothing outside $work was written to."