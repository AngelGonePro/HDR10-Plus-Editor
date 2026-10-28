'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const on = (ch) => (cb) => {
  const h = (_e, d) => cb(d);
  ipcRenderer.on(ch, h);
  return () => ipcRenderer.removeListener(ch, h);
};

contextBridge.exposeInMainWorld('api', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (v) => ipcRenderer.invoke('settings:save', v),
  checkTools: () => ipcRenderer.invoke('tools:check'),
  pickFile: (title, current) => ipcRenderer.invoke('dialog:pickFile', { title, current }),
  pickFolder: (title, current) => ipcRenderer.invoke('dialog:pickFolder', { title, current }),
  openClips: () => ipcRenderer.invoke('dialog:openClips'),
  importClip: (file, opts) => ipcRenderer.invoke('clip:import', file, opts),
  track: (args) => ipcRenderer.invoke('track:run', args),
  stopTrack: () => ipcRenderer.invoke('track:stop'),
  findFlashes: (file) => ipcRenderer.invoke('clip:findFlashes', { file }),
  onFlashProgress: on('flash:progress'),
  saveExportDialog: (defaultName, container) => ipcRenderer.invoke('dialog:saveExport', { defaultName, container }),
  runExport: (project, settings, outPath) => ipcRenderer.invoke('export:run', { project, settings, outPath }),
  cancelExport: () => ipcRenderer.invoke('export:cancel'),
  saveSession: (s) => ipcRenderer.invoke('session:save', s),
  loadSession: () => ipcRenderer.invoke('session:load'),
  showItem: (p) => ipcRenderer.invoke('shell:showItem', p),
  openLogs: () => ipcRenderer.invoke('shell:openLogs'),
  pathForFile: (f) => webUtils.getPathForFile(f),
  onClipProgress: on('clip:progress'),
  onTrackBoxes: on('track:boxes'),
  onExportProgress: on('export:progress'),
  onLog: on('log:line'),
});
