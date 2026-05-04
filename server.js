const express = require('express');
const multer  = require('multer');
const cors    = require('cors');
const path    = require('path');

const app    = express();
const upload = multer({ limits: { fileSize: 15 * 1024 * 1024 } });

app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

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
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/generate', async (req, res) => {
  try {
    const key = req.headers['x-fal-key'];
    if (!key) return res.status(401).json({ error: 'Chave API não fornecida.' });

    const { image_url, prompt, negative_prompt, image_size, strength } = req.body;

    const falResp = await fetch('https://fal.run/fal-ai/flux/dev/image-to-image', {
      method: 'POST',
      headers: { 'Authorization': `Key ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image_url,
        prompt,
        negative_prompt: negative_prompt || 'blurry, bad anatomy, deformed, ugly, low quality, watermark',
        image_size:      image_size || 'portrait_4_3',
        num_inference_steps: 35,
        strength:        strength || 0.72,
        guidance_scale:  7.5,
        num_images:      1,
        enable_safety_checker: true,
      }),
    });

    if (!falResp.ok) {
      const err = await falResp.json().catch(() => ({}));
      if (falResp.status === 401) return res.status(401).json({ error: 'Chave API inválida ou sem créditos.' });
      return res.status(falResp.status).json({ error: err.detail || 'Erro no fal.ai' });
    }

    const data = await falResp.json();
    const imgUrl = data?.images?.[0]?.url || data?.image?.url;
    if (!imgUrl) return res.status(500).json({ error: 'Resposta inesperada do fal.ai.' });

    res.json({ url: imgUrl, seed: data.seed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Studio rodando na porta ${PORT}`));
