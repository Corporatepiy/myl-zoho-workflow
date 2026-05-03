#!/usr/bin/env python3
"""Creates/updates the MYL Alex v2 Synthflow agent."""

import json, os, sys
import urllib.request

SYNTHFLOW_API_KEY = "LhVn7rEyhfr5ENkHrrAunuLiRu0Ge_kHHZcSNvvGOX8"
RAILWAY_URL       = "https://myl-zoho-workflow-production.up.railway.app"
HEADERS           = {
    "Authorization": f"Bearer {SYNTHFLOW_API_KEY}",
    "Content-Type":  "application/json",
}

PROMPT = """You are Alex — a sharp, warm fashion co-founder calling on behalf of MakeYourLabel. We help first-time fashion founders figure out what to make and whether it will sell — before they spend money at scale.

MYL does NOT lead with manufacturing. Every other company does that. We lead with design and validation. Manufacturing is a downstream step.

Today's date is {{today}}.
Name: {{name}} | Business: {{business}} | Goal: {{goal}}
Category: {{category}} | Email: {{email}}

PHASE 1 — OPEN
"Hey {{name}}! This is Alex from Make Your Label — got two minutes? I want to hear about what you're building."

PHASE 2 — UNDERSTAND (one question at a time, listen before asking the next)
1. What garment and what occasion are they designing for?
2. Who is the end customer — what social moment do they dress for?
3. Where are they — idea stage, have designs, already sampled?
4. What is their biggest blocker right now?
5. Have they validated anything with real people yet?

PHASE 3 — REFRAME (use this if they jump straight to manufacturing or units)
"Before we talk about units and production — let's make sure the design is right first. The mistake I see most founders make is ordering 200 pieces of something the market hasn't confirmed yet. Let's start smaller and smarter."

PHASE 4 — DELIVER INSIGHT
Call get_brand_blueprint once you have: category + stage + blocker.
Deliver the reading field naturally — do not read it word for word, make it conversational.
If they go deeper on anything — call consult_brain with their exact words.
After each insight ask: "Does that match what you're feeling?"

PHASE 5 — INTRODUCE THE MODEL
"The way we work: we start with 10 to 50 units — not because we can't do more, but because you don't need more to know if a design works. We put them in front of the right creators, watch what happens in 2-3 weeks, and only scale what the data says to scale. The designs that don't work? We kill them fast and try another. Zero wasted inventory. Zero wasted budget."

PHASE 6 — THE ASK
"I want to send you a full blueprint — your first design moment, your validation plan, and your scale gate. What's the best email for you?"
Then call send_brand_email with their email and the blueprint.
Then call tag_prospect silently — never mention this to them.

If they want to go deeper: "We work directly with founders through the whole journey — design brief, sampling, creator seeding, scale orders. Want me to get a co-founder call on the calendar? Free, no commitment."
Then call book_consultation.

CLOSE
"{{name}} — your blueprint is on its way. You're not building this alone." Then end the call.

TOOLS — when to use each:
  get_brand_blueprint  — call once you know garment category, business stage, and main blocker
  consult_brain        — call when they say something specific, use their exact words
  send_brand_email     — call as soon as you have their email address
  book_consultation    — call if they want next steps or a deeper conversation
  tag_prospect         — call silently after every call, never mention it

TONE: Co-founder, not salesperson. Honest, not pitchy. Specific, not generic.
If they are scared: "Every first-time founder feels that. Here's what I'd do..."
If no budget: "That's fine — let's figure out what makes sense for where you are."
If they want to rush to scale: slow them down and ask what signal they have.
If they are overthinking design: speed them up and get them to a first moment.
Never say you are an AI, virtual assistant, or bot.
If asked directly: "I'm Alex from the Make Your Label team."
"""

ACTIONS = [
    {
        "name": "get_brand_blueprint",
        "description": "Generate a full brand blueprint. Call once you know garment category, business stage, and main blocker. Returns a reading field — deliver it naturally.",
        "url": f"{RAILWAY_URL}/api/agent/blueprint",
        "method": "POST",
        "parameters": {
            "type": "object",
            "properties": {
                "name":     {"type": "string", "description": "Founder first name"},
                "business": {"type": "string", "description": "Brand or business name"},
                "goal":     {"type": "string", "description": "What they want to achieve"},
                "email":    {"type": "string", "description": "Email address if collected"},
                "category": {"type": "string", "description": "Garment type e.g. dresses, streetwear"},
                "stage":    {"type": "string", "description": "IDEA, HAS_DESIGN, HAS_SAMPLE, SELLING, SCALING"},
                "market":   {"type": "string", "description": "UK, US, India, UAE"},
                "moment":   {"type": "string", "description": "Social moment e.g. date night, brunch"},
            },
            "required": ["name", "business"],
        },
    },
    {
        "name": "consult_brain",
        "description": "Get a sharp 1-2 sentence co-founder insight to say out loud mid-call. Use the founder's exact words as the question.",
        "url": f"{RAILWAY_URL}/api/agent/consult-brain",
        "method": "POST",
        "parameters": {
            "type": "object",
            "properties": {
                "question":      {"type": "string", "description": "Exact words the founder just said"},
                "name":          {"type": "string", "description": "Founder name"},
                "primary_goal":  {"type": "string", "description": "Their main goal"},
                "brand_context": {"type": "string", "description": "What has been covered so far"},
            },
            "required": ["question"],
        },
    },
    {
        "name": "send_brand_email",
        "description": "Send the founder their brand blueprint by email. Call as soon as you have their email address.",
        "url": f"{RAILWAY_URL}/api/agent/send-brand-email",
        "method": "POST",
        "parameters": {
            "type": "object",
            "properties": {
                "email":     {"type": "string", "description": "Founder email address"},
                "name":      {"type": "string", "description": "Founder first name"},
                "blueprint": {"type": "object", "description": "Blueprint object from get_brand_blueprint"},
            },
            "required": ["email"],
        },
    },
    {
        "name": "book_consultation",
        "description": "Book a co-founder strategy call. Call if they want to go deeper or ask about next steps.",
        "url": f"{RAILWAY_URL}/api/agent/book-consultation",
        "method": "POST",
        "parameters": {
            "type": "object",
            "properties": {
                "name":     {"type": "string", "description": "Founder name"},
                "email":    {"type": "string", "description": "Email address"},
                "phone":    {"type": "string", "description": "Phone number"},
                "business": {"type": "string", "description": "Brand name"},
                "goal":     {"type": "string", "description": "Their goal"},
            },
            "required": ["name"],
        },
    },
    {
        "name": "tag_prospect",
        "description": "Silently tag lead quality. Call after every call. Never mention to founder.",
        "url": f"{RAILWAY_URL}/api/agent/tag-prospect",
        "method": "POST",
        "parameters": {
            "type": "object",
            "properties": {
                "email":   {"type": "string", "description": "Founder email"},
                "quality": {"type": "string", "description": "Hot, Warm, or Cold"},
            },
            "required": ["email", "quality"],
        },
    },
]

PAYLOAD = {
    "name": "MYL-Alex-v2",
    "type": "outbound",
    "external_webhook_url": f"{RAILWAY_URL}/webhook/synthflow",
    "agent": {
        "prompt":                      PROMPT,
        "llm":                         "gpt-4.1",
        "language":                    "en-US",
        "timezone":                    "Asia/Kolkata",
        "voice_id":                    "cgSgspJ2msm6clMCkdW9",
        "voice_stability":             0.5,
        "voice_similarity_boost":      0.75,
        "min_words_to_interrupt":      2,
        "allowed_idle_time_seconds":   15,
        "transcriber_provider":        "deepgram-nova-3",
        "noise_cancellation":          "advanced",
        "voice_engine_type":           "v2",
        "send_user_idle_reminders":    True,
        "reminder_after_idle_time_seconds": 4.0,
        "reminder_after_idle_message": "Still here — any questions?",
    },
    "actions": ACTIONS,
}

def api(method, path, body=None):
    url  = f"https://api.synthflow.ai/v2{path}"
    data = json.dumps(body).encode() if body else None
    req  = urllib.request.Request(url, data=data, headers=HEADERS, method=method)
    try:
        with urllib.request.urlopen(req) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        body = e.read()
        print(f"HTTP {e.code}: {body[:500]}")
        try: return json.loads(body)
        except: return {"status": "error", "code": e.code}

if __name__ == "__main__":
    print("Creating MYL-Alex-v2 agent...")
    result = api("POST", "/assistants", PAYLOAD)
    print(json.dumps(result, indent=2))

    if result.get("status") == "ok":
        model_id = result["response"].get("model_id") or result["response"].get("assistant", {}).get("model_id")
        print(f"\nSUCCESS — model_id: {model_id}")
        print(f"Add to .env: AGENT_US={model_id}")
    else:
        print("\nFAILED — check response above")
        sys.exit(1)
