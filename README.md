# MHM — Mental Health Matters · Vercel + Supabase + GitHub

Architecture : `index.html` (site) → `/api/*` (fonction Vercel, clé secrète côté serveur) → Supabase Postgres.
Le navigateur ne parle jamais directement à la base. Aucune dépendance npm.

## Mise en ligne (≈ 20 min)
1. **Supabase** : New project (région *West EU – Paris*) → SQL Editor → colle `supabase/schema.sql` → Run.
2. **Supabase** : Project Settings → API (ou API Keys) → copie l'URL du projet et la clé **secrète / service_role**.
3. **GitHub** : nouveau dépôt, envoie tout ce dossier (le fichier `.gitignore` empêche d'envoyer des secrets).
4. **Vercel** : Add New → Project → importe le dépôt → Framework Preset : *Other* → ouvre *Environment Variables* et ajoute :
   `SUPABASE_URL` · `SUPABASE_SERVICE_ROLE_KEY` · `ADMIN_PASSWORD` → Deploy.
5. Teste `https://TON-SITE.vercel.app/api/data` → doit afficher `{"posts":[]}`.

## Modération
Petit 🔒 en bas de page → `ADMIN_PASSWORD` → « Supprimer » (histoire ou commentaire), vérifié côté serveur.

## À savoir
- Supabase gratuit : un projet inactif est mis en pause après environ 1 semaine ; un ping régulier sur `/api/data` (UptimeRobot) l'évite.
- Numéros d'urgence : constante `EMERGENCY` en haut du script de `index.html` (à vérifier).
- Anti-spam : 20 s entre deux histoires, 6 s entre deux commentaires (IP hachée, jamais stockée en clair).
- Modifier le site : édite sur GitHub, Vercel redéploie automatiquement.
