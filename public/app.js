// Live table of agents, fed by the SSE stream (/api/flux). Built with DOM nodes only: no innerHTML.
const STATUS = { working: 'au travail', waiting_permission: 'attend une autorisation', idle: 'en attente', ended: 'terminé' };
const agents = new Map();
let silenceMs = 15 * 60_000;

const ago = (at) => {
  const minutes = Math.round((Date.now() - at) / 60_000);
  return minutes < 1 ? 'à l’instant' : minutes < 60 ? `il y a ${minutes} min` : `il y a ${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')}`;
};

function cell(text, className) {
  const td = document.createElement('td');
  td.textContent = text;
  if (className) td.className = className;
  return td;
}

function row(agent) {
  const tr = document.createElement('tr');
  const busy = agent.status === 'working' || agent.status === 'waiting_permission';
  const stale = busy && Date.now() - agent.lastActivityAt > silenceMs;
  const name = `${agent.kind === 'subagent' ? '↳ ' : ''}${agent.title ?? agent.agentType ?? agent.id.slice(0, 8)}`;
  tr.append(
    cell(name),
    cell(stale ? 'silencieux' : STATUS[agent.status] ?? agent.status, `etat ${stale ? 'stale' : agent.status}`),
    cell(agent.pendingPermission ?? agent.currentTool?.summary ?? '—'),
    cell(String(agent.toolCalls) + (agent.toolErrors ? ` (${agent.toolErrors} ✖)` : '')),
    cell(agent.tokens.output.toLocaleString('fr-FR')),
    cell(ago(agent.lastActivityAt)),
  );
  return tr;
}

function render() {
  const body = document.getElementById('agents');
  const sorted = [...agents.values()].sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  body.replaceChildren(...(sorted.length ? sorted.map(row) : [Object.assign(document.createElement('tr'), { textContent: 'Aucun agent récent.' })]));
}

const source = new EventSource('/api/flux');
const status = document.getElementById('connexion');
source.addEventListener('open', () => { status.textContent = 'en direct'; });
source.addEventListener('error', () => { status.textContent = 'serveur injoignable — reconnexion…'; });
source.addEventListener('snapshot', (event) => {
  const snapshot = JSON.parse(event.data);
  silenceMs = snapshot.silenceMs;
  agents.clear();
  for (const agent of snapshot.agents) agents.set(agent.id, agent);
  render();
});
source.addEventListener('agents', (event) => {
  for (const agent of JSON.parse(event.data)) agents.set(agent.id, agent);
  render();
});
setInterval(render, 30_000);
