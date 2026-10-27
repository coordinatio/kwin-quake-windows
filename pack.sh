#!/bin/bash
#
# Builds quakewindows.kwinscript from the package contents.
#
# SPDX-License-Identifier: GPL-3.0-or-later

set -euo pipefail

cd "$(dirname "$0")"

package="quakewindows.kwinscript"

rm -f "$package"
zip -r "$package" contents/ LICENSE metadata.json

echo "Built $package"
