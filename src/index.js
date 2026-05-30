const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const qrcodeLib = require('qrcode');
const cron = require('node-cron');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const http = require('http');

// Limpiar locks de Chromium al arrancar
try {
  const exec = require('child_process').execSync;
  exec('find /app/data -name "SingletonLock" -o -name "SingletonCookie" -o -name "SingletonSocket" | xargs rm -f 2>/dev/null || true');
  console.log('🧹 Locks de Chromium limpiados');
} catch(e) {}

// ─── CONFIGURACIÓN ────────────────────────────────────────────────────────────
const CONFIG = {
  NIC: '4351344',
  INTERVALO_MINUTOS: 40,
  RETRY_MINUTOS: 5,
  MAX_REINTENTOS: 3,
  TU_NUMERO: '18097494863',
};

// ─── BASE DE DATOS ────────────────────────────────────────────────────────────
const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'consumo.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS consumo (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    kwh       REAL    NOT NULL,
    fecha     TEXT    NOT NULL,
    hora      TEXT    NOT NULL,
    timestamp INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS errores (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    mensaje   TEXT,
    timestamp INTEGER NOT NULL
  );
`);
const sqlInsert  = db.prepare('INSERT INTO consumo (kwh, fecha, hora, timestamp) VALUES (?, ?, ?, ?)');
const sqlError   = db.prepare('INSERT INTO errores (mensaje, timestamp) VALUES (?, ?)');
const sqlUltimos = db.prepare('SELECT * FROM consumo ORDER BY timestamp DESC LIMIT 10');

// ─── HELPERS ──────────────────────────────────────────────────────────────────
const esperar = ms => new Promise(r => setTimeout(r, ms));

const ahora = () => {
  const d = new Date();
  return {
    fecha: d.toLocaleDateString('es-DO'),
    hora:  d.toLocaleTimeString('es-DO'),
    ts:    d.getTime(),
  };
};

const log = msg => {
  const { fecha, hora } = ahora();
  console.log(`[${fecha} ${hora}] ${msg}`);
};

// Esperar hasta que LUCY aparezca en el chat
async function esperarLucy(chat, timeoutMs = 30000) {
  const inicio = Date.now();
  while (Date.now() - inicio < timeoutMs) {
    await esperar(2000);
    const msgs = await chat.fetchMessages({ limit: 5 });
    const lucyMsg = msgs.reverse().find(m => !m.fromMe && m.body.includes('LUCY'));
    if (lucyMsg) return lucyMsg.body;
  }
  throw new Error('LUCY no respondió en 30 segundos');
}

// Esperar una respuesta que contenga cierta palabra
async function esperarRespuesta(chat, palabraClave, timeoutMs = 20000) {
  const inicio = Date.now();
  while (Date.now() - inicio < timeoutMs) {
    await esperar(2000);
    const msgs = await chat.fetchMessages({ limit: 5 });
    const match = msgs.reverse().find(m => !m.fromMe && m.body.includes(palabraClave));
    if (match) return match.body;
  }
  throw new Error(`No recibí respuesta con "${palabraClave}"`);
}

// ─── SERVIDOR WEB PARA EL QR ──────────────────────────────────────────────────
let qrImageData = null;
let botListo    = false;

const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  if (botListo) {
    res.end(`<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:50px;background:#111;color:#0f0">
      <h1>✅ Bot Conectado</h1>
      <p style="font-size:20px">WhatsApp ya está vinculado y el bot está corriendo.</p>
      <p>Consultando EDEESTE cada ${CONFIG.INTERVALO_MINUTOS} minutos automáticamente.</p>
    </body></html>`);
    return;
  }

  if (!qrImageData) {
    res.end(`<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:50px;background:#111;color:#fff">
      <h1>⏳ Generando QR...</h1>
      <p>El bot está iniciando. Esta página se recarga sola.</p>
      <script>setTimeout(()=>location.reload(), 5000)</script>
    </body></html>`);
    return;
  }

  const qrImg = await qrcodeLib.toDataURL(qrImageData, { width: 400 });
  res.end(`<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:30px;background:#111;color:#fff">
    <h1>😤 Tamo Harto EDES Bot</h1>
    <h2>📱 Escanea este QR con WhatsApp Business</h2>
    <img src="${qrImg}" style="border:8px solid white;border-radius:16px;width:350px"/>
    <br/><br/>
    <p style="color:#aaa">WhatsApp Business → ⋮ → Dispositivos vinculados → Vincular dispositivo</p>
    <p style="color:#f90;font-weight:bold">⚠️ El QR expira cada 60 seg — página se recarga automáticamente</p>
    <script>setTimeout(()=>location.reload(), 30000)</script>
  </body></html>`);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => log(`🌐 Servidor QR corriendo en puerto ${PORT}`));

// ─── ESTADO ───────────────────────────────────────────────────────────────────
let cliente   = null;
let enProceso = false;
let intentos  = 0;

// ─── CONSULTA PRINCIPAL ───────────────────────────────────────────────────────
async function consultarConsumo() {
  if (enProceso) { log('⚠️  Consulta ya en proceso, esperando...'); return; }
  enProceso = true;
  log('🔄 Iniciando consulta de consumo EDEESTE...');

  try {
    const chats = await cliente.getChats();
    const chat = chats.find(c => c.name && (
      c.name.toLowerCase().includes('edeeste') ||
      c.name.toLowerCase().includes('ede este') ||
      c.name.toLowerCase().includes('ede') ||
      c.name.includes('EDEEste') ||
      c.name.includes('EDEESTE')
    ));
    if (!chat) throw new Error(`No encontré el chat de EDEESTE. Chats: ${chats.map(c=>`"${c.name}"`).join(' | ')}`);
    log(`✅ Chat encontrado: "${chat.name}"`);

    // Paso 0: enviar texto random para despertar el chat y esperar a LUCY
    const random = `hola${Math.floor(Math.random() * 9000 + 1000)}`;
    log(`📤 Despertando chat con "${random}"...`);
    await chat.sendMessage(random);

    log('⏳ Esperando que LUCY aparezca...');
    await esperarLucy(chat, 30000);
    log('✅ LUCY respondió, procediendo...');

    // Paso 1: Servicio Prepago
    await esperar(1500);
    log('📤 Enviando "3" (Servicio Prepago)...');
    await chat.sendMessage('3');
    await esperarRespuesta(chat, 'Recarga', 20000);
    log('✅ Submenú Prepago recibido');

    // Paso 2: Recarga de Servicio
    await esperar(1500);
    log('📤 Enviando "1" (Recarga de Servicio)...');
    await chat.sendMessage('1');
    await esperarRespuesta(chat, 'NIC', 20000);
    log('✅ Solicitud de NIC recibida');

    // Paso 3: Enviar NIC
    await esperar(1500);
    log(`📤 Enviando NIC ${CONFIG.NIC}...`);
    await chat.sendMessage(CONFIG.NIC);
    await esperarRespuesta(chat, 'Recargar', 20000);
    log('✅ NIC validado');

    // Paso 4: Ver Energía Actual
    await esperar(1500);
    log('📤 Enviando "2" (Ver Energía Actual)...');
    await chat.sendMessage('2');
    await esperar(8000);

    // Leer consumo
    const msgs = await chat.fetchMessages({ limit: 8 });
    let consumoRaw = null;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const body = msgs[i].body.trim();
      if (!msgs[i].fromMe && /^\d+(\.\d+)?$/.test(body)) {
        consumoRaw = body;
        break;
      }
    }
    if (!consumoRaw) throw new Error('No pude leer el valor de consumo');

    const kwh = parseFloat(consumoRaw);
    const { fecha, hora, ts } = ahora();
    sqlInsert.run(kwh, fecha, hora, ts);
    log(`💾 Consumo guardado: ${kwh} kWh`);

    // Cerrar sesión
    await esperar(1500);
    await chat.sendMessage('2');
    log('👋 Sesión cerrada');

    await notificarExito(kwh, fecha, hora);
    intentos = 0;

  } catch (err) {
    log(`❌ Error: ${err.message}`);
    sqlError.run(err.message, Date.now());
    intentos++;
    if (intentos < CONFIG.MAX_REINTENTOS) {
      log(`🔁 Reintentando en ${CONFIG.RETRY_MINUTOS} min (intento ${intentos}/${CONFIG.MAX_REINTENTOS})...`);
      enProceso = false;
      setTimeout(consultarConsumo, CONFIG.RETRY_MINUTOS * 60 * 1000);
      return;
    }
    log('🚫 Máximo de reintentos. Esperando próximo ciclo.');
    intentos = 0;
  }

  enProceso = false;
}

// ─── NOTIFICACIONES ───────────────────────────────────────────────────────────
async function notificarExito(kwh, fecha, hora) {
  try {
    const historial = sqlUltimos.all();
    const anterior  = historial[1];
    let diff = '';
    if (anterior) {
      const delta = kwh - anterior.kwh;
      diff = `\n📈 Variación: ${delta >= 0 ? '+' : ''}${delta.toFixed(2)} kWh vs lectura anterior`;
    }
    const msg =
      `😤 *Tamo Harto EDES - Consumo*\n` +
      `━━━━━━━━━━━━━━━━━━━\n` +
      `🔋 Energía actual: *${kwh} kWh*\n` +
      `📅 Fecha: ${fecha}\n` +
      `🕐 Hora: ${hora}` + diff +
      `\n━━━━━━━━━━━━━━━━━━━\n` +
      `_Bot automático cada ${CONFIG.INTERVALO_MINUTOS} min_`;

    if (CONFIG.TU_NUMERO) {
      await cliente.sendMessage(`${CONFIG.TU_NUMERO}@c.us`, msg);
      log('📬 Notificación enviada');
    } else {
      log(`📊 RESULTADO: ${kwh} kWh`);
    }
  } catch (e) { log(`⚠️  Error notificación: ${e.message}`); }
}

// ─── INICIO ───────────────────────────────────────────────────────────────────
async function iniciar() {
  log('😤 Tamo Harto EDES Bot arrancando...');

  cliente = new Client({
    authStrategy: new LocalAuth({
      dataPath: path.join(__dirname, '..', 'data', '.wwebjs_auth'),
    }),
    puppeteer: {
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-gpu',
      ],
    },
  });

  cliente.on('qr', qr => {
    qrImageData = qr;
    log('📱 QR generado — abre la URL pública de Railway en tu navegador');
    qrcode.generate(qr, { small: true });
  });

  cliente.on('authenticated', () => {
    log('✅ WhatsApp autenticado');
    qrImageData = null;
  });

  cliente.on('auth_failure', msg => {
    log(`❌ Fallo auth: ${msg}`);
    process.exit(1);
  });

  cliente.on('ready', async () => {
    botListo = true;
    log('🟢 ¡Bot listo! Conectado a WhatsApp Business');
    log(`⏰ Consultando EDEESTE cada ${CONFIG.INTERVALO_MINUTOS} minutos`);

    setTimeout(consultarConsumo, 10000);

    cron.schedule(`*/${CONFIG.INTERVALO_MINUTOS} * * * *`, () => {
      log('⏰ Ciclo programado — iniciando consulta...');
      consultarConsumo();
    });

    cron.schedule('0 8 * * *', async () => {
      const registros = sqlUltimos.all();
      if (!registros.length || !CONFIG.TU_NUMERO) return;
      const lista = registros.slice(0, 6).map((r, i) => `${i + 1}. ${r.hora} → *${r.kwh} kWh*`).join('\n');
      const reporte =
        `📊 *Reporte Diario EDEESTE*\n` +
        `━━━━━━━━━━━━━━━━━━━\n` +
        lista + '\n' +
        `━━━━━━━━━━━━━━━━━━━\n` +
        `Min: ${Math.min(...registros.map(r => r.kwh))} kWh | Max: ${Math.max(...registros.map(r => r.kwh))} kWh`;
      await cliente.sendMessage(`${CONFIG.TU_NUMERO}@c.us`, reporte);
      log('📊 Reporte diario enviado');
    });
  });

  cliente.on('disconnected', reason => {
    botListo = false;
    log(`🔴 Desconectado: ${reason} — reconectando en 30s...`);
    setTimeout(iniciar, 30000);
  });

  await cliente.initialize();
}

process.on('SIGINT', async () => {
  if (cliente) await cliente.destroy();
  process.exit(0);
});

process.on('uncaughtException', err => {
  log(`💥 Error inesperado: ${err.message}`);
  sqlError.run(`UNCAUGHT: ${err.message}`, Date.now());
});

iniciar();
