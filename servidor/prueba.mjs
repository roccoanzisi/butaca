import test from 'node:test';
import assert from 'node:assert/strict';
import { slugValido, nombreValido, validarMedida, cuerpoPublicar, cuerpoSuscribir, cuerpoCapa } from './src/logica.js';

test('slug: caracteres y límites del contrato', () => {
  for (const slug of ['a', 'cine-123', '-'.repeat(32)]) assert.equal(slugValido(slug), true);
  for (const slug of ['', 'a'.repeat(33), 'Cine', 'a_b', 'a/b', '%61', 'á', 'a\n', null, 123]) {
    assert.equal(slugValido(slug), false);
  }
});

test('nombre: valor predeterminado, recorte Unicode y controles', () => {
  assert.equal(nombreValido('  '), 'Alguien');
  assert.equal(nombreValido('  Rocco  '), 'Rocco');
  assert.equal(nombreValido('😀'.repeat(21)), '😀'.repeat(20));
  for (const nombre of [null, 10, 'a\nb', 'a\x00b', 'a\x7fb', 'a\u0085b', 'a\u202eb']) {
    assert.throws(() => nombreValido(nombre), /Nombre inválido/);
  }
});

const medida = { ms: 120.5, perdida: 0.01, alto: 1080, fps: 29.97, congelamientos: 2, relay: false };
test('medidas: sólo campos admitidos, valores finitos y rangos', () => {
  assert.deepEqual(validarMedida({ ...medida, tipo: 'medida', id: 'falso', extra: true }), medida);
  assert.deepEqual(validarMedida({ ms: 0, perdida: 1, alto: 0, fps: 0, congelamientos: 0, relay: true }),
    { ms: 0, perdida: 1, alto: 0, fps: 0, congelamientos: 0, relay: true });
  for (const campo of ['ms', 'perdida', 'alto', 'fps', 'congelamientos']) {
    for (const valor of [NaN, Infinity, -1, '1', null, undefined]) {
      assert.throws(() => validarMedida({ ...medida, [campo]: valor }), /Medida inválida/);
    }
  }
  for (const invalida of [{ perdida: 1.01 }, { alto: 16385 }, { fps: 241 }, { ms: 60001 },
    { congelamientos: 1000001 }, { congelamientos: 1.1 }, { alto: 1.1 }, { relay: 1 }]) {
    assert.throws(() => validarMedida({ ...medida, ...invalida }), /Medida inválida/);
  }
});

const pistas = ['video', 'pantalla', 'micro'].map((trackName, n) => ({ mid: String(n), trackName }));
test('tracks/new local: oferta y pistas con lista permitida', () => {
  assert.deepEqual(cuerpoPublicar({ sdp: 'v=0\r\n', pistas }), {
    sessionDescription: { type: 'offer', sdp: 'v=0\r\n' },
    tracks: pistas.map(p => ({ location: 'local', ...p })),
  });
  for (const datos of [null, {}, { sdp: '', pistas }, { sdp: 'x'.repeat(200001), pistas },
    { sdp: 'x', pistas: [] }, { sdp: 'x', pistas: [{ mid: '0', trackName: 'intruso' }] },
    { sdp: 'x', pistas: [pistas[0], pistas[0]] },
    { sdp: 'x', pistas: [{ mid: '0', trackName: 'video' }, { mid: '0', trackName: 'micro' }] },
    { sdp: 'x', pistas: [{ mid: null, trackName: 'video' }] }]) assert.throws(() => cuerpoPublicar(datos));
});

test('tracks/new remoto: los tres tracks, simulcast sólo en video', () => {
  for (const capa of ['f', 'h', 'q']) for (const auto of [true, false]) {
    assert.deepEqual(cuerpoSuscribir('pub-1', { capa, auto }), { tracks: [
      { location: 'remote', sessionId: 'pub-1', trackName: 'video', simulcast: {
        preferredRid: capa, priorityOrdering: auto ? 'asciibetical' : 'none', ridNotAvailable: 'asciibetical',
      } },
      { location: 'remote', sessionId: 'pub-1', trackName: 'pantalla' },
      { location: 'remote', sessionId: 'pub-1', trackName: 'micro' },
    ] });
  }
});

test('tracks/update: usa el mid de la butaca y conserva el simulcast', () => {
  assert.deepEqual(cuerpoCapa('pub-1', '7', { capa: 'h', auto: false }), { tracks: [
    { location: 'remote', sessionId: 'pub-1', trackName: 'video', mid: '7', simulcast: {
      preferredRid: 'h', priorityOrdering: 'none', ridNotAvailable: 'asciibetical',
    } },
  ] });
  for (const datos of [null, {}, { capa: 'auto', auto: true }, { capa: 'f', auto: 'true' }]) {
    assert.throws(() => cuerpoSuscribir('pub', datos));
    assert.throws(() => cuerpoCapa('pub', '0', datos));
  }
  assert.throws(() => cuerpoCapa('pub', undefined, { capa: 'f', auto: true }));
});
