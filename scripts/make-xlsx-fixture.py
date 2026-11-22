#!/usr/bin/env python3
"""Writes fixtures/xlsx/edge-cases.en.xlsx (planning/v1-spec.md §3.10, issue #169).

A workbook built by hand for the constructs a producer rarely emits together
and the filter must still read: sheets whose files are not in tab order, a
shared string used on two sheets, a string no cell uses, an empty string, rich
text (a run with no properties, a bold run, a run that only sets the font,
italic, superscript, a property switched off), a line break inside a cell, a
phonetic guide, edge whitespace, entities, a text cell that is only digits, a
raw `_x000D_` escape, inline strings (plain and rich), a formula with a cached
text, a self-closed string cell, and a table with a header row and a totals
row. Every sentence is written for this repository. Standard library only; run
from the repository root:

    python3 scripts/make-xlsx-fixture.py
"""
import zipfile

MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships"
CT = "application/vnd.openxmlformats-officedocument.spreadsheetml"
HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'

# What Excel writes on every run of a rich string: size, colour and font only.
FONT = '<sz val="11"/><color theme="1"/><rFont val="Calibri"/><family val="2"/><scheme val="minor"/>'


def plain(text, preserve=False):
    space = ' xml:space="preserve"' if preserve else ""
    return f"<si><t{space}>{text}</t></si>"


def run(text, props=None, preserve=False):
    space = ' xml:space="preserve"' if preserve else ""
    rpr = "" if props is None else f"<rPr>{props}</rPr>"
    return f"<r>{rpr}<t{space}>{text}</t></r>"


# Index: what it is for. The comments name the cell that shows it.
STRINGS = [
    plain("Dish"),  # 0  Menu!A1, a table's header
    plain("Price"),  # 1  Menu!B1, a table's header; also Orders!B2
    plain("Soup of the day"),  # 2  Menu!A2 and Orders!B1: one string, two sheets
    plain("Bread &amp; butter &lt;fresh&gt;"),  # 3  Menu!A3, entities
    plain("Total"),  # 4  Menu!A4, the table's totals row
    # 5  Orders!A1: a run with no properties, a bold run, a run that only sets the font;
    #    two sentences.
    "<si>"
    + run("Served ", preserve=True)
    + run("hot", "<b/>" + FONT)
    + run(" or cold. Ask the kitchen.", FONT, preserve=True)
    + "</si>",
    plain("First line\nSecond line", preserve=True),  # 6  Orders!A2, a line break in a cell
    plain("2026"),  # 7  Orders!A3, text with no letter
    plain("Unused text nobody sees."),  # 8  no cell uses it
    "<si><t/></si>",  # 9  Orders!A4, empty
    # 10 Notes!A1: a phonetic guide after the text.
    '<si><t>Tokyo office</t><rPh sb="0" eb="5"><t>toukyou</t></rPh><phoneticPr fontId="1"/></si>',
    # 11 Notes!A2: italic, superscript, then a run with no properties.
    "<si>"
    + run("Note", "<i/>" + FONT)
    + run("1", '<vertAlign val="superscript"/>' + FONT)
    + run(" applies.", preserve=True)
    + "</si>",
    plain("  Padded  ", preserve=True),  # 12 Notes!A3, edge whitespace
    "<si>" + run("Not bold at all.", '<b val="0"/>' + FONT) + "</si>",  # 13 Notes!A4
    plain("Kept_x000D_\nraw.", preserve=True),  # 14 Notes!A5, an escape left as it is
]

SHARED = (
    HEAD
    + f'<sst xmlns="{MAIN}" count="16" uniqueCount="{len(STRINGS)}">'
    + "".join(STRINGS)
    + "</sst>"
)


def sheet(rows, extra=""):
    body = "".join(f'<row r="{n}">{cells}</row>' for n, cells in rows)
    return (
        HEAD
        + f'<worksheet xmlns="{MAIN}" xmlns:r="{REL}">'
        '<sheetViews><sheetView workbookViewId="0"/></sheetViews>'
        '<sheetFormatPr defaultRowHeight="15"/>'
        f"<sheetData>{body}</sheetData>{extra}</worksheet>"
    )


def shared(ref, index, style=None):
    s = "" if style is None else f' s="{style}"'
    return f'<c r="{ref}"{s} t="s"><v>{index}</v></c>'


def number(ref, value):
    return f'<c r="{ref}"><v>{value}</v></c>'


# sheet1.xml is the SECOND tab ("Orders").
ORDERS = sheet(
    [
        (
            1,
            shared("A1", 5)
            + shared("B1", 2)
            # A formula's cached text is not a string to translate.
            + '<c r="C1" t="str"><f>A1&amp;"!"</f><v>Served hot or cold. Ask the kitchen.!</v></c>'
            # A self-closed string cell, then a number: 7 is not a string index.
            + '<c r="D1" t="s"/>'
            + number("E1", 7),
        ),
        (2, shared("A2", 6, style=1) + shared("B2", 1) + '<c r="C2" s="0"/>'),
        (3, shared("A3", 7)),
        (4, shared("A4", 9)),
    ]
)

# sheet2.xml is the FIRST tab ("Menu"), and holds the table.
MENU = sheet(
    [
        (1, shared("A1", 0) + shared("B1", 1)),
        (2, shared("A2", 2) + number("B2", "4.5")),
        (3, shared("A3", 3) + number("B3", 2)),
        (4, shared("A4", 4) + '<c r="B4"><f>SUBTOTAL(109,Table1[Price])</f><v>6.5</v></c>'),
    ],
    extra='<tableParts count="1"><tablePart r:id="rId1"/></tableParts>',
)

# sheet3.xml is the THIRD tab ("Notes"), and holds the inline strings.
NOTES = sheet(
    [
        (1, shared("A1", 10) + '<c r="B1" t="inlineStr"><is><t>Inline note.</t></is></c>'),
        (
            2,
            shared("A2", 11)
            + '<c r="B2" t="inlineStr"><is>'
            + run("Bold inline", "<b/>")
            + run(" and plain.", preserve=True)
            + "</is></c>",
        ),
        (3, shared("A3", 12)),
        (4, shared("A4", 13)),
        (5, shared("A5", 14, style=1)),
    ]
)

TABLE = (
    HEAD
    + f'<table xmlns="{MAIN}" id="1" name="Table1" displayName="Table1" ref="A1:B4" totalsRowCount="1">'
    '<autoFilter ref="A1:B3"/>'
    '<tableColumns count="2">'
    '<tableColumn id="1" name="Dish" totalsRowLabel="Total"/>'
    '<tableColumn id="2" name="Price" totalsRowFunction="sum"/>'
    "</tableColumns>"
    '<tableStyleInfo name="TableStyleMedium2" showFirstColumn="0" showLastColumn="0" '
    'showRowStripes="1" showColumnStripes="0"/>'
    "</table>"
)

WORKBOOK = (
    HEAD
    + f'<workbook xmlns="{MAIN}" xmlns:r="{REL}"><sheets>'
    '<sheet name="Menu" sheetId="1" r:id="rId2"/>'
    '<sheet name="Orders" sheetId="2" r:id="rId1"/>'
    '<sheet name="Notes" sheetId="3" r:id="rId3"/>'
    "</sheets></workbook>"
)

STYLES = (
    HEAD
    + f'<styleSheet xmlns="{MAIN}">'
    '<fonts count="2">'
    '<font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font>'
    '<font><sz val="6"/><name val="Calibri"/><family val="2"/></font>'
    "</fonts>"
    '<fills count="2"><fill><patternFill patternType="none"/></fill>'
    '<fill><patternFill patternType="gray125"/></fill></fills>'
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
    '<cellXfs count="2">'
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1">'
    '<alignment wrapText="1"/></xf>'
    "</cellXfs>"
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
    "</styleSheet>"
)


def rels(*items):
    body = "".join(f'<Relationship Id="{i}" Type="{t}" Target="{target}"/>' for i, t, target in items)
    return HEAD + f'<Relationships xmlns="{PKG_REL}">{body}</Relationships>'


parts = [
    ("[Content_Types].xml", HEAD
     + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
     '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
     '<Default Extension="xml" ContentType="application/xml"/>'
     f'<Override PartName="/xl/workbook.xml" ContentType="{CT}.sheet.main+xml"/>'
     + "".join(f'<Override PartName="/xl/worksheets/sheet{n}.xml" ContentType="{CT}.worksheet+xml"/>' for n in (1, 2, 3))
     + f'<Override PartName="/xl/styles.xml" ContentType="{CT}.styles+xml"/>'
     f'<Override PartName="/xl/sharedStrings.xml" ContentType="{CT}.sharedStrings+xml"/>'
     f'<Override PartName="/xl/tables/table1.xml" ContentType="{CT}.table+xml"/></Types>'),
    ("_rels/.rels", rels(("rId1", f"{REL}/officeDocument", "xl/workbook.xml"))),
    ("xl/workbook.xml", WORKBOOK),
    ("xl/_rels/workbook.xml.rels", rels(
        ("rId1", f"{REL}/worksheet", "worksheets/sheet1.xml"),
        ("rId2", f"{REL}/worksheet", "worksheets/sheet2.xml"),
        ("rId3", f"{REL}/worksheet", "worksheets/sheet3.xml"),
        ("rId4", f"{REL}/styles", "styles.xml"),
        ("rId5", f"{REL}/sharedStrings", "sharedStrings.xml"))),
    ("xl/styles.xml", STYLES),
    ("xl/sharedStrings.xml", SHARED),
    ("xl/worksheets/sheet1.xml", ORDERS),
    ("xl/worksheets/sheet2.xml", MENU),
    ("xl/worksheets/_rels/sheet2.xml.rels", rels(("rId1", f"{REL}/table", "../tables/table1.xml"))),
    ("xl/worksheets/sheet3.xml", NOTES),
    ("xl/tables/table1.xml", TABLE),
]

# Fixed timestamps so the file is the same bytes on every run.
with zipfile.ZipFile("fixtures/xlsx/edge-cases.en.xlsx", "w", zipfile.ZIP_DEFLATED) as z:
    for name, data in parts:
        info = zipfile.ZipInfo(name, date_time=(2026, 11, 22, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        z.writestr(info, data.encode("utf-8"))
print("wrote fixtures/xlsx/edge-cases.en.xlsx")
