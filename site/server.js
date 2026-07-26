#!/usr/bin/env node
/* Zero-dependency static server for the Foldview site.
   Usage: npm run dev -- --port 7100 --host 127.0.0.1 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const root = __dirname;
const argv = process.argv.slice(2);

function argValue(name) {
  const flag = '--' + name;
  const index = argv.findIndex((a) => a === flag || a.startsWith(flag + '='));
  if (index === -1) return null;
  const arg = argv[index];
  return arg.includes('=') ? arg.split('=')[1] : argv[index + 1];
}

const port = Number(process.env.PORT || argValue('port') || argv[0] || 7100);
const host = process.env.HOST || argValue('host') || '127.0.0.1';

const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

http.createServer((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400);
    return res.end('Bad request');
  }
  let file = path.normalize(path.join(root, urlPath));
  if (!file.startsWith(root)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  if (urlPath.endsWith('/')) file = path.join(file, 'index.html');
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404);
      return res.end('Not found');
    }
    res.writeHead(200, {
      'Content-Type': types[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    fs.createReadStream(file).pipe(res);
  });
}).listen(port, host, () => {
  console.log(`foldview site → http://${host}:${port}/`);
});
