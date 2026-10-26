# virtual-office

Bureau virtuel en direct des agents **Claude Code** de ce poste : sessions, sous-agents, outil en cours, demandes d'autorisation, jetons consommés.

Un serveur local collecte les événements et les diffuse en flux. Deux pages s'y branchent :

- **`/`** : le bureau 3D (Three.js). Chaque session a son îlot, ses sous-agents travaillent autour d'elle, reliés par un faisceau. Un robot qui attend ton autorisation lève la main sous une balise orange, et une alerte liste ces demandes.
- **`/tableau`** : la même information en tableau.

## Le bureau 3D

| Ce que l'on voit | Ce que cela signifie |
|---|---|
| Robot corail à un bureau | une session Claude Code ; l'écran prend la couleur de son état |
| Petit robot gris autour de l'îlot | un sous-agent de cette session (faisceau coloré vers elle) |
| Bras qui tapent | au travail ; la bulle dit quoi (lit le code, modifie, lance les tests, git…) |
| Main levée et balise orange | attend ton autorisation |
| Tête basse | silencieux depuis plus du seuil de silence |
| Salle d'attente | sessions et sous-agents sans îlot libre |
| Entrée et sortie par la porte | un agent qui commence ou qui finit |

Commandes : glisser pour tourner, molette pour zoomer, double-clic ou *Recentrer* pour revenir, clic sur un robot ou sur la liste pour ouvrir sa fiche, `Échap` pour la fermer. *Visite* (`T`) fait tourner la caméra. *Mouvements réduits* fige les animations ; ce réglage suit par défaut la préférence système et se mémorise dans le navigateur.

Chaque agent garde sa place d'une mise à jour à l'autre. Une session active ou en attente d'autorisation peut prendre l'îlot de la session inactive la plus ancienne. Le rendu s'arrête quand rien ne bouge. Sans WebGL, la page reste utilisable en liste en direct, avec l'alerte et les fiches.

## Principe

```
Claude Code ──hooks──▶ hooks/relay.mjs ──POST /api/hooks──┐
                                                          ├─▶ réducteur pur ─▶ store ─▶ SSE /api/flux ─▶ pages
~/.claude/projects/**.jsonl ──lecture incrémentale────────┘
```

- **Hooks** (temps réel, état exact) : début de session, prompt, outil lancé ou terminé, autorisation demandée, fin de tour, sous-agent lancé ou terminé.
- **Transcripts** (rattrapage et complément) : seuls les octets ajoutés depuis le dernier passage sont relus. On en tire le titre de la session, les messages, les outils et les **jetons** (champ `usage`, compté une seule fois par message).
- Les deux sources peuvent rapporter le même fait, et dans le désordre. Le réducteur déduplique les outils par identifiant et n'applique un changement de statut que s'il est plus récent que le dernier connu.

États d'un agent : `working`, `waiting_permission`, `idle`, `ended`. Un agent occupé mais silencieux au-delà du seuil est marqué `stale`.

## Démarrer

Node 24 ou plus (il exécute TypeScript directement, sans étape de compilation).

```bash
npm install
```

```bash
npm start
```

La page est alors servie sur http://127.0.0.1:4317. Sans hooks, le bureau vit déjà des transcripts. Pour l'état en temps réel, installez les hooks :

```bash
npm run hooks:install -- --dry-run
```

```bash
npm run hooks:install
```

Le script ajoute le relais à `~/.claude/settings.json` sans toucher aux autres réglages ni aux autres hooks. Il sauvegarde d'abord le fichier (`settings.json.bak-<date>`) et ne fait rien s'il est déjà installé. Pour le retirer : `npm run hooks:install -- --uninstall`. L'option `--settings <fichier>` cible un autre fichier, par exemple `.claude/settings.json` d'un seul projet.

Le relais ne gêne jamais Claude Code : il n'écrit rien sur la sortie standard, rend toujours la main avec le code 0 et abandonne après 1,5 s. Si le bureau ne tourne pas, il se tait. Il ne transmet ni le résultat des outils ni le contenu des fichiers écrits.

## API

| Route | Rôle |
|---|---|
| `GET /api/flux` | flux SSE : `snapshot` à la connexion, puis `agents` (agents modifiés) ; battement toutes les 15 s |
| `GET /api/etat` | état complet `{ ok, data: { generatedAt, silenceMs, agents } }` |
| `GET /api/health` | `{ ok: true, data: { status: "up" } }` |
| `POST /api/hooks` | réception des hooks ; en-tête `x-virtual-office-token` obligatoire |

Toutes les réponses JSON utilisent la même enveloppe : `{ ok: true, data }` ou `{ ok: false, error }`.

## Sécurité

- Écoute sur la boucle locale uniquement : toute autre adresse est refusée au démarrage.
- **Toutes les routes**, lectures comprises, vérifient `Host`, `Origin` et `Sec-Fetch-Site`. C'est ce qui bloque le DNS rebinding, qu'un simple contrôle sur les routes d'écriture laisserait passer.
- Les hooks sont authentifiés par un jeton aléatoire de 256 bits, comparé en temps constant et stocké dans `~/.config/virtual-office/token` (droits 0600).
- Corps limité à 1 Mo, `content-type` JSON exigé, aucune construction HTML à partir des données (DOM uniquement).
- CSP stricte sur les pages. L'importmap du bureau 3D est autorisée par son empreinte SHA-256, jamais par `unsafe-inline`.
- Fichiers statiques : préfixes fixes, types `.js`/`.css` seulement, ni traversée de chemin ni lien symbolique sortant. Three.js est servi en local depuis `node_modules` et limité au build et aux modules d'exemple, sans CDN.
- Les clients SSE qui ne lisent plus sont déconnectés : un onglet bloqué ne fait pas gonfler la mémoire du serveur.

**Modèle de menace.** Le bureau vise une machine à un seul utilisateur. Les lectures (`/api/etat`, `/api/flux`) sont protégées contre les sites web, mais pas contre un autre compte ou un autre processus de la même machine. Ces lectures exposent les derniers prompts, les messages, les dossiers de travail et le résumé des commandes lancées. Sur une machine partagée, ne lancez pas le serveur.

**Coût.** Les hooks sont synchrones : chaque appel d'outil attend le démarrage du relais (quelques dizaines de millisecondes).

## Configuration (variables d'environnement)

| Variable | Défaut |
|---|---|
| `VO_PORT` | `4317` |
| `VO_HOST` | `127.0.0.1` (`::1` ou `localhost` acceptés) |
| `VO_CLAUDE_PROJECTS` | `~/.claude/projects` |
| `VO_TOKEN_FILE` | `$XDG_CONFIG_HOME/virtual-office/token` |
| `VO_WINDOW_HOURS` | `48` : historique conservé |
| `VO_SILENCE_MINUTES` | `15` : délai avant `stale` |
| `VO_SCAN_INTERVAL_MS` | `1000` |
| `VO_MAX_INITIAL_BYTES` | `8388608` : lecture initiale maximale par transcript |

`VO_PORT` et `VO_TOKEN_FILE` valent aussi pour le relais.

## Développement

```bash
npm run check
```

Cette commande enchaîne le contrôle de types strict (`tsc`, sans émission) et les tests vitest avec la couverture (seuil de 80 %).

Organisation : `src/domain` (types, réducteur pur, store), `src/sources` (hooks, transcripts, lecteur incrémental), `src/server` (HTTP, garde, SSE, jeton, configuration), `src/install` (fusion des réglages), `hooks/relay.mjs`, `public/office/` (bureau 3D : `logic/` pur et testé, `scene/` Three.js, `hud.js`), `public/` (pages), `test/`.

La logique du bureau (placement, activité, bulles, flux) est testée par vitest. La scène 3D a besoin de WebGL : elle se vérifie dans un navigateur, par exemple Chrome en mode headless avec `--use-angle=swiftshader`.

S'inspire de [bilwifi/bureau-agents-3d](https://github.com/bilwifi/bureau-agents-3d) (MIT).
