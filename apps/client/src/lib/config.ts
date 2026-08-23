/**
 * config.ts — environment + display constants.
 *
 * Single place to change endpoints, identity, voice registry fallback,
 * and user-facing labels. Future work: fetch LIVEKIT_URL/IDENTITY from
 * the token endpoint so the bundle is environment-agnostic.
 */
import type { VoiceOption } from './types';

/** LiveKit Cloud SFU (WebSocket endpoint of the project). */
export const LIVEKIT_URL = 'wss://jarvis-s8lzasoo.livekit.cloud';

/** Local participant identity — transcripts attributed to us arrive here. */
export const IDENTITY = 'schnee';

/** Shorekeeper-specific token/voice endpoints (port 8083, terpisah dari jarvis lama). */
export const TOKEN_ENDPOINT = '/shorekeeper/api/token';
export const VOICES_ENDPOINT = '/shorekeeper/api/voices';

/** localStorage key for the chosen Fish Audio voice. */
export const VOICE_STORAGE_KEY = 'shorekeeper-voice';
export const MODEL_STORAGE_KEY = 'shorekeeper-model';

/** Static voice registry — Native Gemini Live Realtime Voices (All 30 Celestial Voices) */
export const FALLBACK_VOICES: VoiceOption[] = [
  { id: 'Aoede', label: 'Aoede', desc: 'Warm · Melodic', default: true },
  { id: 'Achernar', label: 'Achernar', desc: 'Bright · Resonant', default: false },
  { id: 'Achird', label: 'Achird', desc: 'Crisp · Balanced', default: false },
  { id: 'Algenib', label: 'Algenib', desc: 'Calm · Grounded', default: false },
  { id: 'Algieba', label: 'Algieba', desc: 'Warm · Steady', default: false },
  { id: 'Alnilam', label: 'Alnilam', desc: 'Deep · Dynamic', default: false },
  { id: 'Autonoe', label: 'Autonoe', desc: 'Gentle · Expressive', default: false },
  { id: 'Callirrhoe', label: 'Callirrhoe', desc: 'Smooth · Radiant', default: false },
  { id: 'Charon', label: 'Charon', desc: 'Deep · Authoritative', default: false },
  { id: 'Despina', label: 'Despina', desc: 'Smooth · Conversational', default: false },
  { id: 'Enceladus', label: 'Enceladus', desc: 'Light · Cheerful', default: false },
  { id: 'Erinome', label: 'Erinome', desc: 'Polished · Clear', default: false },
  { id: 'Fenrir', label: 'Fenrir', desc: 'Direct · Strong', default: false },
  { id: 'Gacrux', label: 'Gacrux', desc: 'Mature · Grounded', default: false },
  { id: 'Iapetus', label: 'Iapetus', desc: 'Rich · Steady', default: false },
  { id: 'Kore', label: 'Kore', desc: 'Calm · Clear', default: false },
  { id: 'Laomedeia', label: 'Laomedeia', desc: 'Soft · Airy', default: false },
  { id: 'Leda', label: 'Leda', desc: 'Gentle · Soothing', default: false },
  { id: 'Orus', label: 'Orus', desc: 'Bold · Confident', default: false },
  { id: 'Puck', label: 'Puck', desc: 'Playful · Energetic', default: false },
  { id: 'Pulcherrima', label: 'Pulcherrima', desc: 'Vibrant · Melodic', default: false },
  { id: 'Rasalgethi', label: 'Rasalgethi', desc: 'Warm · Deep', default: false },
  { id: 'Sadachbia', label: 'Sadachbia', desc: 'Focused · Direct', default: false },
  { id: 'Sadaltager', label: 'Sadaltager', desc: 'Quiet · Refined', default: false },
  { id: 'Schedar', label: 'Schedar', desc: 'Firm · Resonant', default: false },
  { id: 'Sulafat', label: 'Sulafat', desc: 'Gentle · Harmonic', default: false },
  { id: 'Umbriel', label: 'Umbriel', desc: 'Subtle · Calm', default: false },
  { id: 'Vindemiatrix', label: 'Vindemiatrix', desc: 'Clear · Eloquent', default: false },
  { id: 'Zephyr', label: 'Zephyr', desc: 'Bright · Expressive', default: false },
  { id: 'Zubenelgenubi', label: 'Zubenelgenubi', desc: 'Deep · Classic', default: false },
];

export interface ModelOption {
  id: string;
  label: string;
  desc: string;
  default?: boolean;
}

export const MODEL_OPTIONS: ModelOption[] = [
  { id: 'gemini-3.1-flash-live-preview', label: 'Gemini 3.1 Flash Live (Native)', desc: 'Realtime Audio · Complex Reasoning', default: true },
  { id: 'gemini-live-2.5-flash-native-audio', label: 'Gemini 2.5 Flash Live', desc: 'Realtime Audio · Low Latency' },
];

/** Human-friendly labels for tool progress rows, keyed by tool name. */
export const TOOL_LABELS: Record<string, string> = {
  web_search: 'Searching the web',
  web_extract: 'Reading a page',
  terminal: 'Running a command',
  read_file: 'Reading a file',
  write_file: 'Writing a file',
  search_files: 'Searching files',
  session_search: 'Searching memory',
  cronjob: 'Scheduling a task',
  memory: 'Updating memory',
  delegate_task: 'Delegating a task',
  clarify: 'Thinking',
};

export const toolLabel = (name: string): string => TOOL_LABELS[name] || 'Working on it';

/** Extract a human-readable argument summary for display in the tool chip. */
export const extractToolDetail = (name: string, args?: Record<string, any>): string | undefined => {
  if (!args || typeof args !== 'object') return undefined;
  if (name === 'web_search' && args.query) return `"${args.query}"`;
  if (name === 'terminal' && args.command) {
    const cmd = args.command.trim();
    return cmd.length > 30 ? cmd.slice(0, 30) + '…' : cmd;
  }
  if (name === 'read_file' && args.path) return args.path.split('/').pop();
  if (name === 'write_file' && args.path) return args.path.split('/').pop();
  if (name === 'search_files' && args.pattern) return `"${args.pattern}"`;
  if (name === 'session_search' && args.query) return `"${args.query}"`;
  return undefined;
};

/** Keep the user transcript on the caption bar this long after it commits. */
export const TRANSCRIPT_HOLD_MS = 3500;

/** Seal the live agent reply into history this long after the last activity. */
export const SEAL_DELAY_MS = 1500;

/** Footer chip — pipeline credit line. */
export const STACK_LINE = 'Deepgram Nova-3 · Hermes · Fish Audio';

/** HH:MM:SS in 24h format. */
export const getTime = (): string =>
  new Date().toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
