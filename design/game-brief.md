# Game Brief: BASTIONS

**One-sentence pitch:** Un jeu de stratégie multijoueur dans le navigateur. Chaque joueur bâtit sa forteresse sur une grande carte partagée, exploite or, bois et pierre, monte son donjon de niveau, pille les camps de monstres, dispute le Sanctuaire central et rase les bastions voisins, seul ou en clan, en direct, sur ton propre serveur.

## Core loop
- **Produire** : le Donjon donne un peu de tout. Les Mines (sur filons) font l'or, les Scieries (contre la forêt) le bois, les Carrières (contre la roche) la pierre.
- **S'étendre** : monter le Donjon (3 niveaux) agrandit le territoire et débloque Écurie, Forge et Soigneur, puis Atelier et Catapulte. Les Avant-postes repoussent la frontière vers de nouvelles ressources.
- **Armer** : Guerriers, Archers, Soigneurs, Cavaliers et Catapultes, avec des forces et des faiblesses entre eux. La Forge améliore l'attaque et l'armure.
- **Piller et conquérir** : des camps de barbares, de loups et d'ogres gardent des trésors. Le Sanctuaire central rapporte des ressources et de la gloire à qui le tient seul. Les bastions ennemis se rasent pour leur or.
- **S'allier** : un clan (5 membres) partage portes, chat et classement. Pas de dégâts entre alliés.

## Player goal & fail state — what "working" looks like
- **But** : avoir le plus de **Gloire** (bâtiments, unités, camps, donjons rasés, temps passé à tenir le Sanctuaire).
- **Échec** : si ton **Donjon** tombe, ta base s'effondre, l'attaquant vole 30 % de tes ressources et tu renais ailleurs avec un bouclier. Le monde est persistant.

## MVP — what must exist to be the game
1. Serveur Node.js autoritaire (10 ticks/s) sur une carte de 160×160, monde persistant en JSON, vue culling des unités.
2. Trois ressources, 11 bâtiments, Donjon à 3 niveaux, avant-postes, territoire = union de disques.
3. Cinq unités avec bonus croisés, file de recrutement par bâtiment, pathfinding qui traverse les portes alliées et casse les murs ennemis.
4. Monstres neutres en camps à piller, qui réapparaissent ; Sanctuaire central à capturer.
5. Clans : fondation, invitation, chat de clan, pas de tir ami.
6. Client pixel art : onglets Bâtir / Armée / Donjon, coûts multi-ressources, verrous de niveau, mini-carte, classement, chat.

## Out of scope — not building this
- Pas de brouillard de guerre (les unités hors de la caméra ne sont simplement pas envoyées).
- Pas de comptes ni mots de passe : un pseudo, plus un jeton secret gardé dans le navigateur.
- Pas de héros, pas de commerce entre joueurs, pas de saisons ni de réinitialisation automatique.
- Pas de musique ni de sons.

## Build order
1. Données partagées (`config.js`, `territory.js`) et génération de carte seedée.
2. Simulation (`World`) : économie, territoire, unités, camps, Sanctuaire, clans. Tests pour chaque règle.
3. Réseau : nouvelles intentions (amélioration, recherche, clan, vue), chat de clan, culling par caméra.
4. Sprites pixel art des nouveaux bâtiments, unités et monstres (`technical-artist`).
5. Client : onglets, coûts multi-ressources, cartes de bâtiment et de joueur, panneau de clan.
6. Vérification à deux navigateurs, déploiement.

---
**Who it's for / what they feel:** un groupe d'amis sur un serveur privé, en soirée : l'excitation du raid, la panique de « ta base est attaquée ! », la fierté d'une défense qui tient.

**Art & audio direction:** pixel art 16×16 en vue de dessus trois-quarts. Herbe tramée, falaises, plages et eau scintillante, forêts denses. Donjons, tours à toit conique, remparts qui se raccordent, tentes-casernes et soldats animés aux couleurs de chaque joueur (rampes de 5 teintes). Interface en panneaux biseautés prune et or, polices pixel *Pixelify Sans* et *Jersey 10* (licence OFL, hébergées sur le serveur). Tout est dessiné en code, sans fichier image. Pas de son au MVP.

**Reference game:** les jeux de stratégie « .io » à base persistante. On ne garde que la boucle or → bâtir → recruter → raser, sur une seule carte partagée, sans méta-progression.

---
### Tuning & rationale
Toutes les valeurs de gameplay (coûts, PV, dégâts, portées, revenus, rayons, boucliers) sont dans `src/shared/config.js`, lu par le serveur **et** le client (le client n'affiche que ce que le serveur appliquera). Les réglages d'hébergement (port, taille de carte, seed, joueurs max, bouclier hors-ligne) passent par variables d'environnement : `docs/deploy-vps.md`.

Repères d'équilibrage v2 (calculés depuis `config.js`) :
- Départ : 250 or, 150 bois, 100 pierre ; Donjon niv. 1 : +3 or, +1 bois, +1 pierre par seconde.
- Une Scierie entourée de 7 cases de forêt rapporte 2,8 bois/s, mais une seule case de forêt ne donne que 0,4 bois/s : on place ses bâtiments avec soin.
- Donjon niv. 2 (350 or, 250 bois, 250 pierre) : rayon 9 → 12 ; niv. 3 (800/500/600) : rayon 15, Catapultes.
- Triangle : Guerrier ×1,5 contre Cavalier ; Cavalier ×2 contre Archer, Catapulte, Soigneur ; Archer ×1,25 contre Guerrier. La Catapulte (portée 7) démolit les tours (portée 5) sans être touchée : il faut la défendre avec de la cavalerie.

Repères v1 (revus par `game-designer` le 2026-11-06), toujours valables :
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
- **2026-11-06, v2 « plus grand, plus de possibilités »** (retour du joueur : carte trop petite, pas assez de choix) :
  - Carte 96 → 160.
  - Ajout du bois et de la pierre, du Donjon à 3 niveaux, des avant-postes et des portes.
  - Nouvelles unités : Écurie/Cavalier, Atelier/Catapulte, Soigneur, et une Forge pour les recherches.
  - Monstres neutres en camps à piller, Sanctuaire central, clans.
  - Pour tenir la bande passante sur une grande carte, le serveur n'envoie que les unités proches de la caméra de chaque joueur.
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
