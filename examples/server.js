#!/usr/bin/env node
// A small HTTP API around editPdf (no dependencies). Any language or frontend can call it.
//
//   node examples/server.js            -> http://localhost:3000
//
// POST /edit   (Content-Type: application/json)
//   { "pdf": "<base64 PDF>",
//     "edits": [ { "search": "Old", "replace": "New" },                                    // find & replace
//                { "search": "2024", "replace": "2026", "page": 1, "bbox": [x0,y0,x1,y1] } ], // select & replace
//     "fields": { "name": "Priyank", "agree": true },                                        // form fields
//     "password": "optional" }
//   -> { "pdf": "<base64 edited PDF>", "report": { ok, replaced, edits: [...], warnings } }
//
// POST /edit?download=1  -> same request, but the response is the edited PDF itself
//   (the report is sent in the X-Edit-Report header, URI-encoded JSON)

import http from 'node:http';
import { editPdf, getFormFields, PDFDocument, PDFPasswordError, PDFLimitError } from '../src/index.js';

const PORT = Number(process.env.PORT || 3000);
const MAX_BODY = 60 * 1024 * 1024; // 60 MB JSON (≈ 45 MB PDF)

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { status: 'ok' });
  // POST /fields  { pdf } -> list of fillable fields (to build the form UI)
  if (req.method === 'POST' && url.pathname === '/fields') {
    try {
      const body = JSON.parse(await readBody(req));
      const doc = await PDFDocument.load(Buffer.from(body.pdf || '', 'base64'), { password: body.password });
      return send(res, 200, { fields: getFormFields(doc) });
    } catch (err) {
      return send(res, err instanceof PDFPasswordError ? 401 : 422, { error: err.message });
    }
  }
  if (req.method !== 'POST' || url.pathname !== '/edit') return send(res, 404, { error: 'POST /edit' });

  try {
    const body = JSON.parse(await readBody(req));
    if (typeof body.pdf !== 'string') return send(res, 400, { error: '"pdf" (base64) is required' });
    const { pdf, report } = await editPdf(Buffer.from(body.pdf, 'base64'), body.edits || [], {
      password: body.password,
      editor: body.editor,
      fields: body.fields,
    });
    if (url.searchParams.get('download')) {
      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Disposition': 'attachment; filename="edited.pdf"',
        'X-Edit-Report': encodeURIComponent(JSON.stringify(report)),
      });
      return res.end(pdf);
    }
    return send(res, 200, { pdf: pdf.toString('base64'), report });
  } catch (err) {
    const status = err instanceof PDFPasswordError ? 401
      : err instanceof PDFLimitError ? 413
        : err instanceof SyntaxError || err instanceof TypeError ? 400 : 422;
    return send(res, status, { error: err.message });
  }
});

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('Request too large'), { name: 'PDFLimitError' }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

server.listen(PORT, () => console.log(`libr-pdf API on http://localhost:${PORT}  (POST /edit)`));
