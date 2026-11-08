"""Serve the frontend folder for local use, with caching switched OFF.

Why: python's plain `http.server` lets the browser keep old copies of CSS/JS, so after an update a
page can show an old look until the user presses Ctrl+F5. This server sends `Cache-Control: no-store`
so every load gets the current files.

Usage (from anywhere):   backend\\.venv\\Scripts\\python.exe E:\\c&a-newww\\serve_frontend.py [port]
Default port 5500, bound to 127.0.0.1 only. The folder served is the `frontend` folder next to this file.
"""
import http.server
import os
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "frontend")


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, max-age=0")
        self.send_header("Pragma", "no-cache")
        super().end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5500
    with http.server.ThreadingHTTPServer(("127.0.0.1", port), NoCacheHandler) as httpd:
        print(f"Serving {ROOT} on http://127.0.0.1:{port}/ (no caching)")
        httpd.serve_forever()
