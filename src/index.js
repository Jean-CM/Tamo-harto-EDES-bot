const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const cron = require('node-cron');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// ─── CONFIGURACIÓN ────────────────────────────────────────────────────────────
const CONFIG = {
  NIC: '4351344',
  INTERVALO_MINUTOS: 40,
  RETRY_MINUTOS: 5,
  MAX_REINTENTOS: 3,
  ESPERA_MS: 8000,
  TU_NUMERO: '',  // Ej: '18091234567' para recibir notificaciones por WhatsApp
};

// ─── BASE DE DATOS ─────────────────────────────────────────────────────────────
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

// ─── ESTADO ───────────────────────────────────────────────────────────────────
let cliente = null;
let enProceso = false;
let intentos  = 0;

// ─── CONSULTA PRINCIPAL ───────────────────────────────────────────────────────
async function consultarConsumo() {
  if (enProceso) { log('⚠️  Consulta ya en proceso, esperando...'); return; }
  enProceso = true;
  log('🔄 Iniciando consulta de consumo EDEESTE...');

  try {
    const chats = await cliente.getChats();
    const chat  = chats.find(c => c.name && c.name.toLowerCase().includes('edeeste'));
    if (!chat) throw new Error('No encontré el chat de EDEESTE.RD en tu WhatsApp');

    log('📤 Paso 1: enviando "1"...');
    await chat.sendMessage('1');
    await esperar(5000);

    let msgs = await chat.fetchMessages({ limit: 3 });
    let ultimo = msgs[msgs.length - 1];
    if (!ultimo || ultimo.fromMe || !ultimo.body.includes('LUCY')) {
      throw new Error('No recibí el menú de LUCY');
    }
    log('✅ Menú LUCY recibido');

    await esperar(1500);
    log('📤 Paso 2: enviando "3" (Servicio Prepago)...');
    await chat.sendMessage('3');
    await esperar(5000);

    msgs   = await chat.fetchMessages({ limit: 3 });
    ultimo = msgs[msgs.length - 1];
    if (!ultimo || ultimo.fromMe || !ultimo.body.includes('Recarga')) {
      throw new Error('No recibí el submenú de Servicio Prepago');
    }
    log('✅ Submenú Prepago recibido');

    await esperar(1500);
    log('📤 Paso 3: enviando "1" (Recarga de Servicio)...');
    await chat.sendMessage('1');
    await esperar(5000);

    msgs   = await chat.fetchMessages({ limit: 3 });
    ultimo = msgs[msgs.length - 1];
    if (!ultimo || ultimo.fromMe || !ultimo.body.includes('NIC')) {
      throw new Error('No se solicitó el NIC');
    }
    log('✅ Solicitud de NIC recibida');

    await esperar(1500);
    log(`📤 Paso 4: enviando NIC ${CONFIG.NIC}...`);
    await chat.sendMessage(CONFIG.NIC);
    await esperar(7000);

    msgs   = await chat.fetchMessages({ limit: 5 });
    ultimo = msgs[msgs.length - 1];
    if (!ultimo || ultimo.fromMe) throw new Error('Sin respuesta tras enviar NIC');
    if (ultimo.body.toLowerCase().includes('error') || ultimo.body.toLowerCase().includes('no encontr')) {
      throw new Error(`EDEESTE rechazó el NIC: ${ultimo.body}`);
    }
    if (!ultimo.body.includes('Recargar')) throw new Error(`Respuesta inesperada: ${ultimo.body}`);
    log('✅ NIC validado');

    await esperar(1500);
    log('📤 Paso 5: enviando "2" (Ver Energía Actual)...');
    await chat.sendMessage('2');
    await esperar(6000);

    msgs = await chat.fetchMessages({ limit: 6 });

    let consumoRaw = null;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const body = msgs[i].body.trim();
      if (!msgs[i].fromMe && /^\d+(\.\d+)?$/.test(body)) {
        consumoRaw = body;
        break;
      }
    }
    if (!consumoRaw) throw new Error('No pude leer el valor de consumo en la respuesta');

    const kwh = parseFloat(consumoRaw);
    const { fecha, hora, ts } = ahora();

    sqlInsert.run(kwh, fecha, hora, ts);
    log(`💾 Consumo guardado: ${kwh} kWh`);

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
    await notificarError(err.message);
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
      `🕐 Hora: ${hora}` +
      diff +
      `\n━━━━━━━━━━━━━━━━━━━\n` +
      `_Bot automático cada ${CONFIG.INTERVALO_MINUTOS} min_`;

    if (CONFIG.TU_NUMERO) {
      await cliente.sendMessage(`${CONFIG.TU_NUMERO}@c.us`, msg);
      log('📬 Notificación enviada');
    } else {
      log(`📊 RESULTADO: ${kwh} kWh`);
      log('💡 Configura TU_NUMERO en CONFIG para recibir notificaciones por WhatsApp');
    }
  } catch (e) {
    log(`⚠️  Error enviando notificación: ${e.message}`);
  }
}

async function notificarError(mensaje) {
  try {
    const msg =
      `❌ *Tamo Harto EDES - Error*\n` +
      `━━━━━━━━━━━━━━━━━━━\n` +
      `${mensaje}\n` +
      `_Se reintentará en el próximo ciclo (${CONFIG.INTERVALO_MINUTOS} min)_`;

    if (CONFIG.TU_NUMERO) {
      await cliente.sendMessage(`${CONFIG.TU_NUMERO}@c.us`, msg);
    }
    log(`🚨 Error notificado: ${mensaje}`);
  } catch (e) {}
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
    log('📱 ¡Escanea este QR con WhatsApp Business!');
    log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    qrcode.generate(qr, { small: true });
    log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    log('👆 WhatsApp Business → ⋮ → Dispositivos vinculados → Vincular dispositivo');
  });

  cliente.on('authenticated', () => log('✅ WhatsApp autenticado'));
  cliente.on('auth_failure',  msg => { log(`❌ Fallo auth: ${msg}`); process.exit(1); });

  cliente.on('ready', async () => {
    log('🟢 ¡Bot listo! Conectado a WhatsApp Business');
    log(`⏰ Consultando EDEESTE cada ${CONFIG.INTERVALO_MINUTOS} minutos`);
    log(`📋 NIC configurado: ${CONFIG.NIC}`);

    setTimeout(consultarConsumo, 10000);

    cron.schedule(`*/${CONFIG.INTERVALO_MINUTOS} * * * *`, () => {
      log('⏰ Ciclo programado — iniciando consulta...');
      consultarConsumo();
    });

    cron.schedule('0 8 * * *', async () => {
      const registros = sqlUltimos.all();
      if (!registros.length) return;
      const lista = registros.slice(0, 6).map((r, i) => `${i + 1}. ${r.hora} → *${r.kwh} kWh*`).join('\n');
      const reporte =
        `📊 *Reporte Diario EDEESTE*\n` +
        `━━━━━━━━━━━━━━━━━━━\n` +
        lista + '\n' +
        `━━━━━━━━━━━━━━━━━━━\n` +
        `Min: ${Math.min(...registros.map(r => r.kwh))} kWh\n` +
        `Max: ${Math.max(...registros.map(r => r.kwh))} kWh`;
      if (CONFIG.TU_NUMERO) {
        await cliente.sendMessage(`${CONFIG.TU_NUMERO}@c.us`, reporte);
      }
      log('📊 Reporte diario enviado');
    });
  });

  cliente.on('disconnected', reason => {
    log(`🔴 Desconectado: ${reason} — reconectando en 30s...`);
    setTimeout(iniciar, 30000);
  });

  await cliente.initialize();
}

process.on('SIGINT', async () => {
  log('🛑 Apagando bot...');
  if (cliente) await cliente.destroy();
  process.exit(0);
});

process.on('uncaughtException', err => {
  log(`💥 Error inesperado: ${err.message}`);
  sqlError.run(`UNCAUGHT: ${err.message}`, Date.now());
});

iniciar();
