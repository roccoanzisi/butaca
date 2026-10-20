'use strict';

// Butaca: una cabina comparte pantalla por WebRTC P2P (PeerJS), las butacas miran.
// Prioridad: demora mínima. Ver DESIGN.md.

const PREFIJO = 'butaca-rocco-';

const CALIDADES = {
  liviana: { ancho: 1280, alto: 720, fps: 30, kbps: 2500 },
  normal: { ancho: 1920, alto: 1080, fps: 30, kbps: 5000 },
  alta: { ancho: 1920, alto: 1080, fps: 60, kbps: 8000 },
};

// Calidad que elige cada butaca para sí misma (tope sobre lo que manda la cabina).
const VISTAS = {
  auto: null,
  '720': { alto: 720, kbps: 2500, fps: 60 },
  '480': { alto: 480, kbps: 1200, fps: 30 },
  '360': { alto: 360, kbps: 600, fps: 30 },
};

const NOTAS_CONTENIDO = {
  movimiento: 'Prioriza fluidez: si la red no alcanza, baja la nitidez antes que sumar demora.',
  texto: 'Prioriza nitidez: la letra se lee bien, pero con poca red baja la fluidez.',
};

const $ = (id) => document.getElementById(id);

// ---------- Utilidades ----------

const guardado = {
  leer(clave, porDefecto) {
    try { return localStorage.getItem('butaca:' + clave) ?? porDefecto; } catch { return porDefecto; }
  },
  escribir(clave, valor) {
    try { localStorage.setItem('butaca:' + clave, valor); } catch { /* sin almacenamiento */ }
  },
};

function aSlug(texto) {
  return String(texto || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/, '');
}

function limpiarNombre(texto) {
  const limpio = String(texto || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 20);
  return limpio || 'Alguien';
}

function letrero(el, texto, animar) {
  el.textContent = '';
  el.setAttribute('aria-label', texto);
  let i = 0;
  for (const caracter of texto.toUpperCase()) {
    const ficha = document.createElement('span');
    ficha.setAttribute('aria-hidden', 'true');
    if (caracter === ' ') {
      ficha.className = 'letrero__hueco';
    } else {
      ficha.className = 'letrero__ficha';
      ficha.textContent = caracter;
      // Torcidas leves y fijas, como fichas colocadas a mano.
      ficha.style.setProperty('--giro', (((i * 37) % 7) - 3) * 0.45 + 'deg');
      ficha.style.setProperty('--dy', (((i * 53) % 5) - 2) * 0.015 + 'em');
      ficha.style.setProperty('--i', i);
    }
    el.append(ficha);
    i++;
  }
  if (animar) el.classList.add('letrero--colocando');
}

function salaLegible(slug) {
  return slug.replace(/-/g, ' ');
}

function ponerAire(prefijo, encendido) {
  $(prefijo + '-aire').dataset.estado = encendido ? 'encendido' : 'apagado';
  $(prefijo + '-aire-texto').textContent = encendido ? 'En vivo' : 'Fuera del aire';
}

// Preferir H264: casi todas las compus lo codifican por hardware,
// lo que baja la demora y la carga de CPU cuando hay varias butacas.
function preferirH264(pc) {
  if (!window.RTCRtpSender?.getCapabilities) return;
  const codecs = RTCRtpSender.getCapabilities('video')?.codecs;
  if (!codecs) return;
  const orden = (c) => (/h264/i.test(c.mimeType) ? 0 : /vp8/i.test(c.mimeType) ? 1 : 2);
  const ordenados = [...codecs].sort((a, b) => orden(a) - orden(b));
  for (const t of pc.getTransceivers()) {
    if (t.sender?.track?.kind === 'video' && t.setCodecPreferences) {
      try { t.setCodecPreferences(ordenados); } catch { /* el navegador elige */ }
    }
  }
}

// Lee getStats y estima la demora de punta a punta del lado de quien mira.
function crearMedidor() {
  let previo = null;
  return async function medir(pc) {
    const stats = await pc.getStats();
    let video = null;
    let rtt = null;
    stats.forEach((s) => {
      if (s.type === 'inbound-rtp' && s.kind === 'video') video = s;
      if (s.type === 'candidate-pair' && s.state === 'succeeded' && s.nominated && s.currentRoundTripTime != null) {
        rtt = s.currentRoundTripTime;
      }
    });
    if (!video) return null;
    let buffer = 0;
    let decodificar = 0;
    if (previo) {
      const emitidos = (video.jitterBufferEmittedCount || 0) - (previo.jitterBufferEmittedCount || 0);
      if (emitidos > 0) buffer = ((video.jitterBufferDelay || 0) - (previo.jitterBufferDelay || 0)) / emitidos;
      const cuadros = (video.framesDecoded || 0) - (previo.framesDecoded || 0);
      if (cuadros > 0) decodificar = ((video.totalDecodeTime || 0) - (previo.totalDecodeTime || 0)) / cuadros;
    }
    previo = video;
    // Red (ida) + buffer de jitter + decodificación + ~1 cuadro de captura/codificación.
    const fps = video.framesPerSecond || 30;
    const ms = Math.round(((rtt ?? 0) / 2 + buffer + decodificar) * 1000 + 1000 / fps);
    return { ms, ancho: video.frameWidth, alto: video.frameHeight, fps: Math.round(video.framesPerSecond || 0) };
  };
}

function iceDirecto(pc, alCambiar) {
  pc.addEventListener('connectionstatechange', () => alCambiar(pc.connectionState));
}

// ---------- Inicio ----------

function iniciarInicio() {
  $('vista-inicio').hidden = false;
  letrero(document.querySelector('[data-letrero]'), 'Butaca', true);
  const entrada = $('inicio-sala');
  entrada.value = salaLegible(guardado.leer('ultima-sala', ''));
  $('form-inicio').addEventListener('submit', (e) => {
    e.preventDefault();
    const sala = aSlug(entrada.value);
    if (!sala) {
      entrada.setCustomValidity('Usá al menos una letra o número.');
      entrada.reportValidity();
      return;
    }
    guardado.escribir('ultima-sala', sala);
    const modo = e.submitter?.value === 'cabina' ? '&cabina' : '';
    location.search = '?sala=' + encodeURIComponent(sala) + modo;
  });
  entrada.addEventListener('input', () => entrada.setCustomValidity(''));
}

// ---------- Cabina (quien transmite) ----------

function iniciarCabina(sala) {
  $('vista-cabina').hidden = false;
  document.title = 'Cabina: ' + salaLegible(sala) + ' | Butaca';
  letrero($('cabina-letrero'), salaLegible(sala), false);

  const linkSala = location.origin + location.pathname + '?sala=' + encodeURIComponent(sala);
  $('cabina-link').value = linkSala;

  const video = $('cabina-video');
  const btnCompartir = $('btn-compartir');
  const btnCortar = $('btn-cortar');

  const espectadores = new Map(); // peerId -> { conn, nombre, llamada, demora }
  let stream = null;
  let peer = null;
  let intentosId = 0;
  let calidad = CALIDADES[guardado.leer('calidad', 'normal')] ? guardado.leer('calidad', 'normal') : 'normal';
  let contenido = guardado.leer('contenido', 'movimiento') === 'texto' ? 'texto' : 'movimiento';

  function aviso(titulo, texto, conBoton) {
    $('cabina-aviso').hidden = false;
    $('cabina-aviso-titulo').textContent = titulo;
    $('cabina-aviso-texto').textContent = texto;
    btnCompartir.hidden = !conBoton;
  }

  if (!navigator.mediaDevices?.getDisplayMedia) {
    aviso('Este dispositivo no puede compartir pantalla',
      'Para transmitir hace falta una compu con Chrome, Edge o Firefox. Desde el celular sí se puede mirar.', false);
    return;
  }

  // Elegir H264 antes de cada oferta que arma PeerJS.
  const crearOferta = RTCPeerConnection.prototype.createOffer;
  RTCPeerConnection.prototype.createOffer = function (...args) {
    preferirH264(this);
    return crearOferta.apply(this, args);
  };

  function conectar() {
    aviso('Conectando la cabina', 'Un momento.', false);
    peer = new Peer(PREFIJO + sala, { debug: 1 });

    peer.on('open', () => {
      intentosId = 0;
      if (!stream) aviso('La cabina está lista', 'Compartí tu pantalla cuando quieras. Quien tenga el link la ve al instante.', true);
    });

    peer.on('connection', (conn) => {
      conn.on('open', () => {
        const pedida = conn.metadata?.vista;
        const vista = typeof pedida === 'string' && Object.hasOwn(VISTAS, pedida) ? pedida : 'auto';
        espectadores.set(conn.peer, { conn, nombre: limpiarNombre(conn.metadata?.nombre), llamada: null, demora: null, vista });
        if (stream) llamar(conn.peer);
        difundir();
      });
      conn.on('data', (msg) => {
        const e = espectadores.get(conn.peer);
        if (!e || !msg || typeof msg !== 'object') return;
        if (msg.tipo === 'demora' && Number.isFinite(msg.ms)) {
          e.demora = Math.max(0, Math.min(99999, Math.round(msg.ms)));
          dibujarFila();
        } else if (msg.tipo === 'vista' && typeof msg.valor === 'string' && Object.hasOwn(VISTAS, msg.valor)) {
          e.vista = msg.valor;
          const pc = e.llamada?.peerConnection;
          if (pc && pc.connectionState === 'connected') codificar(pc, e);
          dibujarFila();
        } else if (msg.tipo === 'pedir-imagen' && stream) {
          llamar(conn.peer);
        }
      });
      conn.on('close', () => quitar(conn.peer));
      conn.on('error', () => quitar(conn.peer));
    });

    peer.on('disconnected', () => {
      // Se cayó el servidor de salas; las conexiones P2P siguen. Reconectar para recibir gente nueva.
      setTimeout(() => { if (peer && !peer.destroyed && peer.disconnected) peer.reconnect(); }, 2000);
    });

    peer.on('error', (err) => {
      if (err.type === 'unavailable-id') {
        peer.destroy();
        // Al recargar, el servidor puede tardar unos segundos en soltar el nombre.
        if (++intentosId <= 4) {
          aviso('Conectando la cabina', 'Recuperando la sala…', false);
          setTimeout(conectar, 3000);
        } else {
          aviso('Esta sala ya tiene a alguien transmitiendo', 'Elegí otro nombre de sala desde el inicio.', false);
        }
      } else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) {
        if (!stream) aviso('No hay conexión con el servidor de salas', 'Revisá tu internet. Se reintenta solo.', false);
        if (peer.destroyed) setTimeout(conectar, 4000);
      } else if (err.type === 'browser-incompatible') {
        aviso('Este navegador no sirve para transmitir', 'Probá con Chrome, Edge o Firefox actualizados.', false);
      }
    });
  }

  function quitar(id) {
    const e = espectadores.get(id);
    if (!e) return;
    e.llamada?.close();
    espectadores.delete(id);
    difundir();
  }

  function llamar(id) {
    const e = espectadores.get(id);
    if (!e || !stream) return;
    e.llamada?.close();
    const llamada = peer.call(id, stream, { metadata: { sala } });
    if (!llamada) return;
    e.llamada = llamada;
    const pc = llamada.peerConnection;
    if (pc) iceDirecto(pc, (estado) => { if (estado === 'connected') codificar(pc, e); });
    llamada.on('close', () => { if (e.llamada === llamada) e.llamada = null; });
    llamada.on('error', () => { if (e.llamada === llamada) e.llamada = null; });
  }

  // Cada butaca tiene su propia copia: se ajusta resolución y bitrate sólo para ella.
  function codificar(pc, e) {
    const c = CALIDADES[calidad];
    const v = VISTAS[e?.vista] || null;
    for (const sender of pc.getSenders()) {
      if (sender.track?.kind !== 'video') continue;
      const p = sender.getParameters();
      if (!p.encodings || !p.encodings.length) p.encodings = [{}];
      const altoFuente = sender.track.getSettings().height || c.alto;
      p.encodings[0].scaleResolutionDownBy = v ? Math.max(1, altoFuente / v.alto) : 1;
      p.encodings[0].maxBitrate = (v ? Math.min(c.kbps, v.kbps) : c.kbps) * 1000;
      p.encodings[0].maxFramerate = v ? Math.min(c.fps, v.fps) : c.fps;
      p.encodings[0].priority = 'high';
      p.encodings[0].networkPriority = 'high';
      p.degradationPreference = contenido === 'texto' ? 'maintain-resolution' : 'maintain-framerate';
      sender.setParameters(p).catch(() => {});
    }
  }

  function aplicarATodos() {
    if (!stream) return;
    const c = CALIDADES[calidad];
    const pista = stream.getVideoTracks()[0];
    if (pista) {
      pista.contentHint = contenido === 'texto' ? 'detail' : 'motion';
      pista.applyConstraints({ width: { ideal: c.ancho }, height: { ideal: c.alto }, frameRate: { ideal: c.fps, max: c.fps } }).catch(() => {});
    }
    for (const e of espectadores.values()) {
      const pc = e.llamada?.peerConnection;
      if (pc && pc.connectionState === 'connected') codificar(pc, e);
    }
  }

  async function compartir() {
    const c = CALIDADES[calidad];
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { width: { ideal: c.ancho }, height: { ideal: c.alto }, frameRate: { ideal: c.fps, max: c.fps } },
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        systemAudio: 'include',
        selfBrowserSurface: 'exclude',
        surfaceSwitching: 'include',
      });
    } catch (err) {
      stream = null;
      if (err.name !== 'NotAllowedError' && err.name !== 'AbortError') {
        aviso('No se pudo compartir la pantalla', 'El navegador no dio permiso. Probá de nuevo o reiniciá el navegador.', true);
      }
      return;
    }
    const pista = stream.getVideoTracks()[0];
    pista.addEventListener('ended', cortar);
    aplicarATodos();
    video.srcObject = stream;
    video.dataset.activo = '';
    $('cabina-aviso').hidden = true;
    btnCortar.hidden = false;
    ponerAire('cabina', true);
    const sonido = $('cabina-sonido');
    sonido.textContent = stream.getAudioTracks().length
      ? 'Con sonido: tu audio también se transmite.'
      : 'Sin sonido. Para mandar audio, elegí una pestaña (o la pantalla completa en Windows) y activá "Compartir audio".';
    for (const id of espectadores.keys()) llamar(id);
    difundir();
  }

  function cortar() {
    if (!stream) return;
    for (const pista of stream.getTracks()) pista.stop();
    stream = null;
    for (const e of espectadores.values()) { e.llamada?.close(); e.llamada = null; }
    video.srcObject = null;
    delete video.dataset.activo;
    btnCortar.hidden = true;
    $('cabina-sonido').textContent = '';
    ponerAire('cabina', false);
    aviso('Transmisión cortada', 'Tus amigos siguen en la sala. Cuando vuelvas a compartir, la imagen les aparece sola.', true);
    difundir();
  }

  function difundir() {
    const estado = {
      tipo: 'estado',
      enVivo: !!stream,
      espectadores: [...espectadores.values()].map((e) => e.nombre),
    };
    for (const e of espectadores.values()) {
      if (e.conn.open) e.conn.send(estado);
    }
    dibujarFila();
  }

  function dibujarFila() {
    const fila = $('cabina-fila');
    const lista = [...espectadores.values()];
    $('cabina-cuenta').textContent = lista.length;
    fila.textContent = '';
    const total = Math.max(5, Math.ceil(lista.length / 5) * 5);
    for (let i = 0; i < total; i++) {
      const e = lista[i];
      const li = document.createElement('li');
      li.className = 'fila__butaca';
      li.innerHTML = '<svg aria-hidden="true"><use href="#butaca"/></svg>';
      const nombre = document.createElement('span');
      nombre.className = 'fila__nombre';
      nombre.textContent = e ? e.nombre : 'Libre';
      li.append(nombre);
      if (e) {
        li.dataset.ocupada = '';
        const demora = document.createElement('span');
        demora.className = 'fila__demora';
        const vista = e.vista === 'auto' ? '' : e.vista + 'p ';
        demora.textContent = e.demora != null && stream ? vista + e.demora + ' ms' : vista.trim();
        li.append(demora);
      }
      fila.append(li);
    }
    const c = CALIDADES[calidad];
    const nota = $('cabina-subida');
    if (lista.length) {
      const kbps = lista.reduce((suma, e) => suma + (VISTAS[e.vista] ? Math.min(c.kbps, VISTAS[e.vista].kbps) : c.kbps), 0);
      const mbps = Math.round(kbps / 100) / 10;
      nota.textContent = `Tu conexión manda una copia a cada butaca, con la calidad que eligió cada una: hasta ${mbps} Mbps de subida.`
        + (mbps > 20 || lista.length > 8 ? ' Si se traba o sube la demora, bajá la calidad.' : '');
      nota.dataset.tono = mbps > 20 || lista.length > 8 ? 'alerta' : '';
    } else {
      nota.textContent = 'Todavía no entró nadie. Mandales el link.';
      nota.dataset.tono = '';
    }
  }

  function segmentos(id, actual, alElegir) {
    const grupo = $(id);
    const botones = [...grupo.querySelectorAll('button')];
    const marcar = (valor) => {
      for (const b of botones) {
        const elegido = b.dataset.valor === valor;
        b.setAttribute('aria-checked', String(elegido));
        b.tabIndex = elegido ? 0 : -1;
      }
    };
    marcar(actual);
    grupo.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      marcar(b.dataset.valor);
      alElegir(b.dataset.valor);
    });
    grupo.addEventListener('keydown', (e) => {
      if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
      const i = botones.indexOf(document.activeElement);
      const sig = botones[(i + (e.key === 'ArrowRight' ? 1 : botones.length - 1)) % botones.length];
      sig.focus();
      sig.click();
    });
  }

  segmentos('sel-calidad', calidad, (v) => {
    calidad = v;
    guardado.escribir('calidad', v);
    aplicarATodos();
    dibujarFila();
  });
  segmentos('sel-contenido', contenido, (v) => {
    contenido = v;
    guardado.escribir('contenido', v);
    $('cabina-nota-contenido').textContent = NOTAS_CONTENIDO[v];
    aplicarATodos();
  });
  $('cabina-nota-contenido').textContent = NOTAS_CONTENIDO[contenido];

  btnCompartir.addEventListener('click', compartir);
  btnCortar.addEventListener('click', cortar);
  $('btn-copiar').addEventListener('click', async () => {
    const btn = $('btn-copiar');
    try {
      await navigator.clipboard.writeText(linkSala);
      btn.textContent = 'Copiado';
    } catch {
      $('cabina-link').select();
      btn.textContent = 'Copialo a mano';
    }
    setTimeout(() => { btn.textContent = 'Copiar'; }, 2000);
  });
  window.addEventListener('beforeunload', (e) => {
    if (stream) e.preventDefault();
  });
  window.addEventListener('pagehide', () => peer?.destroy());

  dibujarFila();
  conectar();
}

// ---------- Sala (quien mira) ----------

function iniciarSala(sala) {
  $('vista-sala').hidden = false;
  document.title = salaLegible(sala) + ' | Butaca';
  letrero($('entrada-letrero'), salaLegible(sala), true);
  const campoNombre = $('entrada-nombre');
  campoNombre.value = guardado.leer('nombre', '');

  $('form-entrada').addEventListener('submit', (e) => {
    e.preventDefault();
    const nombre = limpiarNombre(campoNombre.value);
    guardado.escribir('nombre', nombre);
    $('form-entrada').hidden = true;
    $('sala-escenario').hidden = false;
    letrero($('sala-letrero'), salaLegible(sala), false);
    mirar(sala, nombre);
  });
  if (!campoNombre.value) campoNombre.focus();
}

function mirar(sala, nombre) {
  const video = $('sala-video');
  const pantalla = $('sala-pantalla');
  const btnSonido = $('btn-sonido');
  const btnMute = $('btn-mute');
  const volumen = $('sala-volumen');
  const demoraEl = $('sala-demora');
  const selVista = $('sala-calidad');

  let peer = null;
  let conn = null;
  let llamada = null;
  let enVivo = false;
  let reintento = null;
  let vigiaImagen = null;
  const medir = crearMedidor();

  let vista = guardado.leer('vista', 'auto');
  if (!Object.hasOwn(VISTAS, vista)) vista = 'auto';
  selVista.value = vista;
  selVista.addEventListener('change', () => {
    vista = selVista.value;
    guardado.escribir('vista', vista);
    if (conn?.open) conn.send({ tipo: 'vista', valor: vista });
  });

  video.volume = Number(guardado.leer('volumen', '1')) || 1;
  volumen.value = video.volume;

  function aviso(titulo, texto) {
    $('sala-aviso').hidden = false;
    $('sala-aviso-titulo').textContent = titulo;
    $('sala-aviso-texto').textContent = texto;
  }

  function reintentar(ms) {
    clearTimeout(reintento);
    reintento = setTimeout(conectarCabina, ms);
  }

  function apagarPantalla() {
    video.srcObject = null;
    delete video.dataset.activo;
    demoraEl.textContent = '';
    btnSonido.hidden = true;
  }

  function conectar() {
    aviso('Buscando la sala', 'Un momento.');
    peer = new Peer({ debug: 1 });
    peer.on('open', conectarCabina);
    peer.on('call', atender);
    peer.on('disconnected', () => {
      setTimeout(() => { if (peer && !peer.destroyed && peer.disconnected) peer.reconnect(); }, 2000);
    });
    peer.on('error', (err) => {
      if (err.type === 'peer-unavailable') {
        if (!enVivo) aviso('La cabina está cerrada', 'Cuando empiece la transmisión en esta sala, la imagen aparece sola. No hace falta recargar.');
        reintentar(4000);
      } else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) {
        if (!enVivo) aviso('No hay conexión con el servidor de salas', 'Revisá tu internet. Se reintenta solo.');
        if (peer.destroyed) setTimeout(conectar, 4000);
      } else if (err.type === 'browser-incompatible') {
        aviso('Este navegador no puede mostrar la transmisión', 'Probá con Chrome, Edge, Firefox o Safari actualizados.');
      }
    });
  }

  function conectarCabina() {
    if (!peer || peer.destroyed || peer.disconnected) return;
    if (conn?.open) return;
    conn?.close();
    const actual = peer.connect(PREFIJO + sala, { metadata: { nombre, vista }, serialization: 'json', reliable: true });
    conn = actual;
    // Si en 15 s no abrió (red muy cerrada), volver a probar.
    const limite = setTimeout(() => { if (conn === actual && !actual.open) { actual.close(); reintentar(1000); } }, 15000);
    actual.on('open', () => {
      clearTimeout(limite);
      if (!enVivo) aviso('La función todavía no empezó', 'Ya estás en tu butaca. La pantalla se enciende cuando empiece la transmisión.');
    });
    actual.on('data', (msg) => {
      if (conn !== actual || !msg || msg.tipo !== 'estado') return;
      const n = Array.isArray(msg.espectadores) ? msg.espectadores.length : 0;
      $('sala-cuenta').textContent = n === 1 ? '1 mirando' : n + ' mirando';
      enVivo = !!msg.enVivo;
      ponerAire('sala', enVivo);
      clearTimeout(vigiaImagen);
      if (!enVivo) {
        apagarPantalla();
        aviso('La función todavía no empezó', 'Ya estás en tu butaca. La pantalla se enciende cuando empiece la transmisión.');
      } else if (!video.srcObject) {
        aviso('Recibiendo imagen', 'Un segundo.');
        vigilarImagen();
      }
    });
    actual.on('close', () => {
      clearTimeout(limite);
      if (conn !== actual) return;
      enVivo = false;
      ponerAire('sala', false);
      $('sala-cuenta').textContent = '';
      llamada?.close();
      apagarPantalla();
      aviso('La cabina está cerrada', 'Cuando empiece la transmisión en esta sala, la imagen aparece sola. No hace falta recargar.');
      reintentar(2000);
    });
  }

  // Si está en vivo pero la imagen no llega, pedirla de nuevo.
  function vigilarImagen() {
    clearTimeout(vigiaImagen);
    vigiaImagen = setTimeout(() => {
      if (enVivo && !video.srcObject && conn?.open) {
        conn.send({ tipo: 'pedir-imagen' });
        vigilarImagen();
      }
    }, 8000);
  }

  function atender(nueva) {
    llamada?.close();
    llamada = nueva;
    nueva.answer();
    const pc = nueva.peerConnection;
    nueva.on('stream', (s) => {
      // PeerJS avisa una vez por pista (video y audio): reproducir una sola vez.
      if (llamada !== nueva || video.srcObject === s) return;
      // Demora mínima: sin colchón extra en el buffer de jitter.
      for (const r of pc.getReceivers()) {
        if ('jitterBufferTarget' in r) r.jitterBufferTarget = 0;
        else if ('playoutDelayHint' in r) r.playoutDelayHint = 0;
      }
      video.srcObject = s;
      video.dataset.activo = '';
      $('sala-aviso').hidden = true;
      clearTimeout(vigiaImagen);
      reproducir();
    });
    nueva.on('close', () => {
      if (llamada !== nueva) return;
      llamada = null;
      apagarPantalla();
      if (enVivo) { aviso('Recibiendo imagen', 'Un segundo.'); vigilarImagen(); }
    });
    if (pc) {
      iceDirecto(pc, (estado) => {
        if (estado === 'failed' && llamada === nueva && conn?.open) conn.send({ tipo: 'pedir-imagen' });
      });
    }
  }

  function marcarMudo(mudo) {
    video.muted = mudo;
    btnMute.setAttribute('aria-pressed', String(mudo));
    btnMute.textContent = mudo ? 'Activar sonido' : 'Silenciar';
  }

  async function reproducir() {
    const elegido = guardado.leer('mudo', '0') === '1';
    video.muted = elegido;
    try {
      await video.play();
      marcarMudo(elegido);
      btnSonido.hidden = true;
    } catch {
      // El navegador no dejó arrancar con sonido: arrancar mudo y ofrecer el botón.
      marcarMudo(true);
      btnSonido.hidden = false;
      video.play().catch(() => {});
    }
  }

  // Medir demora y contarle a la cabina.
  setInterval(async () => {
    const pc = llamada?.peerConnection;
    if (!pc || !video.srcObject) return;
    try {
      const m = await medir(pc);
      if (!m) return;
      const resolucion = m.alto ? m.alto + 'p' : '';
      demoraEl.textContent = `${resolucion} ${m.fps} fps, demora ≈ ${m.ms} ms`.trim();
      demoraEl.dataset.tono = m.ms <= 250 ? 'bien' : m.ms > 600 ? 'alerta' : '';
      if (conn?.open) conn.send({ tipo: 'demora', ms: m.ms });
    } catch { /* sin estadísticas */ }
  }, 1000);

  btnSonido.addEventListener('click', () => {
    marcarMudo(false);
    guardado.escribir('mudo', '0');
    btnSonido.hidden = true;
  });
  btnMute.addEventListener('click', () => {
    const silenciar = !video.muted;
    marcarMudo(silenciar);
    guardado.escribir('mudo', silenciar ? '1' : '0');
    if (!silenciar) btnSonido.hidden = true;
  });
  volumen.addEventListener('input', () => {
    video.volume = Number(volumen.value);
    guardado.escribir('volumen', volumen.value);
  });

  function pantallaCompleta() {
    if (document.fullscreenElement) return document.exitFullscreen();
    if (pantalla.requestFullscreen) return pantalla.requestFullscreen().catch(() => {});
    if (video.webkitEnterFullscreen) video.webkitEnterFullscreen(); // iPhone
  }
  $('btn-completa').addEventListener('click', pantallaCompleta);
  pantalla.addEventListener('dblclick', pantallaCompleta);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'f' && !e.ctrlKey && !e.metaKey && !e.altKey && e.target === document.body) pantallaCompleta();
  });
  window.addEventListener('pagehide', () => peer?.destroy());

  conectar();
}

// ---------- Arranque ----------

(function arrancar() {
  const params = new URLSearchParams(location.search);
  const sala = aSlug(params.get('sala'));
  if (!sala) iniciarInicio();
  else if (params.has('cabina')) iniciarCabina(sala);
  else iniciarSala(sala);
})();
