from playwright.sync_api import sync_playwright
from pathlib import Path
import json, re, tempfile, os, sys

ROOT=Path(__file__).resolve().parents[1]
text=(ROOT/'data/players.js').read_text(encoding='utf8')
players=json.loads(re.search(r'self\.PLAYERS\s*=\s*(\[.*\])\s*;\s*$',text,re.S).group(1))

def names(team, era, n=8):
    return [p['player'] for p in players if p.get('team')==team and p.get('era')==era][:n]

def fixture(team, era):
    return '<div class="decade">%s</div>%s' % (era, ''.join('<button class="player">%s</button>' % n for n in names(team,era)))

with sync_playwright() as p:
    launch = {
        'user_data_dir': tempfile.mkdtemp(prefix='ezo-ui-'),
        'headless': True,
        'args': ['--no-sandbox','--disable-gpu','--no-first-run','--disable-dev-shm-usage'],
        'timeout': 20000,
    }
    chromium_path = os.environ.get('CHROMIUM_EXECUTABLE')
    if not chromium_path and Path('/usr/bin/chromium').exists(): chromium_path = '/usr/bin/chromium'
    if chromium_path: launch['executable_path'] = chromium_path
    ctx=p.chromium.launch_persistent_context(**launch)
    page=ctx.new_page()
    errors=[]
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.set_content('<!doctype html><html><body><main id="game"></main></body></html>')
    page.locator('#game').evaluate('(el, html)=>el.innerHTML=html', fixture('WAS','2020s'))

    # Load exact app math/data modules in a real Chromium renderer.
    page.add_style_tag(path=str(ROOT/'content.css'))
    page.add_script_tag(path=str(ROOT/'data/players.js'))
    page.add_script_tag(path=str(ROOT/'solver-core.js'))
    page.add_script_tag(path=str(ROOT/'probability-core.js'))

    page.evaluate('''() => {
      window.__settings = {strategyMode:'no_skips', simulations:50, teamSkipAvailable:true, decadeSkipAvailable:true};
      window.__storageListeners = [];
      window.__runtimeListeners = [];
      window.__forceSolveError = false;
      ProbabilityEngine.init(self.PLAYERS.filter(p => p.era !== '1950s'));

      const mockChrome = {
        storage: {
          local: {
            get: (key, cb) => setTimeout(() => cb({settings: window.__settings}), 0),
            set: (obj, cb) => { if (obj.settings) window.__settings = obj.settings; if (cb) cb(); }
          },
          onChanged: { addListener: fn => window.__storageListeners.push(fn) }
        },
        runtime: {
          lastError: null,
          onMessage: { addListener: fn => window.__runtimeListeners.push(fn) },
          sendMessage: (msg, cb) => {
            if (msg.type === 'GET_PLAYERS') {
              setTimeout(() => cb({players:self.PLAYERS, source:'bundled'}), 0);
              return;
            }
            if (msg.type === 'SOLVE_PATHS') {
              setTimeout(() => {
                if (window.__forceSolveError) cb({error:'forced solver failure'});
                else cb({result: ProbabilityEngine.solve(msg.request)});
              }, 0);
              return;
            }
            setTimeout(() => cb && cb({}), 0);
          },
          getURL: p => p
        }
      };
      try { Object.defineProperty(window, 'chrome', {value:mockChrome, configurable:true}); }
      catch (e) { window.chrome = mockChrome; }
      window.__setSettings = patch => {
        window.__settings = Object.assign({}, window.__settings, patch);
        window.__storageListeners.forEach(fn => fn({settings:{newValue:window.__settings}}, 'local'));
      };
    }''')

    page.add_script_tag(path=str(ROOT/'content.js'))

    panel=page.locator('#draft-helper-panel')
    panel.wait_for(state='visible', timeout=10000)
    
    page.wait_for_function("() => document.querySelector('#draft-helper-panel')?.textContent.includes('Projected 82-0 path')", timeout=15000)
    t=panel.inner_text()
    assert 'Washington Wizards' in t and '2020s' in t, t
    assert 'Russell Westbrook' in t, t
    assert 'No-skips AI' in t, t
    assert '82-0' in t, t

    # Exercise the user-facing Add button and roster update.
    panel.locator('.dh-add').first.click()
    page.wait_for_timeout(150)
    t=panel.inner_text()
    assert 'PG Russell Westbrook' in t, t

    # Exercise Next.js-like in-place roll mutation and second-roll detection.
    page.locator('#game').evaluate('(el, html)=>el.innerHTML=html', fixture('DET','2000s'))
    page.wait_for_function("() => document.querySelector('#draft-helper-panel')?.innerText.includes('Detroit Pistons')", timeout=10000)
    page.wait_for_function("() => document.querySelector('#draft-helper-panel')?.textContent.includes('Projected 82-0 path')", timeout=15000)
    t=panel.inner_text()
    assert 'Detroit Pistons' in t and 'PG Russell Westbrook' in t, t

    # Switch to skip comparison and ensure skip rows render.
    page.evaluate("window.__setSettings({strategyMode:'compare_skips'})")
    page.wait_for_function("() => document.querySelector('#draft-helper-panel')?.textContent.includes('Immediate skip comparison')", timeout=15000)
    t=panel.inner_text()
    assert ('Team skip' in t or 'Decade skip' in t), t

    # Failure isolation: force the AI path solver to fail on the next roll. The
    # base helper must remain visible and show OVR fallback recommendations.
    page.evaluate('window.__forceSolveError = true')
    page.locator('#game').evaluate('(el, html)=>el.innerHTML=html', fixture('UTA','2020s'))
    page.wait_for_function("() => document.querySelector('#draft-helper-panel')?.innerText.includes('Utah Jazz')", timeout=10000)
    page.wait_for_function("() => document.querySelector('#draft-helper-panel')?.textContent.includes('forced solver failure')", timeout=10000)
    t=panel.inner_text()
    assert 'best current ovr' in t.lower(), t
    assert 'roster' in t.lower() and 'PG Russell Westbrook' in t, t

    page.screenshot(path='/mnt/data/82-0-e2e-ui.png', full_page=True)
    assert not errors, errors
    print('E2E UI PASS')
    print('Final panel:\n'+t)
    ctx.close()
