const express = require('express');
const multer  = require('multer');
const cors    = require('cors');
const path    = require('path');

const app    = express();
const upload = multer({ limits: { fileSize: 15 * 1024 * 1024 } });

app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Upload de imagem para fal.ai storage ──────────────────
app.post('/api/upload', upload.single('image'), async (req, res) => {
  try {
    const key = req.headers['x-fal-key'];
    if (!key) return res.status(401).json({ error: 'Chave API não fornecida.' });

    const fileBuffer = req.file.buffer;
    const mimeType   = req.file.mimetype;
    const fileName   = req.file.originalname || 'photo.jpg';

    const uploadResp = await fetch('https://rest.alpha.fal.ai/storage/upload/initiate', {
      method: 'POST',
      headers: { 'Authorization': `Key ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_name: fileName, content_type: mimeType }),
    });

    if (!uploadResp.ok) {
      const err = await uploadResp.json().catch(() => ({}));
      return res.status(uploadResp.status).json({ error: err.detail || 'Erro no upload.' });
    }

    const { upload_url, file_url } = await uploadResp.json();

    const putResp = await fetch(upload_url, {
      method: 'PUT',
      headers: { 'Content-Type': mimeType },
      body: fileBuffer,
    });

    if (!putResp.ok) return res.status(500).json({ error: 'Erro ao enviar arquivo.' });

    res.json({ url: file_url });
  } catch (err) {
    console.error('[UPLOAD]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── ETAPA 1: Gera ensaio com FLUX + ETAPA 2: Face-swap ───
app.post('/api/generate', async (req, res) => {
  try {
    const key = req.headers['x-fal-key'];
    if (!key) return res.status(401).json({ error: 'Chave API não fornecida.' });

    const { face_image_url, prompt, image_size } = req.body;
    if (!face_image_url || !prompt) {
      return res.status(400).json({ error: 'face_image_url e prompt são obrigatórios.' });
    }

    console.log('[STEP 1] Gerando ensaio com FLUX...');

    const fluxResp = await fetch('https://fal.run/fal-ai/flux/dev/image-to-image', {
      method: 'POST',
      headers: { 'Authorization': `Key ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image_url:             face_image_url,
        prompt:                prompt,
        negative_prompt:       'blurry, bad anatomy, deformed, ugly, low quality, watermark, cartoon, anime, 3d render, bad face, disfigured',
        image_size:            image_size || 'portrait_4_3',
        num_inference_steps:   35,
        strength:              0.85,
        guidance_scale:        8,
        num_images:            1,
        enable_safety_checker: true,
      }),
    });

    if (!fluxResp.ok) {
      const err = await fluxResp.json().catch(() => ({}));
      if (fluxResp.status === 401) return res.status(401).json({ error: 'Chave inválida ou sem créditos.' });
      return res.status(fluxResp.status).json({ error: err.detail || 'Erro no FLUX.' });
    }

    const fluxData  = await fluxResp.json();
    const ensaioUrl = fluxData?.images?.[0]?.url;
    if (!ensaioUrl) return res.status(500).json({ error: 'FLUX não retornou imagem.' });

    console.log('[STEP 2] Aplicando rosto original com face-swap...');

    const swapResp = await fetch('https://fal.run/fal-ai/face-swap', {
      method: 'POST',
      headers: { 'Authorization': `Key ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        base_image_url:        ensaioUrl,
        swap_image_url:        face_image_url,
        base_image_face_index: 0,
        swap_image_face_index: 0,
      }),
    });

    if (!swapResp.ok) {
      console.warn('[STEP 2] Face-swap falhou, retornando ensaio sem swap.');
      return res.json({ url: ensaioUrl, swapped: false });
    }

    const swapData = await swapResp.json();
    const finalUrl = swapData?.image?.url || swapData?.images?.[0]?.url || ensaioUrl;

    res.json({ url: finalUrl, swapped: true });
  } catch (err) {
    console.error('[GENERATE]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Verifica chave ────────────────────────────────────────
app.get('/api/credits', async (req, res) => {
  try {
    const key = req.headers['x-fal-key'];
    if (!key) return res.status(401).json({ error: 'Chave não fornecida.' });
    const testResp = await fetch('https://rest.alpha.fal.ai/storage/upload/initiate', {
      method: 'POST',
      headers: { 'Authorization': `Key ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_name: 'test.txt', content_type: 'text/plain' }),
    });
    res.json({ valid: testResp.status !== 401 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Studio rodando na porta ${PORT}`));
