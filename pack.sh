#!/bin/bash
#
# Builds quakewindows.kwinscript from the package contents.
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

# md5sum of the compiled catalogs, independent of git, so the build can tell
# whether tools/build-locale.sh changed a tracked file.
catalog_checksum() {
    if [ -d contents/locale ]; then
        find contents/locale -type f -name '*.mo' | LC_ALL=C sort | xargs -r md5sum
    fi
}

locale_before=$(catalog_checksum)

# Recompile the catalogs so the package cannot ship translations that drifted
# away from po/*.po. Without msgfmt the committed .mo files are packaged as they
# are, which is fine as long as po/ was not touched.
if command -v msgfmt >/dev/null 2>&1; then
    tools/build-locale.sh
else
    echo "WARNING: msgfmt is not installed, packaging the committed contents/locale" >&2
    echo "         files unchanged. Install gettext and rebuild to update them." >&2
fi

if [ "$locale_before" != "$(catalog_checksum)" ]; then
    echo "WARNING: tools/build-locale.sh changed contents/locale." >&2
    echo "         Commit contents/locale together with po/ before releasing." >&2
fi

rm -f "$package"
zip -r "$package" contents/ LICENSE metadata.json

echo "Built $package"
