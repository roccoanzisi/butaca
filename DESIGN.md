# Butaca — sistema de diseño

Una persona proyecta su pantalla desde la **cabina**; el resto mira desde su **butaca**.
Todo el lenguaje visual sale de una sala de cine de barrio a oscuras: terciopelo vino,
la marquesina de letras sueltas, la linterna ámbar del acomodador y la luz roja de "al aire".

## Prioridad de producto

**Demora mínima.** Cada decisión técnica se subordina a eso:

- SFU de Cloudflare con nodos en Argentina: la cabina sube una vez en tres capas (simulcast) y cada butaca recibe la suya.
- Sin tocar el buffer de jitter (forzarlo a 0 se veía a tirones) y con arranque rápido (`x-google-start-bitrate`).
- Modo "Movimiento" por defecto: `contentHint = 'motion'` + `degradationPreference = 'balanced'`
  (`maintain-framerate` desplomaba la resolución ante cualquier pérdida).
- La demora medida (`getStats`) se muestra siempre, en la butaca y en la cabina.
- Audio sin mezclar: pantalla y micrófono viajan en pistas separadas (sin WebAudio en el camino).
- Cada butaca elige su capa (Auto, Media, Baja) sin costo para la cabina.

## Color

| Token | Hex | Uso |
|---|---|---|
| `--sala` | `#1C0C12` | Fondo: sala a oscuras, marrón-morado, nunca negro neutro |
| `--terciopelo` | `#5A1424` | Superficies, butacas ocupadas |
| `--terciopelo-claro` | `#7A2236` | Bordes activos, hover |
| `--marquesina` | `#F3EEE2` | Panel retroiluminado del letrero (solo ahí) |
| `--tinta` | `#1B1416` | Letras del letrero |
| `--acomodador` | `#F0A93B` | Acción principal y foco de teclado |
| `--aire` | `#FF4D3D` | Luz "en vivo"; nada más usa este rojo |
| `--texto` / `--texto-suave` | `#EADBD3` / `#B49A9F` | Texto |

## Tipografía

- **Anybody** (variable, eje `wdth`): letrero de marquesina a ancho 70 y peso 800, títulos a ancho 85.
  Es el único lugar con mayúsculas: las letras de marquesina son mayúsculas por naturaleza.
- **Familjen Grotesk**: todo el resto. Frases en minúscula inicial, sin etiquetas en mayúsculas.

Escala (base 16px, razón ~1.25): 13 / 16 / 20 / 25 / 31 / 39 / clamp para el letrero.

## Lo memorable (único lugar con audacia)

**El letrero.** El nombre de la sala se arma con fichas sueltas sobre un panel acanalado retroiluminado,
cada ficha levemente torcida como colocada a mano. Al cargar, las fichas se colocan una por una
(única animación no disparada por la persona; desactivada con `prefers-reduced-motion`).

## Estructura

- **Inicio**: letrero "BUTACA", campo de sala, "Mirar" (principal) y "Transmitir desde acá".
- **Cabina**: pantalla grande con la vista previa; columna con link para compartir, calidad,
  tipo de contenido, sonido, fila de butacas (una por persona conectada, con su nombre) y la subida necesaria.
- **Sala**: entrada (nombre + "Entrar", el clic habilita el sonido), luego la pantalla ocupa todo;
  barra mínima con letrero chico, luz al aire, cantidad mirando, demora, volumen de pantalla y de micrófono
  por separado, calidad propia y pantalla completa.

La fila de butacas es información, no decoración: butaca encendida = persona conectada.

## Reglas

- Radios: 2px en controles, 14px solo en la pantalla (bordes de pantalla de cine curvos). Sin sombras grises genéricas;
  el único "brillo" es el resplandor de la pantalla y de la luz al aire.
- Sin flechas en botones, sin separadores con punto medio, sin monoespaciada para datos.
- Errores: dicen qué pasó y qué hacer, sin disculparse.
- Responsive hasta 360px; foco visible ámbar; contraste AA.
