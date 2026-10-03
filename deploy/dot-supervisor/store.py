"""Isolated OAuth state for the read-only Buzz supervisor resource."""
import hashlib
import json
import sqlite3
import threading
from pathlib import Path


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def digest(value):
    return hashlib.sha256(value).hexdigest()


def text(value, limit=1000):
    if not isinstance(value, str) or not value.strip() or len(value.encode()) > limit:
        raise ValueError("invalid text")
    return value.strip()


class Ledger:
    """Separate database prevents Blender tokens from gaining Buzz access."""
    def __init__(self, root):
        root = Path(root)
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.lock = threading.RLock()
        self.db = sqlite3.connect(root / "oauth.sqlite3", check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.executescript("""
        PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS clients (id TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS auth_flows (id TEXT PRIMARY KEY, data TEXT NOT NULL, expires REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS codes (hash TEXT PRIMARY KEY, data TEXT NOT NULL, expires REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS tokens (hash TEXT PRIMARY KEY, kind TEXT NOT NULL, client_id TEXT NOT NULL,
            scope TEXT NOT NULL, resource TEXT NOT NULL, expires REAL NOT NULL, family TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS subscriptions (client_id TEXT);
        CREATE TABLE IF NOT EXISTS workers (client_id TEXT);
        """)
