// Everything drawn over the 3D scene: figures, permission alert, agent list and detail panel.
// Built with DOM nodes and textContent only: agent data never becomes markup.
import { activityOf, displayName } from './logic/activity.js';
import { folderName, formatSince, formatTokens } from './logic/format.js';

/** @typedef {import('../../src/domain/types.ts').AgentView} AgentView */
/** @typedef {ReturnType<typeof import('./logic/summary.js').summarize>} Summary */

/** @param {string} id */
const byId = (id) => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`élément #${id} absent de la page`);
  return element;
};

/**
 * @param {string} tag
 * @param {{ className?: string, text?: string }} [options]
 */
function element(tag, { className, text } = {}) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const CONNECTION = { connecting: 'connexion…', live: 'en direct', offline: 'serveur injoignable — reconnexion…' };

/**
 * @param {{ onSelect: (id: string) => void, onClose: () => void }} handlers
 */
export function createHud({ onSelect, onClose }) {
  const panel = byId('fiche');
  const panelTitle = byId('fiche-titre');
  const panelDetails = byId('fiche-details');
  const list = byId('agents');
  const alert = byId('alerte');
  /** @type {string | null} */
  let openId = null;
  /** @type {HTMLElement | null} where focus was before the panel opened */
  let returnFocus = null;
  let alertKey = '';

  byId('fiche-fermer').addEventListener('click', () => close());
  addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && openId) close();
  });

  function markCurrent() {
    for (const button of list.querySelectorAll('button[data-id]')) {
      button.setAttribute('aria-current', String(button instanceof HTMLElement && button.dataset.id === openId));
    }
  }

  function close() {
    panel.hidden = true;
    openId = null;
    markCurrent();
    if (returnFocus?.isConnected) returnFocus.focus();
    returnFocus = null;
    onClose();
  }

  /**
   * Rebuilding a list destroys the focused button; give focus back to the one for the same agent.
   * @param {HTMLElement} container
   * @param {() => void} rebuild
   */
  function keepingFocus(container, rebuild) {
    const active = document.activeElement;
    const focusedId = active instanceof HTMLElement && container.contains(active) ? active.dataset.id : undefined;
    rebuild();
    if (!focusedId) return;
    const again = [...container.querySelectorAll('button[data-id]')].find((button) => button instanceof HTMLElement && button.dataset.id === focusedId);
    if (again instanceof HTMLElement) again.focus();
  }

  /** @param {Array<[string, string | null | undefined]>} rows */
  function fillDetails(rows) {
    panelDetails.replaceChildren(
      ...rows.filter(([, value]) => value).flatMap(([name, value]) => [element('dt', { text: name }), element('dd', { text: String(value) })]),
    );
  }

  /** @param {AgentView} agent @param {number} now */
  function describe(agent, now) {
    const activity = activityOf(agent);
    panelTitle.textContent = displayName(agent, 80);
    fillDetails([
      ['Type', agent.kind === 'session' ? 'Session Claude Code' : `Sous-agent${agent.agentType ? ` · ${agent.agentType}` : ''}`],
      ['État', `${activity.icon} ${activity.label}`],
      ['Autorisation demandée', agent.pendingPermission],
      ['Outil en cours', agent.currentTool?.summary],
      ['Dossier', agent.cwd ? `${folderName(agent.cwd)} (${agent.cwd})` : null],
      ['Modèle', agent.model],
      ['Outils', `${agent.toolCalls} appel(s)${agent.toolErrors ? `, ${agent.toolErrors} en erreur` : ''}`],
      ['Jetons', `${formatTokens(agent.tokens.output)} en sortie · ${formatTokens(agent.tokens.input + agent.tokens.cacheRead + agent.tokens.cacheWrite)} en entrée (cache compris)`],
      ['Début', formatSince(agent.startedAt, now)],
      ['Dernière activité', formatSince(agent.lastActivityAt, now)],
      ['Dernière demande', agent.lastPrompt],
      ['Dernier message', agent.lastMessage],
    ]);
  }

  return {
    /** @param {'connecting' | 'live' | 'offline'} state */
    setConnection(state) {
      const status = byId('connexion');
      status.textContent = CONNECTION[state];
      status.dataset.etat = state;
    },

    /**
     * @param {Summary} summary
     * @param {readonly AgentView[]} shown agents with a robot, in display order
     * @param {number} hidden agents without a seat
     * @param {number} now
     */
    update(summary, shown, hidden, now) {
      byId('k-travail').textContent = String(summary.working);
      byId('k-autorisation').textContent = String(summary.waiting.length);
      byId('k-autorisation-carte').classList.toggle('alerte', summary.waiting.length > 0);
      byId('k-attente').textContent = String(summary.idle + summary.stale);
      byId('k-jetons').textContent = formatTokens(summary.outputTokens);

      // The alert is announced by screen readers: touch it only when the requests themselves change.
      const waitingKey = summary.waiting.map((agent) => `${agent.id}:${agent.pendingPermission}`).join('|');
      if (waitingKey !== alertKey) {
        alertKey = waitingKey;
        alert.hidden = summary.waiting.length === 0;
        keepingFocus(alert, () =>
          alert.replaceChildren(
            element('strong', { text: summary.waiting.length === 1 ? '✋ Un agent attend ton autorisation' : `✋ ${summary.waiting.length} agents attendent ton autorisation` }),
            ...summary.waiting.slice(0, 4).map((agent) => {
              const button = element('button', { className: 'lien', text: `${displayName(agent, 40)} — ${agent.pendingPermission ?? 'autorisation'}` });
              button.dataset.id = agent.id;
              button.addEventListener('click', () => onSelect(agent.id));
              return button;
            }),
          ),
        );
      }

      keepingFocus(list, () => {
        list.replaceChildren(
          ...shown.map((agent) => {
            const activity = activityOf(agent);
            const item = element('li', { className: agent.kind });
            const button = element('button', { className: 'agent' });
            button.dataset.id = agent.id;
            button.dataset.ton = activity.tone;
            button.append(element('span', { className: 'nom', text: displayName(agent, 40) }), element('span', { className: 'etat', text: `${activity.icon} ${activity.label}` }));
            button.setAttribute('aria-current', String(agent.id === openId));
            button.addEventListener('click', () => onSelect(agent.id));
            item.append(button);
            return item;
          }),
        );
        if (shown.length === 0) list.replaceChildren(element('li', { className: 'vide', text: 'Aucun agent actif.' }));
      });
      byId('debordement').textContent = hidden > 0 ? `+ ${hidden} hors du bureau (voir le tableau)` : '';
      byId('maj').textContent = `mis à jour ${new Date(now).toLocaleTimeString('fr-FR')}`;
    },

    /** @param {AgentView} agent @param {number} now */
    open(agent, now) {
      if (panel.hidden && document.activeElement instanceof HTMLElement && document.activeElement !== document.body) returnFocus = document.activeElement;
      openId = agent.id;
      describe(agent, now);
      panel.hidden = false;
      markCurrent();
      byId('fiche-fermer').focus();
    },

    /** Keeps an open panel current as its agent changes. @param {ReadonlyMap<string, AgentView>} agents @param {number} now */
    refresh(agents, now) {
      if (!openId) return;
      const agent = agents.get(openId);
      if (agent) describe(agent, now);
    },

    get openId() {
      return openId;
    },
  };
}
