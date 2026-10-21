import { DurableObject } from 'cloudflare:workers';
import { VISTAS, esObjeto, slugValido, nombreValido, validarMedida, validarSdp,
  cuerpoPublicar, cuerpoSuscribir, cuerpoCapa } from './logica.js';

const API = 'https://rtc.live.cloudflare.com/v1';
const STUN = { urls: 'stun:stun.cloudflare.com:3478' };
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type' };
const json = (body, status = 200) => Response.json(body, { status, headers: CORS });

function conexion(url) {
  const match = /^\/sala\/([^/]+)$/.exec(url.pathname);
  if (!match || !slugValido(match[1])) throw new Error('Sala inválida');
  const rol = url.searchParams.get('rol');
  const vista = url.searchParams.get('vista') ?? 'auto';
  if (!['cabina', 'butaca'].includes(rol)) throw new Error('Rol inválido');
  if (!VISTAS.includes(vista)) throw new Error('Vista inválida');
  return { slug: match[1], rol, vista, nombre: nombreValido(url.searchParams.get('nombre') ?? '') };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (request.method !== 'GET') return json({ error: 'Método no permitido' }, 405);
    if (url.pathname === '/salud') return json({ ok: true,
      sfu: Boolean(env.CF_APP_ID && env.CF_APP_SECRET),
      turn: Boolean(env.CF_TURN_KEY_ID && env.CF_TURN_KEY_TOKEN) });
    if (!url.pathname.startsWith('/sala/')) return json({ error: 'Ruta inexistente' }, 404);
    let info;
    try { info = conexion(url); } catch (e) { return json({ error: e.message }, 400); }
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'Se requiere WebSocket' }, 426);
    return env.SALAS.get(env.SALAS.idFromName(info.slug)).fetch(request);
  },
};

export class Sala extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.sockets = new Map();
    this.colas = new Map();
    this.pendientes = new Map();
    // El ping de los clientes se contesta sin despertar al objeto (plan gratis).
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"tipo":"ping"}', '{"tipo":"pong"}'));
    for (const ws of ctx.getWebSockets()) {
      const info = ws.deserializeAttachment();
      if (info && ws.readyState === 1) this.sockets.set(info.id, { ws, info });
    }
    ctx.blockConcurrencyWhile(async () => {
      this.estado = await ctx.storage.get('sala') ?? {
        publicacion: null, numero: 0, sonidoPantalla: false, microfono: false,
      };
      if (this.estado.publicacion && !this.sockets.has(this.estado.publicacion.dueno)) {
        this.estado.publicacion = null;
        await this.guardar();
      }
    });
  }

  guardar() { return this.ctx.storage.put('sala', this.estado); }
  adjuntar(ws, info) { ws.serializeAttachment(info); }
  activa(info) { return this.sockets.get(info.id)?.info === info; }
  enviar(ws, mensaje) {
    if (ws.readyState === 1) {
      try { ws.send(JSON.stringify(mensaje)); } catch { /* El cierre dispara la limpieza. */ }
    }
  }
  difundir() {
    const mensaje = { tipo: 'estado', enVivo: Boolean(this.estado.publicacion),
      publicacion: this.estado.publicacion?.numero ?? null,
      sonidoPantalla: this.estado.sonidoPantalla, microfono: this.estado.microfono,
      espectadores: [...this.sockets.values()].filter(({ info }) => info.rol === 'butaca')
        .map(({ info: { id, nombre, vista } }) => ({ id, nombre, vista })) };
    for (const { ws, info } of this.sockets.values()) if (info.lista) this.enviar(ws, mensaje);
  }

  async fetch(request) {
    let info;
    try { info = conexion(new URL(request.url)); } catch (e) { return json({ error: e.message }, 400); }
    if (request.method !== 'GET' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return json({ error: 'Se requiere WebSocket' }, 426);
    }
    const [client, ws] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(ws);
    const miembros = [...this.sockets.values()];
    if (info.rol === 'cabina' && miembros.some(s => s.info.rol === 'cabina' && s.ws.readyState === 1)) {
      ws.close(4001, 'ocupada');
    } else if (info.rol === 'butaca' && miembros.filter(s => s.info.rol === 'butaca' && s.ws.readyState === 1).length >= 40) {
      ws.close(4002, 'llena');
    } else {
      info = { rol: info.rol, nombre: info.nombre, vista: info.vista,
        id: crypto.randomUUID().slice(0, 12), sesion: null, lista: false };
      this.adjuntar(ws, info);
      this.sockets.set(info.id, { ws, info });
      // La bienvenida antecede al estado y a cualquier respuesta, incluso con TURN lento.
      this.ctx.waitUntil(this.encolar(info, async () => {
        const ice = await this.ice();
        if (!this.activa(info)) return;
        info.lista = true;
        this.adjuntar(ws, info);
        this.enviar(ws, { tipo: 'bienvenida', id: info.id, ice });
        this.difundir();
      }));
    }
    return new Response(null, { status: 101, webSocket: client, headers: CORS });
  }

  encolar(info, trabajo) {
    const anterior = this.colas.get(info.id) ?? Promise.resolve();
    this.pendientes.set(info.id, (this.pendientes.get(info.id) ?? 0) + 1);
    const siguiente = anterior.catch(() => {}).then(trabajo).finally(() => {
      const n = (this.pendientes.get(info.id) ?? 1) - 1;
      if (n) this.pendientes.set(info.id, n); else this.pendientes.delete(info.id);
      if (this.colas.get(info.id) === siguiente) this.colas.delete(info.id);
    });
    this.colas.set(info.id, siguiente);
    return siguiente;
  }

  async ice() {
    if (!this.env.CF_TURN_KEY_ID || !this.env.CF_TURN_KEY_TOKEN) return [STUN];
    try {
      const datos = await this.api(`/turn/keys/${encodeURIComponent(this.env.CF_TURN_KEY_ID)}/credentials/generate-ice-servers`,
        'POST', { ttl: 86400 }, 'TURN', this.env.CF_TURN_KEY_TOKEN);
      return [STUN, ...(Array.isArray(datos.iceServers) ? datos.iceServers : [])];
    } catch { return [STUN]; }
  }

  async api(path, method, body, operacion, token = this.env.CF_APP_SECRET) {
    if (!token) throw new Error('Falta configurar Cloudflare');
    let response, datos;
    try {
      response = await fetch(`${API}${path}`, { method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        // sessions/new no acepta cuerpo vacío ("{}" da decoding_error): sin cuerpo cuando no hay datos.
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000) });
      datos = await response.json();
    } catch { throw new Error(`No se pudo contactar a Cloudflare: ${operacion}`); }
    const fallo = !response.ok || !esObjeto(datos) || datos.errorCode || datos.error ||
      (Array.isArray(datos.tracks) && datos.tracks.some(t => t.errorCode));
    if (fallo) {
      let detalle = datos?.errorDescription ?? (Array.isArray(datos?.tracks)
        ? datos.tracks.find(t => t.errorCode)?.errorDescription : undefined);
      if (typeof detalle !== 'string') detalle = `HTTP ${response.status}`;
      for (const secreto of [this.env.CF_APP_SECRET, this.env.CF_TURN_KEY_TOKEN]) {
        if (secreto) detalle = detalle.split(secreto).join('[secreto]');
      }
      detalle = detalle.replace(/[\p{Cc}\p{Cf}]/gu, ' ').slice(0, 180);
      throw new Error(`Cloudflare rechazó ${operacion}: ${detalle}`);
    }
    return datos;
  }

  sfu(sessionId, endpoint, method, body, operacion) {
    if (!this.env.CF_APP_ID || !this.env.CF_APP_SECRET) throw new Error('Falta configurar Cloudflare SFU');
    const base = `/apps/${encodeURIComponent(this.env.CF_APP_ID)}/sessions`;
    return this.api(sessionId ? `${base}/${encodeURIComponent(sessionId)}/${endpoint}` : `${base}/new`, method, body, operacion);
  }
  async nuevaSesion() {
    const datos = await this.sfu(null, '', 'POST', undefined, 'la sesión');
    if (typeof datos.sessionId !== 'string' || !datos.sessionId) throw new Error('Cloudflare no devolvió la sesión');
    return datos.sessionId;
  }
  async cerrarPistas(publicacion) {
    if (!publicacion?.pistas?.length) return;
    try {
      await this.sfu(publicacion.sessionId, 'tracks/close', 'PUT', {
        force: true, tracks: publicacion.pistas.map(({ mid }) => ({ mid })),
      }, 'el cierre');
    } catch { /* El contrato permite ignorar errores al cortar. */ }
  }

  webSocketMessage(ws, message) {
    const id = ws.deserializeAttachment()?.id;
    const info = this.sockets.get(id)?.info;
    if (!info) return;
    if (typeof message !== 'string') { ws.close(1003, 'Sólo JSON de texto'); return; }
    if (message.length > 250000) { ws.close(1009, 'Mensaje demasiado grande'); return; }
    let m;
    try { m = JSON.parse(message); } catch { ws.close(1008, 'JSON inválido'); return; }
    if (!esObjeto(m)) { ws.close(1008, 'Mensaje inválido'); return; }
    if ((this.pendientes.get(id) ?? 0) >= 64) { ws.close(1008, 'Demasiados pedidos'); return; }
    return this.encolar(info, async () => {
      if (!this.activa(info)) return;
      if (m.tipo === 'pedido' && typeof m.reqId === 'number' && Number.isFinite(m.reqId)) {
        try {
          if (!esObjeto(m.datos) || typeof m.accion !== 'string') throw new Error('Pedido inválido');
          const datos = await this.pedido(ws, info, m.accion, m.datos);
          if (this.activa(info)) this.enviar(ws, { tipo: 'respuesta', reqId: m.reqId, ok: true, datos });
        } catch (e) {
          if (this.activa(info)) this.enviar(ws, { tipo: 'respuesta', reqId: m.reqId, ok: false,
            error: e instanceof Error ? e.message : 'No se pudo completar el pedido' });
        }
      } else {
        try {
          if (m.tipo === 'ping') this.enviar(ws, { tipo: 'pong' });
          else if (m.tipo === 'medida' && info.rol === 'butaca') {
            const medida = validarMedida(m);
            for (const s of this.sockets.values()) if (s.info.rol === 'cabina' && s.info.lista) {
              this.enviar(s.ws, { tipo: 'medida', id, ...medida });
            }
          } else if (m.tipo === 'vista' && info.rol === 'butaca' && VISTAS.includes(m.valor)) {
            info.vista = m.valor;
            this.adjuntar(ws, info);
            this.difundir();
          } else throw new Error('Mensaje inválido');
        } catch { ws.close(1008, 'Mensaje inválido'); }
      }
    });
  }

  comprobar(info, pub) {
    if (!this.activa(info)) throw new Error('La conexión se cerró');
    if (pub && this.estado.publicacion !== pub) throw new Error('La transmisión cambió; volvé a suscribirte');
  }

  async pedido(ws, info, accion, datos) {
    const acciones = info.rol === 'cabina' ? ['publicar', 'cortar', 'sonido'] : ['suscribir', 'responder', 'capa'];
    if (!acciones.includes(accion)) throw new Error('Acción no permitida');
    if (accion === 'publicar') {
      const cuerpo = cuerpoPublicar(datos);
      const sessionId = await this.nuevaSesion();
      this.comprobar(info);
      const respuesta = await this.sfu(sessionId, 'tracks/new', 'POST', cuerpo, 'la publicación');
      const pub = { sessionId, dueno: info.id, numero: this.estado.numero + 1,
        pistas: cuerpo.tracks.map(t => ({ mid: t.mid, trackName: t.trackName })) };
      if (!this.activa(info)) { await this.cerrarPistas(pub); throw new Error('La conexión se cerró'); }
      const sdp = validarSdp(respuesta.sessionDescription?.sdp);
      const anterior = this.estado.publicacion;
      this.estado.publicacion = pub;
      this.estado.numero = pub.numero;
      info.sesion = { sessionId, publicacion: pub.numero };
      this.adjuntar(ws, info);
      await this.guardar();
      this.difundir();
      await this.cerrarPistas(anterior);
      return { sdp };
    }
    if (accion === 'cortar') {
      const anterior = this.estado.publicacion;
      this.estado.publicacion = null;
      info.sesion = null;
      this.adjuntar(ws, info);
      await this.guardar();
      this.difundir();
      await this.cerrarPistas(anterior);
      return {};
    }
    if (accion === 'sonido') {
      if (typeof datos.pantalla !== 'boolean' || typeof datos.micro !== 'boolean') throw new Error('Sonido inválido');
      this.estado.sonidoPantalla = datos.pantalla;
      this.estado.microfono = datos.micro;
      await this.guardar();
      this.difundir();
      return {};
    }
    const pub = this.estado.publicacion;
    if (!pub) throw new Error('La transmisión todavía no empezó');
    if (accion === 'suscribir') {
      const cuerpo = cuerpoSuscribir(pub.sessionId, datos);
      // Cada suscripción usa una conexión WebRTC nueva del lado de la butaca: sesión nueva también.
      // Si un audio todavía no tiene paquetes, Cloudflare rechaza todo el pedido (y deja la sesión
      // trabada): probar con menos pistas, en una sesión nueva cada vez, para que el video llegue igual.
      let respuesta;
      let pedidas = cuerpo.tracks;
      let sessionId;
      for (const nombres of [['video', 'pantalla', 'micro'], ['video', 'pantalla'], ['video']]) {
        pedidas = cuerpo.tracks.filter(t => nombres.includes(t.trackName));
        sessionId = await this.nuevaSesion();
        this.comprobar(info, pub);
        try {
          respuesta = await this.sfu(sessionId, 'tracks/new', 'POST', { tracks: pedidas }, 'la suscripción');
          break;
        } catch (e) {
          if (!/No track data/i.test(e.message) || nombres.length === 1) throw e;
        }
      }
      this.comprobar(info, pub);
      const sesion = { sessionId, publicacion: pub.numero, pendiente: false, pistas: [] };
      info.sesion = sesion;
      const sdp = validarSdp(respuesta.sessionDescription?.sdp);
      if (!Array.isArray(respuesta.tracks) || respuesta.tracks.length !== pedidas.length ||
          pedidas.some(t => !respuesta.tracks.some(r => r.trackName === t.trackName && typeof r.mid === 'string'))) {
        throw new Error('Cloudflare no devolvió las pistas');
      }
      sesion.pistas = respuesta.tracks.map(({ trackName, mid }) => ({ trackName, mid }));
      sesion.pendiente = true;
      this.adjuntar(ws, info);
      return { sdp, pistas: sesion.pistas, publicacion: pub.numero };
    }
    const sesion = info.sesion;
    if (!sesion || sesion.publicacion !== pub.numero) throw new Error('Primero suscribite a la transmisión');
    if (accion === 'responder') {
      const sdp = validarSdp(datos.sdp);
      if (!sesion.pendiente) throw new Error('No hay una oferta pendiente');
      await this.sfu(sesion.sessionId, 'renegotiate', 'PUT', { sessionDescription: { type: 'answer', sdp } }, 'la respuesta');
      this.comprobar(info, pub);
      sesion.pendiente = false;
      this.adjuntar(ws, info);
      return {};
    }
    const cuerpo = cuerpoCapa(pub.sessionId, sesion.pistas.find(t => t.trackName === 'video')?.mid, datos);
    if (sesion.pendiente) throw new Error('Primero respondé la oferta pendiente');
    const respuesta = await this.sfu(sesion.sessionId, 'tracks/update', 'PUT', cuerpo, 'el cambio de capa');
    this.comprobar(info, pub);
    if (respuesta.sessionDescription) {
      const sdp = validarSdp(respuesta.sessionDescription.sdp);
      sesion.pendiente = true;
      this.adjuntar(ws, info);
      return { sdp };
    }
    return {};
  }

  async webSocketClose(ws, code) {
    const id = ws.deserializeAttachment()?.id;
    const miembro = this.sockets.get(id);
    if (!miembro || miembro.ws !== ws) return;
    this.sockets.delete(id);
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code, ''); } catch { /* Ya cerrado. */ }
    let anterior;
    if (miembro.info.rol === 'cabina' && this.estado.publicacion?.dueno === id) {
      anterior = this.estado.publicacion;
      this.estado.publicacion = null;
      await this.guardar();
    }
    this.difundir();
    await this.cerrarPistas(anterior);
  }
  webSocketError(ws) { return this.webSocketClose(ws, 1011); }
}
