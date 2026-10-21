'use strict';

// Butaca de escritorio: la misma app web dentro de Electron, con selector propio
// de pantallas/ventanas y sonido del sistema (loopback en Windows).

const path = require('node:path');
const { app, BrowserWindow, desktopCapturer, ipcMain, session, shell } = require('electron');

const PRUEBA = process.env.BUTACA_PRUEBA === '1';
// En Wayland el selector lo pone el sistema (portal de PipeWire): no se arma uno propio.
const WAYLAND = process.platform === 'linux' && process.env.XDG_SESSION_TYPE === 'wayland'
  && !app.commandLine.getSwitchValue('ozone-platform').includes('x11');

let pedido = null; // { id, sonido } para el próximo getDisplayMedia (id null: elegir sola)

function crearVentana() {
  const ventana = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 420,
    minHeight: 520,
    backgroundColor: '#1C0C12',
    title: 'Butaca',
    icon: path.join(__dirname, '..', 'icono.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      // Minimizada o tapada sigue transmitiendo y midiendo sin frenarse.
      backgroundThrottling: false,
      additionalArguments: [`--butaca-selector=${!PRUEBA && !WAYLAND ? 1 : 0}`],
    },
  });
  ventana.removeMenu();
  ventana.loadFile(path.join(__dirname, '..', 'index.html'));

  // Los links externos se abren en el navegador; dentro de la app sólo se navega por sus archivos.
  ventana.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  ventana.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file:')) {
      e.preventDefault();
      if (/^https?:/.test(url)) shell.openExternal(url);
    }
  });
}

function permisos() {
  const permitidos = new Set(['media', 'display-capture', 'clipboard-sanitized-write', 'fullscreen']);
  session.defaultSession.setPermissionRequestHandler((_wc, permiso, responder) => responder(permitidos.has(permiso)));
  session.defaultSession.setPermissionCheckHandler((_wc, permiso) => permitidos.has(permiso));

  session.defaultSession.setDisplayMediaRequestHandler(async (request, responderUnaVez) => {
    const elegido = pedido;
    pedido = null;
    let respondido = false;
    const responder = (respuesta) => {
      if (respondido) return;
      respondido = true;
      responderUnaVez(respuesta); // null = rechazar
    };
    try {
      const fuentes = await desktopCapturer.getSources({ types: ['screen', 'window'] });
      let fuente = null;
      if (elegido?.id) fuente = fuentes.find((f) => f.id === elegido.id);
      else if (PRUEBA && process.env.BUTACA_PRUEBA_FUENTE === 'ventana') fuente = fuentes.find((f) => f.id.startsWith('window:')) || fuentes[0];
      else if (PRUEBA || WAYLAND) fuente = fuentes.find((f) => f.id.startsWith('screen:')) || fuentes[0];
      if (!fuente) return responder(null);
      const sonido = elegido ? elegido.sonido : PRUEBA;
      // Sonido de todo el sistema por loopback (Windows y Linux con PulseAudio/PipeWire).
      if (sonido && request.audioRequested) {
        responder({ video: fuente, audio: 'loopback' });
      } else {
        responder({ video: fuente });
      }
    } catch {
      responder(null);
    }
  });
}

ipcMain.handle('fuentes:listar', async () => {
  const fuentes = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 320, height: 180 },
  });
  // Sin la propia ventana de Butaca: compartirla mostraría un espejo infinito.
  const propias = new Set(BrowserWindow.getAllWindows().map((v) => v.getMediaSourceId()));
  return fuentes
    .filter((f) => !propias.has(f.id))
    .map((f) => ({
      id: f.id,
      nombre: f.name,
      tipo: f.id.startsWith('screen:') ? 'pantalla' : 'ventana',
      miniatura: f.thumbnail.isEmpty() ? null : f.thumbnail.toDataURL(),
    }));
});

ipcMain.handle('fuentes:elegir', (_e, id, sonido) => {
  pedido = { id: typeof id === 'string' && id ? id : null, sonido: !!sonido };
});

app.whenReady().then(() => {
  permisos();
  crearVentana();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) crearVentana();
  });
});

app.on('window-all-closed', () => app.quit());
