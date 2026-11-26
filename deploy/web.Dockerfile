# Web image: Caddy + the static pages.
# Build context = the repository root. The root .dockerignore is an ALLOW-LIST: only deploy/Caddyfile and
# frontend/*.html, frontend/css/, frontend/js/, frontend/assets/ enter the build context, and only those are
# copied below. Never mockups/, tests/, README.md, serve_frontend.py, frontend-video/, BRD/, backend/.
# (If a frontend/fonts/ folder is ever added: add it here AND to the root .dockerignore, and add 'self' to
# font-src in the Caddyfile CSP.)
# Exact tag (Caddy v2.11.9), the version this Caddyfile was verified with; bump it deliberately.
FROM caddy:2.11.9

COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY frontend/*.html /srv/
COPY frontend/css/ /srv/css/
COPY frontend/js/ /srv/js/
COPY frontend/assets/ /srv/assets/

# Fail the build on a Caddyfile error (DOMAIN is only needed to parse it here).
RUN DOMAIN=:80 caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
