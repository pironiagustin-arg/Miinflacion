// Vercel Serverless Function: /api/noticias
// Junta los titulares de economía de varios medios argentinos (RSS públicos),
// los ordena por fecha y los devuelve en JSON. Los diarios no permiten leer
// sus RSS directo desde el navegador (CORS), por eso pasa por acá.
// Solo titular + link + medio + fecha: la nota completa se lee en el medio.

const FEEDS = [
  { medio: 'Ámbito',      url: 'https://www.ambito.com/rss/pages/economia.xml' },
  { medio: 'Infobae',     url: 'https://www.infobae.com/arc/outboundfeeds/rss/category/economia/' },
  { medio: 'La Nación',   url: 'https://www.lanacion.com.ar/arc/outboundfeeds/rss/category/economia/?outputType=xml', filtrar: true },
  { medio: 'iProfesional',url: 'https://www.iprofesional.com/rss/economia' },
  { medio: 'Perfil',      url: 'https://www.perfil.com/feed/economia', filtrar: true },
];

const decode = s => String(s || '')
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/<[^>]+>/g, '')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
  .replace(/\s+/g, ' ').trim();
const tag = (xml, t) => { const m = xml.match(new RegExp('<' + t + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + t + '>', 'i')); return m ? decode(m[1]) : ''; };

// Clasificación simple por palabras clave para el chip de categoría
const CATS = [
  ['dolar',     /d[óo]lar|cambiari|\bmep\b|\bccl\b|blue|devalua|bandas/i],
  ['inflacion', /inflaci[óo]n|\bipc\b|precios|indec|canasta/i],
  ['mercados',  /merval|acciones|bonos|riesgo pa[íi]s|wall street|adr|lecap|plazo fijo|tasas?/i],
  ['bcra',      /\bbcra\b|banco central|reservas/i],
  ['fiscal',    /fmi|super[áa]vit|d[ée]ficit|impuesto|arca|afip|presupuesto|deuda/i],
];
// Para feeds que mezclan otras secciones: quedarse solo con lo económico
const ECONO = /econom|d[óo]lar|inflaci|precio|empleo|despid|salari|sueld|banco|tasa|mercad|consum|export|import|impuest|fiscal|deuda|bono|acci[óo]n|empresa|industri|comerci|venta|cr[ée]dit|hipotec|jubil|tarifa|paritari|pyme|fmi|bcra|indec|reserva|cosecha|soja|energ|petr[óo]le|vaca muerta|inversi|pbi|actividad|recaudaci|subsidi|alquiler/i;
const categoria = t => (CATS.find(([, re]) => re.test(t)) || ['general'])[0];

async function leerFeed({ medio, url, filtrar }) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 7000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0 (MiInflacion news reader)' } });
    if (!r.ok) return [];
    const xml = await r.text();
    return (xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || []).slice(0, 15).map(it => {
      const titulo = tag(it, 'title');
      const link = tag(it, 'link') || (it.match(/<guid[^>]*>(https?:[^<]+)<\/guid>/i) || [])[1] || '';
      const fecha = new Date(tag(it, 'pubDate') || tag(it, 'dc:date') || Date.now());
      return { titulo, link: link.trim(), medio, fecha: isNaN(fecha) ? null : fecha.toISOString(), categoria: categoria(titulo) };
    }).filter(n => n.titulo && /^https?:\/\//.test(n.link) && (!filtrar || ECONO.test(n.titulo))).slice(0, 8);
  } catch (e) { return []; } finally { clearTimeout(to); }
}

module.exports = async (req, res) => {
  const listas = await Promise.all(FEEDS.map(leerFeed));
  const vistos = new Set();
  const items = listas.flat()
    .filter(n => { const k = n.titulo.toLowerCase().slice(0, 60); if (vistos.has(k)) return false; vistos.add(k); return true; })
    .sort((a, b) => (b.fecha || '').localeCompare(a.fecha || ''))
    .slice(0, 40);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  // Cache en el CDN de Vercel: 15 min fresco, hasta 1 h sirviendo viejo mientras refresca
  res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=3600');
  res.status(200).send(JSON.stringify({ actualizado: new Date().toISOString(), items }));
};
