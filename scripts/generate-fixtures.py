"""Generate tiny original EPUB fixtures; no third-party book content."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
root = Path(__file__).resolve().parent.parent / 'tests' / 'fixtures'
root.mkdir(exist_ok=True)
for fixed in [False, True]:
    name = 'fixed' if fixed else 'reflow'
    with ZipFile(root / f'{name}.epub', 'w') as archive:
        archive.writestr('mimetype', 'application/epub+zip')
        archive.writestr('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>', compress_type=ZIP_DEFLATED)
        archive.writestr('OEBPS/content.opf', f'''<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id" prefix="rendition: http://www.idpf.org/vocab/rendition/#"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">mangasee-{name}</dc:identifier><dc:title>MangaSee EPUB fixture</dc:title><dc:language>en</dc:language><meta property="dcterms:modified">2026-09-18T00:00:00Z</meta><meta property="rendition:layout">{'pre-paginated' if fixed else 'reflowable'}</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="one" href="one.xhtml" media-type="application/xhtml+xml"/><item id="two" href="two.xhtml" media-type="application/xhtml+xml"/></manifest><spine page-progression-direction="rtl"><itemref idref="one"/><itemref idref="two"/></spine></package>''', compress_type=ZIP_DEFLATED)
        archive.writestr('OEBPS/nav.xhtml', '''<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><ol><li><a href="one.xhtml">The first chapter</a></li><li><a href="two.xhtml">The second chapter</a></li></ol></nav></body></html>''', compress_type=ZIP_DEFLATED)
        for number in ['one','two']:
            archive.writestr(f'OEBPS/{number}.xhtml', f'''<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter {number}</title><meta name="viewport" content="width=800,height=1200"/><style>body{{padding:30px;font-family:serif}}h1{{color:#334e3d}}</style></head><body><h1>Chapter {number}</h1><p>An original story for testing a quiet reading room.</p><p>The mountains were still, and the reader turned another page.</p><img src="https://blocked.example/track.png" alt="Blocked remote image"/><script>parent.postMessage('epub-script-ran','*')</script></body></html>''', compress_type=ZIP_DEFLATED)
