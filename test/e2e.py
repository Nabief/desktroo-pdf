import asyncio, os, time
from playwright.async_api import async_playwright
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist'])
        pg = await b.new_page(viewport={'width':1220,'height':800})
        logs=[]
        pg.on('console', lambda m: logs.append(m.text))
        await pg.goto('http://localhost:9000/')
        app = pg.frame_locator('#w')
        await app.locator('[data-file="Facture test.pdf"]').wait_for(timeout=20000)
        # attendre l'éditeur prêt (le voile disparaît)
        await app.locator('#wait.hide').wait_for(state='attached', timeout=120000)
        print('editeur pret')
        await app.locator('[data-file="Facture test.pdf"]').click()
        await asyncio.sleep(6)
        await pg.screenshot(path='/home/claude/desktroo-pdf/test/open.png')
        before = os.path.getmtime('/nas/Documents/Facture test.pdf')
        # Ctrl+S dans l'éditeur
        eng = pg.frame_locator('#w').frame_locator('#engine')
        await eng.locator('canvas').click(position={'x':600,'y':400})
        await pg.keyboard.press('Control+s')
        await asyncio.sleep(4)
        await pg.screenshot(path='/home/claude/desktroo-pdf/test/save.png')
        after = os.path.getmtime('/nas/Documents/Facture test.pdf')
        print('enregistre:', after != before)
        print('notes:', await pg.evaluate('window.notes'))
        print('\n'.join(l for l in logs if 'pdf' in l.lower() or 'error' in l.lower())[:2000])
        await b.close()
asyncio.run(main())
