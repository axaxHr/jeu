# Game Brief: BASTIONS

**One-sentence pitch:** Un jeu de stratégie multijoueur dans le navigateur. Chaque joueur bâtit sa forteresse sur une carte partagée, exploite les filons d'or, lève une armée et part raser les bastions voisins, en direct, sur ton propre serveur.

## Core loop
- **Produire** : le Noyau et les Mines (posées sur des filons d'or) rapportent de l'or chaque seconde.
- **Construire** : dans son territoire (rayon autour du Noyau), poser des Murs, Tours (tir auto), Mines et Casernes.
- **Recruter et attaquer** : les Casernes forment des Guerriers et des Archers, qu'on envoie sur un bâtiment ennemi. Ils contournent ou cassent les murs, affrontent les défenseurs et pillent l'or.
- **Se défendre et rebâtir** : les tours et les unités au repos défendent toutes seules. Le butin et la Gloire font grimper au classement, et on recommence plus fort.

## Player goal & fail state — what "working" looks like
- **But** : avoir le plus de **Gloire** (bâtiments et unités ennemis détruits, Noyaux rasés) au classement du serveur.
- **Échec** : si ton **Noyau** tombe, ta base s'effondre, l'attaquant vole 30 % de ton or et tu renais ailleurs avec un bouclier. Il n'y a pas de fin de partie : le monde est persistant (sauvegarde disque).

## MVP — what must exist to be the game
1. Serveur Node.js autoritaire (10 ticks/s) qui sert aussi le client, WebSocket, monde persistant en JSON.
2. Carte procédurale partagée (herbe, eau, roche, forêt, filons d'or) et apparition équitable des joueurs.
3. Économie et construction : or passif, 5 bâtiments, territoire, démolition (50 % remboursés).
4. Armée : 2 unités, file de recrutement, ordres déplacer/attaquer, pathfinding qui casse les murs ennemis.
5. Combat : tours, mêlée et distance, destruction, butin, élimination et réapparition, Gloire.
6. Protection : bouclier de départ, et bouclier des bases dont le joueur est hors-ligne (option serveur).
7. Client : caméra (glisser, zoom), barre de construction, sélection d'armée, mini-carte, classement, **chat**. Jouable à la souris et au doigt.

## Out of scope — not building this
- Pas d'alliances ni d'équipes (le chat sert à la diplomatie), pas de brouillard de guerre.
- Pas de comptes ni mots de passe : un pseudo, plus un jeton secret gardé dans le navigateur pour retrouver sa base.
- Pas d'améliorations de bâtiments, pas d'arbre technologique, pas de héros.
- Pas de musique ni de sons dans le MVP, pas d'assets externes.
- Un seul monde par serveur (pas de salons ni de matchmaking).

## Build order
1. Données partagées (`src/shared/config.js`) et génération de carte seedée, avec tests.
2. Simulation serveur pure (`World`) : construction, économie, recrutement, pathfinding, combat, élimination, avec tests (c'est le cœur, donc en premier).
3. Réseau : WebSocket, validation des messages, limites de débit, reconnexion par jeton, persistance.
4. Client : rendu carte, bâtiments et unités interpolées, caméra, construction.
5. Client : armée et ordres, mini-carte, classement, chat, notifications.
6. Kit VPS : Docker, systemd, nginx (WebSocket et HTTPS), doc de déploiement.

---
**Who it's for / what they feel:** un groupe d'amis sur un serveur privé, en soirée : l'excitation du raid, la panique de « ta base est attaquée ! », la fierté d'une défense qui tient.

**Art & audio direction:** pixel art 16×16 en vue de dessus trois-quarts. Herbe tramée, falaises, plages et eau scintillante, forêts denses. Donjons, tours à toit conique, remparts qui se raccordent, tentes-casernes et soldats animés aux couleurs de chaque joueur (rampes de 5 teintes). Interface en panneaux biseautés prune et or, polices pixel *Pixelify Sans* et *Jersey 10* (licence OFL, hébergées sur le serveur). Tout est dessiné en code, sans fichier image. Pas de son au MVP.

**Reference game:** les jeux de stratégie « .io » à base persistante. On ne garde que la boucle or → bâtir → recruter → raser, sur une seule carte partagée, sans méta-progression.

---
### Tuning & rationale
Toutes les valeurs de gameplay (coûts, PV, dégâts, portées, revenus, rayons, boucliers) sont dans `src/shared/config.js`, lu par le serveur **et** le client (le client n'affiche que ce que le serveur appliquera). Les réglages d'hébergement (port, taille de carte, seed, joueurs max, bouclier hors-ligne) passent par variables d'environnement : `docs/deploy-vps.md`.

Repères d'équilibrage (calculés depuis `config.js`, revus par `game-designer` le 2026-11-06) :
- Revenu de départ : 3 or/s (Noyau), plus 2 or/s par Mine. Une Mine (60 or) est remboursée en 30 s, mais les filons sont limités.
- 10 Guerriers (250 or) détruisent un Noyau de 2000 PV en environ 13 s s'ils ne sont pas arrêtés. Une Tour (70 or) tue un Guerrier en 7 tirs (environ 6,3 s).
- Les Archers (portée 5,5) dépassent la portée des Tours (5). Une attaque préparée qui cible les tours d'abord bat une défense passive du même coût. Un petit raid sans préparation échoue.
- Au plus 12 Tours par seigneur, et des Murs à 250 PV : le repli défensif total ne peut plus tenir face à une armée complète.

### Decision log (workflow `minimal`)
- **2026-11-06, pivot.** Le premier concept (ORBITE, solo à une touche) a été abandonné à la demande du joueur, qui veut un jeu de base multijoueur hébergeable sur son VPS.
- **2026-11-06, moteur = Web natif : Node.js côté serveur, Canvas 2D côté client, pas de moteur tiers.** Un VPS fait tourner Node sans GPU ni build, et un seul processus sert le site et le WebSocket. Le client ne demande aucune installation. Aucun agent spécialiste moteur ne s'applique. Revue réseau par `network-programmer`, revue sécurité par `security-engineer`.
- **2026-11-06, serveur autoritaire, client « terminal ».** Le client envoie des *intentions* (construire, recruter, ordonner, chatter). Le serveur valide tout (coût, territoire, terrain, propriétaire, débit), donc on ne peut pas tricher en modifiant le client.
- **2026-11-06, champs de flux (Dijkstra inversé depuis la cible) au lieu d'un A\* par unité.** Un seul calcul sert tout un groupe envoyé sur la même cible. Les bâtiments ennemis y sont franchissables avec un surcoût : une unité bloquée par un mur le casse plutôt que de rester coincée.
- **2026-11-06, toutes les constructions occupent une tuile (1×1).** Ça simplifie l'occupation, le pathfinding et le placement. Le Noyau est seulement dessiné plus gros.
- **2026-11-06, refonte visuelle en pixel art** (retour du joueur : la première version faisait générique). Les sprites sont générés par code (`src/client/sprites.js`, `terrain.js`) : contour automatique, recoloration par équipe, aucun fichier image à maintenir.
- **2026-11-06, revue `game-designer`, changements appliqués :**
  - Tours : 12 maximum, portée 6 → 5.
  - Archers : portée 4,5 → 5,5, coût 35 → 30, dégâts 10 → 12.
  - Murs : 500 → 250 PV ; coût pour traverser un mur ennemi 14 → 6.
  - La gloire d'un donjon rasé dépend du rapport de gloire (×0,25 à ×1,5), contre le harcèlement des débutants.
  - Le bouclier hors ligne ne s'active qu'après 120 s, pour qu'on ne puisse pas fuir un raid en fermant l'onglet.
- **2026-11-06, revue `security-engineer`, correctifs appliqués :**
  - Plantage par requête d'upgrade malformée.
  - Plafond de comptes par IP, IPv6 regroupée par /64.
  - Purge des bases d'essai abandonnées.
  - Vérification d'`Origin`.
  - Budget de pathfinding par joueur et cache LRU.
  - Limite de connexions par minute, délai d'identification de 10 s, 3 essais.
  - Timeouts HTTP.
  - `X-Forwarded-For` lu seulement si la connexion vient d'un proxy de confiance.
  - Caractères invisibles et sosies cyrilliques ou grecs dans les pseudos.
  - Sauvegardes sérialisées et `fsync`.
