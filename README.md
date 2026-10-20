# Butaca

Una persona comparte su pantalla en vivo y el resto mira, con la menor demora posible.
No hace falta crear cuenta ni instalar nada.

**App:** https://roccoanzisi.github.io/butaca/

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

- WebRTC punto a punto de la cabina a cada butaca, sin servidor de video en el medio. Es la opción con menos demora; la demora medida se ve en pantalla.
- Para encontrarse usan el servidor público de [PeerJS](https://peerjs.com/), que también aporta un TURN de respaldo para redes muy cerradas. Ese servidor no ve el video.
- Quien transmite manda una copia a cada persona, así que su velocidad de subida limita cuántas personas pueden mirar. La cabina muestra la subida necesaria. Con unas 5 a 8 personas anda bien en una conexión hogareña.
- Para transmitir hace falta una compu con Chrome, Edge o Firefox. Para mirar alcanza cualquier navegador, celular incluido.

Diseño: ver [DESIGN.md](DESIGN.md). Sin build: HTML, CSS y JS planos, con PeerJS 1.5.4 incluido en `vendor/`.
