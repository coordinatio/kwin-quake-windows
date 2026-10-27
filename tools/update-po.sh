#!/bin/bash
#
# Regenerates po/quakewindows.pot from contents/ui/config.ui.
#
# Afterwards update the translations and rebuild the compiled catalogs:
#
#   msgmerge --update po/ru.po po/quakewindows.pot
#   tools/build-locale.sh
#
# Notes on the message format:
#
# KWin loads contents/ui/config.ui with QUiLoader and routes the translatable
# strings through KLocalizedTranslator (ki18n). For a string without a
# disambiguation comment that class looks it up with ki18nd(), i.e. with a plain
# gettext lookup in the "quakewindows" domain that ignores the Qt context.
# Therefore this catalog must not use msgctxt - lconvert writes one
# ("KWin::QuakeWindowsConfigForm|"), so it is dropped below. The stripping is
# safe only while no string carries a disambiguation comment: lconvert packs the
# Qt context and that comment into the same msgctxt, so stripping it would leave
# two entries with one msgid and silently corrupt the lookup. The script
# therefore fails on such a collision instead of writing a broken template.
#
# The header must also survive "msgfmt --check", which warns about a missing
# PO-Revision-Date, about the gettext placeholder "YEAR-MO-DA HO:MI+ZONE" and
# about a missing or empty Language. The template therefore carries the date of
# its last regeneration (bump it when the form changes) and "Language: en", the
# language of the msgids. KWin's gettext lookup ignores both fields.
#
# SPDX-License-Identifier: GPL-3.0-or-later

set -euo pipefail

readonly DOMAIN="quakewindows"

cd "$(dirname "$0")/.."

for tool in lupdate lconvert python3; do
    if ! command -v "$tool" >/dev/null 2>&1; then
        echo "$tool is required." >&2
        exit 1
    fi
done

tmp_dir="$(mktemp -d)"
tmp_ts="$tmp_dir/${DOMAIN}.ts"
tmp_po="$tmp_dir/${DOMAIN}.po"
trap 'rm -rf "$tmp_dir"' EXIT

lupdate contents/ui/config.ui -ts "$tmp_ts" -locations none >/dev/null
lconvert -i "$tmp_ts" -o "$tmp_po"

mkdir -p po
python3 - "$tmp_po" "po/${DOMAIN}.pot" <<'PY'
import sys

source, target = sys.argv[1], sys.argv[2]

header = [
    '# Translation template for the Quake Windows settings dialog.',
    '# SPDX-FileCopyrightText: 2023 Ivan Volkov <angrycore@gmail.com>',
    '# SPDX-License-Identifier: GPL-3.0-or-later',
    '#',
    '# Regenerate with tools/update-po.sh after changing contents/ui/config.ui.',
    '#',
    'msgid ""',
    'msgstr ""',
    '"Project-Id-Version: quakewindows\\n"',
    '"Report-Msgid-Bugs-To: angrycore@gmail.com\\n"',
    '"PO-Revision-Date: 2026-10-27 18:31+0300\\n"',
    '"Last-Translator: none\\n"',
    '"Language-Team: none\\n"',
    '"Language: en\\n"',
    '"MIME-Version: 1.0\\n"',
    '"Content-Type: text/plain; charset=UTF-8\\n"',
    '"Content-Transfer-Encoding: 8bit\\n"',
    '',
]

out = []
with open(source, encoding='utf-8') as handle:
    lines = handle.read().splitlines()

index = 0
# Skip the header block written by lconvert.
while index < len(lines) and not lines[index].startswith('msgid ""'):
    index += 1
while index < len(lines) and lines[index].strip() != '':
    index += 1

for line in lines[index:]:
    if line.startswith('msgctxt '):
        continue
    if line.startswith('"X-Qt-Contexts:'):
        continue
    out.append(line)


def collect_msgids(entries):
    """The msgid of every entry, with the continuation lines joined."""
    ids = []
    current = None
    for line in entries:
        if line.startswith('msgid '):
            current = [line[len('msgid '):]]
            ids.append(current)
        elif current is not None and line.startswith('"'):
            current.append(line)
        else:
            current = None
    return [''.join(parts) for parts in ids]


# Guard for the msgctxt stripping above. Only a string with a disambiguation
# comment can lose its msgctxt and end up with the msgid of another entry, and
# one of the two would then be unreachable through the context-free ki18nd()
# lookup. No such string exists today, so this never fires for the current
# form; it stops a future one from silently corrupting the catalog.
msgids = collect_msgids(out)
duplicates = sorted({msgid for msgid in msgids if msgids.count(msgid) > 1})
if duplicates:
    sys.stderr.write(
        'error: stripping msgctxt would give two entries the same msgid: '
        + ', '.join(duplicates) + '\n'
        '       contents/ui/config.ui holds a <string comment="...">. lconvert\n'
        '       packs the Qt context and that comment into msgctxt, and ki18n\n'
        '       looks such a string up with ki18ndc(), so this catalog has to\n'
        '       keep the context for it instead of dropping every msgctxt.\n'
    )
    sys.exit(1)

text = '\n'.join(header + out).rstrip('\n') + '\n'
text = text.replace('\n\n\n', '\n\n')
with open(target, 'w', encoding='utf-8') as handle:
    handle.write(text)
PY

msgfmt --check -o /dev/null "po/${DOMAIN}.pot"

echo "Wrote po/${DOMAIN}.pot"
echo "Next: msgmerge --update po/<lang>.po po/${DOMAIN}.pot && tools/build-locale.sh"
