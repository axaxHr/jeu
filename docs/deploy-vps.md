# BASTIONS : jouer en local et héberger sur un VPS

Un seul processus Node.js sert à la fois le site (le client du jeu) et la
connexion WebSocket. Il n'y a pas de base de données : le monde est sauvegardé
dans `data/world.json` toutes les 30 secondes et à l'arrêt du serveur.

## Jouer en local (2 minutes)

Prérequis : Node.js 20 ou plus récent.

```bash
npm install
```

```bash
npm start
```

Ouvrez <http://localhost:3000>. Pour tester à plusieurs sur la même machine,
ouvrez une fenêtre de navigation privée par joueur (chaque navigateur garde son
propre jeton de joueur). Sur le réseau local, les autres utilisent
`http://IP-DE-VOTRE-PC:3000`.

## Sur un VPS : option A, Docker (recommandé)

Sur le VPS (Debian/Ubuntu), avec Docker installé :

```bash
git clone https://github.com/axaxhr/jeu.git bastions
```

```bash
cd bastions && docker compose up -d --build
```

Le jeu répond sur `http://IP-DU-VPS:3000`. Si le pare-feu est actif :

```bash
sudo ufw allow 3000/tcp
```

Le monde est conservé dans le volume Docker `bastions-data`. Les réglages se
font dans `docker-compose.yml` (section `environment`, voir le tableau plus bas).

Mettre à jour après un `git pull` :

```bash
docker compose up -d --build
```

Le dépôt est privé ? Clonez-le avec un jeton d'accès GitHub, ou copiez le
dossier avec `scp`/`rsync`. Seuls `package.json`, `package-lock.json`, `src/`,
`Dockerfile` et `docker-compose.yml` sont nécessaires.

## Sur un VPS : option B, Node.js + systemd

```bash
sudo useradd --system --home /opt/bastions --shell /usr/sbin/nologin bastions
```

```bash
sudo git clone https://github.com/axaxhr/jeu.git /opt/bastions
```

```bash
cd /opt/bastions && sudo npm ci --omit=dev
```

```bash
sudo cp deploy/bastions.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now bastions
```

Journal du serveur :

```bash
journalctl -u bastions -f
```

L'unité fournie écoute sur `127.0.0.1:3100` et attend nginx devant (étape
suivante). Pour exposer le port directement sans nginx, mettez `HOST=0.0.0.0`,
`PORT=3000` et `TRUST_PROXY=false` dans le fichier de service.

## Nom de domaine et HTTPS avec nginx (à côté d'un autre site)

C'est le cas d'un serveur qui héberge déjà un autre jeu ou site sur son domaine
(ex. `arenarow.io`). BASTIONS prend un **sous-domaine** à lui
(`bastions.arenarow.io`), écoute seulement en local sur le port **3100**, et
nginx lui envoie le trafic de ce sous-domaine. La config de l'autre site n'est
pas modifiée.

1. **DNS** : chez le registrar du domaine, ajoutez un enregistrement `A` nommé
   `bastions` qui pointe vers l'IP du VPS (et un `AAAA` si le VPS a une IPv6).
   Vérifiez (la commande doit afficher l'IP du VPS) :

```bash
getent hosts bastions.arenarow.io
```

2. **Le jeu, en local sur le port 3100**. Avec Docker :

```bash
docker compose -f deploy/docker-compose.nginx.yml up -d --build
```

   Sans Docker : `deploy/bastions.service` (option B) écoute déjà sur 3100.
   Vérifiez que le jeu répond :

```bash
curl -s http://127.0.0.1:3100/healthz
```

3. **nginx** : installez le site fourni (il est déjà réglé pour
   `bastions.arenarow.io` ; pour un autre domaine, remplacez ce nom dans le fichier) :

```bash
sudo cp deploy/nginx-bastions.conf /etc/nginx/sites-available/bastions && sudo ln -sf /etc/nginx/sites-available/bastions /etc/nginx/sites-enabled/bastions
```

```bash
sudo nginx -t && sudo systemctl reload nginx
```

4. **HTTPS gratuit** (installez d'abord certbot si besoin :
   `sudo apt install certbot python3-certbot-nginx`) :

```bash
sudo certbot --nginx -d bastions.arenarow.io
```

Le client passe automatiquement en `wss://` quand la page est en HTTPS. Le
fichier nginx utilise sa propre variable (`$bastions_connection_upgrade`), il
ne peut donc pas entrer en conflit avec un `map $connection_upgrade` déjà défini
par l'autre site.

### Avec Caddy au lieu de nginx

Si le serveur utilise Caddy (fichier `/etc/caddy/Caddyfile`), faites les étapes
1 et 2 ci-dessus, puis ajoutez le bloc de `deploy/Caddyfile.bastions` **à la fin**
du Caddyfile, en gardant le bloc du site existant :

```
bastions.arenarow.io {
	reverse_proxy 127.0.0.1:3100
}
```

```bash
sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy
```

Caddy obtient le certificat HTTPS tout seul et transmet le WebSocket. Il remplace
aussi un `X-Forwarded-For` envoyé par un client, ce que le jeu exige pour ses
limites par IP.

Le jeu fonctionne aussi dans un sous-dossier (`https://mondomaine.fr/bastions/`) :
le WebSocket est toujours cherché à côté de la page.

## Réglages (variables d'environnement)

| Variable | Défaut | Rôle |
|---|---|---|
| `PORT` | `3000` | Port HTTP/WebSocket |
| `HOST` | `0.0.0.0` | Interface d'écoute (`127.0.0.1` derrière nginx) |
| `DATA_DIR` | `./data` | Dossier de sauvegarde (`world.json`) |
| `MAP_SIZE` | `160` | Taille de la carte en cases (64–256). 160 accueille une vingtaine de bases et 28 camps de monstres. Seulement à la création du monde. |
| `MAP_SEED` | aléatoire | Graine de la carte, seulement à la création du monde |
| `OFFLINE_SHIELD` | `true` | Les bases des joueurs hors ligne ne peuvent pas être attaquées |
| `SHIELD_SECONDS` | `180` | Bouclier à l'arrivée et après une défaite |
| `START_GOLD`, `START_WOOD`, `START_STONE` | `250`, `150`, `100` | Ressources de départ (montez-les pour des parties plus rapides) |
| `MAX_ONLINE` | `32` | Joueurs connectés en même temps |
| `MAX_CONN_PER_IP` | `6` | Connexions simultanées par adresse IP |
| `TRUST_PROXY` | `false` | Lire l'IP réelle dans `X-Forwarded-For` (uniquement derrière un proxy) |
| `TRUSTED_PROXIES` | vide | IP de proxys autorisés à fournir `X-Forwarded-For`, en plus de `127.0.0.1` (ex. l'IP du conteneur nginx) |
| `NEW_PLAYERS_PER_IP_HOUR` | `3` | Nouveaux comptes par heure et par adresse IP (IPv6 regroupée par /64) |
| `ALLOWED_ORIGINS` | vide | Autres origines autorisées à ouvrir le WebSocket (par défaut : même domaine que la page) |
| `INACTIVE_DAYS` | `21` | Supprime les bases des joueurs absents depuis N jours (`0` = jamais) |
| `SAVE_INTERVAL` | `30` | Secondes entre deux sauvegardes automatiques |

Les règles du jeu (coûts, dégâts, revenus…) sont dans `src/shared/config.js`.
Redémarrez le serveur après modification ; les joueurs rechargent la page.

## Entretien

- **Sauvegarder le monde** : copiez `data/world.json` (Docker :
  `docker compose cp bastions:/app/data/world.json ./world-backup.json`).
- **Changer la taille de la carte** : elle est fixée à la création du monde. Un monde
  créé avant la v2 garde sa carte de 96 (il est converti automatiquement : bois,
  pierre et Sanctuaire ajoutés). Pour profiter de la grande carte, créez un nouveau
  monde (ligne suivante).
- **Nouveau monde** : arrêtez le serveur, renommez ou supprimez `world.json`, puis
  relancez. Une sauvegarde illisible n'est jamais effacée : elle est mise de côté
  (`world.json.corrupt-…`) et un nouveau monde démarre.
- **État du serveur** : `http://IP:3000/healthz` renvoie le nombre de joueurs.
- **Un joueur a perdu sa base en changeant de navigateur** : le jeton de joueur est
  stocké dans le navigateur. Sur un autre appareil, il faut un autre pseudo.

## Dépannage

| Symptôme | Cause probable |
|---|---|
| La page s'affiche mais « Serveur injoignable » | Le proxy ne transmet pas le WebSocket : vérifiez les lignes `Upgrade`/`Connection` de la config nginx. |
| « Trop de connexions » ou erreur 429 | Plusieurs joueurs derrière la même box : augmentez `MAX_CONN_PER_IP`. |
| Toutes les connexions semblent venir de `127.0.0.1` | Derrière nginx sans `TRUST_PROXY=true`. |
| `mondomaine.fr` affiche toujours l'autre site | Normal : c'est son nom. BASTIONS est sur son sous-domaine (`bastions.…`). Si le sous-domaine affiche aussi l'autre site, le DNS n'est pas encore propagé ou le site nginx `bastions` n'est pas activé (`ls /etc/nginx/sites-enabled/`). |
| `docker compose up` : « port is already allocated » | Un autre programme occupe le port : utilisez `deploy/docker-compose.nginx.yml` (port 3100), ou changez `BASTIONS_PORT`. |
| « La carte est pleine » | Augmentez `MAP_SIZE` (nouveau monde) ou baissez `INACTIVE_DAYS`. Les bases jouées moins de 10 minutes sont supprimées après 48 h d'absence. |
| « Trop de nouveaux seigneurs depuis cette connexion » | Plusieurs amis créent leur compte depuis la même box : augmentez `NEW_PLAYERS_PER_IP_HOUR`. |
