const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_CONCURRENT_DOWNLOADS = parseInt(process.env.MAX_CONCURRENT_DOWNLOADS || '3', 10);
const DOWNLOAD_TIMEOUT_MS = parseInt(process.env.DOWNLOAD_TIMEOUT_MS || '600000', 10); // 10min
const MAX_FILESIZE = process.env.MAX_FILESIZE || '512M';
const YTDLP_BIN = process.env.YTDLP_BIN || 'yt-dlp';

const QUALITY_TIERS = [2160, 1440, 1080, 720, 480, 360, 240];

// Bypass YouTube's web-client bot check by impersonating app clients instead
// (no cookies needed). Harmless no-op for non-YouTube URLs.
const YOUTUBE_BYPASS_ARGS = ['--extractor-args', 'youtube:player_client=android,ios,web'];

let activeDownloads = 0;

function isValidUrl(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return false;
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function runYtDlp(args, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(YTDLP_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGKILL');
    }, timeoutMs);

    proc.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    proc.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error('yt-dlp timed out'));
      } else if (code !== 0) {
        reject(new Error(stderr.trim().split('\n').slice(-5).join('\n') || `yt-dlp exited with code ${code}`));
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

function buildFormatArgs(quality) {
  if (quality === 'audio') {
    return { formatArgs: ['-f', 'bestaudio/best', '--extract-audio', '--audio-format', 'mp3'], isAudio: true };
  }
  if (quality === 'best' || !quality) {
    return { formatArgs: ['-f', 'bv*+ba/b'], isAudio: false };
  }
  const height = parseInt(quality, 10);
  if (!QUALITY_TIERS.includes(height)) {
    throw new Error('invalid quality');
  }
  return { formatArgs: ['-f', `bv*[height<=${height}]+ba/b[height<=${height}]`], isAudio: false };
}

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

app.get('/healthz', (req, res) => res.json({ ok: true }));

app.get('/api/info', async (req, res) => {
  const { url } = req.query;
  if (!isValidUrl(url)) {
    return res.status(400).json({ error: '유효한 URL을 입력하세요.' });
  }

  try {
    const { stdout } = await runYtDlp(
      ['-j', '--no-playlist', '--skip-download', ...YOUTUBE_BYPASS_ARGS, url],
      { timeoutMs: 30000 }
    );
    const info = JSON.parse(stdout.trim().split('\n')[0]);

    const availableHeights = new Set(
      (info.formats || [])
        .filter((f) => f.vcodec && f.vcodec !== 'none' && f.height)
        .map((f) => f.height)
    );
    const qualities = QUALITY_TIERS.filter((h) => [...availableHeights].some((a) => a >= h));

    res.json({
      title: info.title,
      thumbnail: info.thumbnail,
      duration: info.duration,
      uploader: info.uploader,
      qualities,
    });
  } catch (err) {
    res.status(422).json({ error: '영상 정보를 가져오지 못했습니다.', detail: String(err.message || err) });
  }
});

app.get('/api/download', async (req, res) => {
  const { url, quality } = req.query;
  if (!isValidUrl(url)) {
    return res.status(400).json({ error: '유효한 URL을 입력하세요.' });
  }

  let formatArgs;
  try {
    ({ formatArgs } = buildFormatArgs(quality));
  } catch {
    return res.status(400).json({ error: '유효하지 않은 화질 옵션입니다.' });
  }

  if (activeDownloads >= MAX_CONCURRENT_DOWNLOADS) {
    return res.status(429).json({ error: '서버가 바쁩니다. 잠시 후 다시 시도하세요.' });
  }

  activeDownloads += 1;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytdl-'));
  const outputTemplate = path.join(tmpDir, '%(title).60s.%(ext)s');

  const cleanup = () => fs.rm(tmpDir, { recursive: true, force: true }, () => {});

  try {
    await runYtDlp(
      [
        '--no-playlist',
        '--no-part',
        '--restrict-filenames',
        '--max-filesize', MAX_FILESIZE,
        '-o', outputTemplate,
        ...formatArgs,
        ...YOUTUBE_BYPASS_ARGS,
        url,
      ],
      { timeoutMs: DOWNLOAD_TIMEOUT_MS }
    );

    const files = fs.readdirSync(tmpDir);
    if (files.length === 0) {
      throw new Error('다운로드된 파일을 찾을 수 없습니다.');
    }
    const filePath = path.join(tmpDir, files[0]);

    res.download(filePath, files[0], (err) => {
      cleanup();
      if (err && !res.headersSent) {
        res.status(500).json({ error: '파일 전송 중 오류가 발생했습니다.' });
      }
    });
  } catch (err) {
    cleanup();
    if (!res.headersSent) {
      res.status(422).json({ error: '다운로드에 실패했습니다.', detail: String(err.message || err) });
    }
  } finally {
    activeDownloads -= 1;
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
