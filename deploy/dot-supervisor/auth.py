"""OAuth authorization-code/PKCE provider for this single-owner MCP resource."""
import base64
import hashlib
import html
import json
import re
import secrets
import time
import uuid
from urllib.parse import urlencode, urlsplit
from store import canonical, digest, text


class AuthError(ValueError):
    pass


class OAuth:
    scope = "blender:work"

    def __init__(self, ledger, issuer, owner_hash):
        self.store = ledger
        self.issuer = issuer.rstrip("/")
        self.resource = self.issuer + "/mcp"
        self.owner_hash = owner_hash
        self.failures = {}

    def metadata(self):
        return {"issuer": self.issuer, "authorization_endpoint": self.issuer + "/oauth/authorize",
                "token_endpoint": self.issuer + "/oauth/token", "registration_endpoint": self.issuer + "/oauth/register",
                "revocation_endpoint": self.issuer + "/oauth/revoke",
                "response_types_supported": ["code"], "grant_types_supported": ["authorization_code", "refresh_token"],
                "token_endpoint_auth_methods_supported": ["none"], "code_challenge_methods_supported": ["S256"],
                "scopes_supported": [self.scope], "authorization_response_iss_parameter_supported": True}

    def protected_metadata(self):
        return {"resource": self.resource, "authorization_servers": [self.issuer], "scopes_supported": [self.scope]}

    def register(self, data):
        redirects = data.get("redirect_uris")
        if not isinstance(redirects, list) or not 1 <= len(redirects) <= 4:
            raise ValueError("redirect_uris required")
        for uri in redirects:
            parsed = urlsplit(uri)
            if (parsed.scheme != "https" or parsed.netloc != "chatgpt.com" or parsed.query or parsed.fragment or
                not (parsed.path == "/connector_platform_oauth_redirect" or
                     re.fullmatch(r"/connector/oauth/[A-Za-z0-9_-]{1,160}", parsed.path))):
                raise ValueError("only documented ChatGPT OAuth callback URIs accepted")
        if data.get("token_endpoint_auth_method", "none") != "none":
            raise ValueError("public PKCE client required")
        if self.store.db.execute("SELECT COUNT(*) FROM clients").fetchone()[0] >= 128:
            raise ValueError("client registration capacity reached")
        client_id = str(uuid.uuid4())
        value = {"client_id": client_id, "redirect_uris": redirects, "token_endpoint_auth_method": "none",
                 "grant_types": ["authorization_code", "refresh_token"], "response_types": ["code"],
                 "client_name": text(data.get("client_name", "ChatGPT"), 100)}
        self.store.db.execute("INSERT INTO clients VALUES(?,?)", (client_id, canonical(value)))
        self.store.db.commit()
        return value

    def authorize(self, args):
        row = self.store.db.execute("SELECT data FROM clients WHERE id=?", (args.get("client_id"),)).fetchone()
        if not row:
            raise ValueError("unknown client")
        client = json.loads(row[0])
        if args.get("redirect_uri") not in client["redirect_uris"]:
            raise ValueError("invalid redirect URI")
        if args.get("response_type") != "code" or args.get("code_challenge_method") != "S256":
            raise ValueError("authorization code with S256 PKCE required")
        if args.get("resource") != self.resource or args.get("scope", self.scope) != self.scope:
            raise ValueError("invalid resource or scope")
        if not re.fullmatch(r"[A-Za-z0-9_-]{43}", args.get("code_challenge", "")):
            raise ValueError("invalid PKCE challenge")
        state = args.get("state", "")
        if not isinstance(state, str) or len(state.encode()) > 2048:
            raise ValueError("invalid OAuth state")
        now = time.time()
        self.store.db.execute("DELETE FROM auth_flows WHERE expires<?", (now,))
        if self.store.db.execute("SELECT COUNT(*) FROM auth_flows").fetchone()[0] >= 64:
            raise ValueError("authorization capacity reached")
        flow = secrets.token_urlsafe(32)
        bound = {k: args[k] for k in ("client_id", "redirect_uri", "code_challenge", "resource")}
        bound.update(scope=self.scope, state=state)
        self.store.db.execute("INSERT INTO auth_flows VALUES(?,?,?)", (digest(flow.encode()), canonical(bound), now+600))
        self.store.db.commit()
        return ("<!doctype html><html lang='ko'><meta charset='utf-8'><meta name='viewport' content='width=device-width'>"
                "<title>FMG Blender 연결</title><main><h1>ChatGPT 닷에 Blender 작업 권한 연결</h1>"
                "<p>이 연결은 작업 가져오기, 진행 보고, 결과 파일 업로드를 허용합니다.</p>"
                f"<form method='post' action='{html.escape(self.issuer)}/oauth/consent'>"
                f"<input type='hidden' name='flow' value='{flow}'>"
                "<label>서버 소유자 연결 암호 <input name='password' type='password' autocomplete='current-password' required></label>"
                "<button type='submit'>연결 승인</button></form></main></html>")

    def consent(self, args, peer):
        now = time.time()
        self.failures = {k: v for k, v in self.failures.items() if v[1] > now-600}
        count, last = self.failures.get(peer, (0, now))
        if count >= 5:
            raise AuthError("too many attempts; wait 10 minutes")
        # Stored value is salted scrypt, never a plaintext owner password.
        salt, expected = self.owner_hash.split(":", 1)
        password = args.get("password", "")
        if not isinstance(password, str) or len(password) > 512:
            raise AuthError("invalid owner password")
        actual = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=16384, r=8, p=1).hex()
        if not secrets.compare_digest(actual, expected):
            self.failures[peer] = (count+1, now)
            raise AuthError("invalid owner password")
        flow = digest(text(args.get("flow"), 100).encode())
        row = self.store.db.execute("SELECT data FROM auth_flows WHERE id=? AND expires>?", (flow, now)).fetchone()
        if not row:
            raise ValueError("authorization expired or already used")
        bound = json.loads(row[0])
        if bound.get("resource") != self.resource or bound.get("scope") != self.scope:
            raise AuthError("consent resource mismatch")
        code = secrets.token_urlsafe(32)
        self.store.db.execute("DELETE FROM auth_flows WHERE id=?", (flow,))
        self.store.db.execute("INSERT INTO codes VALUES(?,?,?)", (digest(code.encode()), canonical(bound), now+300))
        self.store.db.commit()
        self.failures.pop(peer, None)
        return bound["redirect_uri"] + "?" + urlencode({"code": code, "state": bound["state"], "iss": self.issuer})

    def issue(self, client, resource, family=None):
        family = family or str(uuid.uuid4())
        values = {}
        for kind, age in (("access", 3600), ("refresh", 30*86400)):
            raw = secrets.token_urlsafe(48)
            self.store.db.execute("INSERT INTO tokens VALUES(?,?,?,?,?,?,?)",
                                  (digest(raw.encode()), kind, client, self.scope, resource, time.time()+age, family))
            values[kind+"_token"] = raw
        values.update(token_type="Bearer", expires_in=3600, scope=self.scope)
        return values

    def token(self, args):
        if args.get("resource") != self.resource:
            raise AuthError("invalid target resource")
        kind = args.get("grant_type")
        if kind == "authorization_code":
            code_hash = digest(text(args.get("code"), 200).encode())
            row = self.store.db.execute("SELECT * FROM codes WHERE hash=?", (code_hash,)).fetchone()
            if not row or row["expires"] < time.time():
                raise AuthError("invalid or expired authorization code")
            bound = json.loads(row["data"])
            verifier = args.get("code_verifier", "")
            if not re.fullmatch(r"[A-Za-z0-9._~-]{43,128}", verifier):
                raise AuthError("invalid verifier")
            challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
            if (bound["client_id"] != args.get("client_id") or bound["redirect_uri"] != args.get("redirect_uri") or
                bound["resource"] != args["resource"] or bound.get("scope") != self.scope or not secrets.compare_digest(challenge, bound["code_challenge"])):
                raise AuthError("authorization binding mismatch")
            self.store.db.execute("DELETE FROM codes WHERE hash=?", (code_hash,))
            result = self.issue(bound["client_id"], bound["resource"])
        elif kind == "refresh_token":
            hashed = digest(text(args.get("refresh_token"), 200).encode())
            row = self.store.db.execute("SELECT * FROM tokens WHERE hash=? AND kind IN ('refresh','used_refresh')", (hashed,)).fetchone()
            if not row or row["client_id"] != args.get("client_id") or row["resource"] != args["resource"] or row["scope"] != self.scope:
                raise AuthError("invalid refresh token")
            if row["kind"] == "used_refresh":
                self.store.db.execute("DELETE FROM tokens WHERE family=?", (row["family"],))
                self.store.db.execute("DELETE FROM subscriptions WHERE client_id=?", (row["client_id"],))
                self.store.db.execute("DELETE FROM workers WHERE client_id=?", (row["client_id"],))
                self.store.db.commit()
                raise AuthError("refresh replay; connection revoked")
            if row["expires"] < time.time():
                raise AuthError("expired refresh token")
            self.store.db.execute("UPDATE tokens SET kind='used_refresh' WHERE hash=?", (hashed,))
            result = self.issue(row["client_id"], row["resource"], row["family"])
        else:
            raise AuthError("unsupported grant type")
        self.store.db.commit()
        return result

    def bearer(self, header):
        if not isinstance(header, str) or not header.startswith("Bearer ") or len(header) > 300:
            raise AuthError("OAuth bearer required")
        row = self.store.db.execute("SELECT * FROM tokens WHERE hash=? AND kind='access' AND expires>?",
                                    (digest(header[7:].encode()), time.time())).fetchone()
        if not row or row["scope"] != self.scope or row["resource"] != self.resource:
            raise AuthError("expired or invalid bearer")
        return row["client_id"]

    def revoke(self, args):
        hashed = digest(text(args.get("token"), 200).encode())
        row = self.store.db.execute("SELECT * FROM tokens WHERE hash=?", (hashed,)).fetchone()
        if row and row["client_id"] == args.get("client_id") and row["resource"] == self.resource and row["scope"] == self.scope:
            self.store.db.execute("DELETE FROM tokens WHERE family=?", (row["family"],))
            self.store.db.execute("DELETE FROM subscriptions WHERE client_id=?", (row["client_id"],))
            self.store.db.execute("DELETE FROM workers WHERE client_id=?", (row["client_id"],))
            self.store.db.commit()
        return None
