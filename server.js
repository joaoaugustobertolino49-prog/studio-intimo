const express = require('express');
const multer  = require('multer');
const cors    = require('cors');
const path    = require('path');

const app    = express();
const upload = multer({ limits: { fileSize: 15 * 1024 * 1024 } });

app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Upload foto para fal.ai storage
app.post('/api/upload', upload.single('image'), async (req, res) => {
  try {
    const key = req.headers['x-fal-key'];
    if (!key) return res.status(401).json({ error: 'Chave API não fornecida.' });

    const { buffer, mimetype, originalname } = req.file;

    const initResp = await fetch('https://rest.alpha.fal.ai/storage/upload/initiate', {
      method: 'POST',
      headers: { 'Authorization': `Key ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_name: originalname || 'photo.jpg', content_type: mimetype }),
    });

    if (!initResp.ok) {
      const e = await initResp.json().catch(() => ({}));
      return res.status(initResp.status).json({ error: e.detail || 'Erro ao iniciar upload.' });
    }

    const { upload_url, file_url } = await initResp.json();

    const putResp = await fetch(upload_url, {
      method: 'PUT',
      headers: { 'Content-Type': mimetype },
      body: buffer,
    });

    if (!putResp.ok) return res.status(500).json({ error: 'Erro ao enviar imagem.' });

    res.json({ url: file_url });
  } catch (err) {
    console.error('[UPLOAD]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Gerar ensaio com FLUX Kontext — preserva rosto e aplica o prompt
app.post('/api/generate', async (req, res) => {
  try {
    const key = req.headers['x-fal-key'];
    if (!key) return res.status(401).json({ error: 'Chave API não fornecida.' });

    const { image_url, prompt } = req.body;
    if (!image_url || !prompt) return res.status(400).json({ error: 'image_url e prompt obrigatórios.' });

    console.log('[GENERATE] Enviando para FLUX Kontext...');

    const resp = await fetch('https://fal.run/fal-ai/flux-pro/kontext', {
      method: 'POST',
      headers: { 'Authorization': `Key ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image_url,
        prompt,
        guidance_scale:    3.5,
        num_images:        1,
        safety_tolerance:  '5',
        output_format:     'jpeg',
      }),
    });

    if (!resp.ok) {
      const e = await resp.json().catch(() => ({}));
      if (resp.status === 401) return res.status(401).json({ error: 'Chave inválida ou sem créditos. Verifique em fal.ai/dashboard.' });
      return res.status(resp.status).json({ error: e.detail || e.message || `Erro fal.ai ${resp.status}` });
    }

    const data = await resp.json();
    const url  = data?.images?.[0]?.url;
    if (!url) return res.status(500).json({ error: 'Nenhuma imagem retornada pelo fal.ai.' });

    res.json({ url });
  } catch (err) {
    console.error('[GENERATE]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Verificar chave
app.get('/api/credits', async (req, res) => {
  try {
    const key = req.headers['x-fal-key'];
    if (!key) return res.status(401).json({ error: 'Chave não fornecida.' });
    const r = await fetch('https://rest.alpha.fal.ai/storage/upload/initiate', {
      method: 'POST',
      headers: { 'Authorization': `Key ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_name: 'test.txt', content_type: 'text/plain' }),
    });
    res.json({ valid: r.status !== 401 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Studio rodando na porta ${PORT}`));
