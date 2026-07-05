/**
 * Worker "portero" para Biblioteca Digital.
 * Rutas:
 *   GET  /db        -> devuelve db.json desde GitHub
 *   POST /db        -> guarda db.json en GitHub
 *   POST /classify  -> clasifica un producto con Gemini AI
 */

const GH_USER = 'octavofernandez275-del';
const GH_REPO = 'Biblioteca';
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

        const prompt = `Eres un clasificador de libros y ebooks digitales, y también redactor publicitario. Analiza este producto y devuelve SOLO un JSON con estos campos, sin texto extra ni backticks:
{
  "titulo_sugerido": "string — título atractivo del libro. Solo si extractMeta=true y el nombre parece un archivo (con guiones/underscores). Si no, deja vacío.",
  "descripcion_sugerida": "string — descripción de 1-2 oraciones. Solo si extractMeta=true. Si no, deja vacío.",
  "genero": "string (ej: Novela histórica, Autoayuda, Infantil, Tecnología, Negocios, Ficción, etc.)",
  "temas": ["array", "de", "3-5", "temas"],
  "autor_sugerido": "string o vacío si no hay info",
  "edad": "string (ej: Adultos, 6-10 años, Adolescentes, Todas las edades)",
  "idioma": "string",
  "nivel": "string (Principiante, Intermedio, Avanzado, o vacío)",
  "tags": ["array", "de", "3-6", "etiquetas", "cortas"],
  "ad": {
    "headline": "string — frase promocional corta y atractiva (máx 8 palabras)",
    "subheadline": "string — complemento del titular (máx 12 palabras)",
    "cta": "string — llamada a la acción breve, ej: 'Leer ahora', 'Descubrir'",
    "banner_text": "string — texto corto para un banner/badge, ej: 'Nuevo ingreso en Programación'",
    "instagram_caption": "string — texto promocional listo para redes sociales, con emojis, 2-4 líneas",
    "hashtags": ["array", "de", "4-8", "hashtags", "sin", "espacios"]
  }
}

Producto: ${name || ''}
Descripción: ${desc || ''}
Nombre del archivo: ${pdfName || 'no disponible'}
extractMeta: ${extractMeta ? 'true — genera titulo_sugerido y descripcion_sugerida' : 'false — deja titulo_sugerido y descripcion_sugerida vacíos'}
El bloque "ad" se genera siempre, tenga o no extractMeta activado, basándote en el nombre/descripción disponibles.`;

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

        // Si Gemini no devolvió texto (API key inválida, cuota agotada,
        // respuesta bloqueada por safety, etc.) lo reportamos en vez de
        // devolver un objeto vacío silenciosamente.
        const rawText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!rawText) {
          const motivo =
            geminiData.error?.message ||
            geminiData.promptFeedback?.blockReason ||
            geminiData.candidates?.[0]?.finishReason ||
            'Gemini no devolvió contenido';
          return new Response(JSON.stringify({
            error: 'Gemini no devolvió clasificación',
            detail: motivo,
            titulo_sugerido: '', descripcion_sugerida: '', genero: '',
            temas: [], autor_sugerido: '', edad: '', idioma: '', nivel: '', tags: [],
            ad: { headline: '', subheadline: '', cta: '', banner_text: '', instagram_caption: '', hashtags: [] }
          }), {
            status: 200,
            headers: { ...headers, 'Content-Type': 'application/json' },
          });
        }

        const clean = rawText.replace(/```json|```/g, '').trim();

        // Parseo seguro: si Gemini agregó texto fuera del JSON, no rompemos.
        let parsed;
        try {
          parsed = JSON.parse(clean);
        } catch (parseErr) {
          return new Response(JSON.stringify({
            error: 'Respuesta de Gemini no era JSON válido',
            detail: clean.slice(0, 300),
            titulo_sugerido: '', descripcion_sugerida: '', genero: '',
            temas: [], autor_sugerido: '', edad: '', idioma: '', nivel: '', tags: [],
            ad: { headline: '', subheadline: '', cta: '', banner_text: '', instagram_caption: '', hashtags: [] }
          }), {
            status: 200,
            headers: { ...headers, 'Content-Type': 'application/json' },
          });
        }

        return new Response(JSON.stringify(parsed), {
          headers: { ...headers, 'Content-Type': 'application/json' },
        });

      } catch (e) {
        return new Response(JSON.stringify({ error: 'Error clasificando', detail: String(e) }), {
          status: 502,
          headers: { ...headers, 'Content-Type': 'application/json' },
        });
      }
    }

    // ── GENERAR CARÁTULA con Gemini (imagen) ────────────────────
    if (url.pathname === '/generate-cover' && request.method === 'POST') {
      try {
        if (!env.AI) {
          return new Response(JSON.stringify({
            error: 'Workers AI no está habilitado en este Worker',
            detail: 'Andá a Cloudflare Dashboard → tu Worker → Settings → Bindings → Add → "Workers AI" → nombre "AI", y volvé a desplegar.'
          }), {
            status: 200,
            headers: { ...headers, 'Content-Type': 'application/json' },
          });
        }

        const body = await request.json();
        const { name, genre, desc, author, customPrompt } = body;

        let prompt;
        if (customPrompt && customPrompt.trim()) {
          // El usuario describió la portada original a mano — priorizamos su descripción
          prompt = `Book cover illustration, professional digital art style, vertical book cover proportions (2:3), no text or letters anywhere in the image, just the illustration/artwork.
${customPrompt.trim()}
Context — book title (do not render as text in the image): ${name || 'Untitled'}
Clean composition, centered, suitable for a small store thumbnail.`;
        } else {
          prompt = `Book cover illustration, professional digital art style, vertical book cover proportions (2:3), no text or letters anywhere in the image, just the illustration/artwork.
Book title: ${name || 'Untitled'}
Genre/theme: ${genre || 'General'}
${desc ? `About: ${desc}` : ''}
${author ? `Author: ${author}` : ''}
Clean composition, attractive colors, centered, suitable for a small store thumbnail.`;
        }

        const result = await env.AI.run('@cf/black-forest-labs/flux-1-schnell', {
          prompt: prompt.slice(0, 2000),
        });

        // El binding puede devolver { image: base64 } o un ReadableStream según el modelo/versión
        let base64;
        if (result?.image) {
          base64 = result.image;
        } else if (result instanceof ReadableStream || result?.getReader) {
          const buf = await new Response(result).arrayBuffer();
          base64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
        } else if (result instanceof Uint8Array || result?.byteLength !== undefined) {
          base64 = btoa(String.fromCharCode(...new Uint8Array(result)));
        }

        if (!base64) {
          return new Response(JSON.stringify({ error: 'Workers AI no devolvió ninguna imagen', detail: JSON.stringify(result).slice(0,300) }), {
            status: 200,
            headers: { ...headers, 'Content-Type': 'application/json' },
          });
        }

        return new Response(JSON.stringify({ image: `data:image/png;base64,${base64}` }), {
          headers: { ...headers, 'Content-Type': 'application/json' },
        });

      } catch (e) {
        return new Response(JSON.stringify({ error: 'Error generando carátula', detail: String(e) }), {
          status: 502,
          headers: { ...headers, 'Content-Type': 'application/json' },
        });
      }
    }

    // ── BUSCAR PORTADA REAL DEL LIBRO ─────────────────────────
    // Orden de prioridad: 1) Google Books (catálogo comercial amplio, gratis, sin tarjeta)
    // 2) Open Library (gratis, sin API key, buen respaldo)
    // 3) Scrappa.co (buscador general de imágenes, respaldo final para libros raros/independientes)
    if (url.pathname === '/search-cover-images' && request.method === 'POST') {
      try {
        const body = await request.json();
        const { query, author } = body;
        if (!query || !query.trim()) {
          return new Response(JSON.stringify({ error: 'Falta el campo query' }), {
            status: 400,
            headers: { ...headers, 'Content-Type': 'application/json' },
          });
        }
        const title = query.trim();
        let results = [];

        // 1) Google Books API (gratis, no requiere tarjeta; key opcional pero recomendada)
        try {
          const gbUrl = new URL('https://www.googleapis.com/books/v1/volumes');
          let q = `intitle:${title}`;
          if (author) q += `+inauthor:${author}`;
          gbUrl.searchParams.set('q', q);
          gbUrl.searchParams.set('maxResults', '10');
          if (env.GOOGLE_BOOKS_API_KEY) gbUrl.searchParams.set('key', env.GOOGLE_BOOKS_API_KEY);

          const gbRes = await fetch(gbUrl.toString());
          const gbData = await gbRes.json();
          if (gbRes.ok && gbData.items) {
            results.push(...gbData.items
              .filter(it => it.volumeInfo?.imageLinks)
              .map(it => {
                const img = it.volumeInfo.imageLinks;
                const best = (img.extraLarge || img.large || img.medium || img.thumbnail || img.smallThumbnail || '').replace('http://', 'https://');
                return {
                  title: it.volumeInfo.title || '',
                  imageUrl: best,
                  thumbnailUrl: (img.thumbnail || img.smallThumbnail || best).replace('http://', 'https://'),
                  contextUrl: it.volumeInfo.infoLink || '',
                  source: 'Google Books',
                };
              }));
          }
        } catch (e) { console.warn('Google Books falló:', e); }

        // 2) Open Library (gratis, sin key)
        try {
          const olUrl = new URL('https://openlibrary.org/search.json');
          olUrl.searchParams.set('title', title);
          if (author) olUrl.searchParams.set('author', author);
          olUrl.searchParams.set('limit', '10');

          const olRes = await fetch(olUrl.toString());
          const olData = await olRes.json();
          if (olRes.ok && olData.docs) {
            results.push(...olData.docs
              .filter(d => d.cover_i)
              .map(d => ({
                title: d.title || '',
                imageUrl: `https://covers.openlibrary.org/b/id/${d.cover_i}-L.jpg`,
                thumbnailUrl: `https://covers.openlibrary.org/b/id/${d.cover_i}-M.jpg`,
                contextUrl: d.key ? `https://openlibrary.org${d.key}` : '',
                source: 'Open Library',
              })));
          }
        } catch (e) { console.warn('Open Library falló:', e); }

        // 3) Respaldo: Scrappa.co (buscador general de imágenes), solo si no hubo resultados oficiales
        if (results.length === 0 && env.SCRAPPA_API_KEY) {
          try {
            const scUrl = new URL('https://scrappa.co/api/google-images');
            scUrl.searchParams.set('api_key', env.SCRAPPA_API_KEY);
            scUrl.searchParams.set('q', `${title} ${author || ''} libro portada book cover`.trim());

            const scRes = await fetch(scUrl.toString());
            const scData = await scRes.json();
            if (scRes.ok && !scData.error) {
              const raw = scData.images || scData.results || scData.data || [];
              results.push(...raw.slice(0, 10).map(item => ({
                title: item.title || '',
                imageUrl: item.imageUrl || item.image_url || item.original || item.url || item.link,
                thumbnailUrl: item.thumbnailUrl || item.thumbnail_url || item.thumbnail || item.imageUrl || item.image_url,
                contextUrl: item.link || item.source_url || '',
                source: item.source || item.domain || 'Internet',
              })).filter(r => r.imageUrl));
            }
          } catch (e) { console.warn('Scrappa (respaldo) falló:', e); }
        }

        return new Response(JSON.stringify({ results: results.slice(0, 12) }), {
          headers: { ...headers, 'Content-Type': 'application/json' },
        });

      } catch (e) {
        return new Response(JSON.stringify({ error: 'Error buscando portada en internet', detail: String(e) }), {
          status: 502,
          headers: { ...headers, 'Content-Type': 'application/json' },
        });
      }
    }

    // ── PROXY DE IMAGEN (para descargar una portada elegida sin CORS) ──
    if (url.pathname === '/image-proxy' && request.method === 'GET') {
      const imgUrl = url.searchParams.get('url');
      if (!imgUrl) {
        return new Response(JSON.stringify({ error: 'Falta parámetro url' }), {
          status: 400, headers: { ...headers, 'Content-Type': 'application/json' },
        });
      }
      try {
        const imgRes = await fetch(imgUrl, { headers: { 'User-Agent': 'biblioteca-worker' } });
        if (!imgRes.ok) {
          return new Response(JSON.stringify({ error: `Error al obtener imagen: ${imgRes.status}` }), {
            status: imgRes.status, headers: { ...headers, 'Content-Type': 'application/json' },
          });
        }
        const imgBody = await imgRes.arrayBuffer();
        return new Response(imgBody, {
          status: 200,
          headers: {
            ...headers,
            'Content-Type': imgRes.headers.get('Content-Type') || 'image/jpeg',
            'Cache-Control': 'public, max-age=3600',
          },
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: 'Error en proxy de imagen', detail: String(e) }), {
          status: 502, headers: { ...headers, 'Content-Type': 'application/json' },
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
