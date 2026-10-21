# Protocolo Butaca (Cloudflare Realtime SFU + Worker)

Un Worker (`servidor/`) con un Durable Object por sala reemplaza a PeerJS. El Worker guarda los secretos
de Cloudflare Realtime y es el único que llama a su API. Los navegadores hablan con el Worker por un
WebSocket por persona y mandan el video y el audio por WebRTC directo al SFU de Cloudflare (anycast:
entra por Buenos Aires, Córdoba, Neuquén o São Paulo).

## Secretos y variables del Worker

- `CF_APP_ID` (var) y `CF_APP_SECRET` (secret): app de Realtime SFU.
- `CF_TURN_KEY_ID` (var) y `CF_TURN_KEY_TOKEN` (secret): clave de TURN. Opcionales: sin ellas se usa sólo `stun:stun.cloudflare.com:3478`.
- API: `https://rtc.live.cloudflare.com/v1`, header `Authorization: Bearer <secreto>`.
  - SFU: `POST /apps/{CF_APP_ID}/sessions/new`, `POST /apps/{id}/sessions/{s}/tracks/new`,
    `PUT .../renegotiate`, `PUT .../tracks/update`, `PUT .../tracks/close`.
  - TURN: `POST /turn/keys/{CF_TURN_KEY_ID}/credentials/generate-ice-servers` con `{"ttl": 86400}` → `{ "iceServers": [...] }`.

## Conexión

`GET wss://<worker>/sala/<slug>?rol=cabina|butaca&nombre=<texto>&vista=auto|h|q`

- `slug`: `[a-z0-9-]{1,32}`. Otra cosa: 400.
- CORS / Origin: aceptar cualquier origen (la app de escritorio usa `file://`, Origin `null`).
- Un solo socket de rol `cabina` por sala: si ya hay uno abierto, el nuevo se acepta y se cierra enseguida con código `4001` razón `ocupada`.
- Máximo 40 butacas por sala: la 41 se cierra con `4002` `llena`.
- `nombre`: string, sin caracteres de control, recortado a 20; vacío → `Alguien`.

Al aceptar, el servidor manda:

```json
{ "tipo": "bienvenida", "id": "<id corto de esta conexión>", "ice": [ RTCIceServer... ] }
```

`ice` siempre incluye `{ "urls": "stun:stun.cloudflare.com:3478" }` y, si hay clave de TURN, los servidores generados.

## Pedidos con respuesta

Cliente → servidor: `{ "tipo": "pedido", "reqId": <número>, "accion": "<accion>", "datos": {...} }`
Servidor → cliente: `{ "tipo": "respuesta", "reqId": <mismo>, "ok": true, "datos": {...} }` o `{ ..., "ok": false, "error": "<texto en español>" }`.

Los pedidos de una misma conexión se procesan de a uno (cola), porque Cloudflare exige terminar cada renegociación antes de la siguiente mutación de la sesión.

### Cabina

- `publicar` — `datos: { "sdp": "<oferta>", "pistas": [ { "mid": "0", "trackName": "video" }, { "mid": "1", "trackName": "pantalla" }, { "mid": "2", "trackName": "micro" } ] }`
  1. `sessions/new` (una sesión nueva por publicación).
  2. `tracks/new` con `{ "sessionDescription": { "type": "offer", "sdp": ... }, "tracks": [ { "location": "local", "mid": ..., "trackName": ... } ] }`.
  3. Responde `{ "sdp": "<answer de Cloudflare>" }`.
  4. Guarda `publicacion = { sessionId, numero: numero+1 }` y difunde `estado` a todos.
  - `trackName` permitido: sólo `video`, `pantalla`, `micro`.
- `cortar` — `datos: {}`. Borra la publicación (si se puede, `tracks/close` de esas pistas, ignorando errores) y difunde `estado`.
- `sonido` — `datos: { "pantalla": bool, "micro": bool }`. Guarda y difunde `estado` (sólo informativo).

### Butaca

- `suscribir` — `datos: { "capa": "f"|"h"|"q", "auto": bool }`. Requiere publicación activa (si no: error "La transmisión todavía no empezó").
  1. Si la butaca no tiene sesión o la tiene de una publicación anterior: `sessions/new`.
  2. `tracks/new` con
     ```json
     { "tracks": [
       { "location": "remote", "sessionId": "<pub>", "trackName": "video",
         "simulcast": { "preferredRid": "<capa>", "priorityOrdering": "<auto ? 'asciibetical' : 'none'>", "ridNotAvailable": "asciibetical" } },
       { "location": "remote", "sessionId": "<pub>", "trackName": "pantalla" },
       { "location": "remote", "sessionId": "<pub>", "trackName": "micro" } ] }
     ```
  3. Responde `{ "sdp": "<oferta de Cloudflare>", "pistas": [ { "trackName": "video", "mid": "..." }, ... ], "publicacion": <numero> }`.
- `responder` — `datos: { "sdp": "<answer>" }` → `PUT .../renegotiate` con `{ "sessionDescription": { "type": "answer", "sdp": ... } }`. Responde `{}`.
- `capa` — `datos: { "capa": "f"|"h"|"q", "auto": bool }` → `PUT .../tracks/update` con
  `{ "tracks": [ { "location": "remote", "sessionId": "<pub>", "trackName": "video", "mid": "<mid de video de la butaca>", "simulcast": {...igual que arriba} } ] }`. Si Cloudflare responde con `sessionDescription` que requiere renegociar, devolverla como `{ "sdp": ... }` para que la butaca conteste con `responder`; si no, `{}`.

Capas que publica la cabina (RID): `f` completa, `h` = 720p (o 2/3 de la fuente), `q` = 360p (o 1/3). "Auto" pide `f` con `priorityOrdering: asciibetical`, así el SFU baja de capa solo si a esa butaca no le da la conexión.

## Mensajes sin respuesta

- Butaca → servidor: `{ "tipo": "medida", "ms": n, "perdida": 0..1, "alto": n, "fps": n, "congelamientos": n, "relay": bool }` (cada ~4 s). El servidor lo valida (números finitos, acotados) y lo reenvía a la cabina como `{ "tipo": "medida", "id": "<id butaca>", ...los mismos campos }`. También guarda `vista` si viene `{ "tipo": "vista", "valor": "auto"|"h"|"q" }`.
- Servidor → todos: `estado` cada vez que cambia algo (entra/sale alguien, publica, corta, sonido):
  ```json
  { "tipo": "estado", "enVivo": bool, "publicacion": <numero|null>,
    "sonidoPantalla": bool, "microfono": bool,
    "espectadores": [ { "id": "...", "nombre": "...", "vista": "auto|h|q" } ] }
  ```
  `publicacion` cambia cada vez que la cabina vuelve a publicar: las butacas se vuelven a suscribir.
- Si se cierra el socket de la cabina: publicación borrada, `enVivo: false`, difundir.
- Ping: el cliente manda `{ "tipo": "ping" }` cada 20 s; el servidor contesta `{ "tipo": "pong" }`.

## Otros endpoints HTTP

- `GET /salud` → `{ "ok": true, "sfu": bool (hay CF_APP_ID y secreto), "turn": bool }`.

## Errores

Mensajes de error en español, cortos, diciendo qué pasó (por ejemplo "Cloudflare rechazó la publicación: <errorDescription>"). Nunca mandar el secreto ni respuestas crudas con headers al cliente.
