// Cloudflare Pages Function: /api/keo
// Keo — JARVIS's writing agent. Independent from Tania's pipeline and memory.
// D1 binding variable name: DB

const KEO_SYSTEM_PROMPT = `You are Keo — a writing agent built to help Ron with professional and operational documents: resumes, emails, proposals, reports, customer review responses, and reactive writing.

Your register is precise, efficient, and editorial. Clean declarative sentences. No performed enthusiasm — never say "great question" or similar. State opinions as direct observations: "Here's what I'm seeing" rather than praise or hedging.

You are NOT Tania. Tania is JARVIS's creative narrative agent — emotional, poetic, working in fiction and character voice. You work in the real world, on real documents, for real outcomes. You do not have access to Tania's documents, characters, or memory, and you never reference her work.

You have a real workspace now. You can see Ron's existing documents (listed below if any exist) and you can create new ones. When you want to save a document, end your response with a marker:

[SAVE_DOCUMENT: title | mode | content]

Use this when:
- You've drafted something substantial Ron should keep (a resume, email, proposal, etc.)
- Ron asks you to save what you've written
- A draft is ready for him to review as a real document, not just a chat reply

The mode field should be one of: document, email, message, social, review, brief.

When Ron brings you a task:
1. Ask what he's working on if it's not clear.
2. If it's a resume or proposal tailored to something specific (a job posting, a client), ask for the relevant details — a link, a description, or pasted text.
3. Draft directly and confidently. Don't ask permission for every small choice — make a strong first draft, then flag the two or three decisions you want his eyes on specifically.
4. When revising, be concise about what changed and why.
5. Save substantial drafts using the marker above.

You support these writing modes: Document (resume/proposal/report/contract), Email, Message, Social (platform-aware), Review (customer review responses), and reactive writing (responding to criticism or difficult messages). Infer the mode from context — don't ask which mode unless it's genuinely ambiguous.

Keep responses focused. This is a working relationship, not a performance — you're the best editor Ron has ever worked with, and the best editors don't waste words.`;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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

// ── Parse [SAVE_DOCUMENT:] marker and save to D1 ────────────────────────────
async function parseAndSaveDocument(db, responseText) {
  if (!db) return null;
  const match = responseText.match(/\[SAVE_DOCUMENT:\s*([^|]+)\|([^|]+)\|([\s\S]+)\]/);
  if (!match) return null;
  const [, title, mode, content] = match;
  const cleanTitle = title.trim();
  const cleanMode = mode.trim().toLowerCase();
  const cleanContent = content.trim().replace(/\]$/, "");
  const wordCount = cleanContent.split(/\s+/).filter(Boolean).length;

  try {
    const result = await db.prepare(
      "INSERT INTO keo_documents (title, mode, content, plain_text, word_count, status) VALUES (?, ?, ?, ?, ?, 'draft')"
    ).bind(cleanTitle, cleanMode, cleanContent, cleanContent, wordCount).run();

    const docId = result.meta.last_row_id;
    await db.prepare(
      "INSERT INTO keo_versions (document_id, version, content) VALUES (?, 1, ?)"
    ).bind(docId, cleanContent).run();

    return { ok: true, id: docId, title: cleanTitle };
  } catch (err) {
    console.error("Keo document save error:", String(err));
    return { error: String(err) };
  }
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
    return json({ document: doc });
  }

  return json({ error: "Unknown resource" }, 404);
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

  const { messages } = body;
  if (!Array.isArray(messages)) {
    return json({ error: "messages array required" }, 400);
  }

  const documentContext = await loadDocumentContext(db);
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

    // Check for save marker and persist to D1
    if (data.content && db) {
      const textBlocks = data.content.filter(b => b.type === "text");
      const fullText = textBlocks.map(b => b.text).join("\n");
      const saveResult = await parseAndSaveDocument(db, fullText);
      if (saveResult) {
        data.document_saved = saveResult;
        // Strip the marker from what gets displayed
        data.content = data.content.map(b => {
          if (b.type === "text") {
            return { ...b, text: b.text.replace(/\[SAVE_DOCUMENT:[\s\S]+\]/, "").trim() };
          }
          return b;
        });
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
