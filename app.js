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
  if (typeof texto !== 'string') return 'Alguien';
  const limpio = texto.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 20);
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
  // También en el título: se ve en la barra de tareas con la pestaña minimizada.
  const titulo = document.title.replace(/^\(En vivo\) /, '');
  document.title = encendido ? '(En vivo) ' + titulo : titulo;
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
    const ms = Math.round(((rtt ?? 0) / 2 + buffer + decodificar) * 1000 + Math.min(1000 / fps, 34));
    return { ms, ancho: video.frameWidth, alto: video.frameHeight, fps: Math.round(video.framesPerSecond || 0) };
  };
}

function iceDirecto(pc, alCambiar) {
  pc.addEventListener('connectionstatechange', () => alCambiar(pc.connectionState));
}

// ---------- Inicio ----------

function iniciarInicio() {
  $('vista-inicio').hidden = false;
  if (window.butacaEscritorio) $('inicio-descarga').hidden = true;
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

  const escritorio = window.butacaEscritorio;
  // En la app de escritorio el link apunta a la versión web, que se abre en cualquier navegador.
  const linkSala = (escritorio?.linkBase || location.origin + location.pathname) + '?sala=' + encodeURIComponent(sala);
  $('cabina-link').value = linkSala;

  const video = $('cabina-video');
  const btnCompartir = $('btn-compartir');
  const btnCortar = $('btn-cortar');

  const espectadores = new Map(); // peerId -> { conn, nombre, llamada, demora }
  let captura = null; // lo que da getDisplayMedia
  let stream = null; // lo que se manda: video de la captura + audio mezclado
  let peer = null;
  const btnMicro = $('btn-micro');
  let microActivo = false;
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
      if (!stream) aviso('La cabina está lista', 'Elegí la pantalla entera, una ventana o una pestaña. Quien tenga el link la ve al instante.', true);
    });

    peer.on('connection', (conn) => {
      conn.on('open', () => {
        const previo = espectadores.get(conn.peer);
        if (previo && previo.conn !== conn) { previo.llamada?.close(); previo.conn.close(); }
        const pedida = conn.metadata?.vista;
        const vista = typeof pedida === 'string' && Object.hasOwn(VISTAS, pedida) ? pedida : 'auto';
        espectadores.set(conn.peer, { conn, nombre: limpiarNombre(conn.metadata?.nombre), llamada: null, demora: null, vista });
        if (stream) llamar(conn.peer);
        difundir();
      });
      conn.on('data', (msg) => {
        const e = espectadores.get(conn.peer);
        if (!e || e.conn !== conn || !msg || typeof msg !== 'object') return;
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
      conn.on('close', () => quitar(conn));
      conn.on('error', () => quitar(conn));
    });

    peer.on('disconnected', () => {
      // Se cayó el servidor de salas; las conexiones P2P siguen. Reconectar para recibir gente nueva.
      recuperar(peer);
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
        recuperar(peer);
      } else if (err.type === 'browser-incompatible') {
        aviso('Este navegador no sirve para transmitir', 'Probá con Chrome, Edge o Firefox actualizados.', false);
      }
    });
  }

  // PeerJS emite 'error' antes de destruir el peer: decidir un rato después qué hace falta.
  let temporizadorRecuperar = null;
  function recuperar(fallido) {
    clearTimeout(temporizadorRecuperar);
    temporizadorRecuperar = setTimeout(() => {
      if (peer !== fallido) return;
      if (fallido.destroyed) conectar();
      else if (fallido.disconnected) fallido.reconnect();
    }, 3000);
  }

  function quitar(conn) {
    const e = espectadores.get(conn.peer);
    if (!e || e.conn !== conn) return;
    e.llamada?.close();
    espectadores.delete(conn.peer);
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
    if (pc) {
      iceDirecto(pc, (estado) => {
        if (estado === 'connected') { codificar(pc, e); contarPistas(e, pc); }
      });
    }
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

  async function aplicarATodos() {
    if (!stream) return;
    const c = CALIDADES[calidad];
    const pista = stream.getVideoTracks()[0];
    if (pista) {
      pista.contentHint = contenido === 'texto' ? 'detail' : 'motion';
      // Esperar: la escala de cada butaca se calcula con la altura nueva de la fuente.
      await pista.applyConstraints({ width: { ideal: c.ancho }, height: { ideal: c.alto }, frameRate: { ideal: c.fps, max: c.fps } }).catch(() => {});
    }
    if (!stream) return;
    for (const e of espectadores.values()) {
      const pc = e.llamada?.peerConnection;
      if (pc && pc.connectionState === 'connected') codificar(pc, e);
    }
  }

  // Audio en dos pistas separadas, siempre en este orden: pantalla y micrófono.
  // Si falta una fuente viaja una pista muda en su lugar: prender o apagar el micrófono
  // es un replaceTrack sin renegociar, y cada butaca regula cada volumen por separado.
  let audio = null; // { ctx, pantalla, micro, mudaMicro, microReal }

  function pistaMuda(ctx) {
    return ctx.createMediaStreamDestination().stream.getAudioTracks()[0];
  }

  async function reemplazarMicro(nueva) {
    const vieja = audio.micro;
    if (vieja === nueva) return;
    audio.micro = nueva;
    // Quitar y volver a sumar deja el micrófono último, después de la pantalla.
    stream.removeTrack(vieja);
    stream.addTrack(nueva);
    const cambios = [];
    for (const e of espectadores.values()) {
      for (const sender of e.llamada?.peerConnection?.getSenders() || []) {
        if (sender.track === vieja) cambios.push(sender.replaceTrack(nueva).catch(() => {}));
      }
    }
    await Promise.all(cambios);
  }

  async function conectarMicro() {
    if (!audio || audio.microReal) return true;
    let micro;
    try {
      micro = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch {
      return false;
    }
    const pista = micro.getAudioTracks()[0];
    if (!audio || audio.microReal || !microActivo) { pista.stop(); return !!audio?.microReal; }
    audio.microReal = pista;
    await reemplazarMicro(pista);
    difundir();
    return true;
  }

  async function desconectarMicro() {
    if (!audio?.microReal) return;
    const real = audio.microReal;
    audio.microReal = null;
    await reemplazarMicro(audio.mudaMicro);
    real.stop();
    difundir();
  }

  // Avisarle a la butaca qué pista es cuál (por mid, que es igual en las dos puntas).
  function contarPistas(e, pc) {
    if (!audio || !e.conn.open) return;
    const mid = (pista) => pc.getTransceivers().find((t) => t.sender.track === pista)?.mid ?? null;
    e.conn.send({ tipo: 'pistas', pantalla: mid(audio.pantalla), micro: mid(audio.micro) });
  }

  function contarSonido() {
    const nota = $('cabina-sonido');
    if (!stream) {
      nota.textContent = microActivo ? 'El micrófono se suma apenas compartas la pantalla.' : '';
      return;
    }
    const pantalla = captura.getAudioTracks().length > 0;
    const micro = !!audio?.microReal;
    if (pantalla && micro) nota.textContent = 'Se escuchan la pantalla y tu micrófono, por separado: cada butaca regula cada volumen. Usá auriculares para que no se acople.';
    else if (pantalla) nota.textContent = 'Se escucha el sonido de la pantalla.';
    else if (micro && escritorio) nota.textContent = 'Se escucha sólo tu micrófono. Para sumar el sonido de la compu, cortá y volvé a compartir con "Incluir el sonido de la compu" marcado.';
    else if (micro) nota.textContent = 'Se escucha sólo tu micrófono. Para sumar el sonido de la pantalla, volvé a compartir eligiendo una pestaña (o la pantalla completa en Windows) con "Compartir audio" activado.';
    else if (escritorio) nota.textContent = 'Sin sonido de la compu. Para sumarlo, cortá y volvé a compartir con "Incluir el sonido de la compu" marcado.';
    else nota.textContent = 'Sin sonido. Para sumar el de la pantalla, volvé a compartir eligiendo una pestaña (o la pantalla completa en Windows) con "Compartir audio" activado.';
  }

  // Un solo pedido de pantalla a la vez (el selector y el portal pueden tardar).
  let pidiendo = false;
  async function compartir() {
    if (pidiendo || stream) return;
    pidiendo = true;
    try {
      await compartirAhora();
    } finally {
      pidiendo = false;
    }
  }

  async function compartirAhora() {
    const c = CALIDADES[calidad];
    // El AudioContext (para las pistas mudas) se crea dentro del clic.
    const ctx = new AudioContext();
    let fuente = null;
    let sonidoCompu = guardado.leer('sonido-compu', '1') === '1';
    if (escritorio?.selectorPropio) {
      const eleccion = await elegirFuente();
      if (!eleccion) { ctx.close(); return; }
      fuente = eleccion.id;
      sonidoCompu = eleccion.sonido;
    }
    const pedir = async (conSonido) => {
      if (escritorio) await escritorio.elegirFuente(fuente, conSonido);
      return navigator.mediaDevices.getDisplayMedia({
        // Abre el selector en "Toda la pantalla"; ventanas y pestañas siguen disponibles.
        video: { displaySurface: 'monitor', width: { ideal: c.ancho }, height: { ideal: c.alto }, frameRate: { ideal: c.fps, max: c.fps } },
        audio: !escritorio || conSonido ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false } : false,
        systemAudio: 'include',
        monitorTypeSurfaces: 'include',
        selfBrowserSurface: 'exclude',
        surfaceSwitching: 'include',
      });
    };
    try {
      try {
        captura = await pedir(sonidoCompu);
      } catch (err) {
        // En la app, una compu sin salida de audio puede rechazar el loopback: probar sólo con imagen.
        if (!escritorio || !sonidoCompu || err.name === 'NotAllowedError' || err.name === 'AbortError') throw err;
        captura = await pedir(false);
      }
    } catch (err) {
      ctx.close();
      captura = null;
      if (err.name !== 'NotAllowedError' && err.name !== 'AbortError') {
        aviso('No se pudo compartir la pantalla', 'El sistema no dio permiso. Probá de nuevo o reiniciá la app o el navegador.', true);
      }
      return;
    }
    const mia = captura;
    const pista = captura.getVideoTracks()[0];
    pista.addEventListener('ended', cortar);
    const mudaMicro = pistaMuda(ctx);
    audio = { ctx, pantalla: captura.getAudioTracks()[0] || pistaMuda(ctx), micro: mudaMicro, mudaMicro, microReal: null };
    stream = new MediaStream([pista, audio.pantalla, audio.micro]);
    if (microActivo && !(await operarMicro(conectarMicro))) marcarMicro(false);
    if (captura !== mia) return; // se cortó mientras se pedía el micrófono
    await aplicarATodos();
    if (captura !== mia) return; // se cortó mientras se ajustaba la calidad
    video.srcObject = new MediaStream([pista]);
    video.dataset.activo = '';
    $('cabina-aviso').hidden = true;
    btnCortar.hidden = false;
    ponerAire('cabina', true);
    $('cabina-minimizar').hidden = false;
    contarSonido();
    for (const id of espectadores.keys()) llamar(id);
    difundir();
  }

  // Selector propio de la app de escritorio: devuelve { id, sonido } o null.
  // El sonido de la compu lo captura la app por loopback (Windows y Linux).
  async function elegirFuente() {
    const dialogo = $('selector');
    const grupos = { pantalla: $('selector-pantallas'), ventana: $('selector-ventanas') };
    const btnProyectar = $('selector-proyectar');
    const casilla = $('selector-sonido');
    let elegida = null;

    grupos.pantalla.textContent = '';
    grupos.ventana.textContent = '';
    $('selector-grupo-pantallas').hidden = true;
    $('selector-grupo-ventanas').hidden = true;
    $('selector-cargando').hidden = false;
    $('selector-cargando').textContent = 'Buscando pantallas y ventanas…';
    btnProyectar.disabled = true;
    casilla.checked = guardado.leer('sonido-compu', '1') === '1';
    dialogo.returnValue = '';
    dialogo.showModal();

    const fuentes = await escritorio.listarFuentes().catch(() => []);

    $('selector-cargando').hidden = fuentes.length > 0;
    $('selector-cargando').textContent = 'No se encontraron pantallas ni ventanas para compartir.';
    for (const f of fuentes) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'fuente';
      b.setAttribute('aria-pressed', 'false');
      const imagen = f.miniatura ? document.createElement('img') : document.createElement('span');
      if (f.miniatura) { imagen.src = f.miniatura; imagen.alt = ''; } else imagen.className = 'fuente__sin';
      const nombre = document.createElement('span');
      nombre.className = 'fuente__nombre';
      nombre.textContent = f.tipo === 'pantalla' && fuentes.filter((x) => x.tipo === 'pantalla').length === 1 ? 'Pantalla entera' : f.nombre;
      b.append(imagen, nombre);
      b.addEventListener('click', () => {
        for (const otro of dialogo.querySelectorAll('.fuente')) otro.setAttribute('aria-pressed', 'false');
        b.setAttribute('aria-pressed', 'true');
        elegida = f.id;
        btnProyectar.disabled = false;
      });
      b.addEventListener('dblclick', () => { elegida = f.id; dialogo.close('proyectar'); });
      grupos[f.tipo].append(b);
      if (f.tipo === 'pantalla') $('selector-grupo-pantallas').hidden = false;
      else $('selector-grupo-ventanas').hidden = false;
    }
    // La primera pantalla queda elegida: es lo más común.
    grupos.pantalla.querySelector('.fuente')?.click();

    if (dialogo.open) await new Promise((r) => dialogo.addEventListener('close', r, { once: true }));
    if (dialogo.returnValue !== 'proyectar' || !elegida) return null;
    guardado.escribir('sonido-compu', casilla.checked ? '1' : '0');
    return { id: elegida, sonido: casilla.checked };
  }

  function cortar() {
    if (!stream) return;
    for (const pista of captura.getTracks()) pista.stop();
    audio.microReal?.stop();
    audio.ctx.close();
    audio = null;
    captura = null;
    stream = null;
    for (const e of espectadores.values()) { e.llamada?.close(); e.llamada = null; }
    video.srcObject = null;
    delete video.dataset.activo;
    btnCortar.hidden = true;
    $('cabina-minimizar').hidden = true;
    contarSonido();
    ponerAire('cabina', false);
    aviso('Transmisión cortada', 'Tus amigos siguen en la sala. Cuando vuelvas a compartir, la imagen les aparece sola.', true);
    difundir();
  }

  // Prender y apagar el micrófono va de a una operación: cada replaceTrack
  // termina antes de que empiece la siguiente, así ningún sender queda con la pista vieja.
  let colaMicro = Promise.resolve();
  let pendientesMicro = 0;
  function operarMicro(operacion) {
    pendientesMicro++;
    btnMicro.disabled = true;
    const hecho = colaMicro.then(operacion, operacion);
    colaMicro = hecho.catch(() => {});
    colaMicro.then(() => { if (--pendientesMicro === 0) btnMicro.disabled = false; });
    return hecho;
  }

  function marcarMicro(activo) {
    microActivo = activo;
    guardado.escribir('micro', activo ? '1' : '0');
    btnMicro.setAttribute('aria-pressed', String(activo));
    btnMicro.textContent = activo ? 'Apagar micrófono' : 'Activar micrófono';
  }

  btnMicro.addEventListener('click', async () => {
    if (microActivo) {
      marcarMicro(false);
      await operarMicro(desconectarMicro);
    } else {
      marcarMicro(true);
      if (stream && !(await operarMicro(conectarMicro))) {
        marcarMicro(false);
        $('cabina-sonido').textContent = 'El navegador no dio permiso para usar el micrófono. Habilitalo en el candado de la barra de direcciones.';
        return;
      }
    }
    contarSonido();
  });

  function difundir() {
    const estado = {
      tipo: 'estado',
      enVivo: !!stream,
      sonidoPantalla: !!captura?.getAudioTracks().length,
      microfono: !!audio?.microReal,
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

  marcarMicro(guardado.leer('micro', '0') === '1');
  contarSonido();
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
  // Pantalla y micrófono llegan en pistas separadas: un elemento de audio y un volumen para cada una.
  const sonidos = { pantalla: new Audio(), micro: new Audio() };
  const volumenes = { pantalla: $('sala-vol-pantalla'), micro: $('sala-vol-micro') };
  const demoraEl = $('sala-demora');
  const selVista = $('sala-calidad');

  let peer = null;
  let conn = null;
  let llamada = null;
  let recibido = null;
  let mids = null; // qué mid es la pantalla y cuál el micrófono, según la cabina
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

  for (const [clave, el] of Object.entries(sonidos)) {
    el.autoplay = true;
    const guardadoVol = Number(guardado.leer('volumen-' + clave, '1'));
    el.volume = Number.isFinite(guardadoVol) ? Math.min(1, Math.max(0, guardadoVol)) : 1;
    volumenes[clave].value = el.volume;
    volumenes[clave].addEventListener('input', () => {
      el.volume = Number(volumenes[clave].value);
      guardado.escribir('volumen-' + clave, volumenes[clave].value);
    });
  }

  function aviso(titulo, texto) {
    $('sala-aviso').hidden = false;
    $('sala-aviso-titulo').textContent = titulo;
    $('sala-aviso-texto').textContent = texto;
  }

  let temporizadorRecuperar = null;
  function recuperar(fallido) {
    clearTimeout(temporizadorRecuperar);
    temporizadorRecuperar = setTimeout(() => {
      if (peer !== fallido) return;
      if (fallido.destroyed) conectar();
      else if (fallido.disconnected) fallido.reconnect();
    }, 3000);
  }

  function reintentar(ms) {
    clearTimeout(reintento);
    reintento = setTimeout(conectarCabina, ms);
  }

  function apagarPantalla() {
    recibido = null;
    video.srcObject = null;
    for (const el of Object.values(sonidos)) el.srcObject = null;
    delete video.dataset.activo;
    demoraEl.textContent = '';
    btnSonido.hidden = true;
  }

  function conectar() {
    aviso('Buscando la sala', 'Un momento.');
    peer = new Peer({ debug: 1 });
    peer.on('open', conectarCabina);
    peer.on('call', atender);
    peer.on('disconnected', () => recuperar(peer));
    peer.on('error', (err) => {
      if (err.type === 'peer-unavailable') {
        if (!enVivo) aviso('La cabina está cerrada', 'Cuando empiece la transmisión en esta sala, la imagen aparece sola. No hace falta recargar.');
        reintentar(4000);
      } else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) {
        if (!enVivo) aviso('No hay conexión con el servidor de salas', 'Revisá tu internet. Se reintenta solo.');
        recuperar(peer);
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
      if (conn !== actual || !msg) return;
      if (msg.tipo === 'pistas') {
        mids = { pantalla: typeof msg.pantalla === 'string' ? msg.pantalla : null, micro: typeof msg.micro === 'string' ? msg.micro : null };
        if (llamada?.peerConnection && recibido) asignarAudio(llamada.peerConnection);
        return;
      }
      if (msg.tipo !== 'estado') return;
      $('sala-control-micro').hidden = !msg.microfono;
      $('sala-control-pantalla').hidden = !msg.sonidoPantalla;
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
    // Sólo se atiende a la cabina de esta sala.
    if (nueva.peer !== PREFIJO + sala) { nueva.close(); return; }
    llamada?.close();
    llamada = nueva;
    mids = null;
    nueva.answer();
    const pc = nueva.peerConnection;
    nueva.on('stream', (s) => {
      // PeerJS avisa una vez por pista (video y audio): reproducir una sola vez.
      if (llamada !== nueva || recibido === s) return;
      recibido = s;
      // Demora mínima: sin colchón extra en el buffer de jitter.
      for (const r of pc.getReceivers()) {
        if ('jitterBufferTarget' in r) r.jitterBufferTarget = 0;
        else if ('playoutDelayHint' in r) r.playoutDelayHint = 0;
      }
      video.srcObject = new MediaStream(s.getVideoTracks());
      asignarAudio(pc);
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

  // Ubica cada pista de audio por el mid que mandó la cabina; si todavía no llegó, por orden (pantalla, micrófono).
  function asignarAudio(pc) {
    const audios = pc.getTransceivers().filter((t) => t.receiver.track?.kind === 'audio');
    const porMid = (mid) => (mid ? audios.find((t) => t.mid === mid)?.receiver.track : null);
    const pistas = {
      pantalla: porMid(mids?.pantalla) || audios[0]?.receiver.track,
      micro: porMid(mids?.micro) || audios[1]?.receiver.track,
    };
    for (const [clave, el] of Object.entries(sonidos)) {
      const pista = pistas[clave];
      if (!pista) { el.srcObject = null; continue; }
      if (el.srcObject?.getAudioTracks()[0] === pista) continue;
      el.srcObject = new MediaStream([pista]);
      el.play().catch(() => {});
    }
  }

  function sonar() {
    return Promise.all(Object.values(sonidos).filter((el) => el.srcObject).map((el) => el.play()));
  }

  function marcarMudo(mudo) {
    for (const el of Object.values(sonidos)) el.muted = mudo;
    btnMute.setAttribute('aria-pressed', String(mudo));
    btnMute.textContent = mudo ? 'Activar sonido' : 'Silenciar';
  }

  async function reproducir() {
    marcarMudo(guardado.leer('mudo', '0') === '1');
    video.muted = true; // el video va sin audio: el sonido sale por los elementos de audio
    video.play().catch(() => {});
    try {
      await sonar();
      btnSonido.hidden = true;
    } catch {
      // El navegador no dejó arrancar con sonido: mostrar el botón para habilitarlo.
      btnSonido.hidden = false;
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
    // Reproducir dentro del clic: así lo habilitan todos los navegadores, Safari incluido.
    video.play().catch(() => {});
    sonar().then(() => { btnSonido.hidden = true; }, () => { btnSonido.hidden = false; });
  });
  btnMute.addEventListener('click', () => {
    const silenciar = !sonidos.pantalla.muted;
    marcarMudo(silenciar);
    guardado.escribir('mudo', silenciar ? '1' : '0');
    if (!silenciar) sonar().then(() => { btnSonido.hidden = true; }, () => {});
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
