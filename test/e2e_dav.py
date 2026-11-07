import asyncio, os
from playwright.async_api import async_playwright
F='/tmp/davroot/home/Drive/Commun/Factures/Devis client é.pdf'
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist'])
        pg = await b.new_page(viewport={'width':1220,'height':800})
        await pg.goto('http://localhost:9000/')
        app = pg.frame_locator('#w')
        await app.locator('#wait.hide').wait_for(state='attached', timeout=120000)
        await app.locator('[data-src^="dav:"]', has_text='Synology Drive').click()
        await app.locator('[data-dir="Commun"]').click()
        await app.locator('[data-dir="Commun/Factures"]').click()
        await app.locator('[data-file="Commun/Factures/Devis client é.pdf"]').click()
        await asyncio.sleep(6)
        before = os.path.getmtime(F)
        await asyncio.sleep(1.1)
        await pg.frame_locator('#w').frame_locator('#engine').locator('canvas').click(position={'x':600,'y':400})
        await pg.keyboard.press('Control+s')
        await asyncio.sleep(4)
        print('enregistré sur le WebDAV :', os.path.getmtime(F) != before)
        print('notes :', await pg.evaluate('window.notes'))
        await pg.screenshot(path='/home/claude/desktroo-pdf/test/dav.png')
        await b.close()
asyncio.run(main())
