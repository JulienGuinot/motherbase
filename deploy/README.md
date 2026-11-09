# Deploy Internals

Ce dossier contient les fichiers Docker Compose et Traefik utilises par
`../setup.sh`.

La procedure supportee reste :

```bash
./setup.sh
```

Ne lance pas les stacks a la main pour installer Motherbase. Le setup gere :

- le reseau Docker `traefik_proxy`
- Traefik et Let's Encrypt
- le build des images `motherbase-api` et `motherbase-console`
- la Console
- les stacks par projet creees depuis la Console

## DNS VPS

Le setup VPS demande un seul record wildcard :

```dns
Type:  A
Name:  *
Value: <IP_DU_VPS>
```

Pour `example.com`, ce record couvre automatiquement :

```text
console.example.com
project-a.example.com
project-a-storage.example.com
project-b.example.com
```

Une fois le wildcard en place, il n'y a plus de record DNS a ajouter pour
chaque projet cree depuis la Console.

Limites :

- `*.example.com` ne couvre pas `example.com`.
- Un record explicite peut override le wildcard.
- Un domaine externe client comme `client.com` doit toujours etre configure
  chez le client.

## Fichiers

```text
deploy/
├── traefik/                   # reverse proxy lance par setup.sh
├── console/                   # stack Console lancee par setup.sh
├── docker-compose.prod.yml    # stack projet en prod
├── docker-compose.dev-multi.yml
├── update.sh                  # mise a jour en place (garde les donnees)
└── reset.sh                   # reset local/VPS (DETRUIT les donnees)
```

Les autres scripts restent des helpers internes ou de maintenance. Pour une
installation ou un redeploiement standard, utilise `./setup.sh`.

## Updates

Depuis la racine du repo :

```bash
./deploy/update.sh
```

Elle garde les volumes, les `.env` et `/srv/projects`, rebuild les images et ne
recree que les services motherbase. Les migrations passent au demarrage de
chaque conteneur API. A la main : `git pull && ./setup.sh --yes`.

Sur un tag de release `vX.Y.Z` (jamais sur un simple push vers `master`), le job
`deploy-vps` exige les gates `ci` et `runtime`, puis déploie le commit exact du
tag en checkout détaché. Il refuse un checkout modifié, un tag qui ne pointe pas
sur le commit testé, et un ancien job dès qu'une release plus récente existe. Les
fichiers `.env` et volumes sont conservés. Après un déploiement CI, utilise
`--no-pull` pour relancer manuellement le même commit ; les mises à jour passent
par la CI.

Puis mets a jour les projets voulus depuis la Console ou avec `motherbase projects update <id>`. N'utilise pas les scripts `reset` comme chemin de mise a jour. Voir [Updates](https://www.motherbase.site/docs/getting-started/updates/).

## Durcissement production

En mode VPS, `setup.sh` résout chaque image externe utilisée au runtime
(MinIO, client MinIO, Traefik, son proxy et Docker CLI) vers son
`repository@sha256:...`, vérifie le format puis persiste ces références dans
les fichiers `.env`. Un échec de résolution bloque le lancement avec un
message explicite. Les tags restent autorisés en développement.

Les images first-party `motherbase-api`, `motherbase-console`,
`motherbase-orchestrator` et `motherbase-postgres` sont construites
localement depuis le checkout vérifié ; elles conservent donc leur tag de
release au lieu de prétendre disposer d'un RepoDigest de registre.

Dans la stack Console, seul le daemon `orchestrator` contient la CLI Docker et
monte `docker.sock`. Il n'expose aucun port hôte et communique avec la Console
sur un réseau Compose `internal` via un bearer généré par le setup. Son API ne
propose que les opérations de cycle de vie, logs, état et métriques de projets
possédant un manifest valide. Elle n'accepte ni commande, arguments, chemin,
service ou nom de conteneur arbitraire. Chaque opération produit un audit JSON.

La Console ne contient pas la CLI Docker, ne monte pas le socket et ne reçoit
pas `DOCKER_HOST`. Le proxy utilisé séparément par Traefik pour la découverte
des routes reste une composante d'infrastructure et n'est pas accessible depuis
le réseau interne Console-orchestrator.

Le workflow VPS utilise `motherbase` par défaut et refuse `root`. Crée le
compte de déploiement, sa clé SSH et donne-lui accès au daemon Docker avant le
premier run :

```bash
sudo adduser --disabled-password --gecos '' motherbase
sudo usermod -aG docker motherbase
sudo install -d -m 700 -o motherbase -g motherbase /home/motherbase/.ssh
# Installer ensuite la clé publique dans /home/motherbase/.ssh/authorized_keys.
```

Le groupe `docker` confère de fait des privilèges hôte ; un daemon Docker
rootless est préférable quand l'environnement le permet.

## Gates de production

Le job de déploiement échoue **avant SSH** si sa configuration est incomplète.
Dans l'environnement GitHub `production`, renseigner :

| Type | Noms |
| --- | --- |
| Secrets | `VPS_HOST`, `VPS_SSH_KEY`, `VPS_KNOWN_HOSTS`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `SMOKE_PROJECT_EMAIL`, `SMOKE_PROJECT_PASSWORD` |
| Variables obligatoires | `CONSOLE_URL`, `SMOKE_PROJECT`, `SMOKE_PROJECT_URL`, `SMOKE_RLS_MODEL`, `SMOKE_PRIVATE_EDGE_ROUTE` |
| Variables avec défaut | `VPS_USER=motherbase`, `VPS_SSH_PORT=22`, `VPS_REMOTE_DIR=boilerplate-backend` |

Les deux URLs sont des origines HTTPS, sans chemin. `VPS_KNOWN_HOSTS` doit
contenir la clé hôte vérifiée par un canal de confiance (entrée `[hôte]:port`
pour un port SSH différent de 22). Aucun apprentissage automatique de clé SSH.

Créer une fois un **projet dédié aux smoke tests**, avec un utilisateur actif,
une table RLS (`id text`, `user_id text`, `label text`) autorisant son propriétaire
à faire CRUD et refusant l'insertion pour un autre utilisateur, et une Edge
privée qui répond 200 au POST `{"smoke":true}`. Ne pas cibler des données métier.
Les scripts exigent ces fixtures ; ils ne créent plus de projet vide et ne
modifient plus les templates d'e-mail. Les deux scripts doivent réussir après
chaque déploiement. Un échec signale un déploiement non validé, sans rollback
automatique des migrations ni des données.

Les contrôles HTTP vérifient TLS, ignorent `.curlrc` et bornent chaque requête
à 30 secondes (connexion : 10 secondes). `CURL_OPTS` n'est plus utilisé.
Pour un certificat interne lors d'un test manuel, passer `SMOKE_CA_CERT`.

La gate `runtime` construit les images réelles, démarre les services API,
Postgres et MinIO avec les définitions Compose de production, puis teste le
health-check, le Studio et une sauvegarde SQL produite par `BackupService`.
Le dump passe par S3 avant d'être restauré dans une base vide ; les tables,
une donnée témoin, une policy RLS et l'historique des migrations sont comparés.
Elle utilise des volumes et réseaux jetables, aucun port exposé et aucune
configuration VPS. Exécution locale (Docker Linux requis) :

```bash
bash deploy/build-images.sh
bash deploy/verify-runtime.sh
```

Ce drill vérifie une restauration vers une base vide dans la stack isolée.
Il ne prouve pas la présence d'une sauvegarde hors VPS : configurer une
destination distincte, sauvegarder aussi les secrets de configuration et les
objets storage, puis vérifier la récupération sur un hôte séparé avant d'y
confier des données réelles. Un dump SQL ne restaure pas les fichiers storage.

## Maintenance

Reset complet de cette installation :

```bash
./deploy/reset.sh --yes
```

Puis relance :

```bash
./setup.sh
```
