import importlib.util
from pathlib import Path
import shutil
import struct
import sys
import tempfile
import unittest
from unittest.mock import patch
import zlib

MOD = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(MOD))
spec = importlib.util.spec_from_file_location('stage_image', MOD / 'stage-image.py')
image = importlib.util.module_from_spec(spec)
spec.loader.exec_module(image)


def png():
    def chunk(kind, body):
        return struct.pack('>I', len(body)) + kind + body + struct.pack('>I', zlib.crc32(kind + body))
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 2, 1, 8, 2, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(b'\x00\xff\x00\x00\x00\xff\x00')) + chunk(b'IEND', b''))


class Images(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "image '$ name.png"
        self.source.write_bytes(png())
        self.cache = self.root / 'cache'

    def test_local_snapshot_is_full_color_and_content_addressed(self):
        info = image.stage(str(self.source), None, self.cache)
        self.assertEqual((info['width'], info['height']), (2, 1))
        self.assertEqual((self.cache / Path(info['path']).name).read_bytes(), png())
        self.assertEqual(image.stage(str(self.source), None, self.cache), info)
        self.assertEqual(len(list(self.cache.iterdir())), 1)

    def test_a_corrupt_cache_hit_is_an_explicit_integrity_error(self):
        info = image.stage(str(self.source), None, self.cache)
        (self.cache / Path(info['path']).name).write_bytes(b'broken')
        with self.assertRaisesRegex(RuntimeError, 'integrity'):
            image.stage(str(self.source), None, self.cache)

    def test_svg_viewbox_and_intrinsic_dimensions_keep_aspect_ratio(self):
        self.assertEqual(image.dimensions(b'<svg xmlns="http://www.w3.org/2000/svg" width="120" viewBox="0 0 60 30"><rect width="60" height="30" fill="red"/></svg>'), (120, 60, 'svg'))
        self.assertEqual(image.dimensions(b'<svg width="1in" height="2in"/>'), (96, 192, 'svg'))
        with self.assertRaisesRegex(ValueError, 'declarations'):
            image.dimensions(b'<!DOCTYPE svg><svg/>')

    def test_invalid_binary_or_truncated_png_never_publishes_a_cache_entry(self):
        for data in [b'not an image', png()[:-12], png().replace(b'IHDR', b'BAD!')]:
            self.source.write_bytes(data)
            with self.assertRaises((ValueError, RuntimeError)):
                image.stage(str(self.source), None, self.cache)
            self.assertEqual(list(self.cache.iterdir()), [])

    def test_gif_webp_and_bmp_dimensions(self):
        self.assertEqual(image.dimensions(b'GIF89a'+struct.pack('<HH', 3, 4)+b'\x00\x00\x00;'), (3,4,'gif'))
        body=b'\x00'*4+(4).to_bytes(3,'little')+(5).to_bytes(3,'little')
        data=b'RIFF'+(22).to_bytes(4,'little')+b'WEBPVP8X'+(10).to_bytes(4,'little')+body
        self.assertEqual(image.dimensions(data), (5,6,'webp'))
        data=bytearray(54);data[:2]=b'BM';data[2:6]=(54).to_bytes(4,'little');data[18:26]=struct.pack('<ii',3,-4)
        self.assertEqual(image.dimensions(bytes(data)), (3,4,'bmp'))

    def test_remote_images_use_the_captured_machine_and_verified_download(self):
        calls=[]
        def download(on, path, folder):
            calls.append((on,path))
            output=Path(folder)/'payload';shutil.copyfile(self.source,output)
            return {'path':str(output)}
        with patch.object(image,'download',download):
            result=image.stage('/remote/plot.png','chip',self.cache)
        self.assertEqual(calls,[('chip','/remote/plot.png')])
        self.assertEqual(result['width'],2)

    def test_remote_transport_failure_cannot_read_a_same_named_local_image(self):
        with patch.object(image,'download',side_effect=RuntimeError('SSH disconnected')):
            with self.assertRaisesRegex(RuntimeError,'SSH disconnected'):
                image.stage(str(self.source),'chip',self.cache)
        self.assertEqual(list(self.cache.iterdir()),[])

    def test_non_regular_files_do_not_block(self):
        with self.assertRaises((ValueError,OSError)):
            image.stage(str(self.root),None,self.cache)


if __name__ == '__main__':
    unittest.main()
