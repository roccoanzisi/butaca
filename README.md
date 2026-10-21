# Butaca

Una persona comparte su pantalla en vivo y el resto mira, con la menor demora posible.
No hace falta crear cuenta ni instalar nada.

**Web:** https://roccoanzisi.github.io/butaca/  
**App para Windows y Linux:** https://github.com/roccoanzisi/butaca/releases/latest

La app de escritorio es la misma Butaca. Para quien transmite suma un selector propio de pantalla o ventana, y el sonido de toda la compu (loopback) tanto en Windows como en Linux. Para mirar alcanza el link web, aunque la app también sirve.

- Windows: `Butaca-x.y.z-x64.exe` (instalador) o `Butaca-x.y.z-x64-portable.exe` (sin instalar).
- Linux: `Butaca-x.y.z-x86_64.AppImage` (darle permiso de ejecución) o el `.deb`.

## Cómo se usa

1. Quien transmite entra, escribe un nombre de sala y toca **Transmitir desde acá**.
2. Toca **Compartir pantalla** y elige la pantalla entera, una ventana o una pestaña.
   Para mandar sonido, marca "Compartir audio" en el selector. En Windows funciona con la pantalla entera; en cualquier sistema, con una pestaña.
3. Copia el link y se lo pasa a sus amigos. Cada uno escribe su nombre y entra.

Mientras transmite, puede minimizar la pestaña de Butaca o irse al juego: la transmisión sigue.

## Qué se puede ajustar

- **Calidad de la cabina:** 720p 30, 1080p 30 (por defecto) o 1080p 60.
- **Qué se muestra:** "Juego o video" prioriza la fluidez; "Texto o código" prioriza la nitidez.
- **Sonido:** el de la pantalla y el del micrófono viajan por separado, y quien mira regula el volumen de cada uno.
- **Calidad de cada butaca:** cada persona elige Auto, 720p, 480p o 360p según su conexión. Lo que elige afecta sólo a lo que recibe ella.

## Cómo funciona

- El video viaja por el **SFU de Cloudflare Realtime**, que tiene nodos en Buenos Aires, Córdoba, Neuquén y São Paulo. Quien transmite sube la imagen **una sola vez**, en tres calidades (simulcast: completa, ~720p y ~360p), y Cloudflare la reparte. La subida no depende de cuántos miren.
- Cada persona recibe la calidad que aguanta su conexión ("Auto"), o elige Media o Baja. El cambio es instantáneo y no le cuesta nada a quien transmite.
- Un Worker de Cloudflare con un Durable Object por sala (`servidor/`) coordina la sala y guarda los secretos. El contrato está en [servidor/PROTOCOLO.md](servidor/PROTOCOLO.md).
- La cabina queda atada a la compu que la abrió (clave privada que no viaja en el link): nadie con el link puede tomarla.
- Medido: 1080p 30 fps con 60 a 120 ms de demora, sin pérdidas, con cinco personas mirando.
- Plan gratis de Cloudflare: 1.000 GB por mes. Una persona mirando en 1080p usa unos 2 GB por hora.
- Para transmitir hace falta una compu con Chrome, Edge o Firefox, o la app. Para mirar alcanza cualquier navegador, celular incluido.

Diseño: ver [DESIGN.md](DESIGN.md). Sin build: HTML, CSS y JS planos.

### Servidor

```
cd servidor
npm ci
npx wrangler secret put CF_APP_ID          # Realtime → Serverless SFU
npx wrangler secret put CF_APP_SECRET
npx wrangler secret put CF_TURN_KEY_ID     # Realtime → TURN (opcional, ayuda con CGNAT)
npx wrangler secret put CF_TURN_KEY_TOKEN
npx wrangler deploy
curl https://butaca-servidor.penales-salas.workers.dev/salud
```

## Desarrollo de la app de escritorio

```
npm ci
npm start                 # abre la app
npm run prueba            # prueba de punta a punta: la app transmite y un Chromium mira
npm run dist:linux        # AppImage + deb en dist/
npm run dist:win          # instalador + portable (mejor en Windows o en CI)
```

El workflow `Escritorio` corre la prueba en Windows y en Linux, tanto desde el código como desde el ejecutable empaquetado. Con un tag `v*` publica los instaladores en Releases.
