#!/bin/bash
#
# Compiles every po/<lang>.po into
# contents/locale/<lang>/LC_MESSAGES/quakewindows.mo
#
# SPDX-License-Identifier: GPL-3.0-or-later

set -euo pipefail

readonly DOMAIN="quakewindows"

cd "$(dirname "$0")/.."

shopt -s nullglob
po_files=(po/*.po)
shopt -u nullglob
if [ ${#po_files[@]} -eq 0 ]; then
    echo "No po/*.po files found." >&2
    exit 1
fi

for po_file in "${po_files[@]}"; do
    lang="$(basename "$po_file" .po)"
    target_dir="contents/locale/${lang}/LC_MESSAGES"
    mkdir -p "$target_dir"
    msgfmt --check -o "${target_dir}/${DOMAIN}.mo" "$po_file"
    echo "Compiled ${po_file} -> ${target_dir}/${DOMAIN}.mo"
done
