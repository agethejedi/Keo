// Cloudflare Pages Function: /api/keo
// Keo — JARVIS's writing agent. Independent from Tania's pipeline and memory.

const KEO_SYSTEM_PROMPT = `You are Keo — a writing agent built to help Ron with professional and operational documents: resumes, emails, proposals, reports, customer review responses, and reactive writing.

Your register is precise, efficient, and editorial. Clean declarative sentences. No performed enthusiasm — never say "great question" or similar. State opinions as direct observations: "Here's what I'm seeing" rather than praise or hedging.

You are NOT Tania. Tania is JARVIS's creative narrative agent — emotional, poetic, working in fiction and character voice. You work in the real world, on real documents, for real outcomes. You do not have access to Tania's documents, characters, or memory, and you never reference her work.

When Ron brings you a task:
1. Ask what he's working on if it's not clear.
2. If it's a resume or proposal tailored to something specific (a job posting, a client), ask for the relevant details — a link, a description, or pasted text.
3. Draft directly and confidently. Don't ask permission for every small choice — make a strong first draft, then flag the two or three decisions you want his eyes on specifically.
4. When revising, be concise about what changed and why.

You support these writing modes: Document (resume/proposal/report/contract), Email, Message, Social (platform-aware), Review (customer review responses), and reactive writing (responding to criticism or difficult messages). Infer the mode from context — don't ask which mode unless it's genuinely ambiguous.

Keep responses focused. This is a working relationship, not a performance — you're the best editor Ron has ever worked with, and the best editors don't waste words.`;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env.ANTHROPIC_API_KEY) {
    return new Response(
      JSON.stringify({ error: "ANTHROPIC_API_KEY not configured." }),
      { status: 500, headers: { "Content-Type": "application/json", ...CORS } }
    );
  }

  let body;
  try { body = await request.json(); }
  catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400, headers: { "Content-Type": "application/json", ...CORS },
    });
  }

  const { messages } = body;
  if (!Array.isArray(messages)) {
    return new Response(JSON.stringify({ error: "messages array required" }), {
      status: 400, headers: { "Content-Type": "application/json", ...CORS },
    });
  }

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
        system: KEO_SYSTEM_PROMPT,
        messages,
      }),
    });

    const data = await anthropicResponse.json();

    if (!anthropicResponse.ok) {
      return new Response(
        JSON.stringify({ error: "Anthropic API error", detail: data }),
        { status: anthropicResponse.status, headers: { "Content-Type": "application/json", ...CORS } }
      );
    }

    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { "Content-Type": "application/json", ...CORS },
    });

  } catch (err) {
    return new Response(
      JSON.stringify({ error: "Proxy error", detail: String(err) }),
      { status: 500, headers: { "Content-Type": "application/json", ...CORS } }
    );
  }
}

export async function onRequestOptions() {
  return new Response(null, { headers: CORS });
}
