// Run after `npm run build` with the installed Electron executable.
const { app, BrowserWindow } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

app.whenReady().then(async () => {
  let server;
  let win;
  try {
    const dist = path.resolve(__dirname, '../dist');
    const mode = { id: 'plugin:sample:creative', pluginId: 'sample', name: 'Creative', baseMode: 'chat',
      theme: { accent: '#aabbcc', background: '#101020', surface: '#202030', text: '#ffffff' },
      welcome: { type: 'card-list', title: 'Choose a starter', description: 'Choose one to begin.',
        items: [{ id: 'first', label: 'First card', description: 'A useful starter.', message: 'Hello from the starter' }] } };
    let saved = null;
    let sent = null;
    server = http.createServer(async (req, res) => {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      const json = (value) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
      if (pathname === '/seed') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end(`<script>localStorage.setItem('ai-chat:sessionToken','test');localStorage.setItem('ai-chat:userProfile',JSON.stringify({id:'user',name:'User',color:'#ffffff'}));location.href='/';</script>`);
      }
      if (pathname === '/api/health') return json({ status: 'ok' });
      if (pathname === '/api/auth/me') return json({ authenticated: true, user: { id: 'user', username: 'User', color: '#ffffff' } });
      if (pathname === '/api/models') return json({ models: [{ name: 'test-model', supportsThinking: true }] });
      if (pathname === '/api/settings') return json({ modelAssignments: { chat: 'test-model' } });
      if (pathname === '/api/memory') return json({ enabled: false, categories: {}, updatedAt: 0 });
      if (pathname === '/api/plugins/modes') return json({ modes: [mode] });
      if (pathname === '/api/conversations') return json({ conversations: saved ? [saved] : [] });
      if (pathname === '/api/conversations/conv-1') return json({ conversation: saved });
      if (pathname === '/api/chat' && req.method === 'POST') {
        const parts = [];
        for await (const chunk of req) parts.push(chunk);
        sent = JSON.parse(Buffer.concat(parts).toString());
        saved = { id: 'conv-1', title: 'Starter chat', mode: 'chat', pluginModeId: sent.pluginModeId,
          model: sent.model, ownerId: 'user', messages: [{ role: 'user', content: sent.messages.at(-1).content },
            { role: 'assistant', content: 'A response' }], createdAt: Date.now(), updatedAt: Date.now() };
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        for (const event of [{ type: 'conversationId', conversationId: 'conv-1' }, { type: 'chunk', content: 'A response' }, { type: 'done' }]) res.write(`data: ${JSON.stringify(event)}\n\n`);
        return res.end();
      }
      if (pathname.startsWith('/api/')) return json({});
      const file = pathname === '/' ? path.join(dist, 'index.html') : path.join(dist, pathname);
      const ext = path.extname(file);
      res.writeHead(200, { 'Content-Type': ext === '.js' ? 'text/javascript' : ext === '.css' ? 'text/css' : 'text/html' });
      return res.end(fs.readFileSync(file));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    win = new BrowserWindow({ show: false, width: 1000, height: 700, webPreferences: { backgroundThrottling: false } });
    await win.loadURL(`http://127.0.0.1:${server.address().port}/seed`);
    const waitFor = async (expression) => {
      for (let i = 0; i < 80; i++) {
        try { if (await win.webContents.executeJavaScript(expression)) return; } catch { /* navigation in progress */ }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(`Timed out waiting for ${expression}`);
    };
    await waitFor(`[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Creative')`);
    await win.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Creative').click()`);
    await waitFor(`document.body.textContent.includes('Choose a starter') && document.body.textContent.includes('First card')`);
    assert(await win.webContents.executeJavaScript(`!!document.querySelector('.plugin-mode')`));
    assert.strictEqual(await win.webContents.executeJavaScript(`getComputedStyle(document.querySelector('.plugin-mode')).backgroundColor`), 'rgb(16, 16, 32)');
    await win.webContents.executeJavaScript(`[...document.querySelectorAll('.plugin-card button')].find(b => b.textContent.trim() === 'Start').click()`);
    await waitFor(`document.body.textContent.includes('A response')`);
    assert.strictEqual(sent.pluginModeId, mode.id);
    assert.strictEqual(sent.pluginItemId, 'first');
    assert.strictEqual(sent.mode, 'chat');
    assert.strictEqual(sent.messages.at(-1).content, 'Hello from the starter');
    await waitFor(`document.body.textContent.includes('Starter chat')`);
    await win.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Chat').click()`);
    await waitFor(`!document.querySelector('.plugin-mode')`);
    await win.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Creative').click()`);
    await waitFor(`document.body.textContent.includes('Starter chat')`);
    await win.webContents.executeJavaScript(`[...document.querySelectorAll('span')].find(el => el.textContent.trim() === 'Starter chat').click()`);
    await waitFor(`document.body.textContent.includes('A response')`);
    console.log('UI plugin Electron smoke test passed');
    win.destroy(); server.close(); app.exit(0);
  } catch (error) {
    console.error(error);
    if (win && !win.isDestroyed()) win.destroy();
    if (server) server.close();
    app.exit(1);
  }
}).catch((error) => { console.error(error); app.exit(1); });
