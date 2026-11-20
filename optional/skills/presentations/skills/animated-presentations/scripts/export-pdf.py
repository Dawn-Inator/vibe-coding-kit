#!/usr/bin/env python3
"""Export compatible HTML slides to a raster PDF; no automatic dependency installs.

Adapted from Frontend Slides' screenshot/PDF workflow (see ../LICENSE).
Requires Python 3.10+, playwright, and its Chromium browser.
"""
import argparse
import base64
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import threading
from urllib.parse import quote


class LocalHandler(SimpleHTTPRequestHandler):
    """Serve only files physically contained in the chosen deck directory."""

    def translate_path(self, path):
        candidate = Path(super().translate_path(path)).resolve()
        if not candidate.is_relative_to(Path(self.directory).resolve()):
            # Return a deliberately missing path inside the root, never a symlink escape.
            return str(Path(self.directory) / '.blocked-path' / 'missing')
        return str(candidate)

    def list_directory(self, path):
        self.send_error(403, 'Directory listing disabled')
        return None

    def log_message(self, format, *args):
        pass


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('html', type=Path)
    parser.add_argument('output', type=Path, nargs='?')
    parser.add_argument('--width', type=int, default=1920)
    parser.add_argument('--height', type=int, default=1080)
    args = parser.parse_args()
    if not args.html.is_file():
        parser.error('HTML file does not exist')
    if not 1 <= args.width <= 7680 or not 1 <= args.height <= 7680:
        parser.error('Width and height must be between 1 and 7680')
    source = args.html.resolve()
    output = (args.output or source.with_suffix('.pdf')).resolve()
    if output == source:
        parser.error('Output must differ from the source HTML')
    if output.exists():
        parser.error('Output exists; choose a new output path')
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        parser.exit(1, 'Requires playwright and Chromium; see references/tools.md for setup.\n')
    handler = partial(LocalHandler, directory=str(source.parent))
    server = ThreadingHTTPServer(('127.0.0.1', 0), handler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            try:
                page = browser.new_page(viewport={'width': args.width, 'height': args.height}, reduced_motion='reduce')
                failures = []
                page.on('requestfailed', lambda request: failures.append(request.url))
                page.on('response', lambda response: failures.append(response.url) if response.status >= 400 else None)
                page.goto(f'http://127.0.0.1:{server.server_port}/{quote(source.name)}', wait_until='load')
                page.evaluate('() => document.fonts.ready')
                count = page.locator('.slide').count()
                if not count or not page.evaluate("() => typeof window.renderSlide === 'function'"):
                    raise RuntimeError('Requires .slide elements and window.renderSlide(index, {exportMode:true}); see html-template.md')
                captures = []
                for index in range(count):
                    page.evaluate('(index) => window.renderSlide(index, {exportMode:true})', index)
                    page.evaluate('''async () => {
                      await document.fonts.ready;
                      await Promise.all([...document.images].map(image => image.decode().catch(() => {})));
                    }''')
                    broken_images = page.evaluate('() => [...document.images].filter(image => !image.complete || image.naturalWidth === 0).map(image => image.src)')
                    if broken_images or failures:
                        raise RuntimeError(f'Assets failed to load: {broken_images + failures}')
                    captures.append(base64.b64encode(page.screenshot()).decode('ascii'))
                    print(f'Captured {index + 1}/{count}')
                pdf_page = browser.new_page()
                images = ''.join(f'<section><img src="data:image/png;base64,{data}"></section>' for data in captures)
                pdf_page.set_content(f'''<!doctype html><style>
                  * {{ margin:0; padding:0; }}
                  section {{ width:{args.width}px; height:{args.height}px; break-after:page; }}
                  section:last-child {{ break-after:auto; }}
                  img {{ display:block; width:100%; height:100%; }}
                </style>{images}''', wait_until='load')
                output.parent.mkdir(parents=True, exist_ok=True)
                pdf_page.pdf(path=str(output), width=f'{args.width}px', height=f'{args.height}px', print_background=True)
                print(f'Saved {count} static pages: {output}')
            finally:
                browser.close()
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


if __name__ == '__main__':
    main()
