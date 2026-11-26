// Edge Function: indec-ipc
// Proxy a la API oficial de INDEC (https://api.indec.gob.ar/v1, beta desde nov-2026).
// La API pide un token JWT personal (cuenta gratis, vence a los 12 meses), por eso
// no puede ir en el index.html público: queda guardado como secreto en Supabase.
//
// Deploy:
//   supabase secrets set INDEC_TOKEN=<token de api.indec.gob.ar → Gestionar la cuenta>
//   supabase functions deploy indec-ipc --no-verify-jwt
// Después, en index.html: const INDEC_PROXY = 'https://<ref>.supabase.co/functions/v1/indec-ipc';
//
// Devuelve el mismo formato que usa aplicarIPCDivisiones() en el front:
// { fecha:'YYYY-MM-01', divisiones:[{name,cat,v}], nucleo, regulados, estacionales, general, fuente }

const API = "https://api.indec.gob.ar/v1/ipc_nacional";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
};

// Nombre que muestra la app → palabras clave para reconocer la división en la descripción de INDEC
const DIVISIONES: { name: string; cat: string | null; match: RegExp }[] = [
  { name: "Alimentos y bebidas", cat: "alimentos", match: /alimentos/i },
  { name: "Bebidas alc./tabaco", cat: null, match: /alcoh|tabaco/i },
  { name: "Indumentaria/calzado", cat: "indumentaria", match: /prendas|calzado/i },
  { name: "Vivienda y servicios", cat: "vivienda", match: /vivienda/i },
  { name: "Equipam. del hogar", cat: "hogar", match: /equipamiento/i },
  { name: "Salud", cat: "salud", match: /^salud/i },
  { name: "Transporte", cat: "transporte", match: /^transporte/i },
  { name: "Comunicación", cat: "comunicaciones", match: /comunicaci/i },
  { name: "Recreación y cultura", cat: "recreacion", match: /recreaci/i },
  { name: "Educación", cat: "educacion", match: /^educaci/i },
  { name: "Restaurantes y hoteles", cat: "restaurantes", match: /restaurant/i },
];

let cache: { t: number; body: string } | null = null;
const TTL = 6 * 60 * 60 * 1000;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (cache && Date.now() - cache.t < TTL) {
    return new Response(cache.body, { headers: { ...CORS, "Content-Type": "application/json" } });
  }
  const token = Deno.env.get("INDEC_TOKEN");
  if (!token) return json({ error: "Falta el secreto INDEC_TOKEN" }, 500);

  try {
    const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };
    // Último período publicado
    const q1 = new URL(API);
    q1.searchParams.set("select", "periodo");
    q1.searchParams.set("order", "periodo.desc");
    q1.searchParams.set("limit", "1");
    const last = await (await ok(fetch(q1, { headers }))).json();
    const periodo: string = last?.[0]?.periodo;
    if (!periodo) throw new Error("INDEC sin períodos");

    // Variación mensual, total nacional, de ese período
    const q2 = new URL(API);
    q2.searchParams.set("select", "descripcion,nivel,clasificador,region,tipo_de_indicador,valor");
    q2.searchParams.set("periodo", `eq.${periodo}`);
    q2.searchParams.set("region", "ilike.*nacional*");
    q2.searchParams.set("tipo_de_indicador", "ilike.*mensual*");
    q2.searchParams.set("limit", "500");
    const rows: { descripcion: string; nivel: string; clasificador: string; valor: number }[] =
      await (await ok(fetch(q2, { headers }))).json();

    const buscar = (re: RegExp, filtro?: (r: (typeof rows)[number]) => boolean) =>
      rows.find((r) => re.test(String(r.descripcion).trim()) && (!filtro || filtro(r)))?.valor ?? null;
    const esDivision = (r: (typeof rows)[number]) => /divisi/i.test(`${r.nivel} ${r.clasificador}`);
    const r1 = (v: number | null) => (v == null ? null : Math.round(Number(v) * 10) / 10);

    const divisiones = DIVISIONES.map((d) => ({
      name: d.name,
      cat: d.cat,
      v: r1(buscar(d.match, esDivision) ?? buscar(d.match)),
    })).filter((d) => d.v != null);
    if (divisiones.length < 6) throw new Error(`INDEC: solo ${divisiones.length} divisiones reconocidas`);

    const body = JSON.stringify({
      fecha: `${periodo.slice(0, 4)}-${periodo.slice(4, 6)}-01`,
      general: r1(buscar(/nivel general/i)),
      divisiones,
      nucleo: r1(buscar(/n[uú]cleo/i)),
      regulados: r1(buscar(/regulados/i)),
      estacionales: r1(buscar(/estacional/i)),
      fuente: "INDEC (API oficial)",
    });
    cache = { t: Date.now(), body };
    return new Response(body, { headers: { ...CORS, "Content-Type": "application/json" } });
  } catch (e) {
    if (cache) return new Response(cache.body, { headers: { ...CORS, "Content-Type": "application/json" } });
    return json({ error: String(e) }, 502);
  }
});

async function ok(p: Promise<Response>) {
  const r = await p;
  if (!r.ok) throw new Error(`INDEC HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r;
}
function json(o: unknown, status = 200) {
  return new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}
