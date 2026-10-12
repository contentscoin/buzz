"""Read-only, bounded distribution surface for public signed FMG binaries."""
import http.server
from pathlib import Path
import re
import threading

ROOT = Path('/updates').resolve()
ARTIFACT = re.compile(r'^artifacts/[0-9a-f]{64}\.(apk|exe)$')


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.0'

    def setup(self):
        super().setup()
        self.connection.settimeout(30)

    def do_HEAD(self):
        self.serve(head=True)

    def do_GET(self):
        self.serve(head=False)

    def serve(self, head):
        if not self.path.startswith('/fmg-updates/') or len(self.path) > 512:
            self.send_error(404)
            return
        relative = self.path[len('/fmg-updates/'):]
        if not relative:
            relative = 'index.html'
        artifact = ARTIFACT.fullmatch(relative)
        if relative not in ('index.html', 'android/latest.json', 'windows/latest.json') and not artifact:
            self.send_error(404)
            return
        file = ROOT / relative
        if file.is_symlink() or not file.is_file() or not file.resolve().is_relative_to(ROOT):
            self.send_error(404)
            return
        size = file.stat().st_size
        if size > 300 * 1024 * 1024:
            self.send_error(413)
            return
        mime = ('application/vnd.android.package-archive' if file.suffix == '.apk' else
                'application/octet-stream' if file.suffix == '.exe' else
                'application/json' if file.suffix == '.json' else 'text/html; charset=utf-8')
        self.send_response(200)
        self.send_header('Content-Type', mime)
        self.send_header('Content-Length', str(size))
        self.send_header('Cache-Control', 'public, max-age=31536000, immutable' if artifact else 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'")
        self.end_headers()
        if not head:
            try:
                with file.open('rb') as stream:
                    while data := stream.read(65536):
                        self.wfile.write(data)
            except (BrokenPipeError, ConnectionResetError, TimeoutError):
                return

    def log_message(self, *_args):
        # No client identity, URL tokens or request bodies are needed here.
        return


class Server(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, *args):
        self.slots = threading.BoundedSemaphore(8)
        super().__init__(*args)

    def process_request(self, request, address):
        if not self.slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, address)
        except BaseException:
            self.slots.release()
            raise

    def process_request_thread(self, request, address):
        try:
            super().process_request_thread(request, address)
        finally:
            self.slots.release()


if __name__ == '__main__':
    Server(('0.0.0.0', 8000), Handler).serve_forever()
