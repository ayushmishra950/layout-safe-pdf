#!/usr/bin/env node
// HTTP API for the resume generator (no dependencies).
//
//   node resume/server.js              -> http://localhost:3001
//
// POST /resume            body: resume JSON (see resume/README.md)
//   -> the PDF itself (Content-Type: application/pdf); warnings in the X-Resume-Warnings header
// POST /resume?format=json -> { pdf: "<base64>", pages, layout, warnings }
// GET  /health

import http from 'node:http';
import { buildResume } from './index.js';

const PORT = Number(process.env.PORT || 3001);
const MAX_BODY = 1024 * 1024; // 1 MB of JSON is far more than any resume

const send = (res, status, obj) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { status: 'ok' });
  if (req.method !== 'POST' || url.pathname !== '/resume') return send(res, 404, { error: 'POST /resume' });
  try {
    let data;
    try { data = JSON.parse(await readBody(req)); } catch (e) { if (e.status) throw e; return send(res, 400, { error: 'body must be valid JSON' }); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return send(res, 400, { error: 'body must be a JSON object' });
    const r = buildResume(data);
    if (url.searchParams.get('format') === 'json') {
      return send(res, 200, { pdf: r.pdf.toString('base64'), pages: r.pages, layout: r.layout, warnings: r.warnings });
    }
    const file = `${String(data.name).replace(/[^\w.-]+/g, '_')}_Resume.pdf`;
    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Length': r.pdf.length,
      'Content-Disposition': `inline; filename="${file}"`,
      'X-Resume-Pages': String(r.pages),
      'X-Resume-Layout': r.layout,
      'X-Resume-Warnings': encodeURIComponent(JSON.stringify(r.warnings)),
    });
    res.end(r.pdf);
  } catch (err) {
    send(res, err.status || 422, { error: err.message });
  }
});

server.listen(PORT, () => console.log(`resume API on http://localhost:${PORT}  (POST /resume)`));
