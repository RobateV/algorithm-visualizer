"""Generate a disposable, original two-page scan fixture; never opens a textbook."""
from pathlib import Path
import hashlib
import io
import json
import sys
from PIL import Image, ImageDraw
from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader

root = Path(sys.argv[1])
root.mkdir(parents=True, exist_ok=True)
(root / 'ocr').mkdir(exist_ok=True)
(root / 'cache').mkdir(exist_ok=True)
pdf = root / 'synthetic.pdf'
c = canvas.Canvas(str(pdf), pagesize=(300, 200))
for number in (1, 2):
    text = f'Synthetic page {number}. This is an original automation fixture, not textbook content. '
    image = Image.new('RGB', (300, 200), 'white')
    ImageDraw.Draw(image).text((10, 40), f'SYNTHETIC PAGE {number}', fill='black')
    png = io.BytesIO()
    image.save(png, format='PNG')
    c.drawImage(ImageReader(png), 0, 0, width=300, height=200)
    c.showPage()
    (root / 'ocr' / f'p{number:03d}.txt').write_text(text + '中文编码测试。', encoding='utf-8')
c.save()
print(json.dumps({'pdfSha256': hashlib.sha256(pdf.read_bytes()).hexdigest()}))
