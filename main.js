'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const config = require('./core/config');
const log = require('./core/log');
const proc = require('./core/proc');
const clips = require('./core/clips');
const { Worker } = require('worker_threads');
const flashes = require('./core/flashes');
const { exportProject } = require('./core/export');

// Optional separate profile folder (lets automated tests start from a clean session)
if (process.env.HDRCE_USER_DATA) app.setPath('userData', process.env.HDRCE_USER_DATA);

let win = null;
let paths = null;
const clipStore = new Map(); // file path -> imported clip (info + proxy)
// plate tracking runs on its own thread (core/trackWorker.js)
const trackStopFlag = new Int32Array(new SharedArrayBuffer(4));
let trackWorker = null;
let trackJob = null; // { id, file, trackId, resolve, reject }
let trackSeq = 0;
function getTrackWorker() {
  if (trackWorker) return trackWorker;
  const w = new Worker(path.join(__dirname, 'core', 'trackWorker.js'), { workerData: { stop: trackStopFlag.buffer } });
  w.on('message', (m) => {
    if (m.type === 'log') { log.write(m.level, m.msg); return; }
    if (!trackJob || m.id !== trackJob.id) return;
    if (m.type === 'boxes') send('track:boxes', { file: trackJob.file, trackId: trackJob.trackId, boxes: m.boxes });
    else if (m.type === 'done') { const j = trackJob; trackJob = null; j.resolve(m.res); }
    else if (m.type === 'error') { const j = trackJob; trackJob = null; j.reject(new Error(m.message)); }
  });
  const fail = (e) => {
    trackWorker = null;
    if (trackJob) { const j = trackJob; trackJob = null; j.reject(e instanceof Error ? e : new Error(`Tracking stopped unexpectedly (${e})`)); }
  };
  w.on('error', fail);
  w.on('exit', (code) => fail(`exit ${code}`));
  trackWorker = w;
  return w;
}

function loadPaths() {
  paths = config.resolved();
  log.init(paths.workDir);
  log.info(`Settings file: ${config.ENV_PATH}`);
  log.info(`Tools: ffmpeg=${paths.ffmpeg} ffprobe=${paths.ffprobe} nvencc=${paths.nvencc} hdr10plus_tool=${paths.hdr10plus} mkvmerge=${paths.mkvmerge} hwaccel=${paths.hwaccel}`);
}

function send(ch, data) { if (win && !win.isDestroyed()) win.webContents.send(ch, data); }

function createWindow() {
  win = new BrowserWindow({
    width: 1500, height: 940, minWidth: 1100, minHeight: 700,
    backgroundColor: '#111317',
    title: 'HDR10+ Clip Editor',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  if (process.env.HDRCE_DEVTOOLS) win.webContents.openDevTools({ mode: 'detach' });
}

log.bus.on('line', (l) => send('log:line', l));

// ---------- settings / tools ----------
ipcMain.handle('settings:get', () => ({ values: config.load(), envPath: config.ENV_PATH, logFile: log.path }));
ipcMain.handle('settings:save', (_e, values) => {
  config.save(values);
  loadPaths();
  return { values: config.load() };
});

async function checkTool(bin, args, re) {
  try {
    const r = await proc.capture(bin, args, { allowFail: true });
    const text = `${r.stdout}\n${r.stderrTail}`;
    const m = re ? re.exec(text) : null;
    return { ok: r.code === 0 || !!m, version: m ? m[0].trim() : text.split('\n').find((l) => l.trim()) || '' };
  } catch (e) {
    return { ok: false, version: e.message };
  }
}

ipcMain.handle('tools:check', async () => {
  const out = {
    ffmpeg: await checkTool(paths.ffmpeg, ['-hide_banner', '-version'], /ffmpeg version \S+/),
    ffprobe: await checkTool(paths.ffprobe, ['-hide_banner', '-version'], /ffprobe version \S+/),
    nvencc: await checkTool(paths.nvencc, ['--version'], /NVEncC[^\r\n]*/i),
    hdr10plus: await checkTool(paths.hdr10plus, ['--version'], /hdr10plus_tool \S+/),
    mkvmerge: await checkTool(paths.mkvmerge, ['--version'], /mkvmerge v\S+/),
  };
  if (out.nvencc.ok) {
    const hw = await checkTool(paths.nvencc, ['--check-hw'], null);
    out.nvencc.gpu = hw.version;
  }
  log.info(`Tool check: ${JSON.stringify(out)}`);
  return out;
});

ipcMain.handle('dialog:pickFile', async (_e, { title, current }) => {
  const r = await dialog.showOpenDialog(win, { title, defaultPath: current || undefined, properties: ['openFile'] });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('dialog:pickFolder', async (_e, { title, current }) => {
  const r = await dialog.showOpenDialog(win, { title, defaultPath: current || undefined, properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

// ---------- clips ----------
ipcMain.handle('dialog:openClips', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Add clips', properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Videos', extensions: ['mp4', 'mov', 'mkv', 'm4v', 'hevc', 'MP4', 'MOV'] }, { name: 'All files', extensions: ['*'] }],
  });
  return r.canceled ? [] : r.filePaths;
});

function readWave(file) {
  try { return file ? JSON.parse(fs.readFileSync(file, 'utf8')) : null; } catch (_) { return null; }
}
function clientClip(c) {
  const i = c.info;
  return {
    file: c.file,
    name: path.basename(c.file),
    info: {
      width: i.width, height: i.height, dispW: i.dispW, dispH: i.dispH, rotation: i.rotation,
      nFrames: i.nFrames, duration: i.duration, avgFps: i.avgFps, nominalFps: i.nominalFps, colorTransfer: i.colorTransfer,
      isPQ: i.isPQ, isHLG: i.isHLG, hasHdr10Plus: i.hasHdr10Plus && !!c.hdr10plusJson, hdr10plusUnread: i.hasHdr10Plus && !c.hdr10plusJson, bitDepth: i.bitDepth,
      videoBitrate: i.videoBitrate, audio: i.audio.map((a) => `${a.codec} ${a.channels}ch`), times: i.times, lastDur: i.lastDur,
    },
    proxy: { url: pathToFileURL(c.proxy.file).href, w: c.proxy.w, h: c.proxy.h, times: c.proxy.times, audio: !!c.proxy.audio },
    wave: readWave(c.wave),
  };
}

let importChain = Promise.resolve();
ipcMain.handle('clip:import', (_e, file, opts) => {
  // one import at a time so several big clips don't fight for the GPU/CPU
  const job = importChain.then(async () => {
    const c = await clips.importClip(paths, file, Number(config.load().PROXY_WIDTH) || 960,
      (p) => send('clip:progress', { file, ...p }), { fresh: !!(opts && opts.fresh) });
    clipStore.set(file, c);
    return clientClip(c);
  });
  importChain = job.catch(() => {});
  return job.catch((e) => { log.error(`Import failed for ${file}: ${e.message}`); throw e; });
});

// ---------- tracking ----------
ipcMain.handle('track:run', (_e, { file, trackId, startFrame, box, dir, stopFrame }) => {
  const c = clipStore.get(file);
  if (!c) throw new Error('Clip is not loaded');
  if (trackJob) throw new Error('A plate is already being tracked');
  Atomics.store(trackStopFlag, 0, 0);
  const id = ++trackSeq;
  return new Promise((resolve, reject) => {
    trackJob = { id, file, trackId, resolve, reject };
    getTrackWorker().postMessage({ type: 'track', id, paths, proxy: c.proxy, startFrame, box, dir, stopFrame });
  });
});
ipcMain.handle('track:stop', () => { Atomics.store(trackStopFlag, 0, 1); return true; });

// ---------- lightning finder ----------
ipcMain.handle('clip:findFlashes', async (_e, { file }) => {
  const c = clipStore.get(file);
  if (!c) throw new Error('Clip is not loaded');
  const cfg = config.load();
  const r = await flashes.findFlashes(paths, c.proxy, { threshold: Number(cfg.FLASH_THRESHOLD) || 15, fps: c.info.avgFps },
    (f) => send('flash:progress', { file, frac: f }));
  return { events: r.events, before: Number(cfg.FLASH_BEFORE_SEC) || 0.3, after: Number(cfg.FLASH_AFTER_SEC) || 0.7 };
});

// ---------- export ----------
ipcMain.handle('dialog:saveExport', async (_e, { defaultName, container }) => {
  const cfg = config.load();
  const firstDir = clipStore.size ? path.dirname([...clipStore.keys()][0]) : app.getPath('videos');
  const dir = cfg.OUTPUT_DIR || firstDir;
  const ext = container === 'mkv' ? 'mkv' : 'mp4';
  const r = await dialog.showSaveDialog(win, {
    title: 'Export video', defaultPath: path.join(dir, `${defaultName}.${ext}`),
    filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
  });
  return r.canceled ? null : r.filePath;
});

ipcMain.handle('export:run', async (_e, { project, settings, outPath }) => {
  const full = {
    clips: project.clips.map((pc) => {
      const c = clipStore.get(pc.file);
      if (!c) throw new Error(`Clip not loaded: ${pc.file}`);
      return { info: c.info, removed: pc.removed, tracks: pc.tracks, speeds: pc.speeds || [], transIn: pc.transIn || null, rot: pc.rot || 0, hdr10plusJson: c.hdr10plusJson };
    }),
  };
  // remember the export choices as the new defaults
  config.save({
    ENCODER: settings.encoder, BLUR_STRENGTH: String(settings.blurStrength), BLUR_STYLE: settings.blurStyle,
    BOX_PADDING: String(settings.padPct), OUTPUT_CONTAINER: settings.container, OUTPUT_HEIGHT: String(settings.outHeight),
    BITRATE_MODE: settings.bitrateMode, BITRATE_KBPS: String(settings.bitrateKbps), OUTPUT_DIR: path.dirname(outPath),
    SLOW_AUDIO: settings.slowAudio || 'stretch', FPS_MODE: settings.fpsMode || 'keep',
  });
  paths = config.resolved();
  const s = { ...settings, nvenccPreset: config.load().NVENCC_PRESET, audioKbps: Number(config.load().AUDIO_BITRATE_KBPS) || 0 };
  return exportProject(paths, full, s, outPath, (p) => send('export:progress', p));
});
ipcMain.handle('export:cancel', () => { proc.cancelAll(); return true; });

// ---------- session ----------
const sessionFile = () => path.join(app.getPath('userData'), 'session.json');
ipcMain.handle('session:save', (_e, state) => {
  fs.writeFileSync(sessionFile(), JSON.stringify(state));
  return true;
});
ipcMain.handle('session:load', () => {
  try { return JSON.parse(fs.readFileSync(sessionFile(), 'utf8')); } catch (_) { return null; }
});

ipcMain.handle('shell:showItem', (_e, p) => { shell.showItemInFolder(p); return true; });
ipcMain.handle('shell:openLogs', () => { shell.openPath(path.dirname(log.path)); return log.path; });

app.whenReady().then(() => {
  loadPaths();
  createWindow();
});
app.on('window-all-closed', () => {
  proc.cancelAll();
  Atomics.store(trackStopFlag, 0, 1);
  if (trackWorker) { trackWorker.postMessage({ type: 'cancelAll' }); setTimeout(() => trackWorker && trackWorker.terminate(), 300); }
  app.quit();
});
