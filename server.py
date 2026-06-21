#!/usr/bin/env python3
"""
MHA-DND Class 1-A — Relationship Tracker
Run: python3 server.py
Then open: http://localhost:5001
"""

import http.server
import json
import os
import re
import urllib.parse
from pathlib import Path

PORT = int(os.environ.get("PORT", 5001))
ROOT = Path(__file__).parent
CLASS_DIR = ROOT / "CLASS-1A"
CAMPAIGN_DIR = ROOT / "CAMPAIGN"
RULEBOOKS_DIR = ROOT / "RULEBOOKS"
RELS_FILE = CLASS_DIR / "relationships.json"
HTML_FILE = CLASS_DIR / "relationships.html"
ROSTER_FILE = CLASS_DIR / "roster.json"
INDEX_FILE = ROOT / "index.html"
CAMPAIGN_FILE = ROOT / "campaign.html"

CHAR_FILE_RE = re.compile(r"^/api/character/([a-z0-9_]+\.json)$")
CAMPAIGN_FILE_RE = re.compile(r"^/api/campaign/(arc|world|teachers|villains|tier1|enemies|class1b)$")
SCRIPTS_FILE = CAMPAIGN_DIR / "scripts.json"
TEACHERS_FILE = CAMPAIGN_DIR / "teachers.json"
VILLAINS_FILE = CAMPAIGN_DIR / "villains.json"
CLASS1B_FILE = CAMPAIGN_DIR / "class1b.json"
EXPORT_VERSION = 1
RULEBOOK_FILE_RE = re.compile(r"^/rulebooks/(.+\.pdf)$")
NAME_SLUG_RE = re.compile(r"[^a-z0-9]+")

MIME = {".html": "text/html; charset=utf-8", ".json": "application/json; charset=utf-8", ".pdf": "application/pdf"}


def load_relationships():
    if RELS_FILE.exists():
        with open(RELS_FILE, encoding="utf-8") as f:
            return json.load(f)
    return {}


def save_relationships(data):
    with open(RELS_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)


def load_characters():
    roster = json.loads(ROSTER_FILE.read_text(encoding="utf-8"))
    characters = []
    for student in roster["students"]:
        fname = student.get("file")
        if not fname:
            continue
        fpath = CLASS_DIR / fname
        if fpath.exists():
            char = json.loads(fpath.read_text(encoding="utf-8"))
            char["_file"] = fname
            char["_roster_id"] = student["id"]
            characters.append(char)
    return characters


def save_character(filename, data):
    safe = Path(filename).name
    if not safe.endswith(".json") or "/" in filename or "\\" in filename:
        raise ValueError("Invalid filename")
    fpath = CLASS_DIR / safe
    if not fpath.exists():
        raise FileNotFoundError(f"{safe} not found")
    with open(fpath, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)


def load_all_characters():
    """Aggregate Class 1-A, Class 1-B, teachers, and villains into one tagged list."""
    out = []

    for char in load_characters():
        char["_type"] = "Student (1-A)"
        out.append(char)

    if CLASS1B_FILE.exists():
        class1b = json.loads(CLASS1B_FILE.read_text(encoding="utf-8"))
        for student in class1b.get("students", []):
            student = dict(student)
            student["_type"] = "Student (1-B)"
            student["is_pc"] = False
            out.append(student)

    if TEACHERS_FILE.exists():
        teachers = json.loads(TEACHERS_FILE.read_text(encoding="utf-8"))
        for teacher in teachers.get("teachers", []):
            teacher = dict(teacher)
            teacher["_type"] = "Teacher"
            teacher["is_pc"] = False
            out.append(teacher)

    if VILLAINS_FILE.exists():
        villains_data = json.loads(VILLAINS_FILE.read_text(encoding="utf-8"))
        seen = set()
        for faction in villains_data.get("factions", []):
            for villain in faction.get("villains", []):
                if villain["name"] in seen:
                    continue
                seen.add(villain["name"])
                villain = dict(villain)
                villain["_type"] = "Villain"
                villain["is_pc"] = False
                villain["_faction"] = faction.get("name")
                out.append(villain)

    return out


def slugify(name):
    slug = NAME_SLUG_RE.sub("_", name.strip().lower()).strip("_")
    return slug or "character"


def create_character(payload):
    name = (payload.get("name") or "").strip()
    if not name:
        raise ValueError("Name is required")

    base_slug = slugify(name)
    filename = f"{base_slug}.json"
    n = 2
    while (CLASS_DIR / filename).exists():
        filename = f"{base_slug}_{n}.json"
        n += 1

    char_data = {
        "name": name,
        "is_pc": bool(payload.get("is_pc", False)),
        "gender": payload.get("gender", ""),
        "physiology": payload.get("physiology", ""),
        "quirk": payload.get("quirk", ""),
        "appearance": {"other": payload.get("appearance", "")},
        "personality": {"summary": payload.get("personality", "")},
        "bonus_features": payload.get("bonus_features", ""),
    }
    (CLASS_DIR / filename).write_text(
        json.dumps(char_data, indent=2, ensure_ascii=False), encoding="utf-8"
    )

    roster = json.loads(ROSTER_FILE.read_text(encoding="utf-8"))
    next_id = max((s.get("id", 0) for s in roster.get("students", [])), default=0) + 1
    roster["students"].append({
        "id": next_id,
        "name": name,
        "quirk": payload.get("quirk", ""),
        "gender": payload.get("gender", ""),
        "physiology": payload.get("physiology", ""),
        "is_pc": bool(payload.get("is_pc", False)),
        "file": filename,
    })
    roster["total_students"] = len(roster["students"])
    with open(ROSTER_FILE, "w", encoding="utf-8") as f:
        json.dump(roster, f, indent=2, ensure_ascii=False)

    return filename


def build_export():
    import datetime
    characters = {}
    roster = json.loads(ROSTER_FILE.read_text(encoding="utf-8"))
    for student in roster.get("students", []):
        fname = student.get("file")
        if fname:
            fpath = CLASS_DIR / fname
            if fpath.exists():
                characters[fname] = json.loads(fpath.read_text(encoding="utf-8"))
    return {
        "version": EXPORT_VERSION,
        "exported_at": datetime.datetime.utcnow().isoformat() + "Z",
        "relationships": load_relationships(),
        "characters": characters,
    }


def apply_import(data):
    if data.get("version") != EXPORT_VERSION:
        raise ValueError(f"Unsupported export version: {data.get('version')}")
    errors = []
    if "relationships" in data:
        save_relationships(data["relationships"])
    for fname, char_data in data.get("characters", {}).items():
        try:
            save_character(fname, char_data)
        except (ValueError, FileNotFoundError, OSError) as e:
            errors.append(f"{fname}: {e}")
    if errors:
        raise ValueError("Some files failed to import: " + "; ".join(errors))


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print(f"  {self.address_string()} {fmt % args}")

    def send_json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", len(body))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def serve_file(self, fpath, mime):
        try:
            content = fpath.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", len(content))
            self.end_headers()
            self.wfile.write(content)
        except FileNotFoundError:
            self.send_json(404, {"error": f"{fpath.name} not found"})

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path.rstrip("/") or "/"

        if path == "/api/relationships":
            self.send_json(200, load_relationships())
            return

        if path == "/api/export":
            try:
                bundle = build_export()
                body = json.dumps(bundle, indent=2, ensure_ascii=False).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Disposition", "attachment; filename=\"mha-dnd-backup.json\"")
                self.send_header("Content-Length", len(body))
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(body)
            except Exception as e:
                self.send_json(500, {"error": str(e)})
            return

        if path == "/api/characters":
            try:
                self.send_json(200, load_characters())
            except Exception as e:
                self.send_json(500, {"error": str(e)})
            return

        if path == "/api/all-characters":
            try:
                self.send_json(200, load_all_characters())
            except Exception as e:
                self.send_json(500, {"error": str(e)})
            return

        if path == "/api/campaign/scripts":
            try:
                self.send_json(200, json.loads(SCRIPTS_FILE.read_text(encoding="utf-8")))
            except FileNotFoundError:
                self.send_json(404, {"error": "scripts.json not found"})
            return

        m = CAMPAIGN_FILE_RE.match(path)
        if m:
            fpath = CAMPAIGN_DIR / (m.group(1) + ".json")
            try:
                self.send_json(200, json.loads(fpath.read_text(encoding="utf-8")))
            except FileNotFoundError:
                self.send_json(404, {"error": f"{m.group(1)}.json not found"})
            return

        m = RULEBOOK_FILE_RE.match(path)
        if m:
            fname = urllib.parse.unquote(m.group(1))
            self.serve_file(RULEBOOKS_DIR / fname, "application/pdf")
            return

        if path == "/":
            self.serve_file(INDEX_FILE, "text/html; charset=utf-8")
            return

        if path == "/relationships":
            self.serve_file(HTML_FILE, "text/html; charset=utf-8")
            return

        if path == "/campaign":
            self.serve_file(CAMPAIGN_FILE, "text/html; charset=utf-8")
            return

        if path == "/characters":
            self.serve_file(ROOT / "characters.html", "text/html; charset=utf-8")
            return

        self.send_json(404, {"error": "not found"})

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length)

        if path == "/api/relationships":
            try:
                data = json.loads(body.decode("utf-8"))
                save_relationships(data)
                self.send_json(200, {"ok": True})
            except (json.JSONDecodeError, OSError) as e:
                self.send_json(400, {"error": str(e)})
            return

        if path == "/api/campaign/scripts":
            try:
                data = json.loads(body.decode("utf-8"))
                with open(SCRIPTS_FILE, "w", encoding="utf-8") as f:
                    json.dump(data, f, indent=2, ensure_ascii=False)
                self.send_json(200, {"ok": True})
            except (json.JSONDecodeError, OSError) as e:
                self.send_json(400, {"error": str(e)})
            return

        m = CHAR_FILE_RE.match(path)
        if m:
            filename = m.group(1)
            try:
                data = json.loads(body.decode("utf-8"))
                save_character(filename, data)
                self.send_json(200, {"ok": True})
            except (json.JSONDecodeError, ValueError, FileNotFoundError, OSError) as e:
                self.send_json(400, {"error": str(e)})
            return

        if path == "/api/characters/create":
            try:
                payload = json.loads(body.decode("utf-8"))
                filename = create_character(payload)
                self.send_json(200, {"ok": True, "file": filename})
            except (json.JSONDecodeError, ValueError, OSError) as e:
                self.send_json(400, {"error": str(e)})
            return

        if path == "/api/import":
            try:
                data = json.loads(body.decode("utf-8"))
                apply_import(data)
                self.send_json(200, {"ok": True})
            except (json.JSONDecodeError, ValueError, OSError) as e:
                self.send_json(400, {"error": str(e)})
            return

        self.send_json(404, {"error": "not found"})


if __name__ == "__main__":
    server = http.server.HTTPServer(("127.0.0.1", PORT), Handler)
    print(f"\n  Class 1-A Relationship Tracker")
    print(f"  http://localhost:{PORT}\n")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n  Server stopped.")
