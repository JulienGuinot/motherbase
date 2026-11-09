# Console Deploy Internals

La Console se lance via le setup racine :

```bash
./setup.sh
```

Ce dossier contient seulement la stack Compose utilisee par `setup.sh`.

En VPS, configure le wildcard DNS demande par le setup :

```dns
Type:  A
Name:  *
Value: <IP_DU_VPS>
```

Il couvre `console.example.com` et tous les futurs projets comme
`demo.example.com` ou `demo-storage.example.com`.

Checklist manuelle minimale apres setup :

- login Console OK
- creation d'un projet `demo`
- `demo` apparait dans la liste
- ouverture du projet depuis la Console OK
- Stop / Start / Destroy OK

## Update checks

Ajoute `UPDATE_CHECK_URL` dans `deploy/console/.env` pour afficher le statut de release dans la Console :

```env
UPDATE_CHECK_URL=https://releases.example.com/motherbase.json
```

La Console accepte `{ "version": "1.2.3" }`, `{ "tags": [...] }`, ou `{ "results": [{ "name": "1.2.3" }] }`. Ce panneau est informatif : la mise a jour s'applique toujours depuis la racine avec `git pull` puis `./setup.sh --yes --prod`.

## Frontière Docker

La Console n'embarque ni CLI Docker, ni socket, ni API Docker générique.
Le service interne `orchestrator` est le seul composant de cette stack qui
monte le socket. Son port n'est pas publié, son réseau est `internal`, son
bearer est généré par `setup.sh` et ses routes sont limitées aux opérations
métier sur des slugs/manifests validés.
