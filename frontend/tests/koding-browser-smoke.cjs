// Run with Electron: exercises the actual embedded view against a local page.
const { app, BrowserWindow } = require('electron');
const http = require('http');
const assert = require('assert');
const { installKodingBrowser, isLocalUrl } = require('../electron/koding-browser.cjs');

app.whenReady().then(async () => {
  let server;
  let win;
  let browser;
  try {
    assert(isLocalUrl('http://127.0.0.1:3000/'));
    assert(!isLocalUrl('https://example.com/'));
    assert(!isLocalUrl('http://localhost@example.com/'));
    server = http.createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end(`<!doctype html><title>Smoke test</title><input id="name"><button id="go" onclick="document.querySelector('#result').textContent = document.querySelector('#name').value; console.error('test error')">Go</button><div id="result">Waiting</div><div id="pointer-result">No pointer</div>
        <script>
          let pointerSeen = false;
          new MutationObserver(() => {
            const pointer = document.querySelector('[data-koding-ai-pointer="true"]');
            if (pointer && pointer.style.pointerEvents === 'none' && pointer.style.opacity === '0.55' && pointer.style.transition.includes('transform')) {
              pointerSeen = true;
              document.querySelector('#pointer-result').textContent = 'Animated pointer seen';
            } else if (!pointer && pointerSeen) {
              document.querySelector('#pointer-result').textContent = 'Pointer removed';
            }
          }).observe(document.documentElement, {childList:true});
        </script>`);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    win = new BrowserWindow({ show: true, x: -10000, y: -10000, opacity: 0, skipTaskbar: true, width: 900, height: 700,
      webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false, backgroundThrottling: false } });
    browser = installKodingBrowser(() => win);
    await win.loadURL('data:text/html,<html><body>test shell</body></html>');
    await win.webContents.executeJavaScript(`require('electron').ipcRenderer.on('koding-browser-event', (_event, data) => {
      if (data.type === 'open' && data.sessionId !== 'cancel-smoke') require('electron').ipcRenderer.invoke('koding-browser-bounds', data.sessionId,
        { x: 10, y: 10, width: 700, height: 500, visible: true });
    }); true;`);
    const invoke = (channel, ...args) => win.webContents.executeJavaScript(
      `require('electron').ipcRenderer.invoke(${[channel, ...args].map(JSON.stringify).join(',')})`, true,
    );
    let actionNumber = 0;
    const call = (args) => invoke('koding-browser-action', { key: `action-${++actionNumber}`, sessionId: 'smoke', conversationId: 'chat', args });
    const opened = await call({ operation: 'open', url: `http://127.0.0.1:${server.address().port}/` });
    assert(opened.ok, JSON.stringify(opened));
    const state = await invoke('koding-browser-state');
    assert(state.sessionId === 'smoke' && state.conversationId === 'chat' && state.url.includes('127.0.0.1'));
    const wrongSession = await invoke('koding-browser-action', { key: 'wrong-session', sessionId: 'other', conversationId: 'chat', args: { operation: 'inspect' } });
    assert(!wrongSession.ok);
    const otherChat = await invoke('koding-browser-action', { key: 'other-chat', sessionId: 'other', conversationId: 'other-chat', args: { operation: 'open', url: `http://127.0.0.1:${server.address().port}/` } });
    assert(!otherChat.ok && (await invoke('koding-browser-state')).sessionId === 'smoke');
    const before = await call({ operation: 'inspect' });
    assert(before.ok && before.output.includes('Smoke test') && before.output.includes('#name'), JSON.stringify(before));
    const missing = await call({ operation: 'click', selector: '#does-not-exist' });
    assert(!missing.ok && missing.error.includes('#does-not-exist') && missing.error.includes('inspect'), JSON.stringify(missing));
    const invalid = await call({ operation: 'click', selector: '[' });
    assert(!invalid.ok && invalid.error.includes('Invalid selector'), JSON.stringify(invalid));
    const typed = await call({ operation: 'type', selector: '#name', text: 'Hello Koding' });
    assert(typed.ok, JSON.stringify(typed));
    const typedPage = await call({ operation: 'inspect' });
    assert(typedPage.output.includes('Hello Koding') && typedPage.output.includes('Animated pointer seen'), JSON.stringify(typedPage));
    const cancelledClick = invoke('koding-browser-action', { key: 'cancel-click', sessionId: 'smoke', conversationId: 'chat',
      args: { operation: 'click', selector: '#go' } });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert(await invoke('koding-browser-cancel', 'cancel-click'));
    assert(!(await cancelledClick).ok);
    assert(JSON.parse((await call({ operation: 'inspect' })).output).text.includes('Waiting'));
    const clicked = await call({ operation: 'click', selector: '#go' });
    assert(clicked.ok, JSON.stringify(clicked));
    const after = await call({ operation: 'inspect' });
    assert(after.ok && JSON.parse(after.output).text.includes('Hello Koding'), JSON.stringify(after));
    await new Promise((resolve) => setTimeout(resolve, 500));
    const logs = await call({ operation: 'console' });
    assert(logs.ok && logs.output.includes('test error'), JSON.stringify(logs));
    const screenshot = await call({ operation: 'screenshot' });
    if (screenshot.ok) assert(screenshot.imageData.startsWith('data:image/jpeg;base64,'), JSON.stringify(screenshot));
    else {
      assert(String(screenshot.error).includes('surface not available'), JSON.stringify(screenshot));
      console.log('Screenshot capture skipped: no display surface for the hidden test window.');
    }
    let pointerRemoved = false;
    for (let i = 0; i < 20 && !pointerRemoved; i++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      pointerRemoved = JSON.parse((await call({ operation: 'inspect' })).output).text.includes('Pointer removed');
    }
    assert(pointerRemoved, 'The pointer should disappear after the action');
    const external = await call({ operation: 'open', url: 'https://example.com/' });
    assert(!external.ok);
    const unused = http.createServer();
    await new Promise((resolve) => unused.listen(0, '127.0.0.1', resolve));
    const unusedPort = unused.address().port;
    await new Promise((resolve) => unused.close(resolve));
    const refused = await call({ operation: 'open', url: `http://127.0.0.1:${unusedPort}/` });
    assert(!refused.ok && refused.error.includes('No server accepted') && refused.error.includes('index.html'), JSON.stringify(refused));
    const closed = await call({ operation: 'close' });
    assert(closed.ok);
    assert.strictEqual(await invoke('koding-browser-state'), null);
    const cancelled = invoke('koding-browser-action', { key: 'cancel-action', sessionId: 'cancel-smoke', conversationId: 'chat',
      args: { operation: 'open', url: `http://127.0.0.1:${server.address().port}/` } });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert(await invoke('koding-browser-cancel', 'cancel-action'));
    const cancelledResult = await cancelled;
    assert(!cancelledResult.ok && cancelledResult.error.includes('cancelled'));
    console.log('Koding browser Electron smoke test passed');
    browser.destroy();
    win.destroy();
    server.close();
    app.exit(0);
  } catch (error) {
    console.error(error);
    if (browser) browser.destroy();
    if (win && !win.isDestroyed()) win.destroy();
    if (server) server.close();
    app.exit(1);
  }
}).catch((error) => { console.error(error); app.exit(1); });
