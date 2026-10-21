export const VISTAS = ['auto', 'h', 'q'];
export const PISTAS = ['video', 'pantalla', 'micro'];
export const esObjeto = v => v !== null && typeof v === 'object' && !Array.isArray(v);
export const slugValido = v => typeof v === 'string' && /^[a-z0-9-]{1,32}$/.test(v);
export const claveValida = v => typeof v === 'string' && /^[A-Za-z0-9-]{16,64}$/.test(v);

export function nombreValido(nombre) {
  if (typeof nombre !== 'string' || /[\p{Cc}\p{Cf}]/u.test(nombre)) throw new Error('Nombre inválido');
  return Array.from(nombre.trim()).slice(0, 20).join('') || 'Alguien';
}

export function validarMedida(v) {
  if (!esObjeto(v)) throw new Error('Medida inválida');
  // Límites amplios: 60 s de RTT, 16K, 240 fps y un millón de congelamientos.
  const limites = { ms: 60000, perdida: 1, alto: 16384, fps: 240, congelamientos: 1000000 };
  const medida = {};
  for (const [campo, max] of Object.entries(limites)) {
    const n = v[campo];
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > max ||
        (['alto', 'congelamientos'].includes(campo) && !Number.isInteger(n))) throw new Error('Medida inválida');
    medida[campo] = n;
  }
  if (typeof v.relay !== 'boolean') throw new Error('Medida inválida');
  return { ...medida, relay: v.relay };
}

export function validarSdp(sdp) {
  if (typeof sdp !== 'string' || !sdp.trim() || sdp.length > 200000) throw new Error('SDP inválido');
  return sdp;
}

function simulcast(capa, auto) {
  if (!['f', 'h', 'q'].includes(capa) || typeof auto !== 'boolean') throw new Error('Capa inválida');
  return { preferredRid: capa, priorityOrdering: auto ? 'asciibetical' : 'none', ridNotAvailable: 'asciibetical' };
}

export function cuerpoPublicar(datos) {
  if (!esObjeto(datos)) throw new Error('Publicación inválida');
  const sdp = validarSdp(datos.sdp);
  if (!Array.isArray(datos.pistas) || !datos.pistas.length || datos.pistas.length > 3) throw new Error('Pistas inválidas');
  const mids = new Set(), nombres = new Set();
  const tracks = datos.pistas.map(p => {
    if (!esObjeto(p) || !PISTAS.includes(p.trackName) || typeof p.mid !== 'string' ||
        !/^[a-zA-Z0-9_-]{1,64}$/.test(p.mid) || mids.has(p.mid) || nombres.has(p.trackName)) throw new Error('Pistas inválidas');
    mids.add(p.mid); nombres.add(p.trackName);
    return { location: 'local', mid: p.mid, trackName: p.trackName };
  });
  return { sessionDescription: { type: 'offer', sdp }, tracks };
}

export function cuerpoSuscribir(sessionId, datos) {
  if (!esObjeto(datos)) throw new Error('Capa inválida');
  const config = simulcast(datos.capa, datos.auto);
  return { tracks: PISTAS.map(trackName => ({ location: 'remote', sessionId, trackName,
    ...(trackName === 'video' ? { simulcast: config } : {}) })) };
}

export function cuerpoCapa(sessionId, mid, datos) {
  const { tracks } = cuerpoSuscribir(sessionId, datos);
  if (typeof mid !== 'string' || !mid.length) throw new Error('Falta la pista de video');
  return { tracks: [{ ...tracks[0], mid }] };
}
