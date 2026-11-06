# Preuves : BASTIONS MVP (2026-11-06)

Run result: **PASS**. Tout est produit par `node tools/qa/two-player-smoke.mjs` : un vrai serveur sur un
dossier de données jetable, et deux vrais navigateurs (Chromium, un bureau 1366×768 et un iPhone 13 émulé).
Ils passent par de vrais clics et touchers sur l'interface, jamais par des messages injectés.

| Capture | Ce qu'elle prouve |
|---|---|
| `01-login-desktop.png` | Écran titre : logo, carte de démonstration animée derrière, formulaire de pseudo |
| `02-base-desktop.png` | Base construite à la souris : mines sur filons, casernes, tours, rempart tracé au glisser, territoire sous bouclier |
| `03-base-mobile.png` | Même chose au toucher, sur téléphone : barre d'actions en 2×4, chat et classement repliés |
| `04-raid-desktop.png` | Armée sélectionnée (« Armée »), ordre d'attaque au clic droit sur le donjon adverse, combat en cours |
| `05-under-attack-mobile.png` | Le défenseur voit l'alerte « Votre base est attaquée » et ses unités défendent seules |
| `06-after-raid-desktop.png`, `07-after-raid-mobile.png` | État après le raid (gloire attribuée, pertes) |
| `08-help-desktop.png` | Aide des commandes |
| `09-connection-lost-desktop.png` | Serveur arrêté : bandeau « Connexion perdue ». Au redémarrage, les deux clients se reconnectent et retrouvent leur base (même identifiant, 41 bâtiments avant et après) |

Points vérifiés par le script (échec = code de sortie non nul) :
- aucune erreur JavaScript ni d'erreur console dans les deux pages ;
- le chat d'un joueur arrive chez l'autre ;
- l'attaquant gagne de la Gloire pendant le raid ;
- après un redémarrage du serveur, l'identité et les bâtiments sont restaurés.

Non couvert ici : le rendu sur un vrai téléphone (émulation seulement), le passage par nginx/HTTPS
(voir `docs/deploy-vps.md`), et l'image Docker (pas de démon Docker dans l'environnement de build ;
les étapes de l'image ont été rejouées à la main : `npm ci --omit=dev` puis démarrage OK).

`stamp.txt` contient l'empreinte des fichiers serveur et client au moment des captures.
