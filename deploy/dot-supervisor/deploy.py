"""Deploy a staged release using the existing pinned Python image and TLS router."""
import ast
import hashlib
import json
import os
import shutil
import secrets
import subprocess
import sys
from pathlib import Path

release = Path(sys.argv[1]).resolve()
root = Path("/docker/fmg-dot-supervisor")
if release.parent != root / "releases" or not release.is_dir():
    raise ValueError("release_path_invalid")
os.umask(0o077)
for path in release.glob("*.py"):
    ast.parse(path.read_text(), filename=str(path))
data = root / "data"
data.mkdir(parents=True, exist_ok=True, mode=0o700)
if not (data / "owner.hash").exists():
    password = secrets.token_urlsafe(32)
    salt = secrets.token_bytes(16)
    hashed = hashlib.scrypt(password.encode(), salt=salt, n=16384, r=8, p=1).hex()
    (data / "owner.hash").write_text(salt.hex()+":"+hashed)
    (data / "owner.hash").chmod(0o600)
    (data / "initial-connection-password.txt").write_text(password)
    (data / "initial-connection-password.txt").chmod(0o600)
os.chown(data, 1000, 1000)
os.chown(data / "owner.hash", 1000, 1000)
token_path = data / "operator.token"
if not token_path.exists():
    token_path.write_text(secrets.token_urlsafe(48))
token_path.chmod(0o600)
os.chown(token_path, 1000, 1000)
gateway_token = Path("/docker/openclaw-cknk/data/.openclaw/secrets/fmg-supervisor-operator.token")
gateway_token.write_bytes(token_path.read_bytes())
gateway_token.chmod(0o600)
os.chown(gateway_token, 1000, 1000)
snapshot = Path("/docker/openclaw-cknk/data/.openclaw/fmg-supervisor")
snapshot.mkdir(exist_ok=True, mode=0o700)
os.chown(snapshot, 1000, 1000)
cfg = json.loads(Path("/docker/openclaw-cknk/data/.openclaw/openclaw.json").read_text())
owner = cfg["plugins"]["entries"]["fmg-supervisor"]["config"]["ownerPubkey"]
existing = json.loads(subprocess.check_output(["docker", "inspect", "fmg-dot-blender"]))[0]
image = existing["Config"]["Image"]
if "@sha256:" not in image:
    raise ValueError("python_image_not_pinned")
host = "buzz-dnb0.srv2006121.hstgr.cloud"
rule = f'Host(`{host}`) && (PathPrefix(`/dot-supervisor`) || Path(`/.well-known/oauth-authorization-server/dot-supervisor`) || Path(`/.well-known/oauth-protected-resource/dot-supervisor/mcp`) || Path(`/.well-known/oauth-authorization-server/dot-supervisor/tasks`) || Path(`/.well-known/oauth-protected-resource/dot-supervisor/tasks/mcp`))'
service = {
    "image": image, "container_name": "fmg-dot-supervisor", "restart": "unless-stopped", "user": "1000:1000",
    "command": ["python", "-u", "/app/server.py"], "working_dir": "/app", "read_only": True,
    "environment": {"FMG_DATA": "/data", "FMG_ISSUER": f"https://{host}/dot-supervisor", "FMG_OWNER_PUBKEY": owner, "PYTHONDONTWRITEBYTECODE": "1"},
    "volumes": [str(release)+":/app:ro", str(data)+":/data", str(snapshot)+":/snapshot:ro"],
    "tmpfs": ["/tmp:rw,noexec,nosuid,size=16m"], "cap_drop": ["ALL"], "security_opt": ["no-new-privileges:true"],
    "mem_limit": "128m", "cpus": "0.25", "pids_limit": 32, "networks": ["dokploy-network"],
    "labels": {"traefik.enable": "true", "traefik.docker.network": "dokploy-network",
        "traefik.http.routers.fmg-dot-supervisor.rule": rule, "traefik.http.routers.fmg-dot-supervisor.entrypoints": "websecure",
        "traefik.http.routers.fmg-dot-supervisor.priority": "200", "traefik.http.routers.fmg-dot-supervisor.tls.certresolver": "letsencrypt",
        "traefik.http.services.fmg-dot-supervisor.loadbalancer.server.port": "8000"},
    "logging": {"driver": "json-file", "options": {"max-size": "5m", "max-file": "3"}},
    "healthcheck": {"test": ["CMD", "python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/dot-supervisor/health',timeout=3)"], "interval": "30s", "timeout": "5s", "retries": 3},
}
compose = root / "compose.json"
if compose.exists():
    shutil.copyfile(compose, root / ("compose.before-"+release.name+".json"))
compose.write_text(json.dumps({"services": {"bridge": service}, "networks": {"dokploy-network": {"external": True}}}, indent=2))
subprocess.run(["docker", "compose", "-p", "fmg-dot-supervisor", "-f", str(compose), "up", "-d"], check=True)
print(json.dumps({"service": "fmg-dot-supervisor", "release": release.name, "scope": "buzz:read", "separate_oauth": True, "snapshot_mount_read_only": True}))
