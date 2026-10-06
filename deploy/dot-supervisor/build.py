"""Stage source with the existing pinned OAuth implementation, without secrets."""
import ast
import shutil
from pathlib import Path

root = Path(__file__).resolve().parent
output = root / "dist"
output.mkdir(exist_ok=True)
for name in ("server.py", "store.py", "tools.py", "tasks.py", "auth.py", "deploy.py", "completion.py", "documents.py", "document_access.py", "document_owner.py", "communities.py"):
    shutil.copyfile(root / name, output / name)
for path in output.glob("*.py"):
    ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
print("Supervisor Python sources staged; syntax parsed.")
