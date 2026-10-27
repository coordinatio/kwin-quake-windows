#!/bin/bash
#
# Builds quakewindows.kwinscript from the package contents.
#
# The archive is assembled in a temporary staging directory that is removed on
# exit: building never modifies the working tree, and catalogs of languages that
# were removed from po/ cannot survive in the package.
#
# SPDX-License-Identifier: GPL-3.0-or-later

set -euo pipefail

cd "$(dirname "$0")"

package="quakewindows.kwinscript"

# Files the package cannot work without. Checking them up front turns a broken
# tree into a clear error instead of a silently incomplete archive.
for required in contents/config/main.xml contents/ui/config.ui contents/code/main.js; do
    if [ ! -f "$required" ]; then
        echo "ERROR: $required is missing, refusing to build $package" >&2
        exit 1
    fi
done

staging="$(mktemp -d)"
trap 'rm -rf "$staging"' EXIT

cp -a contents/ LICENSE metadata.json "$staging"/

# md5sum of the compiled catalogs under a package root. The paths are relative to
# that root, so the staged catalogs can be compared with the committed ones.
catalog_checksum() {
    local root="$1"
    if [ -d "$root/locale" ]; then
        ( cd "$root" && find locale -type f -name '*.mo' | LC_ALL=C sort | xargs -r md5sum )
    fi
}

if command -v msgfmt >/dev/null 2>&1; then
    # Rebuild the catalogs from po/*.po inside the staging tree only, so the
    # package cannot ship translations that drifted away from po/. Committed
    # files are never touched; a preview of the drift is reported below.
    rm -rf "$staging/contents/locale"
    shopt -s nullglob
    po_files=(po/*.po)
    shopt -u nullglob
    if [ ${#po_files[@]} -eq 0 ]; then
        echo "ERROR: no po/*.po files found, refusing to build $package" >&2
        exit 1
    fi
    for po_file in "${po_files[@]}"; do
        lang="$(basename "$po_file" .po)"
        target_dir="$staging/contents/locale/${lang}/LC_MESSAGES"
        mkdir -p "$target_dir"
        msgfmt --check -o "${target_dir}/quakewindows.mo" "$po_file"
    done
else
    echo "WARNING: msgfmt is not installed, packaging the committed contents/locale" >&2
    echo "         files unchanged. Install gettext and rebuild to update them." >&2
fi

if [ "$(catalog_checksum contents)" != "$(catalog_checksum "$staging/contents")" ]; then
    echo "WARNING: contents/locale does not match the catalogs built from po/." >&2
    echo "         Commit contents/locale together with po/ before releasing." >&2
fi

rm -f "$package"
( cd "$staging" && zip -qr "$package" contents/ LICENSE metadata.json )
mv -f "$staging/$package" "$package"

echo "Built $package"
