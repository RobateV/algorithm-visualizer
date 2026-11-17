"""Only reads the pinned local PDF/OCR; writes selected raster pages to a private cache."""
import hashlib
import json
from pathlib import Path
import sys
from pypdf import PdfReader


def digest(stream):
    stream.seek(0)
    result = hashlib.file_digest(stream, 'sha256').hexdigest()
    stream.seek(0)
    return result


def prepare(request):
    pdf = Path(request['pdfPath']).resolve(strict=True)
    ocr_root = Path(request['ocrDir']).resolve(strict=True)
    target = Path(request['outputDir']).resolve(strict=True)
    expected = request['pdfSha256']
    pages = request['pages']
    if not isinstance(pages, list) or not 1 <= len(pages) <= 10:
        raise ValueError('page limit')
    if pdf.stat().st_size > 256 * 1024 * 1024:
        raise ValueError('PDF size limit')
    output = []
    with pdf.open('rb') as stream:
        if digest(stream) != expected:
            raise ValueError('PDF fingerprint mismatch')
        reader = PdfReader(stream)
        if reader.is_encrypted:
            raise ValueError('encrypted PDF unsupported')
        for item in pages:
            number = item['pdfPage']
            if not isinstance(number, int) or not 1 <= number <= len(reader.pages):
                raise ValueError('PDF page out of range')
            # This source mode only supports scan pages consisting of one raster image.
            page = reader.pages[number - 1]
            images = list(page.images)
            if len(images) != 1 or (page.extract_text() or '').strip():
                raise ValueError('not a single-image scan; local rendering needed')
            image = images[0]
            if len(image.data) > 8 * 1024 * 1024:
                raise ValueError('image size limit')
            suffix = Path(image.name).suffix.lower()
            if suffix not in ('.png', '.jpg', '.jpeg'):
                raise ValueError('unsupported scan format')
            ocr_file = ocr_root / f'p{number:03d}.txt'
            if ocr_file.resolve(strict=True).parent != ocr_root or ocr_file.is_symlink():
                raise ValueError('OCR path escape')
            if ocr_file.stat().st_size > 12 * 1024:
                raise ValueError('OCR page size limit')
            ocr = ocr_file.read_text(encoding='utf-8-sig')
            if not ocr.strip() or '\x00' in ocr:
                raise ValueError('OCR unavailable')
            image_file = target / f'p{number:03d}{suffix}'
            with image_file.open('xb') as destination:
                destination.write(image.data)
            output.append({**item, 'imageFile': image_file.name,
                           'imageSha256': hashlib.sha256(image.data).hexdigest(),
                           'ocrSha256': hashlib.sha256(ocr.encode()).hexdigest(), 'ocr': ocr})
        if digest(stream) != expected:
            raise ValueError('PDF changed while reading')
    return {'pages': output, 'visualVerification': 'not_performed', 'pdfSha256': expected}


if __name__ == '__main__':
    try:
        result = prepare(json.loads(sys.stdin.read(65537)))
        # ASCII transport avoids Windows console/codepage corruption of Chinese OCR.
        print(json.dumps(result, ensure_ascii=True))
    except Exception:
        # Never emit source text, local paths, provider credentials, or raw parser errors.
        print('Local textbook page preparation failed', file=sys.stderr)
        sys.exit(1)
