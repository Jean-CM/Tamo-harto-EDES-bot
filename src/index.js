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

const CONFIG = {
  NICS: [
    { nic: '4351344', nombre: 'Jean Carlos' },
    { nic: '4204764', nombre: 'Eridania' },
  ],
  INTERVALO_MINUTOS: 40,
  RETRY_MINUTOS: 5,
  MAX_REINTENTOS: 3,
  TU_NUMERO: '18097494863',
  GRUPO: 'Tamo Harto EDES',
};

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'consumo.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS consumo (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    nic       TEXT    NOT NULL,
    nombre    TEXT    NOT NULL,
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
const sqlInsert  = db.prepare('INSERT INTO consumo (nic, nombre, kwh, fecha, hora, timestamp) VALUES (?, ?, ?, ?, ?, ?)');
const sqlError   = db.prepare('INSERT INTO errores (mensaje, timestamp) VALUES (?, ?)');
const sqlUltimos = db.prepare('SELECT * FROM consumo WHERE nic = ? ORDER BY timestamp DESC LIMIT 5');

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

async function esperarLucy(chat, timeoutMs = 45000) {
  const inicio = Date.now();
  while (Date.now() - inicio < timeoutMs) {
    await esperar(3000);
    const msgs = await chat.fetchMessages({ limit: 5 });
    const lucyMsg = msgs.reverse().find(m => !m.fromMe && m.body.includes('LUCY'));
    if (lucyMsg) return lucyMsg.body;
  }
  throw new Error('LUCY no respondió en 45 segundos');
}

async function esperarRespuesta(chat, palabraClave, timeoutMs = 30000) {
  const inicio = Date.now();
  while (Date.now() - inicio < timeoutMs) {
    await esperar(3000);
    const msgs = await chat.fetchMessages({ limit: 5 });
    const match = msgs.reverse().find(m => !m.fromMe && m.body.includes(palabraClave));
    if (match) return match.body;
  }
  throw new Error(`No recibí respuesta con "${palabraClave}"`);
}

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

let cliente   = null;
let enProceso = false;
let intentos  = 0;

// Consultar un NIC individual
async function consultarNIC(chat, nic, nombre) {
  log(`🔍 Consultando NIC ${nic} (${nombre})...`);

  // Despertar con texto random y esperar LUCY
  const random = `hola${Math.floor(Math.random() * 9000 + 1000)}`;
  log(`📤 Despertando chat con "${random}"...`);
  await chat.sendMessage(random);
  await esperar(4000);

  log('⏳ Esperando que LUCY aparezca...');
  await esperarLucy(chat, 45000);
  log('✅ LUCY respondió');

  // Servicio Prepago
  await esperar(4000);
  log('📤 Enviando "3" (Servicio Prepago)...');
  await chat.sendMessage('3');
  await esperar(4000);
  await esperarRespuesta(chat, 'Recarga', 30000);
  log('✅ Submenú Prepago recibido');

  // Recarga de Servicio
  await esperar(4000);
  log('📤 Enviando "1" (Recarga de Servicio)...');
  await chat.sendMessage('1');
  await esperar(4000);
  await esperarRespuesta(chat, 'NIC', 30000);
  log('✅ Solicitud de NIC recibida');

  // Enviar NIC
  await esperar(4000);
  log(`📤 Enviando NIC ${nic}...`);
  await chat.sendMessage(nic);
  await esperar(4000);
  await esperarRespuesta(chat, 'Recargar', 30000);
  log('✅ NIC validado');

  // Ver Energía Actual
  await esperar(4000);
  log('📤 Enviando "2" (Ver Energía Actual)...');
  await chat.sendMessage('2');
  log('⏳ Esperando respuesta con el consumo (30 seg)...');
  await esperar(30000);

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
  if (!consumoRaw) throw new Error(`No pude leer el consumo del NIC ${nic}`);

  const kwh = parseFloat(consumoRaw);
  const { fecha, hora, ts } = ahora();
  sqlInsert.run(nic, nombre, kwh, fecha, hora, ts);
  log(`💾 ${nombre} (${nic}): ${kwh} kWh guardado`);

  // Cerrar sesión
  log('⏳ Esperando menú de cierre...');
  await esperarRespuesta(chat, 'Cerrar', 20000);
  await esperar(4000);
  log('📤 Cerrando sesión con "2"...');
  await chat.sendMessage('2');
  await esperar(8000); // esperar más antes del siguiente NIC
  log(`👋 Sesión cerrada para ${nombre}`);

  return { nic, nombre, kwh, fecha, hora };
}

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

    const resultados = [];

    // Consultar cada NIC uno por uno
    for (const { nic, nombre } of CONFIG.NICS) {
      try {
        const resultado = await consultarNIC(chat, nic, nombre);
        resultados.push(resultado);
        log(`✅ NIC ${nic} (${nombre}) completado: ${resultado.kwh} kWh`);

        // Esperar entre consultas
        if (CONFIG.NICS.indexOf({ nic, nombre }) < CONFIG.NICS.length - 1) {
          log('⏳ Esperando 15 segundos antes del siguiente NIC...');
          await esperar(15000);
        }
      } catch (err) {
        log(`❌ Error en NIC ${nic} (${nombre}): ${err.message}`);
        resultados.push({ nic, nombre, kwh: null, error: err.message });
      }
    }

    // Enviar notificación con todos los resultados
    await notificarResultados(resultados);
    intentos = 0;

  } catch (err) {
    log(`❌ Error general: ${err.message}`);
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

async function notificarResultados(resultados) {
  try {
    const { fecha, hora } = ahora();

    let lineas = '';
    for (const r of resultados) {
      if (r.kwh !== null) {
        const historial = sqlUltimos.all(r.nic);
        const anterior  = historial[1];
        let diff = '';
        if (anterior) {
          const delta = r.kwh - anterior.kwh;
          diff = ` (${delta >= 0 ? '+' : ''}${delta.toFixed(2)} kWh)`;
        }
        lineas += `👤 *${r.nombre}*\n🔋 Energía: *${r.kwh} kWh*${diff}\n\n`;
      } else {
        lineas += `👤 *${r.nombre}*\n❌ Error: ${r.error}\n\n`;
      }
    }

    const msg =
      `😤 *Tamo Harto EDES - Consumo*\n` +
      `━━━━━━━━━━━━━━━━━━━\n` +
      lineas +
      `📅 ${fecha} 🕐 ${hora}\n` +
      `━━━━━━━━━━━━━━━━━━━\n` +
      `_Bot automático cada ${CONFIG.INTERVALO_MINUTOS} min_`;

    // Buscar el grupo
    const chats = await cliente.getChats();
    const grupo = chats.find(c => c.isGroup && c.name === CONFIG.GRUPO);

    if (grupo) {
      await grupo.sendMessage(msg);
      log(`📬 Notificación enviada al grupo "${CONFIG.GRUPO}"`);
    } else {
      log(`⚠️  No encontré el grupo "${CONFIG.GRUPO}" — enviando al número personal`);
      await cliente.sendMessage(`${CONFIG.TU_NUMERO}@c.us`, msg);
    }

  } catch (e) { log(`⚠️  Error notificación: ${e.message}`); }
}

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
    log(`👥 Notificaciones al grupo: "${CONFIG.GRUPO}"`);

    setTimeout(consultarConsumo, 10000);

    cron.schedule(`*/${CONFIG.INTERVALO_MINUTOS} * * * *`, () => {
      log('⏰ Ciclo programado — iniciando consulta...');
      consultarConsumo();
    });

    cron.schedule('0 8 * * *', async () => {
      const chats = await cliente.getChats();
      const grupo = chats.find(c => c.isGroup && c.name === CONFIG.GRUPO);
      if (!grupo) return;

      let reporte = `📊 *Reporte Diario EDEESTE*\n━━━━━━━━━━━━━━━━━━━\n`;
      for (const { nic, nombre } of CONFIG.NICS) {
        const registros = sqlUltimos.all(nic);
        if (!registros.length) continue;
        const lista = registros.slice(0, 4).map((r, i) => `  ${i + 1}. ${r.hora} → ${r.kwh} kWh`).join('\n');
        reporte += `👤 *${nombre}*\n${lista}\n\n`;
      }
      reporte += `━━━━━━━━━━━━━━━━━━━`;
      await grupo.sendMessage(reporte);
      log('📊 Reporte diario enviado al grupo');
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
