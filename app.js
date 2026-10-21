'use strict';

// Butaca: una cabina comparte pantalla, las butacas miran.
// El video viaja por el SFU de Cloudflare Realtime (entra por Buenos Aires, Córdoba, Neuquén o São Paulo):
// la cabina sube una sola vez, en tres capas (simulcast), y cada butaca recibe la que le da su conexión.
// Un Worker con un Durable Object por sala coordina todo (servidor/PROTOCOLO.md). Ver DESIGN.md.

// Servidor de salas. Se puede cambiar con ?servidor=ws://... para pruebas locales.
const SERVIDOR = 'wss://butaca-servidor.penales-salas.workers.dev';

const CALIDADES = {
  liviana: { ancho: 1280, alto: 720, fps: 30, kbps: 2500 },
  normal: { ancho: 1920, alto: 1080, fps: 30, kbps: 5000 },
  alta: { ancho: 1920, alto: 1080, fps: 60, kbps: 8000 },
};

// Capa que pide cada butaca. "auto" deja que el SFU baje de capa si a esa butaca no le da la conexión.
const VISTAS = {
  auto: { capa: 'f', auto: true },
  h: { capa: 'h', auto: false },
  q: { capa: 'q', auto: false },
};

// Capas de simulcast que sube la cabina: completa, media (~720p) y baja (~360p).
function capasSimulcast(c) {
  return [
    { rid: 'f', maxBitrate: c.kbps * 1000, maxFramerate: c.fps },
    { rid: 'h', scaleResolutionDownBy: Math.max(1.5, c.alto / 720), maxBitrate: Math.min(c.kbps, 1800) * 1000, maxFramerate: c.fps },
    { rid: 'q', scaleResolutionDownBy: Math.max(3, c.alto / 360), maxBitrate: 600 * 1000, maxFramerate: 30 },
  ];
}

const NOTAS_CONTENIDO = {
  movimiento: 'Prioriza fluidez: si la red no alcanza, baja la nitidez antes que sumar demora.',
  texto: 'Prioriza nitidez: la letra se lee bien, pero con poca red baja la fluidez.',
};

const $ = (id) => document.getElementById(id);

function urlServidor(sala, params) {
  const base = new URLSearchParams(location.search).get('servidor') || SERVIDOR;
  return `${base.replace(/\/$/, '')}/sala/${encodeURIComponent(sala)}?${new URLSearchParams(params)}`;
}

// WebSocket con el servidor de la sala: pedidos con respuesta, avisos y reconexión sola.
class Canal {
  constructor(url) {
    this.url = url;
    this.oyentes = new Map();
    this.pendientes = new Map();
    this.reqId = 0;
    this.intentos = 0;
    this.terminado = false;
    this.abrir();
    this.latido = setInterval(() => this.enviar({ tipo: 'ping' }), 20000);
  }

  abrir() {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => { this.intentos = 0; };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (!msg || typeof msg !== 'object') return;
      if (msg.tipo === 'respuesta') {
        const p = this.pendientes.get(msg.reqId);
        if (!p) return;
        this.pendientes.delete(msg.reqId);
        if (msg.ok) p.resolver(msg.datos || {});
        else p.rechazar(new Error(msg.error || 'El servidor no pudo hacerlo.'));
        return;
      }
      this.emitir(msg.tipo, msg);
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      for (const p of this.pendientes.values()) p.rechazar(new Error('Se cortó la conexión con el servidor.'));
      this.pendientes.clear();
      this.emitir('cerrado', ev);
      // 4001 (cabina ocupada) y 4002 (sala llena) los decide quien usa el canal.
      if (!this.terminado && ev.code !== 4001 && ev.code !== 4002) this.reintentar();
    };
  }

  reintentar() {
    clearTimeout(this.temporizador);
    this.temporizador = setTimeout(() => this.abrir(), Math.min(8000, 800 * 2 ** this.intentos++));
  }

  get abierto() {
    return this.ws.readyState === WebSocket.OPEN;
  }

  enviar(msg) {
    if (this.abierto) this.ws.send(JSON.stringify(msg));
  }

  pedido(accion, datos = {}) {
    return new Promise((resolver, rechazar) => {
      if (!this.abierto) { rechazar(new Error('Sin conexión con el servidor.')); return; }
      const reqId = ++this.reqId;
      this.pendientes.set(reqId, { resolver, rechazar });
      this.enviar({ tipo: 'pedido', reqId, accion, datos });
      setTimeout(() => {
        if (this.pendientes.delete(reqId)) rechazar(new Error('El servidor no respondió a tiempo.'));
      }, 20000);
    });
  }

  on(tipo, fn) {
    if (!this.oyentes.has(tipo)) this.oyentes.set(tipo, []);
    this.oyentes.get(tipo).push(fn);
  }

  emitir(tipo, msg) {
    for (const fn of this.oyentes.get(tipo) || []) {
      try { fn(msg); } catch (err) { console.error(err); }
    }
  }

  cerrar() {
    this.terminado = true;
    clearInterval(this.latido);
    clearTimeout(this.temporizador);
    this.ws.close();
  }
}

// Servidores ICE que manda el servidor (STUN y TURN de Cloudflare). Con ?ruta=relay se fuerza el TURN.
function configuracionRtc(ice) {
  const config = { iceServers: Array.isArray(ice) && ice.length ? ice : [{ urls: 'stun:stun.cloudflare.com:3478' }], bundlePolicy: 'max-bundle' };
  if (new URLSearchParams(location.search).get('ruta') === 'relay') config.iceTransportPolicy = 'relay';
  return config;
}

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

// Lee getStats y estima la demora de punta a punta del lado de quien mira.
function crearMedidor() {
  let previo = null;
  return async function medir(pc) {
    const stats = await pc.getStats();
    let video = null;
    let rtt = null;
    let par = null;
    stats.forEach((s) => {
      if (s.type === 'inbound-rtp' && s.kind === 'video') video = s;
      if (s.type === 'candidate-pair' && s.state === 'succeeded' && s.nominated) {
        par = s;
        if (s.currentRoundTripTime != null) rtt = s.currentRoundTripTime;
      }
    });
    if (!video) return null;
    const ruta = par ? stats.get(par.localCandidateId)?.candidateType : null;
    let buffer = 0;
    let decodificar = 0;
    let perdida = 0;
    if (previo) {
      const perdidos = (video.packetsLost || 0) - (previo.packetsLost || 0);
      const recibidos = (video.packetsReceived || 0) - (previo.packetsReceived || 0);
      if (perdidos + recibidos > 0) perdida = Math.max(0, perdidos) / (Math.max(0, perdidos) + recibidos);
      const emitidos = (video.jitterBufferEmittedCount || 0) - (previo.jitterBufferEmittedCount || 0);
      if (emitidos > 0) buffer = ((video.jitterBufferDelay || 0) - (previo.jitterBufferDelay || 0)) / emitidos;
      const cuadros = (video.framesDecoded || 0) - (previo.framesDecoded || 0);
      if (cuadros > 0) decodificar = ((video.totalDecodeTime || 0) - (previo.totalDecodeTime || 0)) / cuadros;
    }
    previo = video;
    // Red (ida) + buffer de jitter + decodificación + ~1 cuadro de captura/codificación.
    const fps = video.framesPerSecond || 30;
    const ms = Math.round(((rtt ?? 0) / 2 + buffer + decodificar) * 1000 + Math.min(1000 / fps, 34));
    return {
      ms, ancho: video.frameWidth, alto: video.frameHeight, fps: Math.round(video.framesPerSecond || 0),
      perdida, congelamientos: video.freezeCount || 0, relay: ruta === 'relay',
    };
  };
}

// Arranque rápido: WebRTC empieza en ~300 kbps y tarda medio minuto en llegar a HD.
// Con x-google-start-bitrate arranca cerca de la calidad pedida (Chrome, Edge y la app).
function arranqueRapido(kbps) {
  return (sdp) => {
    const lineas = sdp.split('\r\n');
    const tipos = new Map();
    for (const l of lineas) {
      const m = /^a=rtpmap:(\d+) (VP8|VP9|H264|AV1)\//i.exec(l);
      if (m) tipos.set(m[1], true);
    }
    const salida = [];
    for (const l of lineas) {
      const fmtp = /^a=fmtp:(\d+) (.*)$/.exec(l);
      if (fmtp && tipos.has(fmtp[1])) {
        salida.push(l.includes('x-google-start-bitrate') ? l : `${l};x-google-start-bitrate=${kbps}`);
        tipos.set(fmtp[1], false);
        continue;
      }
      salida.push(l);
      const rtpmap = /^a=rtpmap:(\d+) /.exec(l);
      // VP8 no trae línea fmtp: se agrega una.
      if (rtpmap && tipos.get(rtpmap[1]) && !lineas.some((x) => x.startsWith(`a=fmtp:${rtpmap[1]} `))) {
        salida.push(`a=fmtp:${rtpmap[1]} x-google-start-bitrate=${kbps}`);
        tipos.set(rtpmap[1], false);
      }
    }
    return salida.join('\r\n');
  };
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

  const espectadores = new Map(); // id -> { id, nombre, vista, medida }
  let captura = null; // lo que da getDisplayMedia
  let stream = null; // lo que se publica: video + sonido de la pantalla + micrófono
  let canal = null;
  let ice = null;
  let pc = null; // conexión con el SFU de Cloudflare
  let transceptores = null; // { video, pantalla, micro }
  const btnMicro = $('btn-micro');
  let microActivo = false;
  let intentosOcupada = 0;
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

  function conectar() {
    aviso('Conectando la cabina', 'Un momento.', false);
    canal = new Canal(urlServidor(sala, { rol: 'cabina' }));
    canal.on('bienvenida', (msg) => {
      ice = msg.ice;
      intentosOcupada = 0;
      // Si se cortó el servidor en plena transmisión, el servidor olvidó la publicación: volver a publicar.
      if (stream) publicar().catch(errorPublicar);
      else aviso('La cabina está lista', 'Elegí la pantalla entera, una ventana o una pestaña. Quien tenga el link la ve al instante.', true);
    });
    canal.on('estado', (msg) => {
      const anteriores = new Map(espectadores);
      espectadores.clear();
      for (const x of Array.isArray(msg.espectadores) ? msg.espectadores : []) {
        if (!x || typeof x.id !== 'string') continue;
        espectadores.set(x.id, {
          id: x.id,
          nombre: limpiarNombre(x.nombre),
          vista: Object.hasOwn(VISTAS, x.vista) ? x.vista : 'auto',
          medida: anteriores.get(x.id)?.medida || null,
        });
      }
      dibujarFila();
    });
    canal.on('medida', (msg) => {
      const e = espectadores.get(msg.id);
      if (!e) return;
      const numero = (v, max) => (Number.isFinite(v) ? Math.max(0, Math.min(max, v)) : 0);
      e.medida = {
        ms: Math.round(numero(msg.ms, 99999)),
        perdida: numero(msg.perdida, 1),
        alto: Math.round(numero(msg.alto, 4320)),
        relay: msg.relay === true,
      };
      dibujarFila();
    });
    canal.on('cerrado', (ev) => {
      if (ev.code === 4001) {
        // Al recargar, el servidor puede tardar unos segundos en soltar la cabina anterior.
        if (++intentosOcupada <= 4) {
          aviso('Conectando la cabina', 'Recuperando la sala…', false);
          setTimeout(() => canal.abrir(), 3000);
        } else {
          aviso('Esta sala ya tiene a alguien transmitiendo', 'Elegí otro nombre de sala desde el inicio.', false);
        }
      } else if (!stream) {
        aviso('No hay conexión con el servidor de salas', 'Revisá tu internet. Se reintenta solo.', false);
      }
    });
  }

  // Publica la captura en el SFU: una conexión, video en tres capas y dos audios separados.
  let publicando = null;
  function publicar() {
    if (!publicando) publicando = publicarAhora().finally(() => { publicando = null; });
    return publicando;
  }

  async function publicarAhora() {
    if (!stream || !canal?.abierto) return;
    pc?.close();
    const c = CALIDADES[calidad];
    const nueva = new RTCPeerConnection(configuracionRtc(ice));
    pc = nueva;
    const [pistaVideo] = stream.getVideoTracks();
    transceptores = {
      video: nueva.addTransceiver(pistaVideo, { direction: 'sendonly', streams: [stream], sendEncodings: capasSimulcast(c) }),
      pantalla: nueva.addTransceiver(audio.pantalla, { direction: 'sendonly', streams: [stream] }),
      micro: nueva.addTransceiver(audio.micro, { direction: 'sendonly', streams: [stream] }),
    };
    nueva.addEventListener('connectionstatechange', () => {
      if (pc !== nueva || nueva.connectionState !== 'failed' || !stream) return;
      setTimeout(() => { if (pc === nueva && stream) publicar().catch(errorPublicar); }, 1500);
    });
    await nueva.setLocalDescription(await nueva.createOffer());
    const { sdp } = await canal.pedido('publicar', {
      sdp: nueva.localDescription.sdp,
      pistas: [
        { mid: transceptores.video.mid, trackName: 'video' },
        { mid: transceptores.pantalla.mid, trackName: 'pantalla' },
        { mid: transceptores.micro.mid, trackName: 'micro' },
      ],
    });
    if (pc !== nueva) return;
    await nueva.setRemoteDescription({ type: 'answer', sdp: arranqueRapido(Math.min(2500, c.kbps))(sdp) });
    ajustarVideo();
    avisarSonido();
    $('cabina-alerta').textContent = '';
  }

  function errorPublicar(err) {
    if (!stream) return;
    $('cabina-alerta').textContent = `No se pudo publicar la imagen (${err.message}) Se vuelve a intentar sola.`;
    setTimeout(() => { if (stream && canal?.abierto) publicar().catch(errorPublicar); }, 4000);
  }

  // Ajusta las capas de simulcast a la calidad y al tipo de contenido elegidos.
  function ajustarVideo() {
    const sender = transceptores?.video.sender;
    if (!sender) return;
    const p = sender.getParameters();
    if (!p.encodings?.length) return;
    const capas = capasSimulcast(CALIDADES[calidad]);
    for (const enc of p.encodings) {
      const capa = capas.find((x) => x.rid === enc.rid);
      if (capa) Object.assign(enc, capa);
    }
    // "balanced": ante poca red baja un poco resolución y un poco fluidez, sin desplomar ninguna.
    p.degradationPreference = contenido === 'texto' ? 'maintain-resolution' : 'balanced';
    sender.setParameters(p).catch(() => {});
  }

  async function aplicarCalidad() {
    if (!stream) return;
    const c = CALIDADES[calidad];
    const pista = stream.getVideoTracks()[0];
    if (pista) {
      pista.contentHint = contenido === 'texto' ? 'detail' : 'motion';
      await pista.applyConstraints({ width: { ideal: c.ancho }, height: { ideal: c.alto }, frameRate: { ideal: c.fps, max: c.fps } }).catch(() => {});
    }
    ajustarVideo();
    dibujarFila();
  }

  // Si la imagen está frenada por la CPU o por la subida, decirlo con qué hacer.
  setInterval(async () => {
    if (!pc || !stream) return;
    try {
      const stats = await pc.getStats();
      let limite = 'none';
      stats.forEach((x) => {
        if (x.type === 'outbound-rtp' && x.kind === 'video' && (x.rid === 'f' || !x.rid)) limite = x.qualityLimitationReason || 'none';
      });
      const nota = $('cabina-alerta');
      if (limite === 'cpu') nota.textContent = 'Tu compu no da abasto codificando: bajá a 720p o cerrá programas pesados.';
      else if (limite === 'bandwidth') nota.textContent = 'Tu subida de internet no alcanza para esta calidad: bajá a 720p para que se vea parejo.';
      else if (!nota.textContent.startsWith('No se pudo')) nota.textContent = '';
    } catch { /* sin estadísticas */ }
  }, 3000);

  // Audio en dos pistas separadas: pantalla y micrófono. Si falta una fuente viaja una pista muda,
  // así prender o apagar el micrófono es un replaceTrack sin renegociar.
  let audio = null; // { ctx, pantalla, micro, mudaMicro, microReal }

  function pistaMuda(ctx) {
    return ctx.createMediaStreamDestination().stream.getAudioTracks()[0];
  }

  async function reemplazarMicro(nueva) {
    const vieja = audio.micro;
    if (vieja === nueva) return;
    audio.micro = nueva;
    stream.removeTrack(vieja);
    stream.addTrack(nueva);
    await transceptores?.micro.sender.replaceTrack(nueva).catch(() => {});
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
    avisarSonido();
    return true;
  }

  async function desconectarMicro() {
    if (!audio?.microReal) return;
    const real = audio.microReal;
    audio.microReal = null;
    await reemplazarMicro(audio.mudaMicro);
    real.stop();
    avisarSonido();
  }

  // Le cuenta a la sala qué sonidos hay, para mostrar u ocultar cada volumen.
  function avisarSonido() {
    if (!canal?.abierto) return;
    canal.pedido('sonido', { pantalla: !!captura?.getAudioTracks().length, micro: !!audio?.microReal }).catch(() => {});
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
    await aplicarCalidad();
    if (captura !== mia) return; // se cortó mientras se ajustaba la calidad
    video.srcObject = new MediaStream([pista]);
    video.dataset.activo = '';
    $('cabina-aviso').hidden = true;
    btnCortar.hidden = false;
    ponerAire('cabina', true);
    $('cabina-minimizar').hidden = false;
    contarSonido();
    dibujarFila();
    await publicar().catch(errorPublicar);
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
    pc?.close();
    pc = null;
    transceptores = null;
    canal?.pedido('cortar').catch(() => {});
    video.srcObject = null;
    delete video.dataset.activo;
    btnCortar.hidden = true;
    $('cabina-minimizar').hidden = true;
    $('cabina-alerta').textContent = '';
    contarSonido();
    ponerAire('cabina', false);
    aviso('Transmisión cortada', 'Tus amigos siguen en la sala. Cuando vuelvas a compartir, la imagen les aparece sola.', true);
    dibujarFila();
  }

  // Prender y apagar el micrófono va de a una operación: cada replaceTrack
  // termina antes de que empiece la siguiente.
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

  const NOMBRES_VISTA = { auto: '', h: '720p ', q: '360p ' };

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
        const vista = NOMBRES_VISTA[e.vista] || '';
        demora.textContent = e.medida && stream ? vista + e.medida.ms + ' ms' : vista.trim();
        const problemas = [];
        if (e.medida?.relay) problemas.push('conexión por servidor TURN');
        if ((e.medida?.perdida ?? 0) > 0.04) problemas.push(`pierde ${Math.round(e.medida.perdida * 100)}% de los datos`);
        if (problemas.length) {
          li.dataset.problema = '';
          li.title = e.nombre + ': ' + problemas.join(', ');
        }
        li.append(demora);
      }
      fila.append(li);
    }
    const c = CALIDADES[calidad];
    const nota = $('cabina-subida');
    const mbps = Math.round((c.kbps + Math.min(c.kbps, 1800) + 600) / 100) / 10;
    nota.textContent = lista.length
      ? `Subís la imagen una sola vez, en tres calidades: unos ${mbps} Mbps, sin importar cuántos miren. Cada butaca recibe la que le da su conexión.`
      : 'Todavía no entró nadie. Mandales el link.';
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
    aplicarCalidad();
  });
  segmentos('sel-contenido', contenido, (v) => {
    contenido = v;
    guardado.escribir('contenido', v);
    $('cabina-nota-contenido').textContent = NOTAS_CONTENIDO[v];
    aplicarCalidad();
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
  window.addEventListener('pagehide', () => { canal?.cerrar(); pc?.close(); });

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

  let canal = null;
  let ice = null;
  let pc = null; // conexión con el SFU
  let enVivo = false;
  let publicacion = null; // la última que anunció el servidor
  let suscrita = null; // a la que está conectada esta butaca
  let cola = Promise.resolve();
  let vigia = null;
  const medir = crearMedidor();

  let vista = guardado.leer('vista', 'auto');
  // Valores de la versión anterior.
  if (vista === '720') vista = 'h';
  else if (vista === '480' || vista === '360') vista = 'q';
  if (!Object.hasOwn(VISTAS, vista)) vista = 'auto';
  selVista.value = vista;
  selVista.addEventListener('change', () => {
    vista = Object.hasOwn(VISTAS, selVista.value) ? selVista.value : 'auto';
    guardado.escribir('vista', vista);
    canal?.enviar({ tipo: 'vista', valor: vista });
    if (pc && suscrita != null) {
      encolar(async () => {
        const r = await canal.pedido('capa', VISTAS[vista]);
        if (r.sdp) await renegociar(pc, r.sdp);
      });
    }
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

  function apagarPantalla() {
    clearTimeout(vigia);
    pc?.close();
    pc = null;
    suscrita = null;
    video.srcObject = null;
    delete video.dataset.activo;
    for (const el of Object.values(sonidos)) el.srcObject = null;
    demoraEl.textContent = '';
    btnSonido.hidden = true;
  }

  // Las operaciones con el SFU van de a una (Cloudflare pide terminar cada renegociación antes de otra).
  function encolar(tarea) {
    cola = cola.then(tarea).catch((err) => {
      console.warn('Butaca:', err.message);
      if (enVivo) programarReintento();
    });
    return cola;
  }

  let reintento = null;
  function programarReintento() {
    clearTimeout(reintento);
    reintento = setTimeout(() => { suscrita = null; encolar(suscribir); }, 2000);
  }

  function conectar() {
    aviso('Buscando la sala', 'Un momento.');
    canal = new Canal(urlServidor(sala, { rol: 'butaca', nombre, vista }));
    canal.on('bienvenida', (msg) => {
      ice = msg.ice;
      suscrita = null;
      if (!enVivo) aviso('La función todavía no empezó', 'Ya estás en tu butaca. La pantalla se enciende cuando empiece la transmisión.');
    });
    canal.on('estado', (msg) => {
      const n = Array.isArray(msg.espectadores) ? msg.espectadores.length : 0;
      $('sala-cuenta').textContent = n === 1 ? '1 mirando' : n + ' mirando';
      $('sala-control-micro').hidden = !msg.microfono;
      $('sala-control-pantalla').hidden = !msg.sonidoPantalla;
      enVivo = !!msg.enVivo;
      ponerAire('sala', enVivo);
      if (!enVivo) {
        apagarPantalla();
        aviso('La función todavía no empezó', 'Ya estás en tu butaca. La pantalla se enciende cuando empiece la transmisión.');
        return;
      }
      publicacion = msg.publicacion;
      if (publicacion !== suscrita) encolar(suscribir);
    });
    canal.on('cerrado', (ev) => {
      enVivo = false;
      ponerAire('sala', false);
      apagarPantalla();
      if (ev.code === 4002) aviso('La sala está llena', 'Ya hay 40 personas mirando. Probá de nuevo en un rato.');
      else aviso('Se cortó la conexión con la sala', 'Reconectando sola…');
    });
  }

  async function suscribir() {
    if (!enVivo || !canal?.abierto || (pc && suscrita === publicacion)) return;
    pc?.close();
    clearTimeout(vigia);
    if (!video.srcObject) aviso('Recibiendo imagen', 'Un segundo.');
    const nueva = new RTCPeerConnection(configuracionRtc(ice));
    pc = nueva;
    nueva.addEventListener('connectionstatechange', () => {
      if (pc === nueva && nueva.connectionState === 'failed') programarReintento();
    });
    const r = await canal.pedido('suscribir', VISTAS[vista]);
    if (pc !== nueva) return;
    await renegociar(nueva, r.sdp);
    if (pc !== nueva) return;
    suscrita = r.publicacion ?? publicacion;

    const midDe = (pista) => r.pistas?.find((p) => p.trackName === pista)?.mid;
    const pistaDe = (pista) => nueva.getTransceivers().find((t) => t.mid === midDe(pista))?.receiver.track || null;
    const pistaVideo = pistaDe('video');
    video.srcObject = pistaVideo ? new MediaStream([pistaVideo]) : null;
    for (const clave of ['pantalla', 'micro']) {
      const pista = pistaDe(clave);
      sonidos[clave].srcObject = pista ? new MediaStream([pista]) : null;
    }
    video.dataset.activo = '';
    reproducir();
    // Si en 10 s no llegó imagen, volver a suscribirse.
    vigia = setTimeout(() => { if (pc === nueva && !video.videoWidth) programarReintento(); }, 10000);
  }

  // Oferta del SFU: contestarla y mandar la respuesta.
  async function renegociar(conexion, sdp) {
    await conexion.setRemoteDescription({ type: 'offer', sdp });
    await conexion.setLocalDescription(await conexion.createAnswer());
    await canal.pedido('responder', { sdp: conexion.localDescription.sdp });
  }

  video.addEventListener('loadeddata', () => { $('sala-aviso').hidden = true; });

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

  // Medir demora, mostrarla y contarle a la cabina.
  let ultimaMedida = 0;
  setInterval(async () => {
    if (!pc || !video.srcObject) return;
    try {
      const m = await medir(pc);
      if (!m) return;
      const resolucion = m.alto ? m.alto + 'p' : '';
      let texto = `${resolucion} ${m.fps} fps, demora ≈ ${m.ms} ms`.trim();
      if (m.perdida > 0.02) texto += `, se pierde el ${Math.round(m.perdida * 100)}% de los datos`;
      if (m.relay) texto += ', conexión por servidor TURN';
      demoraEl.textContent = texto;
      demoraEl.dataset.tono = m.ms > 600 || m.perdida > 0.04 ? 'alerta' : m.ms <= 250 ? 'bien' : '';
      if (Date.now() - ultimaMedida >= 4000) {
        ultimaMedida = Date.now();
        canal?.enviar({ tipo: 'medida', ms: m.ms, perdida: m.perdida, alto: m.alto || 0, fps: m.fps, congelamientos: m.congelamientos, relay: m.relay });
      }
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
  window.addEventListener('pagehide', () => { canal?.cerrar(); pc?.close(); });

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
