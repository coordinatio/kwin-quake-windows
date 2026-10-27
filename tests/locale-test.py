#!/usr/bin/env python3
"""Catalog checks for the Quake Windows translations.

Verifies that the committed compiled catalog really ships the Russian text
instead of silently falling back to the English msgids, that it carries exactly
the msgstr text of po/ru.po (so a catalog built from an older po/ru.po fails),
and that the catalog, the template and metadata.json agree on the version and on
the translation domain:

    python3 tests/locale-test.py

Only the Python standard library is used (gettext for the compiled catalog, a
small PO reader for the sources), so the script runs everywhere python3 does.
"""

import gettext
import json
import os
import re
import struct
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOCALEDIR = os.path.join(REPO_ROOT, "contents", "locale")
DOMAIN = "quakewindows"
METADATA_PATH = os.path.join(REPO_ROOT, "metadata.json")
POT_PATH = os.path.join(REPO_ROOT, "po", DOMAIN + ".pot")
PO_PATH = os.path.join(REPO_ROOT, "po", "ru.po")
MO_PATH = os.path.join(LOCALEDIR, "ru", "LC_MESSAGES", DOMAIN + ".mo")

failures = []


def check(condition, message):
    if not condition:
        failures.append(message)
        print("FAIL:", message)
    else:
        print("ok:  ", message)


def fail(message):
    failures.append(message)
    print("FAIL:", message)


# ------------------------------------------------------------------ PO reader
FIELD_RE = re.compile(r'^(msgctxt|msgid_plural|msgid|msgstr(?:\[\d+\])?)\s+(".*")$')

# The PO escapes that gettext defines for string content.
UNESCAPE = {
    "n": "\n",
    "t": "\t",
    "r": "\r",
    "\\": "\\",
    '"': '"',
    "a": "\a",
    "b": "\b",
    "f": "\f",
    "v": "\v",
}


def unquote(literal):
    """Decodes the content of one PO string literal (with surrounding quotes)."""
    body = literal[1:-1]
    out = []
    index = 0
    while index < len(body):
        char = body[index]
        if char != "\\":
            out.append(char)
            index += 1
            continue
        index += 1
        if index >= len(body):
            raise ValueError("trailing backslash in %r" % literal)
        escape = body[index]
        if escape in UNESCAPE:
            out.append(UNESCAPE[escape])
            index += 1
        elif escape in "01234567":
            digits = ""
            while index < len(body) and len(digits) < 3 and body[index] in "01234567":
                digits += body[index]
                index += 1
            out.append(chr(int(digits, 8)))
        elif escape == "x":
            digits = ""
            index += 1
            while index < len(body) and body[index] in "0123456789abcdefABCDEF":
                digits += body[index]
                index += 1
            out.append(chr(int(digits, 16)))
        else:
            out.append(escape)
            index += 1
    return "".join(out)


def parse_po(path):
    """Returns the entries of a PO/POT file as a list of dicts.

    Multi-line entries are concatenated the way gettext does it: the first
    literal starts the value, every following one is appended.
    """
    entries = []
    current = None
    field = None

    with open(path, encoding="utf-8") as handle:
        for number, raw in enumerate(handle, 1):
            line = raw.rstrip("\n")
            stripped = line.strip()
            if not stripped or stripped.startswith("#"):
                continue
            if stripped.startswith('"'):
                if field is None:
                    raise ValueError("%s:%d: string without a keyword" % (path, number))
                current[field] += unquote(stripped)
                continue
            match = FIELD_RE.match(stripped)
            if not match:
                raise ValueError("%s:%d: cannot parse %r" % (path, number, stripped))
            keyword, literal = match.groups()
            if keyword == "msgid":
                if current is not None:
                    entries.append(current)
                current = {"msgctxt": None, "msgid": "", "msgstr": ""}
            elif current is None:
                raise ValueError("%s:%d: %s before the first msgid" % (path, number, keyword))
            if keyword.startswith("msgstr["):
                # No plural forms are used by this catalog; the first form is kept.
                keyword = "msgstr"
            if keyword in ("msgctxt", "msgid", "msgstr"):
                current[keyword] = unquote(literal)
            field = keyword

    if current is not None:
        entries.append(current)
    return entries


def header_entry(entries):
    for entry in entries:
        if entry["msgid"] == "" and entry["msgctxt"] is None:
            return entry
    return None


def header_field(entry, name):
    """Extracts one header field out of the msgstr of the header entry."""
    for line in entry["msgstr"].split("\n"):
        if line.lower().startswith(name.lower() + ":"):
            return line.split(":", 1)[1].strip()
    return None


# ------------------------------------------------------------------ MO reader
def parse_mo(path):
    """Returns the msgids of a compiled GNU MO catalog.

    The catalog is read directly instead of through GNUTranslations._catalog so
    the check sees exactly what KWin's gettext lookup sees, metadata included.
    """
    with open(path, "rb") as handle:
        data = handle.read()
    magic = struct.unpack_from("<I", data, 0)[0]
    if magic == 0x950412DE:
        endian = "<"
    elif magic == 0xDE120495:
        endian = ">"
    else:
        raise ValueError("%s is not a GNU MO file (magic %#x)" % (path, magic))
    count, table_offset = struct.unpack_from(endian + "II", data, 8)
    msgids = []
    for index in range(count):
        length, offset = struct.unpack_from(
            endian + "II", data, table_offset + index * 8)
        msgids.append(data[offset:offset + length].decode("utf-8"))
    return msgids


# ---------------------------------------------------------------------- checks
def main():
    for path in (METADATA_PATH, POT_PATH, PO_PATH, MO_PATH):
        if not os.path.isfile(path):
            fail("%s is missing" % os.path.relpath(path, REPO_ROOT))
    if failures:
        return report()

    # ------------------------------------------------ compiled Russian catalog
    try:
        translation = gettext.translation(DOMAIN, localedir=LOCALEDIR, languages=["ru"])
    except OSError as error:
        fail("cannot load %s: %s" % (os.path.relpath(MO_PATH, REPO_ROOT), error))
        return report()

    try:
        mo_msgids = parse_mo(MO_PATH)
    except (ValueError, struct.error) as error:
        fail("cannot read %s: %s" % (os.path.relpath(MO_PATH, REPO_ROOT), error))
        return report()
    check(True, "%s parses and holds %d msgids"
          % (os.path.relpath(MO_PATH, REPO_ROOT), len(mo_msgids)))
    check("" in mo_msgids, "the catalog carries a header entry")

    # ------------------------------------------------------------ the template
    try:
        pot_entries = parse_po(POT_PATH)
    except ValueError as error:
        fail("cannot read %s: %s" % (os.path.relpath(POT_PATH, REPO_ROOT), error))
        return report()
    pot_header = header_entry(pot_entries)
    if pot_header is None:
        fail("po/%s.pot has no valid header entry" % DOMAIN)
        return report()
    pot_msgids = [entry["msgid"] for entry in pot_entries
                  if entry["msgid"] != "" or entry["msgctxt"] is not None]
    check(len(pot_msgids) > 0, "po/%s.pot holds %d translatable msgids"
          % (DOMAIN, len(pot_msgids)))
    check(len(set(pot_msgids)) == len(pot_msgids),
          "po/%s.pot has no duplicate msgid" % DOMAIN)

    # Every template string must come back translated, not as the English fallback.
    untranslated = []
    for msgid in pot_msgids:
        text = translation.gettext(msgid)
        if not text.strip() or text == msgid:
            untranslated.append(msgid)
    check(not untranslated,
          "every msgid of the template has Russian text in the catalog"
          + ("" if not untranslated else " (missing or English: %s)" % untranslated))

    # ... and the catalog must not carry msgids the template dropped, which would
    # mean the .mo is stale after a form change.
    stale = sorted(set(mo_msgids) - set(pot_msgids) - {""})
    check(not stale,
          "the catalog holds no msgid that is missing from the template"
          + ("" if not stale else " (stale: %s)" % stale))

    # The project id must at least name our domain; ru.po has to stay gettext-valid.
    pot_project = header_field(pot_header, "Project-Id-Version") or ""
    check(pot_project.split()[:1] == [DOMAIN],
          "po/%s.pot names the domain %r in Project-Id-Version (got %r)"
          % (DOMAIN, DOMAIN, pot_project))

    try:
        ru_entries = parse_po(PO_PATH)
    except ValueError as error:
        fail("cannot read %s: %s" % (os.path.relpath(PO_PATH, REPO_ROOT), error))
        return report()
    ru_header = header_entry(ru_entries)
    if ru_header is None:
        fail("po/ru.po has no valid header entry")
        return report()

    # The compiled catalog must carry the text of po/ru.po verbatim. Without this
    # check a .mo that was not rebuilt after a ru.po edit still passes: the stale
    # string is a translation too, it just is not the committed one.
    ru_msgstr = {entry["msgid"]: entry["msgstr"] for entry in ru_entries
                 if entry["msgctxt"] is None and entry["msgid"] != ""}
    mismatched = []
    for msgid in pot_msgids:
        expected = ru_msgstr.get(msgid)
        if expected is None:
            mismatched.append((msgid, "missing from po/ru.po"))
        elif translation.gettext(msgid) != expected:
            mismatched.append((msgid, "the catalog holds %r" % translation.gettext(msgid)))
    check(not mismatched,
          "the compiled catalog carries the msgstr text of po/ru.po"
          + ("" if not mismatched else " (mismatched: %s)" % mismatched))

    # ----------------------------------------------------------------- versions
    try:
        with open(METADATA_PATH, encoding="utf-8") as handle:
            metadata = json.load(handle)
        metadata_version = metadata["KPlugin"]["Version"]
        translation_domain = metadata.get("X-KWin-Config-TranslationDomain")
    except (OSError, ValueError, KeyError, TypeError) as error:
        fail("cannot read metadata.json: %s" % error)
        return report()
    check(bool(metadata_version) and isinstance(metadata_version, str),
          "metadata.json KPlugin.Version is a non-empty string (%r)" % metadata_version)

    # KWin's generic scripted configuration module looks the UI strings up in the
    # domain named by X-KWin-Config-TranslationDomain. A drift between that field
    # and the catalog this test loads would leave every widget in English while
    # every other check here still passes, so the three have to agree.
    mo_stem = os.path.splitext(os.path.basename(MO_PATH))[0]
    check(translation_domain == DOMAIN,
          "metadata.json X-KWin-Config-TranslationDomain is %r (got %r)"
          % (DOMAIN, translation_domain))
    check(mo_stem == DOMAIN,
          "the catalog file name spells the domain %r (got %r)" % (DOMAIN, mo_stem))

    ru_project = (header_field(ru_header, "Project-Id-Version") or "").split()
    check(ru_project[:1] == [DOMAIN],
          "po/ru.po names the domain %r in Project-Id-Version (got %r)"
          % (DOMAIN, " ".join(ru_project)))
    check(len(ru_project) == 2 and ru_project[1] == metadata_version,
          "po/ru.po Project-Id-Version carries the metadata.json version %r (got %r)"
          % (metadata_version, " ".join(ru_project)))

    pot_version = pot_project.split()[1:]
    check(not pot_version or pot_version == [metadata_version],
          "po/%s.pot version, when present, equals metadata.json %r (got %r)"
          % (DOMAIN, metadata_version, " ".join(pot_version)))

    return report()


def report():
    if failures:
        print("\n%d check(s) failed" % len(failures))
        return 1
    print("\nAll locale checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
