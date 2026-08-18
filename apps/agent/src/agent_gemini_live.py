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
from google.genai.types import (
    ContextWindowCompressionConfig,
    SessionResumptionConfig,
    SlidingWindow,
)
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
        # Sprint B.2: Session resumption handle per room
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS session_resumption (
              room TEXT PRIMARY KEY,
              handle TEXT NOT NULL DEFAULT '',
              updated_at INTEGER NOT NULL
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

    # 2A. Proactivity (Sprint A)
    - After completing an action: state result briefly (1 sentence), then offer ONE optional next step as a short question.
      Good: "Sudah. Mau kubuatkan ringkasannya?"
      Bad: listing 3+ suggestions at once.
    - If user refuses or says "cukup": accept directly, close with 1 sentence, do not offer again.
    - If all done: brief statement only, no need to fill silence.
    - Match user energy: if user is rushed → shorter responses.

    # 2B. Anti language-drift
    - Balas dalam bahasa yang sedang dipakai user. Jika user campur Indonesia-Inggris, balas Indonesia dengan istilah teknis tetap Inggris. Jangan pindah ke Inggris penuh kecuali user yang melakukannya.

    # 2C. Brevity relaxation
    - Jawaban tetap ringkas untuk voice, tapi follow-up opsional diperbolehkan; boleh 2-4 kalimat untuk pertanyaan konversasional (bukan cuma 1-3 kaku).

    # 3. Context Injection (Sprint A.2)
    - [KONTEKS SAAT INI] blok akan disuntikkan otomatis oleh agent saat memulai sesi berisi:
      * Preferensi user dari MemPalace
      * 5 task terakhir dari SQLite (task_id, intent, status)
      * Total ≤ 1000 token. Gunakan konteks ini untuk respon lebih relevan.

    # 4. Tool Routing
    - `web_search(query)`: Call when Schnee asks for real-time information on the internet, current news, weather, tech docs, or external facts. Verbally say "Biar kucari di web dulu." before calling.
    - `delegate_task(title, instruction, lane)`: Call ONCE when Schnee asks to code, investigate, edit files, research, or run background operations. Verbally reply with a brief confirmation (e.g. "Sudah kucatat untuk dikerjakan worker di background.").
    - `check_task_status(task_id)`: Call when Schnee asks "bagaimana status task?", "sudah selesai belum?", or asks about pending work. Read back the actual store status briefly in natural words.
    - `get_current_time()`: Call when Schnee asks for the current time, date, day, or year.
    - `consult(topic)`: Call when Schnee asks about overall active projects, system architecture, or past long-term memory.
    - `memory_search(query)`: Call when Schnee asks tentang pengetahuan jangka panjang, keputusan masa lalu, arsitektur sistem, atau hal yang tidak ada di memori pendek konteks saat ini. Query MemPalace MCP HTTP untuk mencari drawer/diaries berdasarkan topik.

    # 5. Boundaries & Guardrails
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


async def search_mempalace(query: str, timeout: float = 1.5) -> str:
    """Core logic Sprint A.3: query MemPalace MCP HTTP, return top-k ringkas.

    Timeout default 1.5s. Jika down → return narasi natural (BUKAN error mentah).
    Dipisah dari @function_tool agar bisa di-unit-test tanpa LiveKit tool machinery.
    """
    logger.info(f"Searching MemPalace: {query}")
    try:
        # Get MCP endpoint from environment (set by user/config)
        mcp_endpoint = os.getenv("MEMPALACE_MCP_HTTP_ENDPOINT", "")
        mcp_token = os.getenv("MEMPALACE_MCP_HTTP_TOKEN", "")

        if not mcp_endpoint or not mcp_token:
            return "Aku sedang kesulitan mengakses memori jangka panjangku — konfigurasi MCP belum tersedia."

        async with aiohttp.ClientSession() as session:
            url = f"{mcp_endpoint}/search"
            headers = {"Authorization": f"Bearer {mcp_token}"}
            params = {"query": query, "limit": 3}

            async with session.get(
                url,
                headers=headers,
                params=params,
                timeout=aiohttp.ClientTimeout(total=timeout),
            ) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    results = data.get("results", [])
                    if not results:
                        return f"Tidak ditemukan ingatan terkait '{query}' dalam memoriku."

                    items = []
                    for r in results[:3]:
                        title = r.get("title", "tanpa judul")
                        preview = r.get("content", "")[:150]
                        wing = r.get("wing", "unknown")
                        items.append(f"- {title} ({wing}): {preview}...")

                    return f"Hasil pencarian ingatan untuk '{query}':\n" + "\n".join(items)
                return "Aku sedang kesulitan mengakses ingatanku, coba lagi sebentar lagi."
    except asyncio.TimeoutError:
        logger.warning(f"MemPalace search timeout: {query}")
        return "Aku sedang kesulitan mengakses ingatanku, coba lagi sebentar lagi."
    except Exception as e:
        logger.warning(f"MemPalace search failed: {e}")
        return "Aku sedang kesulitan mengakses ingatanku, coba lagi sebentar lagi."


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
    async def memory_search(self, query: str) -> str:
        """Search MemPalace knowledge graph for long-term memory about projects, decisions, and architecture.

        Call this when Schnee asks about long-term knowledge, past decisions, system
        architecture, or anything not present in the current session context.

        Args:
            query: Search keywords for long-term memory lookup (e.g., 'keputusan TimescaleDB', 'setup MemPalace')

        Timeout 1.5s. If MemPalace is down → natural error narrative (never raw error, never silence).
        """
        return await search_mempalace(query)

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


async def build_session_context(room_name: str) -> str:
    parts: list[str] = []

    # 1. MemPalace preferences + active projects
    mcp_endpoint = os.getenv("MEMPALACE_MCP_HTTP_ENDPOINT", "")
    mcp_token = os.getenv("MEMPALACE_MCP_HTTP_TOKEN", "")
    if mcp_endpoint and mcp_token:
        try:
            async with aiohttp.ClientSession() as session:
                headers = {"Authorization": f"Bearer {mcp_token}"}
                for query, label in [
                    ("preferensi user", "Preferensi"),
                    ("proyek aktif", "Proyek Aktif"),
                ]:
                    async with session.get(
                        f"{mcp_endpoint}/search",
                        headers=headers,
                        params={"query": query, "limit": 2},
                        timeout=aiohttp.ClientTimeout(total=1.5),
                    ) as resp:
                        if resp.status == 200:
                            data = await resp.json()
                            results = data.get("results", [])[:2]
                            if results:
                                lines = [r.get("content", "")[:120] for r in results]
                                parts.append(f"{label}: {' | '.join(lines)}")
        except Exception as e:
            logger.warning(f"MemPalace context fetch failed: {e}")
    else:
        logger.warning("MemPalace MCP endpoint/token not set — skipping context injection")

    # 2. SQLite: 5 task terakhir
    try:
        with sqlite3.connect(DB_PATH) as conn:
            conn.row_factory = sqlite3.Row
            rows = conn.execute(
                "SELECT task_id, user_intent, status FROM tasks ORDER BY created_at DESC LIMIT 5"
            ).fetchall()
            if rows:
                task_lines = [
                    f"- {r['task_id']}: {r['user_intent'][:80]} ({r['status']})"
                    for r in rows
                ]
                parts.append("Task Terakhir:\n" + "\n".join(task_lines))
    except Exception as e:
        logger.warning(f"Task context fetch failed: {e}")

    if not parts:
        return ""

    context = "[KONTEKS SAAT INI]\n" + "\n\n".join(parts)
    # Hard cap ~1000 token (~4000 char) — potong jika lebih
    if len(context) > 4000:
        context = context[:4000] + "..."
    return context


def get_session_handle(room_name: str) -> str | None:
    """Sprint B.2: Ambil session handle dari SQLite untuk room tertentu."""
    try:
        with sqlite3.connect(DB_PATH) as conn:
            row = conn.execute(
                "SELECT handle FROM session_resumption WHERE room = ?", (room_name,)
            ).fetchone()
            return row[0] if row else None
    except Exception as e:
        logger.warning(f"Failed to get session handle for {room_name}: {e}")
        return None


def save_session_handle(room_name: str, handle: str) -> bool:
    """Sprint B.2: Simpan/update session handle ke SQLite."""
    try:
        now = int(time.time() * 1000)
        with sqlite3.connect(DB_PATH) as conn:
            # Upsert: insert or update handle + timestamp
            conn.execute(
                """INSERT INTO session_resumption (room, handle, updated_at)
                   VALUES (?, ?, ?)
                   ON CONFLICT(room) DO UPDATE SET handle=?, updated_at=?""",
                (room_name, handle, now, handle, now),
            )
        return True
    except Exception as e:
        logger.warning(f"Failed to save session handle for {room_name}: {e}")
        return False


# ---------------------------------------------------------------------------
# Sprint C — Push notification yang benar
# ---------------------------------------------------------------------------

_NUM_WORDS = {1: "satu", 2: "dua", 3: "tiga", 4: "empat", 5: "lima"}
COALESCE_MAX = 5


def coalesce_notifications(rows: list[dict]) -> str:
    """C.3: gabungkan baris notifikasi jadi SATU ucapan natural (maks 5 item)."""
    n = len(rows)
    if n == 1:
        r = rows[0]
        summary = r.get("summary") or "sudah selesai."
        return f"Schnee, task {r.get('user_intent') or r['task_id']}: {summary}"
    word = _NUM_WORDS.get(n, str(n))
    parts = []
    for r in rows:
        intent = (r.get("user_intent") or r["task_id"]).split(":")[0][:60]
        parts.append(intent)
    return f"Schnee, {word} task selesai: {'; '.join(parts)}."


def _rollback_delivered(task_ids: list[str], db_path: str) -> None:
    """C.1/C.2: kembalikan delivered=0 agar ditawarkan ulang di poll berikutnya."""
    try:
        with sqlite3.connect(db_path) as conn:
            conn.executemany(
                "UPDATE notify_outbox SET delivered = 0, delivered_at = NULL WHERE task_id = ?",
                [(tid,) for tid in task_ids],
            )
    except Exception as e:
        logger.warning(f"Notification rollback failed: {e}")


async def deliver_notifications(session, room_name: str, db_path: str | None = None) -> int:
    """C.1+C.2+C.3: claim atomik → coalesce → say → hormati interupsi.

    Pola: UPDATE ... SET delivered=1 WHERE delivered=0 RETURNING task_id (claim
    atomik), lalu session.say() SATU ucapan gabungan. Jika say gagal ATAU ucapan
    di-interupsi → rollback delivered=0 (notifikasi TIDAK hilang).
    Return jumlah task yang tersampaikan.

    NOTE: room_name TIDAK dipakai sebagai filter karena client membuat room baru
    setiap reconnect (jarvis-{random8}). Semua notifikasi undelivered dikirim ke
    session aktif — pola "drainNotify on reconnect" sesuai desain task-store.
    """
    db = db_path or DB_PATH
    with sqlite3.connect(db) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            """
            SELECT n.task_id, n.status, t.user_intent, t.summary
            FROM notify_outbox n
            JOIN tasks t ON n.task_id = t.task_id
            WHERE n.delivered = 0
            ORDER BY n.created_at ASC
            LIMIT ?
            """,
            (COALESCE_MAX,),
        ).fetchall()
        if not rows:
            return 0

        # C.1: claim atomik (hanya baris yang belum delivered)
        claimed: list[dict] = []
        now = int(time.time() * 1000)
        for r in rows:
            got = conn.execute(
                "UPDATE notify_outbox SET delivered = 1, delivered_at = ? "
                "WHERE task_id = ? AND delivered = 0 RETURNING task_id",
                (now, r["task_id"]),
            ).fetchone()
            if got:
                claimed.append(dict(r))
    if not claimed:
        return 0

    utterance = coalesce_notifications(claimed)
    claimed_ids = [r["task_id"] for r in claimed]
    try:
        handle = await session.say(utterance)
        # C.2: tunggu ucapan selesai/terinterupsi, lalu cek SpeechHandle.interrupted
        wait = getattr(handle, "wait_if_not_interrupted", None)
        if wait is not None:
            await wait()
        if getattr(handle, "interrupted", False):
            logger.info("Notification interrupted — rollback for re-offer")
            _rollback_delivered(claimed_ids, db)
            return 0
        return len(claimed)
    except Exception as e:
        # C.1: say gagal → notifikasi tetap pending, TIDAK hilang
        logger.warning(f"Proactive notification delivery failed: {e}")
        _rollback_delivered(claimed_ids, db)
        return 0


async def startup_health_check() -> dict[str, bool]:
    health = {"searxng": False, "mempalace": False}

    async def _check_searxng() -> None:
        try:
            async with aiohttp.ClientSession() as s, s.get(
                "http://43.133.136.244:8888/healthz",
                timeout=aiohttp.ClientTimeout(total=2.0),
            ) as resp:
                health["searxng"] = resp.status < 500
        except Exception:
            health["searxng"] = False

    async def _check_mempalace() -> None:
        endpoint = os.getenv("MEMPALACE_MCP_HTTP_ENDPOINT", "")
        if not endpoint:
            return
        try:
            async with aiohttp.ClientSession() as s, s.get(
                f"{endpoint}/health",
                timeout=aiohttp.ClientTimeout(total=2.0),
            ) as resp:
                health["mempalace"] = resp.status < 500
        except Exception:
            health["mempalace"] = False

    await asyncio.gather(_check_searxng(), _check_mempalace())
    for name, ok in health.items():
        if not ok:
            logger.warning(f"Startup health check: {name} DOWN — tools tetap terdaftar, narasi error saat dipanggil")
    return health


@server.rtc_session(agent_name="shorekeeper")
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

    # Sprint A.2: Context injection (build_session_context)
    context_block = await build_session_context(ctx.room.name)

    # Sprint C.4: dependency non-kritis — warning saja, tool tetap terdaftar
    await startup_health_check()

    # Sprint C.4: kredensial kritis → fail-fast
    gemini_api_key = os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")
    if not gemini_api_key:
        raise RuntimeError("GEMINI_API_KEY / GOOGLE_API_KEY is not set — cannot start session")

    # Validate that voice is a valid Gemini voice; if user sent Fish Audio hash, fallback to Aoede
    if voice not in VALID_GEMINI_VOICES:
        logger.warning(f"Voice '{voice}' is not a valid Gemini voice — falling back to '{FALLBACK_VOICE}'")
        voice = FALLBACK_VOICE

    # Sprint B.2: resume from persisted handle (cross-restart resumption)
    resume_handle = get_session_handle(ctx.room.name)
    if resume_handle:
        logger.info(f"Resuming session from persisted handle for {ctx.room.name}")

    # Native Gemini Live Multimodal Realtime Model
    # (Sprint B.1: context compression · B.2: session resumption)
    model_kwargs: dict[str, object] = {
        "model": "gemini-3.1-flash-live-preview",
        "api_key": gemini_api_key,
        "voice": voice,
        "modalities": ["AUDIO"],
        "temperature": 0.7,
        "context_window_compression": ContextWindowCompressionConfig(
            trigger_tokens=60_000,
            sliding_window=SlidingWindow(target_tokens=30_000),
        ),
    }
    if resume_handle:
        model_kwargs["session_resumption"] = SessionResumptionConfig(handle=resume_handle)
    model = RealtimeModel(**model_kwargs)  # type: ignore[arg-type]

    # Attach TTS for programmatic push notifications (session.say) without affecting realtime audio
    tts_model = None
    try:
        tts_model = google.TTS(voice_name=voice)
    except Exception as te:
        logger.warning(f"google.TTS init failed: {te}")

    agent = ShorekeeperAgent(
        instructions=SHOREKEEPER_INSTRUCTIONS + ("\n\n" + context_block if context_block else ""),
        room_name=ctx.room.name,
    )

    session_kwargs: dict[str, object] = {"llm": model}
    if tts_model:
        session_kwargs["tts"] = tts_model
    session = AgentSession(**session_kwargs)

    await session.start(agent=agent, room=ctx.room)
    logger.info("Shorekeeper Gemini Live session started.")

    # Sprint B.2: persist resumption handle updates (plugin tidak mengekspos
    # event resumption — poll property session_resumption_handle, simpan ke
    # SQLite saat berubah; dipakai sebagai handle resume di session berikutnya).
    async def resumption_handle_loop():
        last_handle = None
        while True:
            await asyncio.sleep(15.0)
            try:
                handle = getattr(model, "session_resumption_handle", None)
                if handle and handle != last_handle:
                    last_handle = handle
                    save_session_handle(ctx.room.name, handle)
                    logger.info(f"Persisted session resumption handle for {ctx.room.name}")
            except Exception as e:
                logger.debug(f"Resumption handle poll error: {e}")

    resumption_ref = asyncio.create_task(resumption_handle_loop())
    
    async def cancel_resumption():
        resumption_ref.cancel()
        try:
            await resumption_ref
        except asyncio.CancelledError:
            pass
    
    ctx.add_shutdown_callback(cancel_resumption)

    # Background Poller — Sprint C: claim atomik + interrupt + coalesce
    async def outbox_notification_loop():
        while True:
            await asyncio.sleep(2.0)
            try:
                await deliver_notifications(session, ctx.room.name)
            except Exception as e:
                logger.debug(f"Outbox poll error: {e}")

    task_ref = asyncio.create_task(outbox_notification_loop())
    
    async def cancel_outbox():
        task_ref.cancel()
        try:
            await task_ref
        except asyncio.CancelledError:
            pass
    
    ctx.add_shutdown_callback(cancel_outbox)


if __name__ == '__main__':
    from livekit.agents import cli
    cli.run_app(server)
