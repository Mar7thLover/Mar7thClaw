const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('clawDesktop', {
  togglePin: () => ipcRenderer.invoke('claw:toggle-pin'),
  isPinned: () => ipcRenderer.invoke('claw:is-pinned'),
  hide: () => ipcRenderer.invoke('claw:hide'),
  openInBrowser: () => ipcRenderer.invoke('claw:open-browser'),
  avatarChanged: cardId => ipcRenderer.invoke('claw:avatar', String(cardId)),
  attention: () => ipcRenderer.invoke('claw:attention'),
  notify: (title, body) => ipcRenderer.invoke('claw:notify', title, body),
});
