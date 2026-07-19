# Fociz — serveur (site + comptes)

Petit serveur Node.js **sans aucune dépendance** (pas de `npm install`).
Il sert le site Fociz **et** gère les comptes (inscription, connexion,
mot de passe oublié par email) — une seule adresse pour tout.

## Installation

Mettre `fociz.html` (le fichier du site) **dans ce même dossier**, à côté de
`docker-compose.yml`. Puis :

```bash
cd fociz-serveur
cp env.example .env
# éditer .env : au minimum RESEND_API_KEY et FRONT_URL
docker compose up -d
```

Vérifier que ça tourne :

```bash
curl http://localhost:8080/sante
# {"ok":true,"joueurs":0}
```

Le site est servi sur cette même adresse (`http://localhost:8080/`).
Les comptes sont dans `./data/fociz.json` (un seul fichier, facile à sauvegarder).

Pour mettre à jour le site plus tard : remplacer `fociz.html` dans ce dossier,
pas besoin de reconstruire l'image (`docker compose restart` suffit, même pas
toujours nécessaire).

### Config email (mot de passe oublié)

1. Créer un compte gratuit sur [resend.com](https://resend.com) (100 emails/jour gratuits).
2. Récupérer une clé API et la mettre dans `.env` → `RESEND_API_KEY`.
3. Mettre l'adresse du **site** (pas du serveur) dans `.env` → `FRONT_URL`, par ex.
   `https://fociz.netlify.app`. C'est ce qui compose le lien envoyé par email.
4. Sans domaine à soi, `MAIL_FROM=Fociz <onboarding@resend.dev>` fonctionne pour
   tester, mais atterrit parfois en spam. Pour un vrai envoi fiable, vérifier son
   propre domaine dans Resend puis changer `MAIL_FROM`.

Si `RESEND_API_KEY` est vide, le serveur ne plante pas : les emails ne partent
juste pas (message dans les logs `docker compose logs -f`), pratique pour tester
le reste sans compte Resend.

## Mise en ligne

Une seule adresse suffit pour tout (site + comptes), en **HTTPS**. Avec un
reverse proxy déjà en place (Nginx Proxy Manager, Traefik, Caddy), pointer par
exemple `fociz.mondomaine.fr` vers `fociz:8080`.

Exemple Caddy :

```
fociz.mondomaine.fr {
    reverse_proxy fociz:8080
}
```

Ensuite, dans `fociz.html`, renseigner cette **même** adresse en haut du
script (le site s'appelle donc lui-même, c'est normal) :

```js
const API = "https://fociz.mondomaine.fr";
```

Et dans `.env`, `FRONT_URL` doit être la même adresse aussi — c'est ce qui
compose le lien envoyé par email pour le mot de passe oublié.

Si `API` reste vide dans `fociz.html`, le site fonctionne quand même, mais
tout reste enregistré uniquement dans le navigateur (pas de compte partagé
entre appareils).

## Routes

Les routes `/api/...` sont toutes en `POST`, corps et réponse en JSON.
Toute autre requête `GET` (donc `/`) sert directement le fichier `fociz.html`.

| Route                     | Entrée                                   | Sortie                    |
|---------------------------|-------------------------------------------|---------------------------|
| `GET /`                   | —                                         | le site (fociz.html)      |
| `/api/inscription`        | `pseudo`, `email`, `mdp`, `tete`         | `jeton`, `joueur`         |
| `/api/connexion`          | `pseudo` (ou email), `mdp`               | `jeton`, `joueur`, `amis` |
| `/api/motDePasseOublie`   | `email`                                  | `ok`                      |
| `/api/reinitialiser`      | `token`, `mdp`                           | `jeton`, `joueur`         |
| `/api/sync`               | `jeton`, `arbres`, `serie`, `minutes`    | `joueur`                  |
| `/api/ami`                | `jeton`, `action` (`ajouter`/`retirer`), `pseudo` | `amis`           |
| `/api/classement`         | `jeton`                                  | `classement`              |
| `/sante`                  | —                                         | état du serveur           |

`ami` et `classement` restent dans le serveur mais ne sont plus appelées par
le site depuis que la fonctionnalité "amis" a été retirée de l'interface —
elles ne gênent en rien, elles ne servent juste plus.

## Sécurité — ce qui est fait et ce qui ne l'est pas

Fait :
- mots de passe jamais stockés en clair (scrypt + sel unique par compte)
- jeton de session aléatoire, 5 appareils maximum par compte
- lien de réinitialisation à usage unique, valable 30 minutes
- la demande de réinitialisation répond pareil que l'email existe ou non (n'expose pas qui a un compte)
- corps de requête limité à 10 Ko

Pas fait (à ajouter si le site sort du cercle des copains) :
- limitation du nombre de tentatives de connexion
- vérification que l'email saisi à l'inscription existe vraiment (pas de mail de confirmation)
- modération des pseudos

À faire tourner derrière le reverse proxy, pas exposé directement sur Internet.

## À savoir : emails de mineurs

Fociz vise des collégiens/lycéens. Collecter leur email est une donnée
personnelle de mineur — en France le RGPD demande l'accord d'un parent pour
les moins de 15 ans. Rien d'automatisé ici pour ça ; à garder en tête si le
site sort du cercle familial/amical.
