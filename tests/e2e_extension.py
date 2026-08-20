"""True MV3 unpacked-extension E2E.

Requires Playwright's bundled Chromium (`python -m playwright install chromium`).
The test copies the production extension to a temp dir, adds localhost only to
that temp manifest, and makes the temp background fetch fail immediately so the
production bundled-data fallback is exercised deterministically.
"""
from pathlib import Path
from playwright.sync_api import sync_playwright, Error as PlaywrightError
import json, os, shutil, tempfile, threading, http.server, socketserver, re, sys

ROOT = Path(__file__).resolve().parents[1]

# Fixture names are derived from the exact bundled data rather than hard-coded
# CSS selectors, just like the production roll detector.
text = (ROOT / 'data/players.js').read_text(encoding='utf8')
players = json.loads(re.search(r'self\.PLAYERS\s*=\s*(\[.*\])\s*;\s*$', text, re.S).group(1))
def names(team, era, n=10):
    return [p['player'] for p in players if p.get('team') == team and p.get('era') == era][:n]
def fixture(team, era):
    return '<!doctype html><html><body><main id="game"><div>%s</div>%s</main></body></html>' % (
        era, ''.join('<button class="player">%s</button>' % n for n in names(team, era)))

build = Path(tempfile.mkdtemp(prefix='82-0-ext-build-'))
for path in ROOT.iterdir():
    if path.name in {'.git', 'tests'}: continue
    if path.is_dir(): shutil.copytree(path, build / path.name)
    else: shutil.copy2(path, build / path.name)

manifest = json.loads((build / 'manifest.json').read_text())
manifest['host_permissions'].append('http://127.0.0.1/*')
manifest['content_scripts'][0]['matches'].append('http://127.0.0.1/*')
(build / 'manifest.json').write_text(json.dumps(manifest, indent=2))

# Deterministically exercise the production offline fallback without depending
# on CI internet access. Only the test copy is modified.
bg = (build / 'background.js').read_text()
bg = bg.replace(
    '"https://firebasestorage.googleapis.com/v0/b/" +\n  "project-4599904239656435772.firebasestorage.app/o/" +\n  "players_flat.json?alt=media"',
    '"http://127.0.0.1:1/unreachable"'
)
(build / 'background.js').write_text(bg)
(build / 'fixture.html').write_text(fixture('WAS', '2020s'))

class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args): pass

cwd = os.getcwd(); os.chdir(build)
server = socketserver.TCPServer(('127.0.0.1', 0), Quiet)
port = server.server_address[1]
threading.Thread(target=server.serve_forever, daemon=True).start()

try:
    with sync_playwright() as p:
        # Intentionally do NOT use a branded/system Chrome executable. Playwright
        # Chromium retains the extension flags that recent branded Chrome removes.
        try:
            ctx = p.chromium.launch_persistent_context(
                tempfile.mkdtemp(prefix='82-0-ext-profile-'),
                headless=True,
                args=[f'--disable-extensions-except={build}', f'--load-extension={build}', '--no-sandbox'],
                timeout=30000,
            )
        except PlaywrightError as e:
            if 'executable doesn\'t exist' in str(e).lower():
                print('SKIP e2e_extension: install Playwright Chromium first')
                sys.exit(0)
            raise

        page = ctx.new_page()
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto(f'http://127.0.0.1:{port}/fixture.html', wait_until='load')
        panel = page.locator('#draft-helper-panel')
        panel.wait_for(state='visible', timeout=20000)
        page.wait_for_function(
            "document.querySelector('#draft-helper-panel')?.textContent.includes('Projected 82-0 path')",
            timeout=45000,
        )
        t = panel.inner_text()
        assert 'Washington Wizards' in t and 'Russell Westbrook' in t and 'No-skips AI' in t, t
        assert len(ctx.service_workers) >= 1, 'MV3 service worker did not start'

        panel.locator('.dh-add').first.click()
        page.wait_for_function(
            "document.querySelector('#draft-helper-panel')?.textContent.includes('PG Russell Westbrook')",
            timeout=10000,
        )
        page.locator('#game').evaluate('(el, html) => el.innerHTML = html', fixture('DET','2000s').split('<main id="game">')[1].split('</main>')[0])
        page.wait_for_function(
            "document.querySelector('#draft-helper-panel')?.textContent.includes('Detroit Pistons')",
            timeout=15000,
        )
        assert not errors, errors
        ctx.close()
        print('PASS e2e_extension')
finally:
    server.shutdown(); os.chdir(cwd); shutil.rmtree(build, ignore_errors=True)
