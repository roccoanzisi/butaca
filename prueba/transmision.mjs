import { _electron, chromium } from 'playwright';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const salida = resolve(raiz, 'prueba/salida');
const sala = `prueba-ci-${randomUUID()}`;
const resultado = {
  sala,
  plataforma: process.platform,
  arquitectura: process.arch,
  ejecutable: process.env.BUTACA_EJECUTABLE || null,
  videoRecibido: false,
  videoWidth: 0,
  videoHeight: 0,
  fotogramasIniciales: null,
  fotogramasFinales: null,
  demora: null,
  sonido: null,
  conSonido: false,
  error: null,
  erroresDiagnostico: [],
};
let app;
let navegador;
let cabina;
let espectador;
let temporizador;
let finalizando = false;

// Reserva diez segundos para guardar evidencia y cerrar los procesos.
const limiteAbsoluto = setTimeout(() => {
  console.error('Se agotó el timeout global de 120 segundos.');
  app?.process().kill('SIGKILL');
  process.exit(1);
}, 120_000);

async function transmitir() {
  const args = process.platform === 'linux' ? ['--no-sandbox'] : [];
  const opciones = {
    env: { ...process.env, BUTACA_PRUEBA: '1' },
    args: process.env.BUTACA_EJECUTABLE ? args : [...args, raiz],
    timeout: 30_000,
  };
  if (process.env.BUTACA_EJECUTABLE) {
    opciones.executablePath = resolve(process.env.BUTACA_EJECUTABLE);
  }
  app = await _electron.launch(opciones);
  if (finalizando) {
    await app.close();
    throw new Error('Lanzamiento cancelado por timeout.');
  }
  cabina = await app.firstWindow({ timeout: 30_000 });
  cabina.setDefaultTimeout(30_000);
  await cabina.waitForURL('file://**/index.html*');
  await cabina.evaluate((nombre) => {
    const url = new URL('index.html', location.href);
    url.searchParams.set('sala', nombre);
    url.searchParams.set('cabina', '');
    location.href = url.href;
  }, sala);
  await cabina.locator('#cabina-aviso-titulo').filter({
    hasText: /^La cabina está lista$/,
  }).waitFor({ timeout: 30_000 });
  await cabina.locator('#btn-compartir').click();

  navegador = await chromium.launch({
    headless: true,
    timeout: 20_000,
    args: ['--autoplay-policy=no-user-gesture-required'],
    // Opcional: usar un Chromium ya instalado en vez del de Playwright.
    ...(process.env.BUTACA_CHROMIUM ? { executablePath: process.env.BUTACA_CHROMIUM } : {}),
  });
  if (finalizando) {
    await navegador.close();
    throw new Error('Lanzamiento del espectador cancelado por timeout.');
  }
  espectador = await navegador.newPage({ viewport: { width: 1920, height: 1080 } });
  // Guardar las conexiones WebRTC del espectador para medir el audio que llega.
  await espectador.addInitScript(() => {
    const Original = window.RTCPeerConnection;
    window.__conexiones = [];
    window.RTCPeerConnection = class extends Original {
      constructor(...args) { super(...args); window.__conexiones.push(this); }
    };
  });
  espectador.setDefaultTimeout(30_000);
  const url = pathToFileURL(resolve(raiz, 'index.html'));
  url.searchParams.set('sala', sala);
  await espectador.goto(url.href);
  await espectador.locator('#entrada-nombre').fill('CI');
  await espectador.locator('#form-entrada').evaluate((form) => form.requestSubmit());

  // Esperar video real: ancho > 0, cuadros que avanzan y una imagen que no sea un cuadro liso.
  const leer = () => espectador.locator('#sala-video').evaluate((video) => {
    const cuadros = Math.max(
      video.webkitDecodedFrameCount || 0,
      video.getVideoPlaybackQuality?.().totalVideoFrames || 0,
    );
    let variacion = 0;
    if (video.videoWidth) {
      const lienzo = document.createElement('canvas');
      lienzo.width = 160;
      lienzo.height = 90;
      const ctx = lienzo.getContext('2d');
      ctx.drawImage(video, 0, 0, 160, 90);
      const px = ctx.getImageData(0, 0, 160, 90).data;
      let suma = 0;
      let suma2 = 0;
      for (let i = 0; i < px.length; i += 4) {
        const y = (px[i] + px[i + 1] + px[i + 2]) / 3;
        suma += y;
        suma2 += y * y;
      }
      const n = px.length / 4;
      variacion = Math.round(Math.sqrt(suma2 / n - (suma / n) ** 2));
    }
    return { cuadros, ancho: video.videoWidth, alto: video.videoHeight, variacion };
  });
  const limite = Date.now() + 60_000;
  let previo = null;
  let datos = null;
  while (Date.now() < limite) {
    const actual = await leer();
    if (previo && actual.ancho > 0 && actual.cuadros > previo.cuadros) {
      datos = { antes: previo.cuadros, despues: actual.cuadros, ancho: actual.ancho, alto: actual.alto, variacion: actual.variacion };
      if (actual.variacion > 3) break; // con contenido: listo
    }
    previo = actual;
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (!datos) throw new Error('No llegó video al espectador en 60 s.');
  // Dejar que la calidad suba antes de guardar la evidencia.
  await new Promise((r) => setTimeout(r, 8000));
  // Audio recibido: nivel por pista (0 a 1). En una compu sin sonido sonando da 0, y eso no es un fallo.
  resultado.audioRecibido = await espectador.evaluate(async () => {
    const pistas = [];
    for (const pc of window.__conexiones || []) {
      const stats = await pc.getStats();
      stats.forEach((st) => {
        if (st.type === 'inbound-rtp' && st.kind === 'audio') {
          pistas.push({ mid: st.mid, nivel: +(st.audioLevel || 0).toFixed(3), energia: +(st.totalAudioEnergy || 0).toFixed(4) });
        }
      });
    }
    return pistas;
  });
  Object.assign(resultado, {
    videoRecibido: true,
    videoWidth: datos.ancho,
    videoHeight: datos.alto,
    fotogramasIniciales: datos.antes,
    fotogramasFinales: datos.despues,
    variacionImagen: datos.variacion,
    imagenConContenido: datos.variacion > 3,
  });
}

async function guardarEvidencia() {
  const tareas = [];
  if (cabina && !cabina.isClosed()) {
    tareas.push((async () => {
      resultado.sonido = await cabina.locator('#cabina-sonido').textContent({ timeout: 1500 });
      resultado.conSonido = resultado.sonido.trim().startsWith('Se escucha');
    })());
    tareas.push(cabina.screenshot({ path: resolve(salida, 'cabina.png'), timeout: 2500 }));
  }
  if (espectador && !espectador.isClosed()) {
    tareas.push((async () => {
      resultado.demora = await espectador.locator('#sala-demora').textContent({ timeout: 1500 });
      Object.assign(resultado, await espectador.locator('#sala-video').evaluate((video) => ({
        videoWidth: video.videoWidth,
        videoHeight: video.videoHeight,
      }), null, { timeout: 1500 }));
    })());
    tareas.push(espectador.screenshot({ path: resolve(salida, 'espectador.png'), timeout: 2500 }));
  }
  const estados = await Promise.allSettled(tareas);
  resultado.erroresDiagnostico = estados.filter((r) => r.status === 'rejected')
    .map((r) => String(r.reason));
  await writeFile(resolve(salida, 'resultado.json'), `${JSON.stringify(resultado, null, 2)}\n`);
}

try {
  await mkdir(salida, { recursive: true });
  await Promise.race([
    transmitir(),
    new Promise((_, rechazar) => {
      temporizador = setTimeout(() => rechazar(new Error('Timeout de transmisión (110 s).')), 110_000);
    }),
  ]);
} catch (error) {
  resultado.error = error.stack || String(error);
  console.error(resultado.error);
} finally {
  finalizando = true;
  clearTimeout(temporizador);
  try {
    await guardarEvidencia();
  } catch (error) {
    resultado.error ||= String(error);
    console.error('No se pudo guardar toda la evidencia:', error);
  } finally {
    let cierre;
    await Promise.race([
      Promise.allSettled([navegador?.close(), app?.close()]),
      new Promise((resolver) => {
        cierre = setTimeout(() => {
          app?.process().kill('SIGKILL');
          resolver();
        }, 4000);
      }),
    ]);
    clearTimeout(cierre);
    clearTimeout(limiteAbsoluto);
  }
}

console.log(`Sala: ${sala} | ${process.platform} | video: ${resultado.videoRecibido ? 'OK' : 'FALLÓ'} | ${resultado.videoWidth}x${resultado.videoHeight}`);
console.log(`Demora: ${resultado.demora ?? 'sin datos'} | sonido: ${resultado.sonido ?? 'sin datos'}`);
console.log(`Evidencia: ${salida}`);
// Salir sí o sí: un proceso de Electron vivo retiene la salida y cuelga el CI.
try { app?.process()?.kill('SIGKILL'); } catch { /* ya cerrado */ }
process.exit(resultado.videoRecibido && !resultado.error ? 0 : 1);
