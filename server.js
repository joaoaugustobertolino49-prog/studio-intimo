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

// Gerar com FLUX Kontext
app.post('/api/generate', async (req, res) => {
  try {
    const key = req.headers['x-fal-key'];
    if (!key) return res.status(401).json({ error: 'Chave API não fornecida.' });

    const { image_url, prompt } = req.body;
    if (!image_url || !prompt) return res.status(400).json({ error: 'image_url e prompt obrigatórios.' });

    console.log('[GENERATE] Enviando para FLUX Kontext...');
    console.log('[PROMPT]', prompt.substring(0, 120));

    const body = {
      image_url,
      prompt,
      guidance_scale: 3.5,
      num_images:     1,
      output_format:  'jpeg',
    };

    const resp = await fetch('https://fal.run/fal-ai/flux-pro/kontext', {
      method:  'POST',
      headers: { 'Authorization': `Key ${key}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });

    const rawText = await resp.text();
    console.log('[FAL RESPONSE STATUS]', resp.status);
    console.log('[FAL RESPONSE BODY]', rawText.substring(0, 400));

    if (!resp.ok) {
      let errMsg = `Erro fal.ai ${resp.status}`;
      try {
        const e = JSON.parse(rawText);
        errMsg = e.detail || e.message || e.error || errMsg;
      } catch(_) {}
      if (resp.status === 401) return res.status(401).json({ error: 'Chave inválida ou sem créditos.' });
      return res.status(resp.status).json({ error: errMsg });
    }

    let data;
    try { data = JSON.parse(rawText); } 
    catch(_) { return res.status(500).json({ error: 'Resposta inválida do fal.ai.' }); }

    const url = data?.images?.[0]?.url;
    if (!url) {
      console.error('[FAL] Sem URL na resposta:', JSON.stringify(data).substring(0, 300));
      return res.status(500).json({ error: 'fal.ai não retornou imagem. Verifique o prompt ou tente novamente.' });
    }

    console.log('[RESULT URL]', url.substring(0, 80));
    res.json({ url });
  } catch (err) {
    console.error('[GENERATE ERROR]', err.message);
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
