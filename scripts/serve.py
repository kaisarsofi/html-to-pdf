"""Static file server for the examples.

Identical to `python3 -m http.server` except that it sends `Cache-Control:
no-store`. Without that, browsers cache the ES modules under src/ and keep
running the previous version of the library after you edit it — which looks
exactly like your change not working.
"""
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, max-age=0")
        super().end_headers()

    def log_message(self, fmt, *args):  # quieter output
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 4173
    print(f"serving on http://localhost:{port}/examples/")
    ThreadingHTTPServer(("127.0.0.1", port), NoCacheHandler).serve_forever()
