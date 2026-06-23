/**
 * Worker "portero" para Biblioteca Digital.
 * Rutas:
 *   GET  /db        -> devuelve db.json desde GitHub
 *   POST /db        -> guarda db.json en GitHub
 *   POST /classify  -> clasifica un producto con Gemini AI
 */

const GH_USER = 'octavofernandez275-del';
const GH_REPO = 'biblioteca';
const GH_FILE = 'db.json';

const ALLOWED_ORIGINS = ['*'];

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes('*') ? '*' : (ALLOWED_ORIGINS.includes(origin) ? origin : ''),
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

async function githubGet(env) {
  const res = await fetch(
    `https://api.github.com/repos/${GH_USER}/${GH_REPO}/contents/${GH_FILE}`,
    { headers: { Authorization: `token ${env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'biblioteca-worker' } }
  );
  return res;
}

async function githubPut(env, contentObj, sha) {
  const content = btoa(unescape(encodeURIComponent(JSON.stringify(contentObj, null, 2))));
  const res = await fetch(
    `https://api.github.com/repos/${GH_USER}/${GH_REPO}/contents/${GH_FILE}`,
    {
      method: 'PUT',
      headers: {
        Authorization: `token ${env.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'biblioteca-worker',
      },
      body: JSON.stringify({
        message: 'Actualizar base de datos',
        content,
        ...(sha ? { sha } : {}),
      }),
    }
  );
  return res;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const headers = corsHeaders(origin);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers });
    }

    // ── CLASSIFY con Gemini ─────────────────────────────────────
    if (url.pathname === '/classify' && request.method === 'POST') {
      try {
        if (!env.GEMINI_API_KEY) {
          return new Response(JSON.stringify({ error: 'GEMINI_API_KEY no configurada' }), {
            status: 500,
            headers: { ...headers, 'Content-Type': 'application/json' },
          });
        }

        const body = await request.json();
        const { name, desc, pdfName, extractMeta } = body;

        const prompt = `Eres un clasificador de libros y ebooks digitales. Analiza este producto y devuelve SOLO un JSON con estos campos, sin texto extra ni backticks:
{
  "titulo_sugerido": "string — título atractivo del libro. Solo si extractMeta=true y el nombre parece un archivo (con guiones/underscores). Si no, deja vacío.",
  "descripcion_sugerida": "string — descripción de 1-2 oraciones. Solo si extractMeta=true. Si no, deja vacío.",
  "genero": "string (ej: Novela histórica, Autoayuda, Infantil, Tecnología, Negocios, Ficción, etc.)",
  "temas": ["array", "de", "3-5", "temas"],
  "autor_sugerido": "string o vacío si no hay info",
  "edad": "string (ej: Adultos, 6-10 años, Adolescentes, Todas las edades)",
  "idioma": "string",
  "nivel": "string (Principiante, Intermedio, Avanzado, o vacío)",
  "tags": ["array", "de", "3-6", "etiquetas", "cortas"]
}

Producto: ${name || ''}
Descripción: ${desc || ''}
Nombre del archivo: ${pdfName || 'no disponible'}
extractMeta: ${extractMeta ? 'true — genera titulo_sugerido y descripcion_sugerida' : 'false — deja titulo_sugerido y descripcion_sugerida vacíos'}`;

        const geminiRes = await fetch(
          'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-goog-api-key': env.GEMINI_API_KEY,
            },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }]
            }),
          }
        );

        const geminiData = await geminiRes.json();
        const text = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
        const clean = text.replace(/```json|```/g, '').trim();

        return new Response(clean, {
          headers: { ...headers, 'Content-Type': 'application/json' },
        });

      } catch (e) {
        return new Response(JSON.stringify({ error: 'Error clasificando', detail: String(e) }), {
          status: 502,
          headers: { ...headers, 'Content-Type': 'application/json' },
        });
      }
    }

    // ── UPLOAD archivo a GitHub ─────────────────────────────────
    if (url.pathname === '/upload' && request.method === 'POST') {
      try {
        if (!env.GITHUB_TOKEN) {
          return new Response(JSON.stringify({ error: 'GITHUB_TOKEN no configurado' }), {
            status: 500, headers: { ...headers, 'Content-Type': 'application/json' },
          });
        }
        const body = await request.json();
        const { path, content } = body; // content = base64 puro, path = 'pdfs/xxx.pdf'
        if (!path || !content) {
          return new Response(JSON.stringify({ error: 'Faltan campos path o content' }), {
            status: 400, headers: { ...headers, 'Content-Type': 'application/json' },
          });
        }

        // Verificar si ya existe para obtener sha
        let sha = null;
        try {
          const check = await fetch(
            `https://api.github.com/repos/${GH_USER}/${GH_REPO}/contents/${path}`,
            { headers: { Authorization: `token ${env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'biblioteca-worker' } }
          );
          if (check.ok) { const d = await check.json(); sha = d.sha; }
        } catch(e) {}

        const putRes = await fetch(
          `https://api.github.com/repos/${GH_USER}/${GH_REPO}/contents/${path}`,
          {
            method: 'PUT',
            headers: {
              Authorization: `token ${env.GITHUB_TOKEN}`,
              Accept: 'application/vnd.github+json',
              'Content-Type': 'application/json',
              'User-Agent': 'biblioteca-worker',
            },
            body: JSON.stringify({
              message: `Upload: ${path}`,
              content,
              ...(sha ? { sha } : {}),
            }),
          }
        );

        if (!putRes.ok) {
          const text = await putRes.text();
          return new Response(JSON.stringify({ error: 'Error subiendo archivo', detail: text }), {
            status: putRes.status, headers: { ...headers, 'Content-Type': 'application/json' },
          });
        }

        const data = await putRes.json();
        return new Response(JSON.stringify({ ok: true, url: data.content.download_url }), {
          headers: { ...headers, 'Content-Type': 'application/json' },
        });

      } catch (e) {
        return new Response(JSON.stringify({ error: 'Fallo al subir archivo', detail: String(e) }), {
          status: 502, headers: { ...headers, 'Content-Type': 'application/json' },
        });
      }
    }

    // ── PDF PROXY (evita CORS de raw.githubusercontent.com) ──────
    if (url.pathname === '/pdf-proxy' && request.method === 'GET') {
      const pdfUrl = url.searchParams.get('url');
      if (!pdfUrl) {
        return new Response(JSON.stringify({ error: 'Falta parámetro url' }), {
          status: 400, headers: { ...headers, 'Content-Type': 'application/json' },
        });
      }
      try {
        const pdfRes = await fetch(pdfUrl, {
          headers: { 'User-Agent': 'biblioteca-worker' },
        });
        if (!pdfRes.ok) {
          return new Response(JSON.stringify({ error: `Error al obtener PDF: ${pdfRes.status}` }), {
            status: pdfRes.status, headers: { ...headers, 'Content-Type': 'application/json' },
          });
        }
        const pdfBody = await pdfRes.arrayBuffer();
        return new Response(pdfBody, {
          status: 200,
          headers: {
            ...headers,
            'Content-Type': 'application/pdf',
            'Cache-Control': 'public, max-age=3600',
          },
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: 'Error en proxy PDF', detail: String(e) }), {
          status: 502, headers: { ...headers, 'Content-Type': 'application/json' },
        });
      }
    }

    // ── DB ──────────────────────────────────────────────────────
    if (!env.GITHUB_TOKEN) {
      return new Response(JSON.stringify({ error: 'GITHUB_TOKEN no configurado en el Worker' }), {
        status: 500,
        headers: { ...headers, 'Content-Type': 'application/json' },
      });
    }

    if (url.pathname === '/db' && request.method === 'GET') {
      try {
        const res = await githubGet(env);
        if (res.status === 404) {
          return new Response(JSON.stringify({ users: [], orders: [], products: [], emailList: [] }), {
            headers: { ...headers, 'Content-Type': 'application/json' },
          });
        }
        if (!res.ok) {
          const text = await res.text();
          return new Response(JSON.stringify({ error: 'Error de GitHub', detail: text, status: res.status }), {
            status: res.status,
            headers: { ...headers, 'Content-Type': 'application/json' },
          });
        }
        const data = await res.json();
        const decoded = decodeURIComponent(escape(atob(data.content)));
        return new Response(decoded, {
          headers: { ...headers, 'Content-Type': 'application/json' },
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: 'Fallo al leer', detail: String(e) }), {
          status: 502,
          headers: { ...headers, 'Content-Type': 'application/json' },
        });
      }
    }

    if (url.pathname === '/db' && request.method === 'POST') {
      try {
        const body = await request.json();
        const newData = body.data;
        if (!newData) {
          return new Response(JSON.stringify({ error: 'Falta el campo data' }), {
            status: 400,
            headers: { ...headers, 'Content-Type': 'application/json' },
          });
        }

        const check = await githubGet(env);
        const sha = check.ok ? (await check.json()).sha : undefined;

        let putRes = await githubPut(env, newData, sha);

        if (putRes.status === 409 || putRes.status === 422) {
          const recheck = await githubGet(env);
          const freshSha = recheck.ok ? (await recheck.json()).sha : undefined;
          putRes = await githubPut(env, newData, freshSha);
        }

        if (!putRes.ok) {
          const text = await putRes.text();
          return new Response(JSON.stringify({ error: 'Error guardando en GitHub', detail: text, status: putRes.status }), {
            status: putRes.status,
            headers: { ...headers, 'Content-Type': 'application/json' },
          });
        }

        return new Response(JSON.stringify({ ok: true }), {
          headers: { ...headers, 'Content-Type': 'application/json' },
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: 'Fallo al guardar', detail: String(e) }), {
          status: 502,
          headers: { ...headers, 'Content-Type': 'application/json' },
        });
      }
    }

    return new Response(JSON.stringify({ error: 'Ruta no encontrada' }), {
      status: 404,
      headers: { ...headers, 'Content-Type': 'application/json' },
    });
  },
};
