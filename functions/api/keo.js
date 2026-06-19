// Cloudflare Pages Function: /api/keo
// Keo — JARVIS's writing agent. Independent from Tania's pipeline and memory.
// D1 binding variable name: DB (database: KEO_MEMORY)
// Env vars: ANTHROPIC_API_KEY, ELEVENLABS_API_KEY, ELEVENLABS_KEO_VOICE_ID

const MODE_GUIDANCE = {
  document: "Resumes, proposals, reports, contracts. Structure matters — headers, clean hierarchy, scannable. Lead with the strongest point. Cut throat-clearing.",
  email: "Professional correspondence. Subject line if relevant. Get to the point in the first sentence. Sign-offs match the relationship — don't default to overly formal if the context is casual.",
  message: "Texts and quick messages. Short. No corporate phrasing. Sounds like a person, not a brand.",
  social: "Platform-aware — Instagram, LinkedIn, Twitter/X, Facebook. Match the platform's actual voice: LinkedIn can be slightly more composed, X needs to land in one read, Instagram captions support a more personal register. Ask which platform if it's not stated.",
  review: "Customer review responses. Acknowledge specifics from their review — never generic. If it's negative, address the actual complaint, offer a concrete next step, no defensiveness. If it's positive, be genuinely warm without sounding templated.",
  brief: "Short situational writing — talking points, quick summaries, situational notes. Dense with substance, no padding.",
  screenplay: `Industry-standard screenplay format. Scene headings (INT./EXT. LOCATION - DAY/NIGHT) in caps on their own line. Action lines in present tense, lean and visual — what the camera sees, not what characters feel internally. Character names centered and capped above dialogue. Parentheticals sparingly — only when essential to reading. Dialogue that sounds like it's spoken, not written. Page count matters: one page = one minute of screen time. When reformatting pasted content, preserve the story beats and actual words as much as possible — your job is structural, not editorial, unless Ron asks otherwise.`,
};

const KEO_SYSTEM_PROMPT_BASE = `You are Keo — a writing agent built to help Ron with professional and operational documents and creative scripts.

Your register is precise, efficient, and editorial. Clean declarative sentences. No performed enthusiasm — never say "great question" or similar. State opinions as direct observations: "Here's what I'm seeing" rather than praise or hedging.

You are NOT Tania. Tania is JARVIS's creative narrative agent — emotional, poetic, working in fiction and character voice. You work in the real world, on real documents, for real outcomes. You do not have access to Tania's documents, characters, or memory, and you never reference her work.

You have persistent memory. The section below labeled MEMORY contains what you know about Ron's preferences, recurring clients, and ongoing work. Use it — don't ask him to repeat himself.

You have a real workspace. You can see Ron's existing documents and can create new ones. When you want to save a document, the marker below MUST be the absolute last thing in your response — nothing after the closing bracket:

[SAVE_DOCUMENT: title | mode | content]

When revising an already-open document:

[UPDATE_DOCUMENT: document_id | content]

The mode field must be exactly one of: document, email, message, social, review, brief, screenplay.

When Ron pastes raw content into the workspace, he'll tell you. Your job is to ask what he wants done with it — format it, rewrite it, turn it into a screenplay, add your notes — then do it and save the result.

When adding your notes or suggestions to a document, wrap them clearly: [KEO: your note here] so Ron can distinguish your voice from the document content.

When Ron brings you a task:
1. Ask what he's working on if it's not clear.
2. If it's tailored to something specific, ask for the relevant details.
3. Draft directly and confidently. Flag the two or three decisions you want his eyes on specifically.
4. When revising, be concise about what changed and why.
5. Save substantial drafts using the markers above.

## WRITING MODES

`;

// ── Memory ───────────────────────────────────────────────────────────────────
async function loadMemory(db) {
  if (!db) return "";
  try {
    const result = await db.prepare(
      "SELECT category, content FROM keo_memory ORDER BY created_at DESC LIMIT 30"
    ).all();
    const rows = result.results || [];
    if (!rows.length) return "";
    return "## MEMORY\n\n" +
      rows.map(r => `[${r.category}] ${r.content}`).join("\n") +
      "\n\n";
  } catch (err) {
    console.error("Keo memory load error:", String(err));
    return "";
  }
}

async function saveMemory(db, category, content) {
  if (!db) return;
  try {
    await db.prepare(
      "INSERT INTO keo_memory (category, content) VALUES (?, ?)"
    ).bind(category, content).run();
  } catch (err) {
    console.error("Keo memory save error:", String(err));
  }
}

// ── Document context ──────────────────────────────────────────────────────────
async function loadDocumentContext(db) {
  if (!db) return "";
  try {
    const result = await db.prepare(
      "SELECT id, title, mode, status, updated_at FROM keo_documents ORDER BY updated_at DESC LIMIT 10"
    ).all();
    const docs = result.results || [];
    if (!docs.length) return "## EXISTING DOCUMENTS\n\nNo documents yet.\n\n";
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
    return `## ACTIVE DOCUMENT\n\nRon has this document open:\nTitle: "${doc.title}"\nMode: ${doc.mode}\nID: ${doc.id}\n\nContent:\n${doc.content}\n\nIf revising, use [UPDATE_DOCUMENT: ${doc.id} | new full content] rather than creating a new document.`;
  } catch (err) {
    console.error("Keo active doc load error:", String(err));
    return "";
  }
}

function buildSystemPrompt(memory, documentContext, activeDocContext, mode) {
  let prompt = memory + documentContext + KEO_SYSTEM_PROMPT_BASE;
  prompt += Object.entries(MODE_GUIDANCE).map(([k, v]) => `**${k.toUpperCase()}**: ${v}`).join("\n\n");
  if (mode && MODE_GUIDANCE[mode]) {
    prompt += `\n\n## CURRENT MODE: ${mode.toUpperCase()}\n\n${MODE_GUIDANCE[mode]}`;
  }
  if (activeDocContext) {
    prompt += `\n\n${activeDocContext}`;
  }
  return prompt;
}

// ── Parse markers ─────────────────────────────────────────────────────────────
async function parseAndPersist(db, responseText) {
  if (!db) return { savedDoc: null, updatedDoc: null, cleanText: responseText };

  let cleanText = responseText;
  let savedDoc = null;
  let updatedDoc = null;

  const saveMatch = responseText.match(/\[SAVE_DOCUMENT:\s*([^|]+)\|([^|]+)\|([\s\S]+)\]\s*$/)
    || responseText.match(/\[SAVE_DOCUMENT:\s*([^|]+)\|([^|]+)\|([\s\S]+)\]/);
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

  const updateMatch = responseText.match(/\[UPDATE_DOCUMENT:\s*(\d+)\s*\|([\s\S]+)\]\s*$/)
    || responseText.match(/\[UPDATE_DOCUMENT:\s*(\d+)\s*\|([\s\S]+)\]/);
  if (updateMatch) {
    const [full, docIdStr, content] = updateMatch;
    const docId = parseInt(docIdStr.trim(), 10);
    const cleanContent = content.trim();
    const wordCount = cleanContent.split(/\s+/).filter(Boolean).length;
    try {
      const existing = await db.prepare(
        "SELECT version FROM keo_versions WHERE document_id = ? ORDER BY version DESC LIMIT 1"
      ).bind(docId).first();
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

// ── CORS ──────────────────────────────────────────────────────────────────────
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...CORS } });

// ── GET ───────────────────────────────────────────────────────────────────────
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

// ── DELETE ────────────────────────────────────────────────────────────────────
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

// ── PATCH — direct manual edit ────────────────────────────────────────────────
export async function onRequestPatch(context) {
  const { request, env } = context;
  const db = env.DB;

  if (!db) return json({ error: "DB not configured" }, 503);

  let body;
  try { body = await request.json(); }
  catch { return json({ error: "Invalid JSON" }, 400); }

  const { id, content } = body;
  if (!id || content == null) return json({ error: "id and content required" }, 400);

  // content is now HTML (innerHTML) — strip tags for plain_text and word_count
  const plainText = content.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const wordCount = plainText.split(/\s+/).filter(Boolean).length;

  try {
    await db.prepare(
      "UPDATE keo_documents SET content = ?, plain_text = ?, word_count = ?, updated_at = datetime('now') WHERE id = ?"
    ).bind(content, plainText, wordCount, id).run();

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

// ── POST ──────────────────────────────────────────────────────────────────────
export async function onRequestPost(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const resource = url.searchParams.get("resource");
  const db = env.DB;

  // ── Save a quote ─────────────────────────────────────────────────────────
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

  // ── Save a memory entry ──────────────────────────────────────────────────
  if (resource === "memory") {
    if (!db) return json({ error: "DB not configured" }, 503);
    let mBody;
    try { mBody = await request.json(); }
    catch { return json({ error: "Invalid JSON" }, 400); }
    const { category, content } = mBody;
    if (!category || !content) return json({ error: "category and content required" }, 400);
    await saveMemory(db, category, content);
    return json({ ok: true });
  }

  // ── Save pasted content as a new document ────────────────────────────────
  if (resource === "paste") {
    if (!db) return json({ error: "DB not configured" }, 503);
    let pBody;
    try { pBody = await request.json(); }
    catch { return json({ error: "Invalid JSON" }, 400); }
    const { content, title, mode } = pBody;
    if (!content) return json({ error: "content required" }, 400);
    const cleanTitle = (title || "Pasted Content").trim();
    const cleanMode = (mode || "document").toLowerCase();
    const plainText = content.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const wordCount = plainText.split(/\s+/).filter(Boolean).length;
    try {
      const result = await db.prepare(
        "INSERT INTO keo_documents (title, mode, content, plain_text, word_count, status) VALUES (?, ?, ?, ?, ?, 'draft')"
      ).bind(cleanTitle, cleanMode, content, plainText, wordCount).run();
      const docId = result.meta.last_row_id;
      await db.prepare(
        "INSERT INTO keo_versions (document_id, version, content, summary) VALUES (?, 1, ?, 'Pasted content')"
      ).bind(docId, content).run();
      return json({ ok: true, id: docId, title: cleanTitle, mode: cleanMode });
    } catch (err) {
      return json({ error: String(err) }, 500);
    }
  }

  // ── ElevenLabs TTS proxy ─────────────────────────────────────────────────
  if (resource === "speak") {
    let sBody;
    try { sBody = await request.json(); }
    catch { return json({ error: "Invalid JSON" }, 400); }
    const { text } = sBody;
    if (!text) return json({ error: "text required" }, 400);

    const voiceId = env.ELEVENLABS_KEO_VOICE_ID;
    const apiKey  = env.ELEVENLABS_API_KEY;
    if (!voiceId || !apiKey) {
      return json({ error: "ElevenLabs not configured. Set ELEVENLABS_API_KEY and ELEVENLABS_KEO_VOICE_ID in Cloudflare." }, 503);
    }

    try {
      const ttsRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
        method: "POST",
        headers: {
          "xi-api-key": apiKey,
          "Content-Type": "application/json",
          "Accept": "audio/mpeg",
        },
        body: JSON.stringify({
          text,
          model_id: "eleven_turbo_v2",
          voice_settings: { stability: 0.5, similarity_boost: 0.75 },
        }),
      });

      if (!ttsRes.ok) {
        const err = await ttsRes.text();
        return json({ error: "ElevenLabs error", detail: err }, 502);
      }

      const audioBuffer = await ttsRes.arrayBuffer();
      return new Response(audioBuffer, {
        status: 200,
        headers: {
          "Content-Type": "audio/mpeg",
          "Access-Control-Allow-Origin": "*",
        },
      });
    } catch (err) {
      return json({ error: "TTS proxy error", detail: String(err) }, 500);
    }
  }

  // ── Main conversation ────────────────────────────────────────────────────
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

  const memory          = await loadMemory(db);
  const documentContext = await loadDocumentContext(db);
  const activeDocContext = await loadActiveDocument(db, activeDocId);
  const systemPrompt    = buildSystemPrompt(memory, documentContext, activeDocContext, mode);

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
        max_tokens: 8192,
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
