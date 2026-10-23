#!/usr/bin/env python3
"""Writes fixtures/pptx/edge-cases.en.pptx (planning/v1-spec.md §3.9, issue #169).

A deck built by hand for the constructs a producer rarely emits and the filter
must still keep: slides whose files are not in the order they play, a
hyperlink, a line break, an empty run, edge whitespace, entities, a paragraph
that is only a field, one that is only digits, a text box stored twice
(mc:AlternateContent), and a notes page. Every sentence is written for this
repository. Standard library only; run from the repository root:

    python3 scripts/make-pptx-fixture.py
"""
import zipfile

NS = (
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
    'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
)
HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
CT = "application/vnd.openxmlformats-officedocument.presentationml"


def run(text, props='lang="en-US" dirty="0"', inner=""):
    return f'<a:r><a:rPr {props}>{inner}</a:rPr><a:t>{text}</a:t></a:r>'


def para(content, ppr=""):
    return f'<a:p>{ppr}{content}<a:endParaRPr lang="en-US" dirty="0"/></a:p>'


def shape(sid, name, paragraphs, y=0):
    return (
        f'<p:sp><p:nvSpPr><p:cNvPr id="{sid}" name="{name}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>'
        f'<p:spPr><a:xfrm><a:off x="457200" y="{y}"/><a:ext cx="8229600" cy="914400"/></a:xfrm>'
        f'<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>'
        f'<p:txBody><a:bodyPr/><a:lstStyle/>{"".join(paragraphs)}</p:txBody></p:sp>'
    )


def slide(shapes):
    return (
        HEAD
        + f'<p:sld {NS} xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">'
        '<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>'
        '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'
        + "".join(shapes)
        + '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>'
    )


# slide1.xml plays SECOND.
edge = shape(
    2,
    "Edge cases",
    [
        para(run("Fish &amp; chips &lt;daily&gt; at Café Résumé.")),
        para(
            run("First line")
            + '<a:br><a:rPr lang="en-US" dirty="0"/></a:br>'
            + run("second line.")
        ),
        para(
            run("Hello, ")
            + run("world", 'lang="en-US" b="1" i="1" u="sng" dirty="0"')
            + run("! Then ")
            + run("water", 'lang="en-US" baseline="-25000" dirty="0"')
            + run(" and ")
            + run("mc", 'lang="en-US" baseline="30000" dirty="0"')
            + run(".")
        ),
        para(
            run("See the ")
            + run("workshop page", 'lang="en-US" dirty="0"', '<a:hlinkClick r:id="rId2"/>')
            + run(" before class.")
        ),
        para(run("Before.") + '<a:r><a:rPr lang="en-US" dirty="0"/><a:t></a:t></a:r>' + run(" After.")),
        para(run("2026")),
        para(
            '<a:fld id="{B1E2C3D4-0000-4000-8000-000000000001}" type="slidenum">'
            '<a:rPr lang="en-US" dirty="0"/><a:t>‹#›</a:t></a:fld>'
        ),
        para(
            run("Slide ")
            + '<a:fld id="{B1E2C3D4-0000-4000-8000-000000000002}" type="slidenum">'
            '<a:rPr lang="en-US" dirty="0"/><a:t>‹#›</a:t></a:fld>'
            + run(" of the deck.")
        ),
    ],
)
fallback_copy = (
    '<mc:AlternateContent><mc:Choice Requires="a14">'
    + shape(3, "Box", [para(run("Stored twice, counted once."))], 1500000)
    + "</mc:Choice><mc:Fallback>"
    + shape(3, "Box", [para(run("Stored twice, counted once."))], 1500000)
    + "</mc:Fallback></mc:AlternateContent>"
)
slide1 = slide([edge, fallback_copy])

# slide2.xml plays FIRST.
slide2 = slide(
    [
        shape(2, "Title", [para(run("Opening slide"))]),
        shape(3, "Body", [para(run("It plays before slide one, though its file is numbered two."))], 1500000),
    ]
)
# slide3.xml plays THIRD, with notes.
slide3 = slide([shape(2, "Last", [para(run("Closing slide. Thank you."))])])


def notes(text):
    return (
        HEAD
        + f'<p:notes {NS}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>'
        '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'
        + shape(2, "Notes Placeholder", [para(run(text))])
        + '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>'
    )


def rels(*items):
    body = "".join(
        f'<Relationship Id="{i}" Type="{t}" Target="{g}"' + (' TargetMode="External"' if ext else "") + "/>"
        for (i, t, g, ext) in items
    )
    return HEAD + f'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">{body}</Relationships>'


THEME = (
    HEAD
    + '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Plain"><a:themeElements>'
    '<a:clrScheme name="Plain"><a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>'
    '<a:dk2><a:srgbClr val="1F2937"/></a:dk2><a:lt2><a:srgbClr val="F3F4F6"/></a:lt2>'
    + "".join(f'<a:accent{n}><a:srgbClr val="{c}"/></a:accent{n}>' for n, c in enumerate(["2563EB", "059669", "D97706", "DC2626", "7C3AED", "0891B2"], 1))
    + '<a:hlink><a:srgbClr val="2563EB"/></a:hlink><a:folHlink><a:srgbClr val="7C3AED"/></a:folHlink></a:clrScheme>'
    '<a:fontScheme name="Plain"><a:majorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>'
    '<a:minorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>'
    '<a:fmtScheme name="Plain"><a:fillStyleLst>'
    + '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' * 3
    + '</a:fillStyleLst><a:lnStyleLst>'
    + '<a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>' * 3
    + '</a:lnStyleLst><a:effectStyleLst>'
    + '<a:effectStyle><a:effectLst/></a:effectStyle>' * 3
    + '</a:effectStyleLst><a:bgFillStyleLst>'
    + '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' * 3
    + '</a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>'
)
MASTER = (
    HEAD
    + f'<p:sldMaster {NS}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>'
    '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'
    '</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" '
    'accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>'
    '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>'
)
LAYOUT = (
    HEAD
    + f'<p:sldLayout {NS} type="blank"><p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>'
    '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'
    '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>'
)
PRESENTATION = (
    HEAD
    + f'<p:presentation {NS}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>'
    # The play order: slide2.xml, slide1.xml, slide3.xml.
    '<p:sldIdLst><p:sldId id="256" r:id="rId4"/><p:sldId id="257" r:id="rId3"/><p:sldId id="258" r:id="rId5"/></p:sldIdLst>'
    '<p:sldSz cx="9144000" cy="6858000" type="screen4x3"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>'
)

parts = [
    ("[Content_Types].xml", HEAD + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
     '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
     '<Default Extension="xml" ContentType="application/xml"/>'
     f'<Override PartName="/ppt/presentation.xml" ContentType="{CT}.presentation.main+xml"/>'
     f'<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="{CT}.slideMaster+xml"/>'
     f'<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="{CT}.slideLayout+xml"/>'
     + "".join(f'<Override PartName="/ppt/slides/slide{n}.xml" ContentType="{CT}.slide+xml"/>' for n in (1, 2, 3))
     + "".join(f'<Override PartName="/ppt/notesSlides/notesSlide{n}.xml" ContentType="{CT}.notesSlide+xml"/>' for n in (1, 3))
     + '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/></Types>'),
    ("_rels/.rels", rels(("rId1", f"{REL}/officeDocument", "ppt/presentation.xml", False))),
    ("ppt/presentation.xml", PRESENTATION),
    ("ppt/_rels/presentation.xml.rels", rels(
        ("rId1", f"{REL}/slideMaster", "slideMasters/slideMaster1.xml", False),
        ("rId2", f"{REL}/theme", "theme/theme1.xml", False),
        ("rId3", f"{REL}/slide", "slides/slide1.xml", False),
        ("rId4", f"{REL}/slide", "slides/slide2.xml", False),
        ("rId5", f"{REL}/slide", "slides/slide3.xml", False))),
    ("ppt/theme/theme1.xml", THEME),
    ("ppt/slideMasters/slideMaster1.xml", MASTER),
    ("ppt/slideMasters/_rels/slideMaster1.xml.rels", rels(
        ("rId1", f"{REL}/slideLayout", "../slideLayouts/slideLayout1.xml", False),
        ("rId2", f"{REL}/theme", "../theme/theme1.xml", False))),
    ("ppt/slideLayouts/slideLayout1.xml", LAYOUT),
    ("ppt/slideLayouts/_rels/slideLayout1.xml.rels", rels(("rId1", f"{REL}/slideMaster", "../slideMasters/slideMaster1.xml", False))),
    ("ppt/slides/slide1.xml", slide1),
    ("ppt/slides/_rels/slide1.xml.rels", rels(
        ("rId1", f"{REL}/slideLayout", "../slideLayouts/slideLayout1.xml", False),
        ("rId2", f"{REL}/hyperlink", "https://example.org/workshop", True),
        ("rId3", f"{REL}/notesSlide", "../notesSlides/notesSlide1.xml", False))),
    ("ppt/slides/slide2.xml", slide2),
    ("ppt/slides/_rels/slide2.xml.rels", rels(("rId1", f"{REL}/slideLayout", "../slideLayouts/slideLayout1.xml", False))),
    ("ppt/slides/slide3.xml", slide3),
    ("ppt/slides/_rels/slide3.xml.rels", rels(
        ("rId1", f"{REL}/slideLayout", "../slideLayouts/slideLayout1.xml", False),
        ("rId2", f"{REL}/notesSlide", "../notesSlides/notesSlide3.xml", False))),
    ("ppt/notesSlides/notesSlide1.xml", notes("Mention the edge cases first.")),
    ("ppt/notesSlides/_rels/notesSlide1.xml.rels", rels(("rId1", f"{REL}/slide", "../slides/slide1.xml", False))),
    ("ppt/notesSlides/notesSlide3.xml", notes("Say thank you.")),
    ("ppt/notesSlides/_rels/notesSlide3.xml.rels", rels(("rId1", f"{REL}/slide", "../slides/slide3.xml", False))),
]

# Fixed timestamps so the file is the same bytes on every run.
with zipfile.ZipFile("fixtures/pptx/edge-cases.en.pptx", "w", zipfile.ZIP_DEFLATED) as z:
    for name, data in parts:
        info = zipfile.ZipInfo(name, date_time=(2026, 10, 23, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        z.writestr(info, data.encode("utf-8"))
print("wrote fixtures/pptx/edge-cases.en.pptx")
