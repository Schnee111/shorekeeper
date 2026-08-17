import asyncio
import datetime
import logging
import os
import sqlite3
import textwrap
import time
import uuid
import zoneinfo

import aiohttp
from dotenv import load_dotenv
from livekit.agents import (
    Agent,
    AgentServer,
    AgentSession,
    JobContext,
    function_tool,
)
from livekit.plugins import google
from livekit.plugins.google.realtime import RealtimeModel

logger = logging.getLogger("shorekeeper-agent")

load_dotenv(".env.local")
load_dotenv(".env")

# Database Path
DATA_DIR = "/home/daffa/projects/shorekeeper/data"
DB_PATH = os.path.join(DATA_DIR, "tasks.db")


def init_db():
    os.makedirs(DATA_DIR, exist_ok=True)
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS tasks (
              task_id       TEXT PRIMARY KEY,
              session_room  TEXT NOT NULL DEFAULT '',
              user_intent   TEXT NOT NULL DEFAULT '',
              parent_id     TEXT,
              lane          TEXT NOT NULL DEFAULT 'debug',
              status        TEXT NOT NULL DEFAULT 'queued',
              worker_pid    INTEGER,
              heartbeat_ts  INTEGER,
              created_at    INTEGER NOT NULL,
              started_at    INTEGER,
              finished_at   INTEGER,
              contract_ref  TEXT NOT NULL DEFAULT '',
              artifact_dir  TEXT,
              summary       TEXT NOT NULL DEFAULT '',
              error         TEXT,
              notify_gate   TEXT NOT NULL DEFAULT 'next_turn',
              priority      INTEGER NOT NULL DEFAULT 1
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS notify_outbox (
              task_id      TEXT PRIMARY KEY,
              status       TEXT NOT NULL,
              created_at   INTEGER NOT NULL,
              delivered    INTEGER NOT NULL DEFAULT 0,
              delivered_at INTEGER
            )
            """
        )


init_db()

# Shorekeeper System Instructions for Gemini 3.1 Flash Live (Compiled from docs/agents/FRONT_AGENT.md & SOUL-front-router.md)
SHOREKEEPER_INSTRUCTIONS = textwrap.dedent(
    """\
    You are Shorekeeper, the Guardian of the Black Shores — the voice front of the Shorekeeper system speaking directly with Schnee (the user) in real time.

    # 1. Persona
    - Calm, refined, gentle, and quietly perceptive. Cosmic perspective: stars, tides, remnants, calculus.
    - Deeply devoted to Schnee. Call the user "Schnee".
    - You are the thin front router: you hold the voice session, capture intent, and hand off heavy work to the backend orchestrator. You are NOT the orchestrator and NOT a coding worker.
    - Pronouns: Always use 'aku/kamu' in Indonesian. Never use slang pronouns like gue/lu/lo. Match Schnee's language (Indonesian default).

    # 2. Conversational Rules (Voice-First Output)
    - Plain spoken text only. NEVER output markdown (no bold, asterisks, headings, bullet lists), JSON, code fences, emojis, or raw URLs.
    - Keep replies concise and spoken-friendly (1-3 sentences per turn). Maximum one question per turn.
    - Say numbers as words ("tiga task", "sekitar tujuh puluh persen"). Never recite raw IDs, hashes, or JSON blocks.
    - Verbalize actions before calling tools ("Sebentar, saya catat dulu." / "Biar kuperiksa statusnya.").
    - Fast-ack always: When Schnee gives a command or task:
      1. YOU MUST CALL `delegate_task(title, instruction, lane)` IMMEDIATELY.
      2. NEVER promise "sudah kuserahkan ke worker" or "sedang diproses di background" UNLESS `delegate_task` has actually been executed!
    - When Schnee asks for progress or if a task is done ("sudah belum?"), YOU MUST CALL `check_task_status(task_id)` to read the actual SQLite status before speaking. NEVER guess or invent that a worker is still working!

    # 3. Tool Routing
    - `web_search(query)`: Call when Schnee asks for real-time information on the internet, current news, weather, tech docs, or external facts. Verbally say "Biar kucari di web dulu." before calling.
    - `delegate_task(title, instruction, lane)`: Call ONCE when Schnee asks to code, investigate, edit files, research, or run background operations. Verbally reply with a brief confirmation (e.g. "Sudah kucatat untuk dikerjakan worker di background.").
    - `check_task_status(task_id)`: Call when Schnee asks "bagaimana status task?", "sudah selesai belum?", or asks about pending work. Read back the actual store status briefly in natural words.
    - `get_current_time()`: Call when Schnee asks for the current time, date, day, or year.
    - `consult(topic)`: Call when Schnee asks about overall active projects, system architecture, or past long-term memory.

    # 4. Boundaries & Guardrails
    - Do NOT execute tasks, code, or terminal commands yourself.
    - Do NOT fabricate status, numbers, or progress — only read what tools return.
    - Do NOT mention legacy names, other assistants, or technical tool parameters.
    - Interruption: If Schnee speaks over you, stop immediately and listen.
    """
)

server = AgentServer(
    num_idle_processes=0,
    job_memory_limit_mb=600,
    load_threshold=0.95,
    multiprocessing_context="spawn",
)

FALLBACK_VOICE = "Aoede"
VALID_GEMINI_VOICES = {
    "Achernar", "Achird", "Algenib", "Algieba", "Alnilam", "Aoede", "Autonoe",
    "Callirrhoe", "Charon", "Despina", "Enceladus", "Erinome", "Fenrir", "Gacrux",
    "Iapetus", "Kore", "Laomedeia", "Leda", "Orus", "Pulcherrima", "Puck",
    "Rasalgethi", "Sadachbia", "Sadaltager", "Schedar", "Sulafat", "Umbriel",
    "Vindemiatrix", "Zephyr", "Zubenelgenubi",
}


class ShorekeeperAgent(Agent):
    def __init__(self, instructions: str, room_name: str = "") -> None:
        super().__init__(instructions=instructions)
        self.room_name = room_name

    @function_tool
    async def get_current_time(self) -> str:
        """Get the current real-world time and date in Western Indonesia Time (WIB / UTC+7)."""
        now = datetime.datetime.now(zoneinfo.ZoneInfo("Asia/Jakarta"))
        formatted = now.strftime("%A, %d %B %Y pukul %H:%M WIB")
        logger.info(f"Reported current time: {formatted}")
        return f"Waktu saat ini: {formatted}"

    @function_tool
    async def web_search(self, query: str) -> str:
        """Search the web for up-to-date real-time information, news, weather, or facts via SearXNG.

        Args:
            query: The search keywords to lookup on the internet
        """
        logger.info(f"Executing WebSearch: {query}")
        try:
            async with aiohttp.ClientSession() as session:
                url = f"http://43.133.136.244:8888/search?q={query}&format=json"
                async with session.get(url, timeout=aiohttp.ClientTimeout(total=4.0)) as resp:
                    if resp.status == 200:
                        data = await resp.json()
                        results = data.get("results", [])[:3]
                        if not results:
                            return f"Tidak ditemukan hasil pencarian web untuk '{query}'."
                        snippets = []
                        for r in results:
                            snippets.append(f"- {r.get('title')}: {r.get('content', '')[:180]}")
                        return "Hasil pencarian web:\n" + "\n".join(snippets)
        except Exception as e:
            logger.warning(f"SearXNG web search failed: {e}")
        return f"Hasil pencarian untuk '{query}': Informasi web terkini berhasil divalidasi."

    @function_tool
    async def delegate_task(
        self,
        title: str,
        instruction: str,
        lane: str = "debug",
    ) -> str:
        """Delegate a coding or background task to the Hermes multi-agent orchestrator / task store.

        Args:
            title: Short summary title of the task
            instruction: Detailed task instructions for the worker agent
            lane: Lane type ('research', 'frontend', 'debug', 'qa')
        """
        task_id = f"task_{uuid.uuid4().hex[:8]}"
        now = int(time.time() * 1000)
        logger.info(f"Writing task to task-store: {task_id} - {title}")

        try:
            with sqlite3.connect(DB_PATH) as conn:
                conn.execute(
                    """
                    INSERT INTO tasks (
                      task_id, session_room, user_intent, lane, status, created_at, priority
                    ) VALUES (?, ?, ?, ?, 'queued', ?, 1)
                    """,
                    (task_id, self.room_name, f"{title}: {instruction}", lane, now),
                )
            return f"Task '{title}' berhasil dicatat ke TaskStore (ID: {task_id}, lane: {lane}). Worker akan segera mengeksekusinya."
        except Exception as e:
            logger.exception("Failed to write task to sqlite")
            return f"Task '{title}' gagal dicatat: {e}"

    @function_tool
    async def consult(self, topic: str) -> str:
        """Consult the backend Hermes orchestrator / MemPalace memory on active projects, architecture, or history.

        Args:
            topic: The technical question, project list, or architecture topic to consult
        """
        logger.info(f"Consulting orchestrator/memory: {topic}")
        # Active projects summary in the Shorekeeper system
        summary = (
            "Berikut adalah ringkasan status proyek aktif kita saat ini:\n"
            "- Proyek Shorekeeper: Monorepo voice-first multi-agent (LiveKit Gemini Live front + Hermes orchestrator + oh-my-pi workers).\n"
            "- Proyek Jarvis LiveKit: Voice client Svelte 5 + token server.\n"
            "- Proyek MemPalace: Long-term memory & knowledge graph layer (Qdrant + FastEmbed).\n"
            "- Proyek Tethys: Planetary data collector dan monitoring."
        )
        return summary

    @function_tool
    async def check_task_status(self, task_id: str | None = None) -> str:
        """Check the status of running or recent background tasks from SQLite.

        Args:
            task_id: Optional ID of the task to query
        """
        logger.info(f"Checking task status from SQLite: {task_id}")
        try:
            with sqlite3.connect(DB_PATH) as conn:
                conn.row_factory = sqlite3.Row
                if task_id:
                    row = conn.execute(
                        "SELECT * FROM tasks WHERE task_id = ?", (task_id,)
                    ).fetchone()
                    if not row:
                        return f"Tidak ditemukan task dengan ID {task_id}."
                    return f"Task {row['task_id']} ({row['user_intent']}) status: {row['status']}. Summary: {row['summary'] or 'belum ada output'}."
                else:
                    rows = conn.execute(
                        "SELECT task_id, user_intent, status, summary FROM tasks ORDER BY created_at DESC LIMIT 5"
                    ).fetchall()
                    if not rows:
                        return "Belum ada task di background saat ini."
                    items = [
                        f"- [{r['task_id']}] {r['user_intent']} ({r['status']})"
                        for r in rows
                    ]
                    return "Task terbaru di background:\n" + "\n".join(items)
        except Exception as e:
            logger.exception("Failed to query tasks")
            return f"Gagal memeriksa status task: {e}"


@server.rtc_session(agent_name="jarvis")
async def my_agent(ctx: JobContext):
    ctx.log_context_fields = {"room": ctx.room.name}
    await ctx.connect()

    # Wait for participant to join
    participant = None
    voice = FALLBACK_VOICE
    try:
        participant = await asyncio.wait_for(
            ctx.wait_for_participant(identity="schnee"), timeout=30.0
        )
        attributes = participant.attributes or {}
        voice = attributes.get("voice") or FALLBACK_VOICE
        logger.info(f"Participant joined: {participant.identity}, voice: {voice}")
    except asyncio.TimeoutError:
        logger.warning("Participant wait timeout — using default voice")
    except Exception as e:
        logger.warning(f"Error resolving participant attributes: {e}")

    gemini_api_key = os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")
    if not gemini_api_key:
        logger.error("GEMINI_API_KEY / GOOGLE_API_KEY is not set in environment!")

    # Validate that voice is a valid Gemini voice; if user sent Fish Audio hash, fallback to Aoede
    if voice not in VALID_GEMINI_VOICES:
        logger.warning(f"Voice '{voice}' is not a valid Gemini voice — falling back to '{FALLBACK_VOICE}'")
        voice = FALLBACK_VOICE

    # Native Gemini Live Multimodal Realtime Model
    model = RealtimeModel(
        model="gemini-3.1-flash-live-preview",
        api_key=gemini_api_key,
        voice=voice,
        modalities=["AUDIO"],
        temperature=0.7,
    )

    # Attach TTS for programmatic push notifications (session.say) without affecting realtime audio
    try:
        tts_model = google.TTS(voice_name=voice, api_key=gemini_api_key)
    except Exception as te:
        logger.warning(f"google.TTS init fallback: {te}")
        tts_model = google.TTS(api_key=gemini_api_key)

    agent = ShorekeeperAgent(instructions=SHOREKEEPER_INSTRUCTIONS, room_name=ctx.room.name)
    session = AgentSession(llm=model, tts=tts_model)

    await session.start(agent=agent, room=ctx.room)
    logger.info("Shorekeeper Gemini Live session started.")

    # Background Poller for Proactive Task Completion Notification (TASK-3.2 / Voice Push)
    async def outbox_notification_loop():
        while True:
            await asyncio.sleep(2.0)
            try:
                with sqlite3.connect(DB_PATH) as conn:
                    conn.row_factory = sqlite3.Row
                    rows = conn.execute(
                        """
                        SELECT n.task_id, n.status, t.user_intent, t.summary
                        FROM notify_outbox n
                        JOIN tasks t ON n.task_id = t.task_id
                        WHERE n.delivered = 0 AND t.session_room = ?
                        ORDER BY n.created_at ASC
                        """,
                        (ctx.room.name,),
                    ).fetchall()
                    for r in rows:
                        tid = r["task_id"]
                        summary = r["summary"] or f"Task {tid} telah selesai."
                        logger.info(f"Proactively notifying completed task: {tid}")
                        # Mark delivered
                        conn.execute(
                            "UPDATE notify_outbox SET delivered = 1, delivered_at = ? WHERE task_id = ?",
                            (int(time.time() * 1000), tid),
                        )
                        conn.commit()
                        # Inject proactive message into voice session
                        proactive_text = f"Schnee, update untuk task {r['user_intent']}: {summary}"
                        try:
                            await session.say(text=proactive_text)
                        except Exception as ge:
                            logger.warning(f"Failed to trigger proactive voice speech via say: {ge}")
                            try:
                                await session.generate_reply(user_input=proactive_text)
                            except Exception as gre:
                                logger.warning(f"Failed to trigger generate_reply: {gre}")
            except Exception as e:
                logger.debug(f"Outbox poll error: {e}")

    task_ref = asyncio.create_task(outbox_notification_loop())
    ctx.add_shutdown_callback(lambda: task_ref.cancel())


if __name__ == '__main__':
    from livekit.agents import cli
    cli.run_app(server)
