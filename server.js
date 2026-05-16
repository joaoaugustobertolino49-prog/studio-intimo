const express = require('express');
const multer  = require('multer');
const cors    = require('cors');
const path    = require('path');

const app    = express();
const upload = multer({ limits: { fileSize: 15 * 1024 * 1024 } });

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

async function uploadToFalStorage(buffer, mimetype, filename, falKey) {
  const initResp = await fetch('https://rest.alpha.fal.ai/storage/upload/initiate', {
    method: 'POST',
    headers: { 'Authorization': `Key ${falKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ file_name: filename || 'photo.jpg', content_type: mimetype }),
  });
  if (!initResp.ok) {
    const e = await initResp.json().catch(() => ({}));
    throw new Error('Erro upload fal.ai: ' + (e.detail || initResp.status));
  }
  const { upload_url, file_url } = await initResp.json();
  const put = await fetch(upload_url, {
    method: 'PUT', headers: { 'Content-Type': mimetype }, body: buffer,
  });
  if (!put.ok) throw new Error('Erro PUT fal.ai: ' + put.status);
  return file_url;
}

app.post('/api/upload', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Nenhuma imagem enviada.' });
    const falKey = req.headers['x-fal-key'];
    if (!falKey) return res.status(400).json({ error: 'x-fal-key necessário para upload.' });
    const url = await uploadToFalStorage(req.file.buffer, req.file.mimetype, req.file.originalname, falKey);
    console.log('[UPLOAD OK]', url.substring(0, 80));
    res.json({ url });
  } catch (err) {
    console.error('[UPLOAD ERROR]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/generate', async (req, res) => {
  try {
    const polloKey = req.headers['x-api-key'];
    if (!polloKey) return res.status(401).json({ error: 'Chave Pollo não fornecida.' });

    const { image_url, prompt } = req.body;
    if (!image_url || !prompt) return res.status(400).json({ error: 'image_url e prompt obrigatórios.' });

    // Pollo 1.6 Image-to-Video aceita APENAS estes campos:
    // image, imageTail, prompt, resolution, length, seed
    // NÃO aceita: mode, aspectRatio, ou qualquer outro campo
    // Prompt máximo: 1000 caracteres
    const truncatedPrompt = prompt.substring(0, 990);

    const body = {
      input: {
        image:      image_url,
        prompt:     truncatedPrompt,
        resolution: '480p',
        length:     5,
      }
    };

    console.log('[GENERATE] image_url:', image_url.substring(0, 80));
    console.log('[GENERATE] prompt length:', truncatedPrompt.length);
    console.log('[GENERATE] body:', JSON.stringify(body).substring(0, 200));

    const resp = await fetch('https://pollo.ai/api/platform/generation/pollo/pollo-v1-6', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': polloKey },
      body:    JSON.stringify(body),
    });

    const raw = await resp.text();
    console.log('[POLLO STATUS]', resp.status);
    console.log('[POLLO BODY]', raw.substring(0, 400));

    if (!resp.ok) {
      let msg = `Erro Pollo ${resp.status}`;
      try {
        const e = JSON.parse(raw);
        // Mostrar issues detalhados se existirem
        if (e.issues?.length) msg = e.issues.map(i => i.message).join(' | ');
        else msg = e.message || e.error || msg;
      } catch(_) { msg = raw.substring(0, 300); }
      if (resp.status === 401) return res.status(401).json({ error: 'Chave Pollo inválida ou sem créditos.' });
      return res.status(resp.status).json({ error: msg });
    }

    const data = JSON.parse(raw);
    const taskId = data?.taskId;
    if (!taskId) return res.status(500).json({ error: 'taskId não retornado: ' + raw.substring(0, 150) });

    console.log('[GENERATE OK] taskId:', taskId);
    res.json({ taskId });

  } catch (err) {
    console.error('[GENERATE ERROR]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/status/:taskId', async (req, res) => {
  try {
    const polloKey = req.headers['x-api-key'];
    if (!polloKey) return res.status(401).json({ error: 'Chave não fornecida.' });
    const resp = await fetch(`https://pollo.ai/api/platform/generation/${req.params.taskId}/status`, {
      headers: { 'x-api-key': polloKey },
    });
    const raw = await resp.text();
    if (!resp.ok) {
      let msg = `Erro ${resp.status}`;
      try { const e = JSON.parse(raw); msg = e.message || msg; } catch(_) {}
      return res.status(resp.status).json({ error: msg });
    }
    const data = JSON.parse(raw);
    const gen  = data?.generations?.[0];
    if (!gen) return res.json({ status: 'processing' });
    console.log('[STATUS]', req.params.taskId, '-', gen.status);
    res.json({ status: gen.status, url: gen.url || null, mediaType: gen.mediaType || null, failMsg: gen.failMsg || null });
  } catch (err) {
    console.error('[STATUS ERROR]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/credits', async (req, res) => {
  try {
    const key = req.headers['x-api-key'];
    if (!key) return res.status(401).json({ error: 'Chave não fornecida.' });
    const r = await fetch('https://pollo.ai/api/platform/credits/balance', { headers: { 'x-api-key': key } });
    const valid = r.status !== 401;
    let credits = null;
    if (valid) { try { const d = await r.json(); credits = d?.balance ?? d?.credits ?? null; } catch(_) {} }
    res.json({ valid, credits });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Studio rodando na porta ${PORT}`));
