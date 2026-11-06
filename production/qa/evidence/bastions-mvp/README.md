# Preuves : BASTIONS v2 (2026-11-06)

Run result: **PASS**. Tout est produit par `node tools/qa/two-player-smoke.mjs` : un vrai serveur sur un
dossier de données jetable, et deux vrais navigateurs (Chromium, un bureau 1366×768 et un iPhone 13 émulé).
Ils passent par de vrais clics et touchers sur l'interface, jamais par des messages injectés.

| Capture | Ce qu'elle prouve |
|---|---|
| `01-login-desktop.png` | Écran titre v2 : carte de démonstration animée (donjons de niveaux 1 à 3, Sanctuaire, camps) |
| `02-base-desktop.png` | Base construite à la souris : mines, scierie, carrière, casernes, tours, écurie, forge, avant-poste, rempart tracé au glisser, onglet Bâtir avec les coûts en or, bois et pierre, et les verrous de niveau |
| `02b-army-tab-desktop.png` | Onglet Armée : Guerrier, Archer, Soigneur, Cavalier, Catapulte verrouillée (Atelier), Tout, Rappel |
| `03-base-mobile.png` | Base construite au toucher sur téléphone |
| `04a-camp-raid-desktop.png` | Armée envoyée sur un camp de monstres, combat en cours (le trésor et la gloire sont vérifiés par le script) |
| `04-raid-desktop.png`, `05-under-attack-mobile.png` | Raid sur le donjon d'un autre joueur, alerte côté défenseur |
| `06-after-raid-desktop.png`, `07-after-raid-mobile.png` | État après le raid |
| `10-clan-panel-desktop.png` | Clan fondé depuis l'onglet Donjon : panneau de clan, tag dans le classement |
| `11-clan-invite-mobile.png` | Invitation reçue sur mobile (puis acceptée par le script) |
| `08-help-desktop.png` | Aide des commandes v2 |
| `09-connection-lost-desktop.png` | Serveur arrêté : bandeau « Connexion perdue ». Au redémarrage, les deux clients retrouvent leur base et leur clan |

Points vérifiés par le script (échec = code de sortie non nul) :
- aucune erreur JavaScript ni d'erreur console dans les deux pages ;
- le chat d'un joueur arrive chez l'autre ;
- amélioration du Donjon au niveau 2 et recherche de la Forge appliquées ;
- un camp de monstres détruit rapporte de la Gloire ;
- l'attaquant gagne de la Gloire pendant le raid ;
- le clan est fondé, l'invitation est reçue et acceptée, et le clan survit au redémarrage ;
- après un redémarrage du serveur, l'identité et les bâtiments sont restaurés.

Non couvert ici : le rendu sur un vrai téléphone (émulation seulement), le passage par nginx/HTTPS
(voir `docs/deploy-vps.md`), et l'image Docker (pas de démon Docker dans l'environnement de build ;
les étapes de l'image ont été rejouées à la main : `npm ci --omit=dev` puis démarrage OK).

`stamp.txt` contient l'empreinte des fichiers serveur et client au moment des captures.
