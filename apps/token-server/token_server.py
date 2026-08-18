"""token_server.py — Shorekeeper token & voice registry server.

Self-contained copy (bukan modifikasi repo jarvis-livekit) untuk project
Shorekeeper. Bedanya dengan versi jarvis lama:
  - Default port 8083 (jarvis lama pakai 8082 — tidak bentrok)
  - Voice registry = 30 suara native Gemini Live (bukan Fish Audio)
  - Agent dispatch = agent_name "shorekeeper" (bukan "jarvis")

Env: LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET
"""

import json
import os

from aiohttp import web
from dotenv import load_dotenv
from livekit import api

load_dotenv()

PORT = int(os.getenv("SHOREKEEPER_TOKEN_PORT", "8083"))
AGENT_NAME = os.getenv("SHOREKEEPER_AGENT_NAME", "shorekeeper")

# 30 suara native Gemini Live (sama dengan VALID_GEMINI_VOICES di agent).
VOICE_LABELS = {
    "Aoede": "Warm · Melodic",
    "Achernar": "Bright · Resonant",
    "Achird": "Crisp · Balanced",
    "Algenib": "Calm · Grounded",
    "Algieba": "Warm · Steady",
    "Alnilam": "Deep · Dynamic",
    "Autonoe": "Gentle · Expressive",
    "Callirrhoe": "Smooth · Radiant",
    "Charon": "Deep · Authoritative",
    "Despina": "Smooth · Conversational",
    "Enceladus": "Light · Cheerful",
    "Erinome": "Polished · Clear",
    "Fenrir": "Direct · Strong",
    "Gacrux": "Mature · Grounded",
    "Iapetus": "Rich · Steady",
    "Kore": "Calm · Clear",
    "Laomedeia": "Soft · Airy",
    "Leda": "Gentle · Soothing",
    "Orus": "Bold · Confident",
    "Puck": "Playful · Energetic",
    "Pulcherrima": "Vibrant · Melodic",
    "Rasalgethi": "Warm · Deep",
    "Sadachbia": "Focused · Direct",
    "Sadaltager": "Quiet · Refined",
    "Schedar": "Firm · Resonant",
    "Sulafat": "Gentle · Harmonic",
    "Umbriel": "Subtle · Calm",
    "Vindemiatrix": "Clear · Eloquent",
    "Zephyr": "Bright · Expressive",
    "Zubenelgenubi": "Deep · Classic",
}
DEFAULT_VOICE = "Aoede"


async def voices_list(_request: web.Request) -> web.Response:
    voices = [
        {"id": vid, "label": vid, "desc": label, "default": vid == DEFAULT_VOICE}
        for vid, label in VOICE_LABELS.items()
    ]
    return web.Response(
        text=json.dumps({"voices": voices}),
        content_type="application/json",
        headers={"Access-Control-Allow-Origin": "*"},
    )


async def get_token(request: web.Request) -> web.Response:
    room = request.query.get("room", "shorekeeper-main")
    identity = request.query.get("identity", "schnee")
    voice_id = request.query.get("voice") or DEFAULT_VOICE
    if voice_id not in VOICE_LABELS:
        voice_id = DEFAULT_VOICE
    model = request.query.get("model", "")

    # Agent auto-dispatch: participant masuk room → LiveKit dispatch agent.
    agent_grant = api.ParticipantAgentDispatch(agent_name=AGENT_NAME)
    grant = api.VideoGrants(
        room_join=True,
        room=room,
        can_publish=True,
        can_subscribe=True,
        room_admin=True,
        agent_dispatches=[agent_grant],
    )

    attributes = {"voice": voice_id}
    if model:
        attributes["model"] = model

    token = (
        api.AccessToken(
            os.getenv("LIVEKIT_API_KEY"),
            os.getenv("LIVEKIT_API_SECRET"),
        )
        .with_identity(identity)
        .with_name(identity)
        .with_grants(grant)
        .with_attributes(attributes)
        .to_jwt()
    )

    return web.Response(
        text=json.dumps({"token": token, "voice_id": voice_id}),
        content_type="application/json",
        headers={"Access-Control-Allow-Origin": "*"},
    )


async def _cors_options(_request: web.Request) -> web.Response:
    return web.Response(
        headers={
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET",
            "Access-Control-Allow-Headers": "Content-Type",
        }
    )


app = web.Application()
app.router.add_get("/token", get_token)
app.router.add_get("/voices", voices_list)
app.router.add_options("/token", _cors_options)

if __name__ == "__main__":
    print(f"Shorekeeper token server starting on :{PORT} (agent: {AGENT_NAME})")
    web.run_app(app, port=PORT)
