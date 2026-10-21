'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const prueba = process.env.BUTACA_PRUEBA === '1';
// El proceso principal decide si hay selector propio (no en pruebas ni en Wayland, donde elige el sistema).
const selectorPropio = process.argv.includes('--butaca-selector=1');

// Lo único que la página ve de la app de escritorio.
contextBridge.exposeInMainWorld('butacaEscritorio', {
  plataforma: process.platform,
  selectorPropio,
  prueba,
  // El link para invitar apunta a la versión web: se puede mirar desde cualquier navegador.
  linkBase: 'https://roccoanzisi.github.io/butaca/',
  listarFuentes: () => ipcRenderer.invoke('fuentes:listar'),
  elegirFuente: (id, sonido) => ipcRenderer.invoke('fuentes:elegir', id, sonido),
});
