"""A small offline OpenID Connect provider for the tests and the local smoke run (never used in production).

It implements what the app's Authlib client uses, with the checks a real provider makes:
  GET  <issuer>/.well-known/openid-configuration   discovery
  GET  <issuer>/jwks                               the public RS256 key
  GET  <issuer>/authorize   code flow: client_id, response_type=code, scope with openid, state, nonce,
                            redirect_uri and PKCE S256 are required; answers 302 to redirect_uri?code&state
  POST <issuer>/token       client_secret_basic; the code is single-use, expires in 60 s and is bound to the
                            redirect_uri and the PKCE challenge; returns an RS256 ID token (kid "mock-1")
  POST <issuer>/_mock/next-login   (smoke runs only) JSON claims for the next sign-in

The routes live under the issuer's path, so one class plays Entra
(https://login.microsoftonline.com/<tid>/v2.0), Google (https://accounts.google.com) or any generic issuer.

pytest:  idp = MockIdP(issuer, client_id, secret); create_app(settings, oidc_transport=httpx.ASGITransport(app=idp.app))
smoke:   MOCK_IDP_ISSUER=http://127.0.0.1:8101 MOCK_IDP_CLIENT_ID=.. MOCK_IDP_CLIENT_SECRET=..
         python -m uvicorn --factory tests.mock_idp:create_smoke_app --port 8101
"""
from __future__ import annotations

import base64
import hashlib
import os
import secrets
import time
from urllib.parse import urlencode, urlsplit

from joserfc import jwt
from joserfc.jwk import RSAKey
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse, PlainTextResponse, RedirectResponse
from starlette.routing import Route

KID = "mock-1"
DROP = object()  # in token_overrides: remove that claim from the ID token
_KEY: RSAKey | None = None


def signing_key() -> RSAKey:
    global _KEY
    if _KEY is None:  # one 2048-bit key per process (generating it takes a moment)
        _KEY = RSAKey.generate_key(2048, parameters={"kid": KID, "use": "sig", "alg": "RS256"})
    return _KEY


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


class MockIdP:
    def __init__(self, issuer: str, client_id: str, client_secret: str):
        self.issuer = issuer.rstrip("/")
        self.client_id, self.client_secret = client_id, client_secret
        self.next_claims: dict = {}        # claims of the next sign-in (sub, email, email_verified, hd, tid, oid...)
        self.token_overrides: dict = {}    # forced ID-token claim values (nonce, iss, aud, exp...); DROP removes
        self.metadata_issuer: str | None = None  # "issuer" in the discovery document (default: the issuer)
        self.sign_key: RSAKey | None = None      # sign with another key (bad signature tests)
        self.deny: str | None = None       # answer /authorize with this OAuth error instead of a code
        self.codes: dict[str, dict] = {}
        self.authorize_requests: list[dict] = []
        self.token_requests: list[dict] = []
        prefix = urlsplit(self.issuer).path.rstrip("/")
        self.app = Starlette(routes=[
            Route(prefix + "/.well-known/openid-configuration", self.discovery),
            Route(prefix + "/jwks", self.jwks),
            Route(prefix + "/authorize", self.authorize),
            Route(prefix + "/token", self.token, methods=["POST"]),
            Route(prefix + "/_mock/next-login", self.set_next_login, methods=["POST"]),
        ])

    async def discovery(self, request: Request):
        i = self.issuer
        return JSONResponse({
            "issuer": self.metadata_issuer or i,
            "authorization_endpoint": f"{i}/authorize",
            "token_endpoint": f"{i}/token",
            "jwks_uri": f"{i}/jwks",
            "response_types_supported": ["code"],
            "response_modes_supported": ["query"],
            "subject_types_supported": ["public"],
            "id_token_signing_alg_values_supported": ["RS256"],
            "code_challenge_methods_supported": ["S256"],
            "token_endpoint_auth_methods_supported": ["client_secret_basic"],
            "scopes_supported": ["openid", "email", "profile"],
        })

    async def jwks(self, request: Request):
        return JSONResponse({"keys": [signing_key().as_dict(private=False)]})

    async def authorize(self, request: Request):
        q = dict(request.query_params)
        self.authorize_requests.append(q)
        if q.get("client_id") != self.client_id:
            return PlainTextResponse("unknown client_id", status_code=400)
        if q.get("response_type") != "code":
            return PlainTextResponse("response_type must be code", status_code=400)
        if "openid" not in (q.get("scope") or "").split():
            return PlainTextResponse("scope must include openid", status_code=400)
        if q.get("code_challenge_method") != "S256" or not q.get("code_challenge"):
            return PlainTextResponse("PKCE S256 is required", status_code=400)
        if not (q.get("state") and q.get("nonce") and q.get("redirect_uri")):
            return PlainTextResponse("state, nonce and redirect_uri are required", status_code=400)
        redirect_uri = q["redirect_uri"]
        if self.deny:
            params = {"error": self.deny, "error_description": "<b>provider text that must not be echoed</b>",
                      "state": q["state"]}
            return RedirectResponse(f"{redirect_uri}?{urlencode(params)}", status_code=302)
        code = secrets.token_urlsafe(16)
        self.codes[code] = {"redirect_uri": redirect_uri, "challenge": q["code_challenge"], "nonce": q["nonce"],
                            "claims": dict(self.next_claims), "exp": time.time() + 60}
        return RedirectResponse(f"{redirect_uri}?{urlencode({'code': code, 'state': q['state']})}", status_code=302)

    async def token(self, request: Request):
        form = dict(await request.form())
        self.token_requests.append(form)
        auth = request.headers.get("authorization", "")
        try:
            cid, _, secret = base64.b64decode(auth[6:]).decode("latin1").partition(":")
        except Exception:
            cid = secret = ""
        if not auth.startswith("Basic ") or cid != self.client_id or secret != self.client_secret:
            return JSONResponse({"error": "invalid_client"}, status_code=401)
        if form.get("grant_type") != "authorization_code":
            return JSONResponse({"error": "unsupported_grant_type"}, status_code=400)
        entry = self.codes.pop(form.get("code") or "", None)  # single use
        if entry is None or entry["exp"] < time.time() or form.get("redirect_uri") != entry["redirect_uri"]:
            return JSONResponse({"error": "invalid_grant"}, status_code=400)
        verifier = form.get("code_verifier") or ""
        if _b64url(hashlib.sha256(verifier.encode("ascii")).digest()) != entry["challenge"]:
            return JSONResponse({"error": "invalid_grant", "error_description": "PKCE"}, status_code=400)
        access_token = secrets.token_urlsafe(24)
        now = int(time.time())
        claims = {"iss": self.issuer, "aud": self.client_id, "iat": now, "exp": now + 300,
                  "nonce": entry["nonce"], "sub": "mock-sub",
                  "at_hash": _b64url(hashlib.sha256(access_token.encode("ascii")).digest()[:16]),
                  **entry["claims"]}
        for k, v in self.token_overrides.items():
            if v is DROP:
                claims.pop(k, None)
            else:
                claims[k] = v
        id_token = jwt.encode({"alg": "RS256", "kid": KID}, claims, self.sign_key or signing_key())
        return JSONResponse({"access_token": access_token, "token_type": "Bearer", "expires_in": 300,
                             "id_token": id_token})

    async def set_next_login(self, request: Request):
        self.next_claims = dict(await request.json())
        return JSONResponse({"ok": True})


def create_smoke_app():
    """uvicorn --factory entry point for the local end-to-end smoke run."""
    idp = MockIdP(os.environ["MOCK_IDP_ISSUER"], os.environ["MOCK_IDP_CLIENT_ID"],
                  os.environ["MOCK_IDP_CLIENT_SECRET"])
    return idp.app
