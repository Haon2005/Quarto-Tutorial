"""
preview.py — render all Quarto profiles and open a local preview.

Usage:  python preview.py
        python preview.py --port 8080
        python preview.py --no-render      (skip rendering, just serve)
        python preview.py --no-kill        (leave older instances running)
"""

import argparse
import http.server
import os
import re
import signal
import subprocess
import sys
import threading
import time
import webbrowser

# ── Config ────────────────────────────────────────────────────────────────────

PROFILES   = ["root", "beg", "int", "exp"]  # must match _quarto-<profile>.yml files
DOCS_DIR   = "docs"
START_PAGE = "index.html"                   # opened in browser after serving

# ── Argument parsing ──────────────────────────────────────────────────────────

parser = argparse.ArgumentParser()
parser.add_argument("--port",      type=int, default=8000)
parser.add_argument("--no-render", action="store_true")
parser.add_argument("--no-kill",   action="store_true",
                    help="do not stop older preview.py instances first")
args = parser.parse_args()

# ── Stop older instances ──────────────────────────────────────────────────────
#
# A running preview server has docs/ as its working directory. On Windows that
# keeps a handle on the folder, so `quarto render --profile root` — the only
# profile that writes straight into docs/ — fails with
#   "os error 32 ... remove '...\docs'".
# Two servers on the same port would collide as well, so any older instance is
# stopped before we render or bind.

SELF_PID = os.getpid()
SCRIPT   = os.path.basename(os.path.abspath(__file__))


def _run(cmd):
    """Run a command, return stdout as text ('' if the command is unavailable)."""
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=20)
    except (OSError, subprocess.SubprocessError):
        return ""
    return result.stdout or ""


def _powershell(script):
    for exe in ("powershell", "pwsh"):
        out = _run([exe, "-NoProfile", "-Command", script])
        if out:
            return out
    return ""


def _ints(text):
    return {int(word) for word in text.split() if word.isdigit()}


def _pids_of_other_instances():
    """PIDs of other Python processes running this script."""
    if os.name == "nt":
        out = _powershell(
            "Get-CimInstance Win32_Process | Where-Object { "
            f"$_.Name -like 'python*' -and $_.CommandLine -like '*{SCRIPT}*' "
            "} | ForEach-Object { $_.ProcessId }"
        )
    else:
        out = _run(["pgrep", "-f", rf"python.*{re.escape(SCRIPT)}"])
    return _ints(out) - {SELF_PID}


def _pids_on_port(port):
    """PIDs listening on the given TCP port."""
    if os.name == "nt":
        out = _powershell(
            f"Get-NetTCPConnection -LocalPort {port} -State Listen "
            "-ErrorAction SilentlyContinue | ForEach-Object { $_.OwningProcess }"
        )
        if not out:
            # Fallback without Get-NetTCPConnection: parse netstat. The state
            # column is localised, so match on the local-address column only.
            out = "\n".join(
                parts[-1]
                for parts in (line.split() for line in _run(["netstat", "-ano"]).splitlines())
                if len(parts) >= 4 and parts[1].endswith(f":{port}")
            )
    else:
        out = _run(["lsof", "-ti", f"tcp:{port}"])
    return _ints(out) - {SELF_PID}


def _is_python(pid):
    """True if the PID belongs to a Python process — we kill nothing else."""
    if os.name == "nt":
        out = _run(["tasklist", "/FI", f"PID eq {pid}", "/FO", "CSV", "/NH"])
    else:
        out = _run(["ps", "-p", str(pid), "-o", "comm="])
    return "python" in out.lower()


def _kill(pid):
    if os.name == "nt":
        _run(["taskkill", "/PID", str(pid), "/F"])
    else:
        for sig in (signal.SIGTERM, signal.SIGKILL):
            try:
                os.kill(pid, sig)
            except ProcessLookupError:
                return
            time.sleep(0.5)


def stop_stale_instances(port):
    """Kill older preview.py instances and any Python process holding the port."""
    stale = _pids_of_other_instances()
    for pid in _pids_on_port(port):
        # Never kill an unrelated program that happens to use the port.
        if _is_python(pid):
            stale.add(pid)
        else:
            print(f"  ⚠  Port {port} is used by PID {pid}, which is not a Python "
                  f"process — leaving it alone.")

    if not stale:
        return

    for pid in sorted(stale):
        print(f"  ↯  Stopping older instance (PID {pid}) …")
        _kill(pid)

    # Windows needs a moment to release the handle on docs/.
    for _ in range(20):
        time.sleep(0.25)
        if not (stale & (_pids_of_other_instances() | _pids_on_port(port))):
            print("  ✓  Older instances stopped.\n")
            return
    print("  ⚠  Some processes could not be stopped — close them manually.\n")


if not args.no_kill:
    stop_stale_instances(args.port)

# ── Render ────────────────────────────────────────────────────────────────────

if not args.no_render:
    print("Rendering Quarto profiles...\n")
    for profile in PROFILES:
        print(f"  → quarto render --profile {profile}")
        result = subprocess.run(
            ["quarto", "render", "--profile", profile],
            cwd=os.path.dirname(os.path.abspath(__file__))
        )
        if result.returncode != 0:
            print(f"    ⚠  Profile '{profile}' failed — skipping.\n")
        else:
            print(f"    ✓  Done.\n")

# ── Fix cross-profile navbar links ────────────────────────────────────────────

def fix_cross_profile_links(docs_dir, profiles):
    """
    Quarto converts all navbar hrefs to relative paths (e.g. ./int/...).
    This breaks cross-profile links on subpages. We rewrite them so they
    navigate correctly relative to each file's depth in the output tree.
    """
    # Match any relative prefix (./  ../  ../../  etc.) followed by a profile name.
    # Quarto generates different depths depending on where the source .qmd lives.
    profile_pattern = re.compile(
        r'href="(?:\.\.?/)*(' + '|'.join(profiles) + r')/(.*?)"'
    )
    docs_path = os.path.abspath(docs_dir)
    fixed = 0

    for profile in profiles:
        profile_dir = os.path.join(docs_path, profile)
        if not os.path.isdir(profile_dir):
            continue
        for dirpath, _, filenames in os.walk(profile_dir):
            for filename in filenames:
                if not filename.endswith('.html'):
                    continue
                html_file = os.path.join(dirpath, filename)
                rel = os.path.relpath(html_file, docs_path)
                # depth = number of directories between docs/ and the file
                depth = len(rel.replace('\\', '/').split('/')) - 1
                prefix = '../' * depth

                def make_replacement(prefix):
                    def replacement(m):
                        return f'href="{prefix}{m.group(1)}/{m.group(2)}"'
                    return replacement

                with open(html_file, encoding='utf-8') as f:
                    content = f.read()
                new_content = profile_pattern.sub(make_replacement(prefix), content)
                if new_content != content:
                    with open(html_file, 'w', encoding='utf-8') as f:
                        f.write(new_content)
                    fixed += 1

    print(f"  ✓  Fixed cross-profile links in {fixed} HTML file(s).\n")

def fix_root_absolute_paths(docs_dir):
    """
    Quarto renders root-profile pages (docs/*.html) with absolute paths like
    /site_libs/... and /index.html. These break when opened as file:// or on
    a GitHub Pages project page (where the site lives at /repo-name/, not /).
    Rewrite all root-relative paths to explicit relative paths (./...).
    """
    docs_path = os.path.abspath(docs_dir)
    # Matches src=, href=, or content= with a root-absolute path /foo but not //foo
    abs_re = re.compile(r'((?:src|href|content)=")(/(?!/)[^"]*")')
    fixed = 0

    for filename in os.listdir(docs_path):
        if not filename.endswith('.html'):
            continue
        html_file = os.path.join(docs_path, filename)
        with open(html_file, encoding='utf-8') as f:
            content = f.read()
        new_content = abs_re.sub(r'\1.\2', content)
        if new_content != content:
            with open(html_file, 'w', encoding='utf-8') as f:
                f.write(new_content)
            fixed += 1

    print(f"  ✓  Fixed absolute paths in {fixed} root HTML file(s).\n")

if not args.no_render:
    docs_abs = os.path.join(os.path.dirname(os.path.abspath(__file__)), DOCS_DIR)
    fix_cross_profile_links(docs_abs, PROFILES)
    fix_root_absolute_paths(docs_abs)

# ── Serve ─────────────────────────────────────────────────────────────────────

docs_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), DOCS_DIR)

if not os.path.isdir(docs_path):
    print(f"Error: '{DOCS_DIR}/' not found. Run without --no-render first.")
    sys.exit(1)

class QuietHandler(http.server.SimpleHTTPRequestHandler):
    """SimpleHTTPRequestHandler with request logging suppressed."""
    def log_message(self, *_):
        pass
    def log_request(self, *_):
        pass

os.chdir(docs_path)
httpd = http.server.HTTPServer(("", args.port), QuietHandler)

url = f"http://localhost:{args.port}/{START_PAGE}"
print(f"Serving at  {url}")
print("Press Ctrl+C to stop.\n")

threading.Timer(0.5, lambda: webbrowser.open(url)).start()

try:
    httpd.serve_forever()
except KeyboardInterrupt:
    print("\nServer stopped.")
