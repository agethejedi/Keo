// Cloudflare Pages Function: /api/keo
// Keo — JARVIS's writing agent. Independent from Tania's pipeline and memory.
// D1 binding variable name: DB (database: KEO_MEMORY)

const MODE_GUIDANCE = {
  document: "Resumes, proposals, reports, contracts. Structure matters — headers, clean hierarchy, scannable. Lead with the strongest point. Cut throat-clearing.",
  email: "Professional correspondence. Subject line if relevant. Get to the point in the first sentence. Sign-offs match the relationship — don't default to overly formal if the context is casual.",
  message: "Texts and quick messages. Short. No corporate phrasing. Sounds like a person, not a brand.",
  social: "Platform-aware — Instagram, LinkedIn, Twitter/X, Facebook. Match the platform's actual voice: LinkedIn can be slightly more composed, X needs to land in one read, Instagram captions support a more personal register. Ask which platform if it's not stated.",
  review: "Customer review responses. Acknowledge specifics from their review — never generic. If it's negative, address the actual complaint, offer a concrete next step, no defensiveness. If it's positive, be genuinely warm without sounding templated.",
  brief: "Short situational writing — talking points, quick summaries, situational notes. Dense with substance, no padding.",
};

const KEO_SYSTEM_PROMPT_BASE = `You are Keo — a writing agent built to help Ron with professional and operational documents.

Your register is precise, efficient, and editorial. Clean declarative sentences. No performed enthusiasm — never say "great question" or similar. State opinions as direct observations: "Here's what I'm seeing" rather than praise or hedging.

You are NOT Tania. Tania is JARVIS's creative narrative agent — emotional, poetic, working in fiction and character voice. You work in the real world, on real documents, for real outcomes. You do not have access to Tania's documents, characters, or memory, and you never reference her work.

You have a real workspace. You can see Ron's existing documents (listed below if any exist) and you can create new ones. When you want to save a document, end your response with a marker on its own line:

[SAVE_DOCUMENT: title | mode | content]

Use this when:
- You've drafted something substantial Ron should keep (a resume, email, proposal, etc.)
- Ron asks you to save what you've written
- A draft is ready for him to review as a real document, not just a chat reply

The mode field must be exactly one of: document, email, message, social, review, brief.

If Ron is continuing work on an already-open document (indicated below), and you're revising it rather than starting fresh, use this marker instead:

[UPDATE_DOCUMENT: document_id | content]

When Ron brings you a task:
1. Ask what he's working on if it's not clear.
2. If it's tailored to something specific (a job posting, a client, a platform), ask for the relevant details.
3. Draft directly and confidently. Don't ask permission for every small choice — make a strong first draft, then flag the two or three decisions you want his eyes on specifically.
4. When revising, be concise about what changed and why.
5. Save substantial drafts using the markers above.

Keep responses focused. This is a working relationship, not a performance — you're the best editor Ron has ever worked with, and the best editors don't waste words.

## WRITING MODES

`;

function buildSystemPrompt(documentContext, activeDocContext, mode) {
  let prompt = documentContext + KEO_SYSTEM_PROMPT_BASE;
  prompt += Object.entries(MODE_GUIDANCE).map(([k, v]) => `**${k.toUpperCase()}**: ${v}`).join("\n\n");
  if (mode && MODE_GUIDANCE[mode]) {
    prompt += `\n\n## CURRENT MODE: ${mode.toUpperCase()}\n\nRon has selected this mode for the current task. ${MODE_GUIDANCE[mode]}`;
  }
  if (activeDocContext) {
    prompt += `\n\n## ACTIVE DOCUMENT\n\n${activeDocContext}`;
  }
  return prompt;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...CORS } });

// ── Load existing documents for context ────────────────────────────────────
async function loadDocumentContext(db) {
  if (!db) return "";
  try {
    const result = await db.prepare(
      "SELECT id, title, mode, status, updated_at FROM keo_documents ORDER BY updated_at DESC LIMIT 10"
    ).all();
    const docs = result.results || [];
    if (!docs.length) return "## EXISTING DOCUMENTS\n\nNo documents yet. This is Ron's first session in his workspace.\n\n";
    return "## EXISTING DOCUMENTS\n\n" +
      docs.map(d => `- [${d.id}] "${d.title}" (${d.mode}, ${d.status}) — last updated ${d.updated_at}`).join("\n") +
      "\n\n";
  } catch (err) {
    console.error("Keo document load error:", String(err));
    return "";
  }
}

async function loadActiveDocument(db, docId) {
  if (!db || !docId) return "";
  try {
    const doc = await db.prepare("SELECT * FROM keo_documents WHERE id = ?").bind(docId).first();
    if (!doc) return "";
    return `Ron currently has this document open:\n\nTitle: "${doc.title}"\nMode: ${doc.mode}\nID: ${doc.id}\n\nContent:\n${doc.content}\n\nIf he asks you to revise or continue this, use the [UPDATE_DOCUMENT: ${doc.id} | new full content] marker rather than creating a new document.`;
  } catch (err) {
    console.error("Keo active doc load error:", String(err));
    return "";
  }
}

// ── Parse markers and persist to D1 ─────────────────────────────────────────
async function parseAndPersist(db, responseText) {
  if (!db) return { savedDoc: null, updatedDoc: null, cleanText: responseText };

  let cleanText = responseText;
  let savedDoc = null;
  let updatedDoc = null;

  const saveMatch = responseText.match(/\[SAVE_DOCUMENT:\s*([^|]+)\|([^|]+)\|([\s\S]+?)\]/);
  if (saveMatch) {
    const [full, title, mode, content] = saveMatch;
    const cleanTitle = title.trim();
    const cleanMode = mode.trim().toLowerCase();
    const cleanContent = content.trim();
    const wordCount = cleanContent.split(/\s+/).filter(Boolean).length;

    try {
      const result = await db.prepare(
        "INSERT INTO keo_documents (title, mode, content, plain_text, word_count, status) VALUES (?, ?, ?, ?, ?, 'draft')"
      ).bind(cleanTitle, cleanMode, cleanContent, cleanContent, wordCount).run();

      const docId = result.meta.last_row_id;
      await db.prepare(
        "INSERT INTO keo_versions (document_id, version, content) VALUES (?, 1, ?)"
      ).bind(docId, cleanContent).run();

      savedDoc = { ok: true, id: docId, title: cleanTitle, mode: cleanMode };
      cleanText = cleanText.replace(full, "").trim();
    } catch (err) {
      console.error("Keo save error:", String(err));
    }
  }

  const updateMatch = responseText.match(/\[UPDATE_DOCUMENT:\s*(\d+)\s*\|([\s\S]+?)\]/);
  if (updateMatch) {
    const [full, docIdStr, content] = updateMatch;
    const docId = parseInt(docIdStr.trim(), 10);
    const cleanContent = content.trim();
    const wordCount = cleanContent.split(/\s+/).filter(Boolean).length;

    try {
      const existing = await db.prepare("SELECT * FROM keo_versions WHERE document_id = ? ORDER BY version DESC LIMIT 1").bind(docId).first();
      const nextVersion = existing ? existing.version + 1 : 1;

      await db.prepare(
        "UPDATE keo_documents SET content = ?, plain_text = ?, word_count = ?, updated_at = datetime('now') WHERE id = ?"
      ).bind(cleanContent, cleanContent, wordCount, docId).run();

      await db.prepare(
        "INSERT INTO keo_versions (document_id, version, content) VALUES (?, ?, ?)"
      ).bind(docId, nextVersion, cleanContent).run();

      const doc = await db.prepare("SELECT title, mode FROM keo_documents WHERE id = ?").bind(docId).first();
      updatedDoc = { ok: true, id: docId, title: doc?.title, mode: doc?.mode, version: nextVersion };
      cleanText = cleanText.replace(full, "").trim();
    } catch (err) {
      console.error("Keo update error:", String(err));
    }
  }

  return { savedDoc, updatedDoc, cleanText };
}

// ── GET — list / fetch documents ────────────────────────────────────────────
export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const resource = url.searchParams.get("resource");
  const db = env.DB;

  if (!db) return json({ error: "DB not configured" }, 503);

  if (resource === "documents") {
    const status = url.searchParams.get("status");
    let query = "SELECT id, title, mode, status, word_count, created_at, updated_at FROM keo_documents";
    if (status && status !== "all") query += ` WHERE status = '${status}'`;
    query += " ORDER BY updated_at DESC";
    const result = await db.prepare(query).all();
    return json({ documents: result.results || [] });
  }

  if (resource === "document") {
    const id = url.searchParams.get("id");
    if (!id) return json({ error: "id required" }, 400);
    const doc = await db.prepare("SELECT * FROM keo_documents WHERE id = ?").bind(id).first();
    if (!doc) return json({ error: "Document not found" }, 404);
    const latestVersion = await db.prepare(
      "SELECT version FROM keo_versions WHERE document_id = ? ORDER BY version DESC LIMIT 1"
    ).bind(id).first();
    return json({ document: { ...doc, version: latestVersion?.version || 1 } });
  }

  if (resource === "modes") {
    return json({ modes: Object.keys(MODE_GUIDANCE) });
  }

  if (resource === "quotes") {
    const search = url.searchParams.get("search");
    let query = "SELECT * FROM keo_quotes";
    const params = [];
    if (search) {
      query += " WHERE quote_text LIKE ? OR document_title LIKE ? OR note LIKE ?";
      const pattern = `%${search}%`;
      params.push(pattern, pattern, pattern);
    }
    query += " ORDER BY created_at DESC";
    const stmt = params.length ? db.prepare(query).bind(...params) : db.prepare(query);
    const result = await stmt.all();
    return json({ quotes: result.results || [] });
  }

  return json({ error: "Unknown resource" }, 404);
}

// ── DELETE — remove a document or a quote ────────────────────────────────────
export async function onRequestDelete(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const resource = url.searchParams.get("resource");
  const id = url.searchParams.get("id");
  const db = env.DB;

  if (!db) return json({ error: "DB not configured" }, 503);
  if (!id) return json({ error: "id required" }, 400);

  if (resource === "quote") {
    try {
      await db.prepare("DELETE FROM keo_quotes WHERE id = ?").bind(id).run();
      return json({ ok: true, deleted: id });
    } catch (err) {
      return json({ error: String(err) }, 500);
    }
  }

  try {
    await db.prepare("DELETE FROM keo_versions WHERE document_id = ?").bind(id).run();
    await db.prepare("DELETE FROM keo_quotes WHERE document_id = ?").bind(id).run();
    await db.prepare("DELETE FROM keo_documents WHERE id = ?").bind(id).run();
    return json({ ok: true, deleted: id });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
}

// ── PATCH — direct manual edit from the editor (not via Keo conversation) ──
export async function onRequestPatch(context) {
  const { request, env } = context;
  const db = env.DB;

  if (!db) return json({ error: "DB not configured" }, 503);

  let body;
  try { body = await request.json(); }
  catch { return json({ error: "Invalid JSON" }, 400); }

  const { id, content } = body;
  if (!id || content == null) return json({ error: "id and content required" }, 400);

  const wordCount = content.trim().split(/\s+/).filter(Boolean).length;

  try {
    await db.prepare(
      "UPDATE keo_documents SET content = ?, plain_text = ?, word_count = ?, updated_at = datetime('now') WHERE id = ?"
    ).bind(content, content, wordCount, id).run();

    const existing = await db.prepare(
      "SELECT version FROM keo_versions WHERE document_id = ? ORDER BY version DESC LIMIT 1"
    ).bind(id).first();
    const nextVersion = existing ? existing.version + 1 : 1;

    await db.prepare(
      "INSERT INTO keo_versions (document_id, version, content, summary) VALUES (?, ?, ?, 'Manual edit')"
    ).bind(id, nextVersion, content).run();

    return json({ ok: true, id, version: nextVersion, word_count: wordCount });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
}

// ── POST — conversation with Keo ─────────────────────────────────────────────
export async function onRequestPost(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const resource = url.searchParams.get("resource");
  const db = env.DB;

  // ── Save a quote — separate from the Keo conversation flow ──────────────
  if (resource === "quote") {
    if (!db) return json({ error: "DB not configured" }, 503);
    let qBody;
    try { qBody = await request.json(); }
    catch { return json({ error: "Invalid JSON" }, 400); }

    const { document_id, document_title, quote_text, note } = qBody;
    if (!quote_text) return json({ error: "quote_text required" }, 400);

    try {
      const result = await db.prepare(
        "INSERT INTO keo_quotes (document_id, document_title, quote_text, note) VALUES (?, ?, ?, ?)"
      ).bind(document_id || null, document_title || "Untitled", quote_text, note || null).run();
      return json({ ok: true, id: result.meta.last_row_id });
    } catch (err) {
      return json({ error: String(err) }, 500);
    }
  }

  if (!env.ANTHROPIC_API_KEY) {
    return json({ error: "ANTHROPIC_API_KEY not configured." }, 500);
  }

  let body;
  try { body = await request.json(); }
  catch { return json({ error: "Invalid JSON" }, 400); }

  const { messages, activeDocId, mode } = body;
  if (!Array.isArray(messages)) {
    return json({ error: "messages array required" }, 400);
  }

  const documentContext = await loadDocumentContext(db);
  const activeDocContext = await loadActiveDocument(db, activeDocId);
  const systemPrompt = buildSystemPrompt(documentContext, activeDocContext, mode);

  try {
    const anthropicResponse = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 2048,
        system: systemPrompt,
        messages,
      }),
    });

    const data = await anthropicResponse.json();

    if (!anthropicResponse.ok) {
      return json({ error: "Anthropic API error", detail: data }, anthropicResponse.status);
    }

    if (data.content && db) {
      const textBlocks = data.content.filter(b => b.type === "text");
      const fullText = textBlocks.map(b => b.text).join("\n");
      const { savedDoc, updatedDoc, cleanText } = await parseAndPersist(db, fullText);

      if (savedDoc) data.document_saved = savedDoc;
      if (updatedDoc) data.document_updated = updatedDoc;

      if (savedDoc || updatedDoc) {
        data.content = data.content.map(b => b.type === "text" ? { ...b, text: cleanText } : b);
      }
    }

    return json(data);

  } catch (err) {
    return json({ error: "Proxy error", detail: String(err) }, 500);
  }
}

export async function onRequestOptions() {
  return new Response(null, { headers: CORS });
}
