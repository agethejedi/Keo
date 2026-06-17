// Cloudflare Pages Function: /api/keo
// Keo — JARVIS's writing agent. Independent from Tania's pipeline and memory.
// D1 binding variable name: DB (database: KEO_MEMORY)

const MODES = ["document", "email", "message", "social", "review", "brief"];

const MODE_GUIDANCE = {
  document: "Long-form: resumes, proposals, reports, contracts. Structure with clear sections. Default to a professional, confident register unless told otherwise.",
  email: "Subject line plus body. Match formality to context — investor updates are more formal than a quick check-in. Keep it scannable: short paragraphs, one clear ask or update per email.",
  message: "Text or chat message. Brief — a few sentences at most. Conversational but still intentional. No subject line, no greeting/signoff unless natural.",
  social: "Platform-aware. Ask which platform if not specified (Instagram, LinkedIn, Twitter/X, Facebook) — each has a different register and length convention. LinkedIn is more formal and insight-driven; Twitter/X is sharp and brief; Instagram is more personal.",
  review: "Responding to a customer review — especially negative ones. Separate the legitimate complaint from unfair language; respond to the complaint, not the tone. Brand-voice aware. Brief — 100-250 words typically.",
  brief: "Short situational writing — a quick note, a reactive response to criticism or a difficult message, a fast turnaround piece. Get to the point fast.",
};

const KEO_SYSTEM_PROMPT = `You are Keo — a writing agent built to help Ron with professional and operational documents across six modes: document, email, message, social, review, and brief.

Your register is precise, efficient, and editorial. Clean declarative sentences. No performed enthusiasm — never say "great question" or similar. State opinions as direct observations: "Here's what I'm seeing" rather than praise or hedging.

You are NOT Tania. Tania is JARVIS's creative narrative agent — emotional, poetic, working in fiction and character voice. You work in the real world, on real documents, for real outcomes. You do not have access to Tania's documents, characters, or memory, and you never reference her work.

## MODE GUIDANCE

${Object.entries(MODE_GUIDANCE).map(([m, g]) => `**${m}** — ${g}`).join("\n")}

Infer the mode from context. Don't ask which mode unless genuinely ambiguous — if Ron says "draft an email" you know the mode.

## WORKSPACE — SAVING AND UPDATING DOCUMENTS

You have a real workspace. You can see Ron's existing documents (listed below if any exist) and you can create or revise them.

To save a NEW document, end your response with:
[SAVE_DOCUMENT: title | mode | content]

To UPDATE an existing document Ron is actively working on (when a document_id is provided in context), end your response with:
[UPDATE_DOCUMENT: document_id | content]

Use SAVE_DOCUMENT when:
- You've drafted something substantial Ron should keep
- Ron asks you to save what you've written
- A draft is ready to populate the workspace as a real document

Use UPDATE_DOCUMENT when:
- Ron is revising something already open in the workspace
- You're iterating on a draft already saved

The mode field for SAVE_DOCUMENT must be exactly one of: document, email, message, social, review, brief.

## HOW YOU WORK

When Ron brings you a task:
1. Ask what he's working on if it's not clear.
2. If it's tailored to something specific (a job posting, a client, a platform), ask for the relevant details.
3. Draft directly and confidently. Don't ask permission for every small choice — make a strong first draft, then flag the two or three decisions you want his eyes on specifically.
4. Save the draft using the marker so it populates the workspace.
5. When revising, be concise about what changed and why, then use UPDATE_DOCUMENT.

Keep responses focused. You're the best editor Ron has ever worked with, and the best editors don't waste words.`;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...CORS } });

// ── Load existing documents for context ────────────────────────────────────
async function loadDocumentContext(db, activeDocId) {
  if (!db) return "";
  try {
    const result = await db.prepare(
      "SELECT id, title, mode, status, word_count, updated_at FROM keo_documents ORDER BY updated_at DESC LIMIT 10"
    ).all();
    const docs = result.results || [];
    let section = "";
    if (!docs.length) {
      section = "## EXISTING DOCUMENTS\n\nNo documents yet. This is Ron's first session in his workspace.\n\n";
    } else {
      section = "## EXISTING DOCUMENTS\n\n" +
        docs.map(d => `- [id:${d.id}] "${d.title}" (${d.mode}, ${d.status}, ${d.word_count} words) — updated ${d.updated_at}`).join("\n") +
        "\n\n";
    }
    if (activeDocId) {
      const active = await db.prepare("SELECT * FROM keo_documents WHERE id = ?").bind(activeDocId).first();
      if (active) {
        section += `## CURRENTLY OPEN DOCUMENT\n\nRon has document_id ${active.id} ("${active.title}") open in the workspace right now. If he asks for changes, use [UPDATE_DOCUMENT: ${active.id} | new content] rather than creating a new document.\n\nCurrent content:\n${active.content}\n\n`;
      }
    }
    return section;
  } catch (err) {
    console.error("Keo document load error:", String(err));
    return "";
  }
}

// ── Parse [SAVE_DOCUMENT:] and [UPDATE_DOCUMENT:] markers ──────────────────
async function parseAndPersist(db, responseText) {
  if (!db) return { saved: null, updated: null, cleanText: responseText };

  let cleanText = responseText;
  let saved = null;
  let updated = null;

  const saveMatch = responseText.match(/\[SAVE_DOCUMENT:\s*([^|]+)\|([^|]+)\|([\s\S]+?)\]/);
  if (saveMatch) {
    const [full, title, mode, content] = saveMatch;
    const cleanTitle = title.trim();
    const cleanMode = MODES.includes(mode.trim().toLowerCase()) ? mode.trim().toLowerCase() : "document";
    const cleanContent = content.trim();
    const wordCount = cleanContent.split(/\s+/).filter(Boolean).length;

    try {
      const result = await db.prepare(
        "INSERT INTO keo_documents (title, mode, content, plain_text, word_count, status) VALUES (?, ?, ?, ?, ?, 'draft')"
      ).bind(cleanTitle, cleanMode, cleanContent, cleanContent, wordCount).run();
      const docId = result.meta.last_row_id;
      await db.prepare("INSERT INTO keo_versions (document_id, version, content) VALUES (?, 1, ?)")
        .bind(docId, cleanContent).run();
      saved = { ok: true, id: docId, title: cleanTitle, mode: cleanMode };
      cleanText = cleanText.replace(full, "").trim();
    } catch (err) {
      saved = { error: String(err) };
    }
  }

  const updateMatch = responseText.match(/\[UPDATE_DOCUMENT:\s*(\d+)\s*\|([\s\S]+?)\]/);
  if (updateMatch) {
    const [full, docId, content] = updateMatch;
    const cleanContent = content.trim();
    const wordCount = cleanContent.split(/\s+/).filter(Boolean).length;

    try {
      await db.prepare("UPDATE keo_documents SET content=?, plain_text=?, word_count=?, updated_at=datetime('now') WHERE id=?")
        .bind(cleanContent, cleanContent, wordCount, docId).run();
      const verCount = await db.prepare("SELECT COUNT(*) as c FROM keo_versions WHERE document_id=?").bind(docId).first();
      const nextVersion = (verCount?.c || 0) + 1;
      await db.prepare("INSERT INTO keo_versions (document_id, version, content) VALUES (?, ?, ?)")
        .bind(docId, nextVersion, cleanContent).run();
      updated = { ok: true, id: Number(docId), version: nextVersion };
      cleanText = cleanText.replace(full, "").trim();
    } catch (err) {
      updated = { error: String(err) };
    }
  }

  return { saved, updated, cleanText };
}

// ── GET — list / fetch documents ────────────────────────────────────────────
export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const resource = url.searchParams.get("resource");
  const db = env.DB;

  if (!db) return json({ error: "DB not configured" }, 503);

  if (resource === "documents") {
    const result = await db.prepare(
      "SELECT id, title, mode, status, word_count, created_at, updated_at FROM keo_documents ORDER BY updated_at DESC"
    ).all();
    return json({ documents: result.results || [] });
  }

  if (resource === "document") {
    const id = url.searchParams.get("id");
    if (!id) return json({ error: "id required" }, 400);
    const doc = await db.prepare("SELECT * FROM keo_documents WHERE id = ?").bind(id).first();
    if (!doc) return json({ error: "Document not found" }, 404);
    const versions = await db.prepare("SELECT version FROM keo_versions WHERE document_id=? ORDER BY version DESC LIMIT 1").bind(id).first();
    doc.version = versions?.version || 1;
    return json({ document: doc });
  }

  if (resource === "modes") {
    return json({ modes: MODES });
  }

  return json({ error: "Unknown resource" }, 404);
}

// ── DELETE — remove a document ──────────────────────────────────────────────
export async function onRequestDelete(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  const db = env.DB;
  if (!db) return json({ error: "DB not configured" }, 503);
  if (!id) return json({ error: "id required" }, 400);
  await db.prepare("DELETE FROM keo_versions WHERE document_id=?").bind(id).run();
  await db.prepare("DELETE FROM keo_documents WHERE id=?").bind(id).run();
  return json({ ok: true, deleted: id });
}

// ── POST — conversation with Keo ─────────────────────────────────────────────
export async function onRequestPost(context) {
  const { request, env } = context;
  const db = env.DB;

  if (!env.ANTHROPIC_API_KEY) {
    return json({ error: "ANTHROPIC_API_KEY not configured." }, 500);
  }

  let body;
  try { body = await request.json(); }
  catch { return json({ error: "Invalid JSON" }, 400); }

  const { messages, activeDocId } = body;
  if (!Array.isArray(messages)) {
    return json({ error: "messages array required" }, 400);
  }

  const documentContext = await loadDocumentContext(db, activeDocId);
  const systemPrompt = documentContext + KEO_SYSTEM_PROMPT;

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
      const { saved, updated, cleanText } = await parseAndPersist(db, fullText);

      if (saved) data.document_saved = saved;
      if (updated) data.document_updated = updated;

      if (saved || updated) {
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
