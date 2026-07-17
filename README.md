# Editor em Massa

Edita vários vídeos de uma vez: corte de trecho (janela arrastável por vídeo), texto sobreposto e troca/mistura de áudio. Front-end + backend Node com FFmpeg nativo.

## Rodar local

```bash
npm install
npm start
# abre http://localhost:3000
```

Precisa do FFmpeg instalado na máquina (`winget install ffmpeg` no Windows).

## Deploy no Render (Docker)

1. Suba esta pasta num repositório do GitHub (GitHub Desktop, como de costume)
2. No Render: **New → Web Service → conecta o repo**
3. Runtime: **Docker** (ele detecta o Dockerfile sozinho)
4. Deploy. Pronto — o FFmpeg já vem instalado pela imagem.

### Avisos do free tier (512 MB RAM / 0.1 CPU)
- Funciona, mas o processamento fica lento (a fila processa 1 vídeo por vez de propósito)
- Uploads grandes (30 vídeos x 100 MB+) podem demorar bastante pra subir
- O disco do Render é efêmero: os resultados ficam disponíveis por 45 min e depois são apagados (isso já é o comportamento do app)

## Rotas da API

- `POST /api/jobs` — multipart: `videos[]`, `overlays[]` (PNGs opcionais, 1 por vídeo), `audio` (opcional), `meta` = `{"items":[{"start":s,"len":s}], "amode":"replace|mix|none"}`
- `GET /api/jobs/:id` — status e progresso por arquivo
- `GET /api/jobs/:id/files/:idx` — baixa um vídeo pronto
- `GET /api/jobs/:id/zip` — baixa tudo em .zip

## Limites configuráveis (server.js)

- Tamanho máximo por arquivo: 500 MB (`limits.fileSize`)
- Tempo de retenção dos resultados: 45 min (`JOB_TTL_MS`)
- Qualidade/velocidade do encode: `-preset veryfast -crf 23`
