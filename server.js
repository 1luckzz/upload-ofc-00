const express = require('express');
const multer = require('multer');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const archiver = require('archiver');

const app = express();
const PORT = process.env.PORT || 3000;

// pasta temporária de trabalho (limpa no boot)
const TMP = path.join(os.tmpdir(), 'editor-massa');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

const JOB_TTL_MS = 45 * 60 * 1000; // resultados ficam 45 min disponíveis
const jobs = {}; // id -> { status, dir, files:[{origName, outName, status, progress, inPath, ovPath, outPath, start, len}], amode, audioPath }
const queue = [];
let working = false;

// ---------- upload ----------
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, req.jobDir),
    filename: (req, file, cb) =>
      cb(null, file.fieldname + '-' + Date.now() + '-' + Math.random().toString(36).slice(2) + path.extname(file.originalname || '')),
  }),
  limits: { fileSize: 500 * 1024 * 1024 }, // 500 MB por arquivo
});

app.use(express.static(path.join(__dirname, 'public')));

app.post(
  '/api/jobs',
  (req, res, next) => {
    req.jobId = crypto.randomUUID();
    req.jobDir = path.join(TMP, req.jobId);
    fs.mkdirSync(req.jobDir, { recursive: true });
    next();
  },
  upload.fields([{ name: 'videos' }, { name: 'overlays' }, { name: 'audio', maxCount: 1 }]),
  (req, res) => {
    try {
      const meta = JSON.parse(req.body.meta || '{}');
      const vids = (req.files.videos || []);
      const ovs = (req.files.overlays || []);
      if (!vids.length) return res.status(400).json({ error: 'Nenhum vídeo enviado.' });
      if (!Array.isArray(meta.items) || meta.items.length !== vids.length)
        return res.status(400).json({ error: 'Metadados inválidos.' });

      const job = {
        id: req.jobId,
        dir: req.jobDir,
        status: 'na fila',
        amode: ['replace', 'mix', 'none'].includes(meta.amode) ? meta.amode : 'none',
        audioPath: req.files.audio ? req.files.audio[0].path : null,
        createdAt: Date.now(),
        files: vids.map((v, i) => ({
          origName: v.originalname || 'video' + i + '.mp4',
          outName: 'pronto_' + sanitize((v.originalname || 'video' + i).replace(/\.\w+$/, '')) + '.mp4',
          inPath: v.path,
          ovPath: ovs[i] ? ovs[i].path : null,
          outPath: path.join(req.jobDir, 'out_' + i + '.mp4'),
          start: Math.max(0, parseFloat(meta.items[i].start) || 0),
          len: Math.max(0, parseFloat(meta.items[i].len) || 0),
          status: 'na fila',
          progress: 0,
        })),
      };
      if (job.amode !== 'none' && !job.audioPath) job.amode = 'none';

      jobs[job.id] = job;
      queue.push(job.id);
      pump();
      // limpeza automática
      setTimeout(() => cleanupJob(job.id), JOB_TTL_MS);
      res.json({ id: job.id });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'Falha ao criar o job.' });
    }
  }
);

app.get('/api/jobs/:id', (req, res) => {
  const job = jobs[req.params.id];
  if (!job) return res.status(404).json({ error: 'Job não encontrado (pode ter expirado).' });
  res.json({
    id: job.id,
    status: job.status,
    files: job.files.map(f => ({ name: f.origName, out: f.outName, status: f.status, progress: f.progress })),
  });
});

app.get('/api/jobs/:id/files/:idx', (req, res) => {
  const job = jobs[req.params.id];
  const f = job && job.files[parseInt(req.params.idx)];
  if (!f || f.status !== 'concluído') return res.status(404).send('Arquivo não disponível.');
  res.download(f.outPath, f.outName);
});

app.get('/api/jobs/:id/zip', (req, res) => {
  const job = jobs[req.params.id];
  if (!job) return res.status(404).send('Job não encontrado.');
  const done = job.files.filter(f => f.status === 'concluído');
  if (!done.length) return res.status(404).send('Nenhum arquivo pronto.');
  res.attachment('videos_prontos.zip');
  const zip = archiver('zip', { zlib: { level: 1 } });
  zip.on('error', err => { console.error(err); res.status(500).end(); });
  zip.pipe(res);
  done.forEach(f => zip.file(f.outPath, { name: f.outName }));
  zip.finalize();
});

// ---------- fila de processamento (1 vídeo por vez p/ não estourar CPU/RAM) ----------
async function pump() {
  if (working) return;
  const id = queue.shift();
  if (!id) return;
  const job = jobs[id];
  if (!job) return pump();
  working = true;
  job.status = 'processando';
  for (const f of job.files) {
    f.status = 'processando';
    try {
      try {
        await processFile(job, f, job.amode);
      } catch (e) {
        // fallback: vídeo sem trilha de áudio original quebra "mix" e "replace" → usa só o áudio novo
        if (job.amode === 'mix' || job.amode === 'replace') await processFile(job, f, 'replace_noorig');
        else throw e;
      }
      f.status = 'concluído';
      f.progress = 100;
    } catch (e) {
      console.error('Erro em', f.origName, e.message);
      f.status = 'erro';
    }
    // libera espaço do arquivo de entrada assim que termina
    fs.rm(f.inPath, { force: true }, () => {});
    if (f.ovPath) fs.rm(f.ovPath, { force: true }, () => {});
  }
  job.status = 'concluído';
  working = false;
  pump();
}

// descobre duração e se o arquivo tem trilha de áudio
function probe(filePath) {
  return new Promise(resolve => {
    const ff = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-show_entries', 'stream=codec_type',
      '-of', 'json', filePath,
    ]);
    let out = '';
    ff.stdout.on('data', d => (out += d));
    ff.on('close', () => {
      try {
        const j = JSON.parse(out);
        resolve({
          duration: parseFloat(j.format && j.format.duration) || 0,
          hasAudio: (j.streams || []).some(s => s.codec_type === 'audio'),
        });
      } catch (e) {
        resolve({ duration: 0, hasAudio: false });
      }
    });
    ff.on('error', () => resolve({ duration: 0, hasAudio: false }));
  });
}

async function processFile(job, f, amode) {
  // dados dos arquivos (duração real e presença de trilha de áudio)
  const vidInfo = await probe(f.inPath);
  if (job.audioPath && !job.audioInfo) job.audioInfo = await probe(job.audioPath);
  const audioDur = job.audioInfo ? job.audioInfo.duration : 0;

  // duração final do corte: o que o usuário escolheu (ou o resto do vídeo)
  const outLen = f.len > 0 ? f.len : Math.max(0, vidInfo.duration - f.start);

  const useAudio = job.audioPath && amode !== 'none';
  const args = ['-hide_banner', '-y'];
  if (f.start > 0) args.push('-ss', f.start.toFixed(2));
  args.push('-i', f.inPath);
  if (f.ovPath) args.push('-i', f.ovPath);
  if (useAudio) args.push('-i', job.audioPath);
  const aIdx = f.ovPath ? 2 : 1;

  let vf = f.ovPath ? '[0:v][1:v]overlay=0:0,format=yuv420p[v]' : '[0:v]format=yuv420p[v]';
  args.push('-map', '[v]');

  if (amode === 'mix' && useAudio && vidInfo.hasAudio) {
    // trilha nova por cima do áudio original, mantendo a duração do vídeo
    vf += ';[0:a][' + aIdx + ':a]amix=inputs=2:duration=first:dropout_transition=0[a]';
    args.push('-map', '[a]');
  } else if (useAudio) {
    if (amode !== 'replace_noorig' && vidInfo.hasAudio && audioDur > 0 && audioDur < outLen - 0.05) {
      // trilha nova toca até acabar; depois volta o áudio original do vídeo
      // (aformat iguala sample rate/canais dos dois — obrigatório pro concat)
      const AF = 'aformat=sample_rates=48000:channel_layouts=stereo';
      vf += ';[' + aIdx + ':a]' + AF + '[nova];' +
            '[0:a]atrim=start=' + audioDur.toFixed(3) + ',asetpts=PTS-STARTPTS,' + AF + '[tail];' +
            '[nova][tail]concat=n=2:v=0:a=1[a]';
      args.push('-map', '[a]');
    } else {
      // trilha nova cobre o corte inteiro (ou o vídeo não tem áudio original)
      args.push('-map', aIdx + ':a');
    }
  } else {
    args.push('-map', '0:a?');
  }

  args.push('-filter_complex', vf);
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart');
  if (outLen > 0) args.push('-t', outLen.toFixed(2));
  args.push(f.outPath);

  // -filter_complex precisa vir antes dos -map na linha de comando
  const fcIdx = args.indexOf('-filter_complex');
  const fc = args.splice(fcIdx, 2);
  const firstMap = args.indexOf('-map');
  args.splice(firstMap, 0, fc[0], fc[1]);

  return runFfmpeg(args, f, outLen);
}

function runFfmpeg(args, f, outLen) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', args);
    let errBuf = '';
    ff.stderr.on('data', chunk => {
      const s = chunk.toString();
      errBuf = (errBuf + s).slice(-4000);
      const m = s.match(/time=(\d+):(\d+):([\d.]+)/);
      if (m && outLen > 0) {
        const t = (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
        f.progress = Math.min(99, Math.round((t / outLen) * 100));
      }
    });
    ff.on('close', code => (code === 0 ? resolve() : reject(new Error('ffmpeg saiu com código ' + code + '\n' + errBuf))));
    ff.on('error', reject);
  });
}

function sanitize(name) {
  return name.replace(/[^\w\-. ]+/g, '_').slice(0, 80);
}

function cleanupJob(id) {
  const job = jobs[id];
  if (!job) return;
  fs.rm(job.dir, { recursive: true, force: true }, () => {});
  delete jobs[id];
}

app.listen(PORT, () => console.log('Editor em Massa rodando na porta ' + PORT));
