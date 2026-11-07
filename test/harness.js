// Faux bureau Desktroo pour les essais : sert /a/pdf/ (préfixe retiré + en-têtes d'identité) et un kit minimal.
const http = require('http');
const SDK_JS = `window.desktroo={inDesktroo:true,notify:function(t,l){parent.postMessage({dk:1,type:'notify',data:{text:t,level:l}},location.origin)}};`;
http.createServer((req, res) => {
  if (req.url === '/') { res.writeHead(200, {'Content-Type':'text/html'}); return res.end(`<!doctype html><body style="margin:0"><iframe id=w src="/a/pdf/" style="width:1200px;height:780px;border:0"></iframe><script>window.notes=[];addEventListener('message',e=>{if(e.data&&e.data.type==='notify')notes.push(e.data.data.text)})</script>`); }
  if (req.url.startsWith('/a/_sdk/')) { res.writeHead(200, {'Content-Type': req.url.endsWith('.js') ? 'text/javascript' : 'text/css'}); return res.end(req.url.endsWith('.js') ? SDK_JS : ''); }
  if (req.url.startsWith('/a/pdf/')) {
    const h = Object.assign({}, req.headers, {'x-desktroo-user': 'fabien', 'x-desktroo-secret': 'test-secret'});
    const p = http.request({host:'127.0.0.1', port:8080, path: req.url.slice(6), method:req.method, headers:h}, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    return req.pipe(p);
  }
  res.writeHead(404); res.end();
}).listen(9000, () => console.log('harness 9000'));
