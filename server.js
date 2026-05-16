const express = require('express');
const multer  = require('multer');
const cors    = require('cors');
const path    = require('path');

const app    = express();
const upload = multer({ limits: { fileSize: 15 * 1024 * 1024 } });

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Converte imagem para base64
function toBase64(buffer, mimetype) {
  return `data:${mimetype};base64,${buffer.toString('base64')}`;
}

// Upload da foto do usuário
app.post('/api/upload', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Nenhuma imagem enviada.' });
    const b64 = toBase64(req.file.buffer, req.file.mimetype);
    console.log(`[UPLOAD] Foto convertida, size: ${Math.round(b64.length/1024)}KB`);
    res.json({ url: b64 });
  } catch (err) {
    console.error('[UPLOAD ERROR]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Inicia geração no Pollo AI
app.post('/api/generate', async (req, res) => {
  try {
    const key = req.headers['x-api-key'];
    if (!key) return res.status(401).json({ error: 'Chave API não fornecida.' });

    const { image_base64, prompt } = req.body;
    if (!image_base64 || !prompt) {
      return res.status(400).json({ error: 'image_base64 e prompt são obrigatórios.' });
    }

    console.log('[GENERATE] Enviando para Pollo 2.0...');
    console.log('[GENERATE] Prompt:', prompt.substring(0, 80) + '...');

    const body = {
      input: {
        image:         image_base64,
        prompt:        prompt,
        generateAudio: false,
        length:        5,
        resolution:    '720p',
      }
    };

    const resp = await fetch('https://pollo.ai/api/platform/generation/pollo/pollo-v2-0', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key },
      body:    JSON.stringify(body),
    });

    const raw = await resp.text();
    console.log('[POLLO STATUS]', resp.status);
    console.log('[POLLO BODY]', raw.substring(0, 300));

    if (!resp.ok) {
      let msg = `Erro Pollo ${resp.status}`;
      try { const e = JSON.parse(raw); msg = e.message || e.error || JSON.stringify(e); } catch(_) { msg = raw.substring(0,200); }
      if (resp.status === 401) return res.status(401).json({ error: 'Chave inválida ou sem créditos. Verifique em pollo.ai/api-platform.' });
      return res.status(resp.status).json({ error: msg });
    }

    const data = JSON.parse(raw);
    const taskId = data?.taskId || data?.data?.taskId || data?.id;
    if (!taskId) {
      console.error('[POLLO] Sem taskId:', raw);
      return res.status(500).json({ error: 'taskId não retornado: ' + raw.substring(0, 150) });
    }

    console.log('[GENERATE] taskId:', taskId);
    res.json({ taskId });

  } catch (err) {
    console.error('[GENERATE ERROR]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Polling do status
app.get('/api/status/:taskId', async (req, res) => {
  try {
    const key = req.headers['x-api-key'];
    if (!key) return res.status(401).json({ error: 'Chave não fornecida.' });

    const resp = await fetch(`https://pollo.ai/api/platform/generation/${req.params.taskId}/status`, {
      headers: { 'x-api-key': key },
    });

    const raw = await resp.text();
    if (!resp.ok) {
      let msg = `Erro status ${resp.status}`;
      try { const e = JSON.parse(raw); msg = e.message || msg; } catch(_) {}
      return res.status(resp.status).json({ error: msg });
    }

    const data = JSON.parse(raw);
    const gen  = data?.generations?.[0];
    if (!gen) return res.json({ status: 'processing' });

    console.log('[STATUS]', req.params.taskId, gen.status, gen.url ? 'URL OK' : 'sem URL');

    res.json({
      status:    gen.status,
      url:       gen.url    || null,
      mediaType: gen.mediaType || null,
      failMsg:   gen.failMsg   || null,
    });
  } catch (err) {
    console.error('[STATUS ERROR]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Verificar chave
app.get('/api/credits', async (req, res) => {
  try {
    const key = req.headers['x-api-key'];
    if (!key) return res.status(401).json({ error: 'Chave não fornecida.' });
    const r = await fetch('https://pollo.ai/api/platform/credits/balance', {
      headers: { 'x-api-key': key },
    });
    const valid = r.status !== 401;
    let credits = null;
    if (valid) {
      try { const d = await r.json(); credits = d?.balance ?? d?.credits ?? null; } catch(_) {}
    }
    res.json({ valid, credits });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Studio rodando na porta ${PORT}`));
