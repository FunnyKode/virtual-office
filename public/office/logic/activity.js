// What an agent is doing, in words and an icon, from its status and current tool.
// Pure: shared by the 3D office and its tests.

/** @typedef {import('../../../src/domain/types.ts').AgentView} AgentView */
/** @typedef {'working' | 'waiting' | 'idle' | 'stale' | 'ended'} Tone */
/** @typedef {{ icon: string, label: string, tone: Tone }} Activity */

/** @type {ReadonlyArray<[RegExp, string, string]>} [pattern on "Tool summary", icon, label] */
const TOOL_RULES = [
  [/^(Read|Grep|Glob|LS)\b/, '🔎', 'lit le code'],
  [/^(Edit|MultiEdit|Write|NotebookEdit)\b/, '✏️', 'modifie'],
  [/^(WebFetch|WebSearch)\b/, '🌐', 'cherche sur le web'],
  [/^(Agent|Task)\b/, '🤝', 'délègue'],
  [/^(TodoWrite|TaskCreate|TaskUpdate)\b/, '🗒️', 'planifie'],
  [/^Bash .*\bgit (commit|push)\b/, '⬆️', 'publie'],
  [/^Bash .*\bgit\b/, '🌿', 'git'],
  [/^Bash .*\b(test|vitest|jest|pytest|playwright|cargo test|go test)\b/, '🧪', 'lance les tests'],
  [/^Bash .*\b(npm|pnpm|yarn|bun) (i|install|ci|add)\b/, '📦', 'installe'],
  [/^Bash .*\b(docker|kubectl|podman)\b/, '🐳', 'conteneurs'],
  [/^Bash\b/, '⌨️', 'terminal'],
  [/^mcp__/, '🔌', 'outil externe'],
];

/**
 * @param {Pick<AgentView, 'status' | 'stale' | 'currentTool'>} agent
 * @returns {Activity}
 */
export function activityOf(agent) {
  if (agent.status === 'ended') return { icon: '✔️', label: 'terminé', tone: 'ended' };
  if (agent.status === 'waiting_permission') return { icon: '✋', label: 'attend ton autorisation', tone: 'waiting' };
  if (agent.stale) return { icon: '💤', label: 'silencieux', tone: 'stale' };
  if (agent.status === 'idle') return { icon: '⏸️', label: 'attend ta demande', tone: 'idle' };
  const summary = agent.currentTool?.summary ?? '';
  const rule = TOOL_RULES.find(([pattern]) => pattern.test(summary));
  if (rule) return { icon: rule[1], label: rule[2], tone: 'working' };
  return { icon: '💭', label: 'réfléchit', tone: 'working' };
}

/**
 * Short name for a bubble: the title, else the subagent type, else the start of the id.
 * @param {Pick<AgentView, 'title' | 'agentType' | 'id' | 'kind'>} agent
 */
export function displayName(agent, max = 48) {
  // Titles come from transcripts: bidirectional controls could make one name look like another.
  const title = agent.title?.replace(BIDI_CONTROLS, '').trim();
  const raw = title || agent.agentType || (agent.kind === 'subagent' ? 'sous-agent' : `session ${agent.id.slice(0, 8)}`);
  const characters = Array.from(raw); // never cut an emoji or accented pair in half
  return characters.length > max ? `${characters.slice(0, max - 1).join('')}…` : raw;
}

const BIDI_CONTROLS = /[‪-‮⁦-⁩‎‏]/g;
