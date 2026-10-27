#!/bin/bash
#
# Builds quakewindows.kwinscript from the package contents.
#
# SPDX-License-Identifier: GPL-3.0-or-later

set -euo pipefail

cd "$(dirname "$0")"

package="quakewindows.kwinscript"

# Recompile the catalogs so the package cannot ship translations that drifted
# away from po/*.po. Without msgfmt the committed .mo files are packaged as they
# are, which is fine as long as po/ was not touched.
if command -v msgfmt >/dev/null 2>&1; then
    tools/build-locale.sh
else
    echo "WARNING: msgfmt is not installed, packaging the committed contents/locale" >&2
    echo "         files unchanged. Install gettext and rebuild to update them." >&2
fi

rm -f "$package"
zip -r "$package" contents/ LICENSE metadata.json

echo "Built $package"
