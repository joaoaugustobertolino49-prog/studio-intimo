const express = require('express');
const multer  = require('multer');
const cors    = require('cors');
const path    = require('path');

const app    = express();
const upload = multer({ limits: { fileSize: 15 * 1024 * 1024 } });

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Upload foto para fal.ai storage
async function uploadToFal(buffer, mimetype, filename, falKey) {
  const init = await fetch('https://rest.alpha.fal.ai/storage/upload/initiate', {
    method: 'POST',
    headers: { 'Authorization': 'Key ' + falKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ file_name: filename || 'photo.jpg', content_type: mimetype }),
  });
  if (!init.ok) {
    const e = await init.json().catch(() => ({}));
    throw new Error('fal upload error: ' + (e.detail || init.status));
  }
  const { upload_url, file_url } = await init.json();
  const put = await fetch(upload_url, {
    method: 'PUT', headers: { 'Content-Type': mimetype }, body: buffer,
  });
  if (!put.ok) throw new Error('fal PUT error: ' + put.status);
  return file_url;
}

// Upload - chaves vem no body (FormData)
app.post('/api/upload', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image.' });
    const falKey = req.body.falKey;
    if (!falKey) return res.status(400).json({ error: 'falKey required in form data.' });
    const url = await uploadToFal(req.file.buffer, req.file.mimetype, req.file.originalname, falKey);
    console.log('[UPLOAD OK]', url.substring(0, 80));
    res.json({ url });
  } catch (err) {
    console.error('[UPLOAD ERROR]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Gerar - chave vem no body JSON
app.post('/api/generate', async (req, res) => {
  try {
    const { polloKey, image_url, prompt } = req.body;
    if (!polloKey) return res.status(401).json({ error: 'polloKey missing.' });
    if (!image_url || !prompt) return res.status(400).json({ error: 'image_url and prompt required.' });

    const body = {
      input: {
        image:      image_url,
        prompt:     prompt.substring(0, 990),
        resolution: '480p',
        length:     5,
      }
    };

    console.log('[GENERATE] url:', image_url.substring(0, 80));
    console.log('[GENERATE] prompt len:', body.input.prompt.length);

    const resp = await fetch('https://pollo.ai/api/platform/generation/pollo/pollo-v1-6', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': polloKey },
      body:    JSON.stringify(body),
    });

    const raw = await resp.text();
    console.log('[POLLO STATUS]', resp.status);
    console.log('[POLLO BODY]', raw.substring(0, 500));

    if (!resp.ok) {
      let msg = raw.substring(0, 400);
      try { const e = JSON.parse(raw); msg = e.message || e.error || JSON.stringify(e); } catch(_) {}
      return res.status(resp.status).json({ error: msg });
    }

    const data = JSON.parse(raw);
    const taskId = data?.taskId;
    if (!taskId) return res.status(500).json({ error: 'No taskId: ' + raw.substring(0, 150) });

    console.log('[GENERATE OK] taskId:', taskId);
    res.json({ taskId });
  } catch (err) {
    console.error('[GENERATE ERROR]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Status - chave vem no body
app.post('/api/status/:taskId', async (req, res) => {
  try {
    const { polloKey } = req.body;
    if (!polloKey) return res.status(401).json({ error: 'polloKey missing.' });

    const resp = await fetch('https://pollo.ai/api/platform/generation/' + req.params.taskId + '/status', {
      headers: { 'x-api-key': polloKey },
    });
    const raw = await resp.text();
    if (!resp.ok) {
      let msg = raw;
      try { const e = JSON.parse(raw); msg = e.message || raw; } catch(_) {}
      return res.status(resp.status).json({ error: msg });
    }
    const data = JSON.parse(raw);
    const gen  = data?.generations?.[0];
    if (!gen) return res.json({ status: 'processing' });
    console.log('[STATUS]', req.params.taskId, gen.status);
    res.json({ status: gen.status, url: gen.url || null, mediaType: gen.mediaType || null, failMsg: gen.failMsg || null });
  } catch (err) {
    console.error('[STATUS ERROR]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Creditos - chave vem no body
app.post('/api/credits', async (req, res) => {
  try {
    const { polloKey } = req.body;
    if (!polloKey) return res.status(401).json({ error: 'polloKey missing.' });
    const r = await fetch('https://pollo.ai/api/platform/credit/balance', {
      headers: { 'x-api-key': polloKey }
    });
    const raw = await r.text();
    console.log('[CREDITS] status:', r.status, 'body:', raw);
    const valid = r.status !== 401;
    let credits = null;
    if (valid) {
      try { const d = JSON.parse(raw); credits = d?.availableCredits ?? d?.balance ?? null; } catch(_) {}
    }
    res.json({ valid, credits });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log('Studio running on port ' + PORT));
