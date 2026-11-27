// Vercel Serverless Function: /api/rem
// Inflación esperada según el REM del BCRA (Relevamiento de Expectativas de Mercado).
// Toma el Excel de resultados más reciente que publica el BCRA y devuelve, para el
// IPC nacional mensual, la mediana general y la del "Top 10" (los 10 analistas que
// mejor pronosticaron según el ranking del BCRA), con percentiles 25-75 como rango.
// El Excel (.xlsx) es un ZIP: se lee con zlib, sin dependencias externas.

const zlib = require('zlib');

const PAGINA = 'https://www.bcra.gob.ar/relevamiento-expectativas-mercado-rem/';
const BASE = 'https://www.bcra.gob.ar';

// ── Lector mínimo de .xlsx ─────────────────────────────────────────────
function leerZip(buf) {
  // Buscar el "end of central directory"
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('ZIP inválido');
  const n = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const archivos = {};
  for (let k = 0; k < n; k++) {
    const metodo = buf.readUInt16LE(p + 10);
    const tamComp = buf.readUInt32LE(p + 20);
    const lenNom = buf.readUInt16LE(p + 28), lenExtra = buf.readUInt16LE(p + 30), lenCom = buf.readUInt16LE(p + 32);
    const offLocal = buf.readUInt32LE(p + 42);
    const nombre = buf.toString('utf8', p + 46, p + 46 + lenNom);
    const ln = buf.readUInt16LE(offLocal + 26), le = buf.readUInt16LE(offLocal + 28);
    const ini = offLocal + 30 + ln + le;
    const datos = buf.subarray(ini, ini + tamComp);
    archivos[nombre] = () => (metodo === 8 ? zlib.inflateRawSync(datos) : datos).toString('utf8');
    p += 46 + lenNom + lenExtra + lenCom;
  }
  return archivos;
}
const xmlDecode = t => t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
function hojas(buf) {
  const z = leerZip(buf);
  const compartidos = [];
  if (z['xl/sharedStrings.xml']) {
    for (const si of z['xl/sharedStrings.xml']().match(/<si>[\s\S]*?<\/si>/g) || []) {
      compartidos.push(xmlDecode((si.match(/<t[^>]*>([\s\S]*?)<\/t>/g) || []).map(t => t.replace(/<[^>]+>/g, '')).join('')));
    }
  }
  const wb = z['xl/workbook.xml']();
  const rels = z['xl/_rels/workbook.xml.rels']();
  const res = {};
  for (const m of wb.matchAll(/<sheet [^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g)) {
    const target = (rels.match(new RegExp('Id="' + m[2] + '"[^>]*Target="([^"]+)"')) || rels.match(new RegExp('Target="([^"]+)"[^>]*Id="' + m[2] + '"')) || [])[1];
    if (!target) continue;
    const ruta = 'xl/' + target.replace(/^\/?xl\//, '');
    if (!z[ruta]) continue;
    const filas = [];
    for (const row of z[ruta]().match(/<row[^>]*>[\s\S]*?<\/row>/g) || []) {
      const celdas = [];
      for (const c of row.match(/<c [^>]*?(?:\/>|>[\s\S]*?<\/c>)/g) || []) {
        const ref = (c.match(/r="([A-Z]+)\d+"/) || [])[1];
        const tipo = (c.match(/ t="([^"]+)"/) || [])[1];
        let v = (c.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        if (v == null) { const is = c.match(/<t[^>]*>([\s\S]*?)<\/t>/); v = is ? xmlDecode(is[1]) : null; }
        else if (tipo === 's') v = compartidos[+v];
        else if (tipo !== 'str') v = Number(v);
        const col = ref.split('').reduce((a, ch) => a * 26 + ch.charCodeAt(0) - 64, 0) - 1;
        celdas[col] = v;
      }
      filas.push(celdas);
    }
    res[m[1]] = filas;
  }
  return res;
}
// Fecha serial de Excel → 'YYYY-MM'
const mesDeSerial = n => { const d = new Date(Math.round((n - 25569) * 864e5)); return d.toISOString().slice(0, 7); };

// Filas del bloque "IPC nivel general-Nacional", var. % mensual
function bloqueIPC(filas, colMediana) {
  const ini = filas.findIndex(f => f.some(v => typeof v === 'string' && /IPC nivel general/i.test(v)));
  if (ini < 0) return [];
  const encab = filas[ini + 1] || [];
  const col = nombre => encab.findIndex(v => typeof v === 'string' && v.trim().toLowerCase() === nombre);
  const cMed = col('mediana'), cP25 = col('percentil 25'), cP75 = col('percentil 75'), cMin = col('mínimo'), cMax = col('máximo');
  const out = [];
  for (let i = ini + 2; i < filas.length; i++) {
    const f = filas[i];
    const c0 = f.findIndex(v => v != null);
    if (c0 < 0 || typeof f[c0] !== 'number' || !/mensual/i.test(String(f[c0 + 1] || ''))) break;
    const r = x => (typeof x === 'number' ? Math.round(x * 100) / 100 : null);
    out.push({ mes: mesDeSerial(f[c0]), mediana: r(f[cMed]), p25: r(f[cP25]), p75: r(f[cP75]), min: r(f[cMin]), max: r(f[cMax]) });
  }
  return out;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  try {
    const UA = { headers: { 'User-Agent': 'Mozilla/5.0 (MiInflacion)' } };
    let urls = [];
    try {
      const html = await (await fetch(PAGINA, UA)).text();
      urls = [...html.matchAll(/href="([^"]*relevamiento-expectativas-mercado-tablas-(\d{4})-(\d{2})\.xlsx)"/g)]
        .map(m => ({ url: m[1].startsWith('http') ? m[1] : BASE + m[1], rel: m[2] + '-' + m[3] }));
    } catch (_) {}
    // Respaldo: probar los últimos 3 meses con la URL armada a mano
    for (let k = 0; k < 3; k++) {
      const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - k);
      const rel = d.toISOString().slice(0, 7);
      urls.push({ url: BASE + '/archivos/Pdfs/PublicacionesEstadisticas/informes/relevamiento-expectativas-mercado-tablas-' + rel + '.xlsx', rel });
    }
    urls.sort((a, b) => b.rel.localeCompare(a.rel));
    let buf = null, elegido = null;
    for (const u of urls) {
      try {
        const r = await fetch(u.url, UA);
        if (!r.ok) continue;
        const b = Buffer.from(await r.arrayBuffer());
        if (b.readUInt32LE(0) !== 0x04034b50) continue; // no es un .xlsx
        buf = b; elegido = u; break;
      } catch (_) {}
    }
    if (!buf) throw new Error('No se encontró el Excel del REM');
    urls[0] = elegido;
    const h = hojas(buf);
    const nombres = Object.keys(h);
    const general = bloqueIPC(h[nombres.find(n => /cuadros/i.test(n)) || nombres[0]] || []);
    const top10 = bloqueIPC(h[nombres.find(n => /top\s*10/i.test(n))] || []);
    if (!general.length) throw new Error('No se pudo leer el bloque de IPC');
    res.setHeader('Cache-Control', 's-maxage=43200, stale-while-revalidate=86400');
    res.status(200).send(JSON.stringify({ relevamiento: urls[0].rel, fuente: 'REM - BCRA', excel: urls[0].url, general, top10 }));
  } catch (e) {
    res.setHeader('Cache-Control', 's-maxage=300');
    res.status(502).send(JSON.stringify({ error: String(e.message || e) }));
  }
};
